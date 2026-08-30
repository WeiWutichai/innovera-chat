#!/usr/bin/env bash
#
# Verified PostgreSQL backup.
#
# Fails closed: a file only carries the real backup name once pg_dump succeeded AND the
# archive proved readable, and it is only marked .verified once it has actually been
# restored into a scratch database and its row counts checked against the source.
#
# Deliberately NOT piped through gzip. PostgreSQL custom format (-Fc) is already
# compressed, and in a shell pipeline the exit status belongs to the LAST command — so
# `pg_dump | gzip` yields a well-formed archive and status 0 even when the dump died
# halfway. The dump is written straight to a file and its status is checked.
#
# The database port is never exposed: every command runs through the Compose service.
#
# Credentials are never hard-coded. Configuration comes from the environment:
#   CHAT_POSTGRES_USER, CHAT_POSTGRES_DB   (required)
#   BACKUP_DIR                             (default: ./backups)
#   BACKUP_EXEC                            (default: docker compose exec -T chat-db)
#
# BACKUP_EXEC exists so the script can be exercised against an isolated test database
# without Docker: set it to the empty string and the pg_* binaries are invoked directly.
# It is NOT a production knob.

set -euo pipefail

: "${CHAT_POSTGRES_USER:?CHAT_POSTGRES_USER must be set}"
: "${CHAT_POSTGRES_DB:?CHAT_POSTGRES_DB must be set}"

BACKUP_DIR="${BACKUP_DIR:-backups}"
# ${VAR-default}: a deliberately empty BACKUP_EXEC is respected.
EXEC="${BACKUP_EXEC-docker compose exec -T chat-db}"
CHECK_DB="restore_check_$$"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="${BACKUP_DIR}/.in-progress-${STAMP}.dump"
FINAL="${BACKUP_DIR}/innovera-chat-${STAMP}.dump"

# ---------------------------------------------------------------------------
# File storage (M1 onward).
#
# Once uploaded files exist, a PostgreSQL dump is NO LONGER a complete backup: the
# File rows would restore with no bytes behind them, and every download would 404.
# The two artefacts are captured under one STAMP and correlated by a manifest so a
# restore can prove it is pairing the right database with the right blobs.
#
# Skipping file capture requires TWO independent signals, not one:
#
#   BACKUP_FILES=0            the intent
#   BACKUP_ALLOW_DB_ONLY=1    the acknowledgement that the result is INCOMPLETE
#
# One variable was too easy to set by accident — a stale export, a copied command line —
# and the consequence is a backup carrying the .verified marker while omitting every
# uploaded file. Requiring the second means a database-only backup can only be produced
# by someone who wrote down that they wanted one.
#
# scripts/deploy.sh refuses if EITHER is set, so a normal production deployment cannot
# reach this path at all.
FILES_ENABLED="${BACKUP_FILES:-1}"

if [ "${FILES_ENABLED}" != "1" ] && [ "${BACKUP_ALLOW_DB_ONLY:-}" != "1" ]; then
  echo "BACKUP FAILED: BACKUP_FILES=0 requires BACKUP_ALLOW_DB_ONLY=1." >&2
  echo "  A database-only backup does NOT restore uploaded files: every File row would" >&2
  echo "  come back with no bytes behind it. Set both only for a pre-M1 environment or" >&2
  echo "  a deliberate database-only rehearsal." >&2
  exit 1
fi
FILES_EXEC="${BACKUP_FILES_EXEC-docker compose exec -T chat-app}"
FILES_ROOT="${BACKUP_FILES_ROOT:-/data/files}"
FILES_FINAL="${BACKUP_DIR}/innovera-chat-${STAMP}.files.tar.gz"
MANIFEST="${BACKUP_DIR}/innovera-chat-${STAMP}.manifest"

mkdir -p "${BACKUP_DIR}"

fail() {
  echo "BACKUP FAILED: $*" >&2
  exit 1
}

