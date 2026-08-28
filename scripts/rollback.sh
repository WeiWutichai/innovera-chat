#!/usr/bin/env bash
#
# INNOVERA AI — application rollback.
#
# APPLICATION ROLLBACK IS NOT DATABASE ROLLBACK. This script restores a previous
# application image and nothing else. It never touches the database, never reverses a
# Prisma migration, and never restores a backup.
#
# Database recovery is a MANUAL incident procedure — see DEPLOYMENT.md. Restoring a
# backup discards every conversation written since it was taken, so it is never an
# automatic consequence of an application problem.
#
# Before running this, the compatibility of the previous application with the CURRENT
# schema must be assessed. That assessment cannot be automated: it depends on what the
# migration actually did.
#
# Resolves its target from the IMMUTABLE image ID that deploy.sh recorded BEFORE it
# rebuilt anything. Never from a mutable tag: the deployment being rolled back from may
# have moved that tag onto the new image, so "roll back to the tag" would redeploy the
# broken revision.
#
# Usage:
#   scripts/rollback.sh                 # use the recorded rollback target (preferred)
#   scripts/rollback.sh <image-id>      # explicit immutable image ID override

set -euo pipefail

COMPOSE="${DEPLOY_COMPOSE:-docker compose}"
APP_URL="${DEPLOY_APP_URL:-http://127.0.0.1:3002}"
LOCK_DIR="${DEPLOY_LOCK_DIR:-.deploy.lock}"
LIVE_TIMEOUT="${DEPLOY_LIVE_TIMEOUT:-60}"
READY_TIMEOUT="${DEPLOY_READY_TIMEOUT:-60}"

ROLLBACK_FILE="${DEPLOY_ROLLBACK_FILE:-.deploy-rollback}"

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'ROLLBACK FAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Resolve the target, failing closed on anything ambiguous.
# ---------------------------------------------------------------------------
PREVIOUS_IMAGE="${1:-}"

if [ -z "${PREVIOUS_IMAGE}" ]; then
  if [ ! -f "${ROLLBACK_FILE}" ]; then
    fail "no rollback metadata at '${ROLLBACK_FILE}' and no image given. Refusing to guess a target — a wrong guess redeploys the broken revision."
  fi

  recorded="$(grep -E '^image_id=' "${ROLLBACK_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)"

  if [ -z "${recorded}" ]; then
    fail "rollback metadata '${ROLLBACK_FILE}' is malformed: no image_id field. Refusing to proceed."
  fi

  if [ "${recorded}" = "none" ]; then
    fail "the last deployment recorded NO application rollback target — there was no previous application container. There is nothing to roll back to; this is a first-deployment failure and must be handled forward."
  fi

  case "${recorded}" in
    sha256:*) ;;
    *) fail "recorded rollback target '${recorded}' is not an immutable image ID (expected sha256:...). Refusing to roll back to a mutable reference." ;;
  esac

  PREVIOUS_IMAGE="${recorded}"
fi

# The image must still exist locally, or the rollback would start nothing.
docker image inspect "${PREVIOUS_IMAGE}" >/dev/null 2>&1 \
  || fail "rollback target '${PREVIOUS_IMAGE}' is not present in the local image store."

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  fail "a deployment or rollback is already running (lock ${LOCK_DIR})"
fi
echo "$$" > "${LOCK_DIR}/pid"
trap 'rm -rf "${LOCK_DIR}"' EXIT

cat <<'NOTICE'

  ROLLBACK — application only.
  The database is NOT modified. Migrations are NOT reversed. No backup is restored.
  You must already have assessed that the previous application is compatible with the
  current schema.

NOTICE

step "1/4 stop the failed application"
# Stop before reasoning about it: a half-working instance serving traffic makes
# everything harder to assess.
${COMPOSE} stop chat-app >/dev/null 2>&1 || true
echo "  stopped"

step "2/4 start the previously recorded image"
echo "  immutable target: ${PREVIOUS_IMAGE}"
# APP_IMAGE (not IMAGE_TAG) is used so a full immutable image ID can be passed. The tag
# form `name:${IMAGE_TAG}` cannot express a digest.
APP_IMAGE="${PREVIOUS_IMAGE}" ${COMPOSE} up -d --force-recreate --no-build chat-app \
  || fail "could not start the previous image"

started_image="$(docker inspect --format '{{.Image}}' "$(${COMPOSE} ps -q chat-app | head -1)" 2>/dev/null || true)"
if [ "${started_image}" != "${PREVIOUS_IMAGE}" ]; then
  fail "started container is running image '${started_image}', not the requested '${PREVIOUS_IMAGE}'"
fi
echo "  verified running image matches the rollback target"

step "3/4 health gates"
live=0
for _ in $(seq 1 "${LIVE_TIMEOUT}"); do
  curl -fsS -o /dev/null "${APP_URL}/api/health/live" 2>/dev/null && { live=1; break; }; sleep 1
done
[ "${live}" -eq 1 ] || fail "/api/health/live did not recover within ${LIVE_TIMEOUT}s"
ready=0
for _ in $(seq 1 "${READY_TIMEOUT}"); do
  curl -fsS -o /dev/null "${APP_URL}/api/health/ready" 2>/dev/null && { ready=1; break; }; sleep 1
done
[ "${ready}" -eq 1 ] || fail "/api/health/ready did not recover within ${READY_TIMEOUT}s"
echo "  live and ready"

step "4/4 rollback smoke (a rollback is a deployment and gets the same verification)"
code=$(curl -s -o /tmp/rb-page.$$ -w '%{http_code}' "${APP_URL}/")
[ "${code}" = "200" ] || fail "landing page returned ${code}"
asset=$(grep -oE '/_next/static/[^"]+\.(css|js)' /tmp/rb-page.$$ | head -1 || true)
if [ -n "${asset}" ]; then
  acode=$(curl -s -o /dev/null -w '%{http_code}' "${APP_URL}${asset}")
  if [ "${acode}" != "200" ]; then fail "static asset returned ${acode}"; fi
fi
api=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -H 'sec-fetch-site: same-origin' -d '{"message":"rollback-smoke"}' "${APP_URL}/api/chat")
[ "${api}" = "401" ] || fail "signed-out /api/chat returned ${api}, expected 401"
rm -f /tmp/rb-page.$$

printf '\nROLLBACK COMPLETE — application only. Database untouched.\n'
