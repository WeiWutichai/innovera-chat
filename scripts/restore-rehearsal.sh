#!/usr/bin/env bash
#
# INNOVERA AI — restore rehearsal.
#
# Proves that a backup pair (database + file storage) can actually be restored TOGETHER
# and that the two halves agree. It is a rehearsal, not a recovery tool: it restores
# into a scratch database and a scratch directory and touches neither the production
# database nor the production volume.
#
# What it proves:
#   1. the manifest exists and both recorded checksums still match the artefacts
#   2. the database archive restores into an isolated scratch database
#   3. the file archive extracts into an isolated scratch directory
#   4. every File row in the restored database has a corresponding blob
#   5. every restored blob's size matches the size recorded in the database
#
# Point 4 is the one that matters. A database-only backup restores File rows whose
# downloads all 404 — it looks successful and is not.
#
# Usage:
#   scripts/restore-rehearsal.sh <backup-id>
#
# Overridable for rehearsal (never for production):
#   BACKUP_DIR, BACKUP_EXEC, RESTORE_SCRATCH_DIR

set -Eeuo pipefail

: "${CHAT_POSTGRES_USER:?CHAT_POSTGRES_USER must be set}"

BACKUP_ID="${1:?usage: restore-rehearsal.sh <backup-id>}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
EXEC="${BACKUP_EXEC-docker compose exec -T chat-db}"
SCRATCH="${RESTORE_SCRATCH_DIR:-$(mktemp -d)}"
CHECK_DB="restore_rehearsal_$$"

MANIFEST="${BACKUP_DIR}/innovera-chat-${BACKUP_ID}.manifest"

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'RESTORE REHEARSAL FAILED: %s\n' "$*" >&2; exit 1; }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