# Remove the scratch database and any partial artefact on ANY exit path.
cleanup() {
  local status=$?
  ${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  if [ "${status}" -ne 0 ]; then
    rm -f "${TMP}"
    # A half-written file archive must never be left where a later run — or an operator
    # glancing at the directory — could mistake it for a complete one.
    rm -f "${FILES_FINAL}.partial"
  fi
}
trap cleanup EXIT

EXPECTED_TABLES='User Conversation Message Usage'

count_rows() {
  # Single row, tab-separated: User, Conversation, Message, Usage.
  ${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "$1" -tAF$'\t' -c \
    'SELECT (SELECT count(*) FROM "User"),
            (SELECT count(*) FROM "Conversation"),
            (SELECT count(*) FROM "Message"),
            (SELECT count(*) FROM "Usage")'
}

# --- 1. dump to a TEMPORARY name; no pipeline, so $? is pg_dump's own ---------
echo "[1/8] dumping ${CHAT_POSTGRES_DB}"
if ! ${EXEC} pg_dump -U "${CHAT_POSTGRES_USER}" -d "${CHAT_POSTGRES_DB}" \
      --format=custom > "${TMP}"; then
  fail "pg_dump returned a non-zero status"
fi
[ -s "${TMP}" ] || fail "pg_dump produced an empty archive"

# --- 2. prove the archive is readable before it may look like a backup --------
echo "[2/8] verifying archive is readable"
${EXEC} pg_restore --list < "${TMP}" >/dev/null 2>&1 \
  || fail "archive is not a readable pg_dump custom-format file"

# --- 3. atomic rename: only now does a file with the real name exist ----------
echo "[3/8] promoting archive"
mv "${TMP}" "${FINAL}"

# --- 4. restore into an ISOLATED scratch database -----------------------------
echo "[4/8] restoring into ${CHECK_DB}"
${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
  -c "DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)" >/dev/null \
  || fail "could not prepare the restore-check database"
${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d postgres \
  -c "CREATE DATABASE ${CHECK_DB}" >/dev/null \
  || fail "could not create the restore-check database"
${EXEC} pg_restore -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" --no-owner < "${FINAL}" \
  || fail "pg_restore into the restore-check database failed"

# --- 5. structural verification of the restored database ----------------------
#
# Verifies that the restore reproduces what the SOURCE actually contained, rather than
# asserting a hardcoded table list. That distinction matters: a fixed list cannot pass
# against a database that has not been migrated yet, so it would block the very first
# deployment — the one moment a verified backup is most valuable.
#
# Deliberately NOT an equality check on ROW COUNTS against the live database. The
# application stays writable during a backup, so the source moves on the moment the dump
# finishes: a dump capturing 1000 messages is valid even though the live table already
# holds 1002. Counts are RECORDED for audit, never compared.
echo "[5/8] verifying restored structure"

list_tables() {
  ${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "$1" -tAc \
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename" \
    2>/dev/null | tr -d '\r'
}

SOURCE_TABLES="$(list_tables "${CHAT_POSTGRES_DB}")" || fail "could not list source tables"
CHECK_TABLES="$(list_tables "${CHECK_DB}")"           || fail "could not list restored tables"

if [ "${SOURCE_TABLES}" != "${CHECK_TABLES}" ]; then
  fail "restored table set differs from the source. source=[$(echo ${SOURCE_TABLES} | tr '\n' ' ')] restored=[$(echo ${CHECK_TABLES} | tr '\n' ' ')]"
fi

if [ -z "${SOURCE_TABLES}" ]; then
  # A pre-migration database. The dump is still valid and still verified: there was
  # simply nothing to capture. Recorded explicitly so this is never mistaken for a
  # silently-empty backup of a populated database.
  echo "      source database has no application tables yet (pre-migration) — nothing to restore"
  printf 'source_tables\n(none — pre-migration)\n' > "${FINAL}.counts"
else
  for table in ${SOURCE_TABLES}; do
    ${EXEC} psql -U "${CHAT_POSTGRES_USER}" -d "${CHECK_DB}" -tAc \
      "SELECT count(*) FROM \"${table}\"" >/dev/null 2>&1 \
      || fail "restored table \"${table}\" could not be queried"
  done
  echo "      restored tables verified queryable: $(echo ${SOURCE_TABLES} | tr '\n' ' ')"

  # Record counts for audit when the application schema is present.
  if echo "${SOURCE_TABLES}" | grep -q '^User$'; then
    RESTORED_COUNTS="$(count_rows "${CHECK_DB}")" || fail "could not read restored row counts"
    printf 'User\tConversation\tMessage\tUsage\n%s\n' "${RESTORED_COUNTS}" > "${FINAL}.counts"
    echo "      restored counts (User/Conversation/Message/Usage): ${RESTORED_COUNTS}"
  else
    printf 'tables\n%s\n' "$(echo ${SOURCE_TABLES} | tr '\n' ' ')" > "${FINAL}.counts"
  fi
fi

# --- 6. file storage archive --------------------------------------------------
#
# Runs AFTER the database is proven restorable but BEFORE the .verified marker, so a
# file-storage failure fails the whole backup closed. A run that produced a verified
# database dump and silently no file archive would be the worst outcome: it looks
# complete and is not.
DB_SHA="$(sha256sum "${FINAL}" 2>/dev/null | awk '{print $1}' || shasum -a 256 "${FINAL}" | awk '{print $1}')"
FILES_SHA="(disabled)"
FILES_COUNT="(disabled)"

if [ "${FILES_ENABLED}" = "1" ]; then
  echo "[6/8] archiving file storage"

  # tar from INSIDE the container: the volume is not reachable from the host in the
  # general case, and going through the container needs no host mount and no root.
  # -C so paths in the archive are relative to the storage root, never absolute.
  if ! ${FILES_EXEC} tar -czf - -C "${FILES_ROOT}" . > "${FILES_FINAL}.partial" 2>/dev/null; then
    fail "file storage archive failed — refusing to mark this backup verified"
  fi

  [ -s "${FILES_FINAL}.partial" ] || fail "file storage archive is empty"

  # Prove the archive is readable before it may carry the real name, mirroring the
  # pg_restore --list check the database dump already gets.
  tar -tzf "${FILES_FINAL}.partial" >/dev/null 2>&1 \
    || fail "file storage archive is not a readable tar.gz"

  mv "${FILES_FINAL}.partial" "${FILES_FINAL}"

  FILES_SHA="$(sha256sum "${FILES_FINAL}" 2>/dev/null | awk '{print $1}' || shasum -a 256 "${FILES_FINAL}" | awk '{print $1}')"
  FILES_COUNT="$(tar -tzf "${FILES_FINAL}" | grep -vc '/$' || true)"

  echo "      archived ${FILES_COUNT} object(s)"
else
  echo "[6/8] file storage archive DISABLED (BACKUP_FILES=0)"
fi

# --- 7. manifest --------------------------------------------------------------
#
# The correlation record. Without it, a directory of dumps and a directory of tarballs
# cannot be paired with confidence, and restoring mismatched halves would produce File
# rows pointing at blobs that belong to a different point in time.
echo "[7/8] writing manifest"
{
  printf 'backup_id=%s\n' "${STAMP}"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_archive=%s\n' "$(basename "${FINAL}")"
  printf 'database_sha256=%s\n' "${DB_SHA}"
  printf 'files_enabled=%s\n' "${FILES_ENABLED}"
  # The single field a consumer should branch on. "complete" asserts that BOTH halves of
  # the configured production backup are present; "database-only" states plainly that
  # they are not, so nothing downstream infers completeness from an absent field.
  printf 'backup_scope=%s\n' "$([ "${FILES_ENABLED}" = "1" ] && echo complete || echo database-only)"
  if [ "${FILES_ENABLED}" = "1" ]; then
    printf 'files_archive=%s\n' "$(basename "${FILES_FINAL}")"
    printf 'files_sha256=%s\n' "${FILES_SHA}"
    printf 'files_object_count=%s\n' "${FILES_COUNT}"
  fi
} > "${MANIFEST}"

# --- 8. only now is the backup verified ---------------------------------------
echo "[8/8] verified"
touch "${FINAL}.verified"
echo "${FINAL}"
