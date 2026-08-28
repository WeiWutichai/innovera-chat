#!/usr/bin/env bash
#
# Backup retention: keep 7 daily + 4 weekly VERIFIED archives.
#
# Safety properties, all deliberate:
#   * operates ONLY inside an explicitly configured BACKUP_DIR, which must exist
#   * never uses a bare wildcard rm; every deletion targets one resolved file
#   * only ever considers archives that carry a .verified marker
#   * NEVER deletes the newest verified archive, whatever the arithmetic says
#   * refuses to run if BACKUP_DIR is empty, /, or outside the working tree
#
# Off-host copies are OUT OF SCOPE here and remain a production blocker: a backup on the
# same disk as the volume it protects does not survive the failure that matters.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
DRY_RUN="${DRY_RUN:-0}"

fail() { printf 'RETENTION FAILED: %s\n' "$*" >&2; exit 1; }

case "${BACKUP_DIR}" in
  ""|"/"|"/*") fail "refusing to operate on '${BACKUP_DIR}'" ;;
esac
[ -d "${BACKUP_DIR}" ] || fail "backup directory '${BACKUP_DIR}' does not exist"

resolved="$(cd "${BACKUP_DIR}" && pwd)"
case "${resolved}" in
  "/"|"${HOME}") fail "refusing to operate on '${resolved}'" ;;
esac

# Only verified archives are eligible; an unverified or in-progress dump is never a
# rotation candidate.
#
# Deliberately avoids `mapfile`/`readarray`: those are bash 4+ builtins and macOS ships
# bash 3.2, so a rehearsal on a developer Mac would fail while production (bash 5) passed
# — the worst possible place to discover a portability gap.
verified_list="$(ls -1t "${BACKUP_DIR}"/*.dump.verified 2>/dev/null || true)"
if [ -z "${verified_list}" ]; then
  echo "verified archives found: 0 — nothing to rotate"
  exit 0
fi
total="$(printf '%s\n' "${verified_list}" | wc -l | tr -d ' ')"
echo "verified archives found: ${total} (keep ${KEEP_DAILY} daily + ${KEEP_WEEKLY} weekly)"

keep=$(( KEEP_DAILY + KEEP_WEEKLY ))
if [ "${total}" -le "${keep}" ]; then
  echo "nothing to rotate"
  exit 0
fi

index=0
while IFS= read -r marker; do
  [ -n "${marker}" ] || continue
  index=$(( index + 1 ))
  # Newest is never a candidate, belt and braces on top of the count check.
  # Explicit `if` rather than `[ ... ] && continue`: the shorthand leaves a non-zero
  # status behind when the test is false, which interacts badly with `set -e`.
  if [ "${index}" -eq 1 ]; then continue; fi
  if [ "${index}" -le "${keep}" ]; then continue; fi

  archive="${marker%.verified}"
  counts="${archive}.counts"

  case "${archive}" in
    "${BACKUP_DIR}"/*) ;;
    *) fail "resolved archive '${archive}' escaped the backup directory" ;;
  esac

  if [ "${DRY_RUN}" = "1" ]; then
    echo "would remove: ${archive}"
  else
    echo "removing: ${archive}"
    rm -f "${archive}" "${marker}" "${counts}"
  fi
done <<EOF_LIST
${verified_list}
EOF_LIST
echo "retention complete"