cleanup() {
  local status=$?
  ${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  # Only remove a directory this script created.
  if [ -z "${RESTORE_SCRATCH_DIR:-}" ]; then rm -rf "${SCRATCH}"; fi
  exit "${status}"
}
trap cleanup EXIT

step "1/5 manifest and integrity"
[ -f "${MANIFEST}" ] || fail "no manifest for backup id '${BACKUP_ID}' at ${MANIFEST}"

DB_ARCHIVE="${BACKUP_DIR}/$(grep '^database_archive=' "${MANIFEST}" | cut -d= -f2-)"
DB_SHA_EXPECTED="$(grep '^database_sha256=' "${MANIFEST}" | cut -d= -f2-)"
FILES_ENABLED="$(grep '^files_enabled=' "${MANIFEST}" | cut -d= -f2-)"
SCOPE="$(grep '^backup_scope=' "${MANIFEST}" 2>/dev/null | cut -d= -f2- || true)"

# A manifest that CLAIMS completeness must be able to prove it. Rejecting the claim here
# rather than at step 4 means an inconsistent manifest is caught before anything is
# restored, and the operator sees the contradiction rather than a confusing later error.
if [ "${SCOPE}" = "complete" ] && [ "${FILES_ENABLED}" != "1" ]; then
  fail "manifest claims backup_scope=complete but files_enabled=${FILES_ENABLED}. The manifest contradicts itself; this backup cannot be trusted."
fi

# Absent scope = written before this field existed. Legacy, not corrupt.
if [ -z "${SCOPE}" ]; then
  echo "  manifest predates backup_scope — treating as LEGACY (pre-M1)"
  SCOPE="legacy"
fi

echo "  declared scope: ${SCOPE}"

[ -f "${DB_ARCHIVE}" ] || fail "database archive missing: ${DB_ARCHIVE}"
[ "$(sha "${DB_ARCHIVE}")" = "${DB_SHA_EXPECTED}" ] \
  || fail "database archive checksum does not match the manifest — the artefact changed since it was written"
echo "  database archive checksum matches"

if [ "${FILES_ENABLED}" = "1" ]; then
  FILES_ARCHIVE="${BACKUP_DIR}/$(grep '^files_archive=' "${MANIFEST}" | cut -d= -f2-)"
  FILES_SHA_EXPECTED="$(grep '^files_sha256=' "${MANIFEST}" | cut -d= -f2-)"
  [ -f "${FILES_ARCHIVE}" ] || fail "file archive missing: ${FILES_ARCHIVE}"
  [ "$(sha "${FILES_ARCHIVE}")" = "${FILES_SHA_EXPECTED}" ] \
    || fail "file archive checksum does not match the manifest"
  echo "  file archive checksum matches"
else
  # A pre-M1 backup. Restoring it is legitimate, but it cannot satisfy the blob check,
  # and saying so plainly is the point of this branch.
  echo "  file storage was NOT captured in this backup (files_enabled=0)"
  echo "  => this is a LEGACY or explicitly database-only backup; blob correspondence"
  echo "     cannot be proven. It is not corrupt — but it does not protect uploaded files."
fi

step "2/5 restore database into an isolated scratch database"
${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
  -c "DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)" >/dev/null
${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
  -c "CREATE DATABASE ${CHECK_DB}" >/dev/null
${EXEC} pg_restore -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" --no-owner < "${DB_ARCHIVE}" \
  || fail "pg_restore failed"
echo "  restored"

step "3/5 extract file archive into an isolated scratch directory"
if [ "${FILES_ENABLED}" = "1" ]; then
  mkdir -p "${SCRATCH}/files"
  tar -xzf "${FILES_ARCHIVE}" -C "${SCRATCH}/files" || fail "file archive extraction failed"
  echo "  extracted $(find "${SCRATCH}/files" -type f | wc -l | tr -d ' ') object(s) to ${SCRATCH}/files"
else
  echo "  skipped"
fi

step "4/5 every File row has its blob"
HAS_FILE_TABLE="$(${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" -tAc \
  "SELECT to_regclass('public.\"File\"') IS NOT NULL")"

if [ "${HAS_FILE_TABLE}" != "t" ]; then
  echo "  no File table in this backup (pre-M1 schema) — nothing to correlate"
elif [ "${FILES_ENABLED}" != "1" ]; then
  ROWS="$(${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" -tAc 'SELECT count(*) FROM "File"')"
  if [ "${ROWS}" != "0" ]; then
    fail "backup contains ${ROWS} File row(s) but no file archive — this backup is INCOMPLETE and cannot be fully restored"
  fi
  echo "  File table present but empty; no blobs required"
else
  MISSING=0
  MISMATCHED=0
  CHECKED=0

  while IFS=$'\t' read -r key size; do
    [ -n "${key}" ] || continue
    CHECKED=$(( CHECKED + 1 ))
    blob="${SCRATCH}/files/${key}"

    if [ ! -f "${blob}" ]; then
      echo "    MISSING blob for storageKey ${key}" >&2
      MISSING=$(( MISSING + 1 ))
      continue
    fi

    actual="$(wc -c < "${blob}" | tr -d ' ')"
    if [ "${actual}" != "${size}" ]; then
      echo "    SIZE MISMATCH ${key}: db=${size} blob=${actual}" >&2
      MISMATCHED=$(( MISMATCHED + 1 ))
    fi
  done < <(${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" -tAF$'\t' \
             -c 'SELECT "storageKey", "sizeBytes" FROM "File"')

  [ "${MISSING}" -eq 0 ]    || fail "${MISSING} File row(s) have no blob in the archive"
  [ "${MISMATCHED}" -eq 0 ] || fail "${MISMATCHED} blob(s) do not match the size recorded in the database"
  echo "  ${CHECKED} File row(s) checked; every blob present and correctly sized"
fi

step "5/5 rehearsal complete"
printf '\nRESTORE REHEARSAL PASSED\n  backup_id: %s\n  database:  %s\n  files:     %s\n' \
  "${BACKUP_ID}" "$(basename "${DB_ARCHIVE}")" \
  "$([ "${FILES_ENABLED}" = "1" ] && basename "${FILES_ARCHIVE}" || echo '(not captured)')"
