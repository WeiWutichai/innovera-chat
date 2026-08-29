#!/usr/bin/env bash
#
# INNOVERA AI — controlled single-replica deployment.
#
# This is NOT a zero-downtime deployment. There is one application replica behind
# NGINX; replacing it means stopping it and starting another. A short service
# interruption is expected, from the moment the old container stops until the new one
# passes readiness. Health checks here confirm the new instance came up — they do not
# gate a traffic switch, because there is no switch.
#
# Fails closed at every step. Any failure before the application is replaced leaves the
# old application running and untouched.
#
# Overridable for staging rehearsal (never for production):
#   DEPLOY_COMPOSE   compose command            (default: docker compose)
#   DEPLOY_APP_URL   base URL to probe          (default: http://127.0.0.1:3002)
#   BACKUP_SCRIPT    backup script path         (default: scripts/backup.sh)
#   BACKUP_DIR       backup output directory    (default: backups)
#   DEPLOY_LOCK_DIR  lock directory             (default: .deploy.lock)
#   SKIP_BUILD       set to 1 to reuse existing images
#   DEPLOY_DB_VOLUME    require this exact named volume on the database
#   DEPLOY_DB_NETWORK   require the database to be on this private network
#   AI_NETWORK_NAME     the shared AI network the database must NOT be on

set -Eeuo pipefail

COMPOSE="${DEPLOY_COMPOSE:-docker compose}"
APP_URL="${DEPLOY_APP_URL:-http://127.0.0.1:3002}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-scripts/backup.sh}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
LOCK_DIR="${DEPLOY_LOCK_DIR:-.deploy.lock}"
LIVE_TIMEOUT="${DEPLOY_LIVE_TIMEOUT:-60}"
READY_TIMEOUT="${DEPLOY_READY_TIMEOUT:-60}"
# Attempts (2s apart) to wait for an ALREADY-RUNNING database to report ready.
# This never starts or restarts it; it only bounds how long we wait for one that
# is expected to be up already.
DB_READY_ATTEMPTS="${DEPLOY_DB_READY_ATTEMPTS:-30}"

REQUIRED_RUNTIME_VARS="DATABASE_URL CLERK_SECRET_KEY LITELLM_API_KEY LITELLM_BASE_URL"
# Consumed by docker-compose.yml interpolation and by the database readiness probe.
# Validated here so a missing value is reported by NAME at step 1 rather than aborting
# mid-deployment on an unbound variable.
REQUIRED_COMPOSE_VARS="CHAT_POSTGRES_USER CHAT_POSTGRES_DB"
REQUIRED_BUILD_VARS="NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Deployment lock. Atomic mkdir rather than flock: flock is not present on macOS by
# default, and mkdir is atomic on every POSIX filesystem. A second concurrent
# deployment fails cleanly instead of interleaving with the first.
# ---------------------------------------------------------------------------
# A boot-scoped identity. PIDs are recycled across reboots, so "is pid N alive?" alone
# can wrongly conclude a lock is held by a long-dead deployment whose number was reused.
boot_identity() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    cat /proc/sys/kernel/random/boot_id                       # Linux
  elif sysctl -n kern.boottime >/dev/null 2>&1; then
    printf '%s' "$(hostname)-$(sysctl -n kern.boottime)"      # macOS/BSD
  else
    printf '%s' "$(hostname)-unknown-boot"
  fi
}

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$" > "${LOCK_DIR}/pid"
    boot_identity > "${LOCK_DIR}/boot"
    hostname > "${LOCK_DIR}/host"
    date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCK_DIR}/started"
    return 0
  fi

  # A lock exists. It is only recovered when the holder PROVABLY cannot still be
  # running. Age is never used as evidence: a long deployment is not a dead one.
  local owner boot host started current_boot
  owner="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  boot="$(cat "${LOCK_DIR}/boot" 2>/dev/null || true)"
  host="$(cat "${LOCK_DIR}/host" 2>/dev/null || true)"
  started="$(cat "${LOCK_DIR}/started" 2>/dev/null || true)"
  current_boot="$(boot_identity)"

  if [ -z "${owner}" ] || [ -z "${boot}" ]; then
    fail "lock ${LOCK_DIR} exists but its metadata is missing or unreadable (pid='${owner}' boot='${boot}'). Refusing to guess whether a deployment is running. Inspect and remove it manually if you are certain it is stale."
  fi

  if [ "${host}" != "$(hostname)" ]; then
    fail "lock ${LOCK_DIR} was taken on host '${host}', this is '$(hostname)'. Refusing to recover a lock from another machine."
  fi

  if [ "${boot}" != "${current_boot}" ]; then
    # The machine has rebooted since the lock was taken, so the holder cannot exist.
    echo "  WARNING: recovering a stale lock — it was taken before the current boot" >&2
    echo "           (pid ${owner}, started ${started}). The holder cannot still be running." >&2
    rm -rf "${LOCK_DIR}"
    acquire_lock
    return 0
  fi

  if kill -0 "${owner}" 2>/dev/null; then
    fail "another deployment is already running (lock ${LOCK_DIR}, pid ${owner}, started ${started}). Refusing to run concurrently."
  fi

  # Same boot, same host, PID no longer exists: the holder died (SIGKILL, crash).
  echo "  WARNING: recovering a stale lock — holder pid ${owner} (started ${started}) is no longer running." >&2
  rm -rf "${LOCK_DIR}"
  acquire_lock
}
# Preserves the exit status. A naive `trap 'rm -rf ...' EXIT` makes the trap's LAST
# command the script's status, so a failed deployment would exit 0 — silently telling
# the operator it succeeded. Capture the real status first and re-exit with it.
release_lock() {
  local status=$?
  rm -rf "${LOCK_DIR}"
  exit "${status}"
}

acquire_lock
trap release_lock EXIT

# ---------------------------------------------------------------------------
step "1/9 configuration validation"
# Reports variable NAMES only. Values are never printed.
# ---------------------------------------------------------------------------
# NOTE: written with explicit `if` blocks rather than `[ ... ] && assign`.
# A `for` loop returns the status of its LAST command, so if the final iteration's
# `[ -z ... ]` test were false the loop would return 1 and `set -e` would kill the
# script silently — a correctly-configured deployment dying at step 1 with no message.
missing=""
for var in ${REQUIRED_RUNTIME_VARS} ${REQUIRED_COMPOSE_VARS}; do
  eval "value=\${${var}:-}"
  if [ -z "${value}" ]; then
    missing="${missing} ${var}"
  fi
done
if [ -n "${missing}" ]; then
  fail "missing required runtime configuration:${missing}"
fi

for var in ${REQUIRED_BUILD_VARS}; do
  eval "value=\${${var}:-}"
  if [ -z "${value}" ]; then
    fail "missing required build-time configuration: ${var}"
  fi
done
echo "  all required variables present (names checked, values never printed)"

# ---------------------------------------------------------------------------
step "2/9 database validation (an existing database is NEVER restarted or recreated)"
#
# This step deliberately does NOT run `docker compose up -d chat-db`.
#
# Compose CONVERGES: when a service definition differs from the running container's,
# `up` RECREATES that container. The first production deployment carrying a changed
# compose file therefore restarted PostgreSQL as a side effect — the data survived only
# because the named volume did, and every in-flight query failed during the gap. An
# application deployment must never take the database down.
#
# So a normal deployment REQUIRES the database to already exist and be healthy, and
# validates it entirely read-only, through `docker inspect` and `docker exec` against
# the resolved container id. No compose subcommand that can converge state is used here
# (`ps` only reads). Creating database infrastructure is a separate, explicit operation:
# scripts/bootstrap-db.sh.
# ---------------------------------------------------------------------------
AI_NET="${AI_NETWORK_NAME:-innovera_default}"

# `ps -aq` so a STOPPED database is found too: "absent" and "stopped" are different
# failures and must not be conflated. Neither is repaired here.
db_container="$(${COMPOSE} ps -aq chat-db 2>/dev/null | head -1 || true)"

if [ -z "${db_container}" ]; then
  fail "no chat-db container exists. A normal deployment does NOT create one: doing so would silently start an EMPTY database and then migrate into it, and the application would come up healthy while serving no data. If this is genuinely a first deployment, run scripts/bootstrap-db.sh explicitly, verify the result, then deploy."
fi

db_inspect() { docker inspect "${db_container}" --format "$1" 2>/dev/null || true; }

db_running="$(db_inspect '{{.State.Running}}')"
if [ "${db_running}" != "true" ]; then
  fail "the chat-db container exists but is not running (state: '$(db_inspect '{{.State.Status}}')'). A normal deployment will NOT start it. A database that stopped unexpectedly must be understood by an operator before anything migrates into it — starting it here could resume a half-shut-down or corrupted instance."
fi

# A container with no healthcheck reports no health at all; that is not a failure, it is
# an absence of evidence, and it is reported as such rather than silently treated as OK.
db_health="$(db_inspect '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
case "${db_health}" in
  healthy|none) ;;
  *) fail "chat-db is running but reports health '${db_health}'. Refusing to migrate against a database that is not healthy." ;;
esac

# The data must live on a NAMED volume. An anonymous volume or a missing mount means the
# data does not survive a recreate, which changes what a failed deployment costs.
db_mount="$(db_inspect '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}')"
case "${db_mount}" in
  volume:?*) ;;
  "") fail "chat-db has no mount at /var/lib/postgresql/data. Its data would not survive a restart. Refusing to deploy." ;;
  *)  fail "chat-db's /var/lib/postgresql/data is not a named volume (found '${db_mount}'). Refusing to deploy." ;;
esac
db_volume="${db_mount#volume:}"

if [ -n "${DEPLOY_DB_VOLUME:-}" ] && [ "${db_volume}" != "${DEPLOY_DB_VOLUME}" ]; then
  fail "chat-db is using volume '${db_volume}', not the expected '${DEPLOY_DB_VOLUME}'. Refusing to deploy against an unexpected database."
fi

db_ports="$(db_inspect '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}')"
if [ -n "${db_ports}" ]; then
  fail "chat-db publishes host port(s): ${db_ports}. The database must be reachable only from the private chat network. Refusing to deploy."
fi

db_networks="$(db_inspect '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
if [ -z "${db_networks}" ]; then
  fail "chat-db is not attached to any network. Refusing to deploy."
fi
for n in ${db_networks}; do
  if [ "${n}" = "${AI_NET}" ]; then
    fail "chat-db is attached to the shared AI network '${AI_NET}'. The database must stay on the private chat network only, or everything on the AI network can reach it. Refusing to deploy."
  fi
done
if [ -n "${DEPLOY_DB_NETWORK:-}" ]; then
  case " ${db_networks} " in
    *" ${DEPLOY_DB_NETWORK} "*) ;;
    *) fail "chat-db is not attached to the expected private network '${DEPLOY_DB_NETWORK}' (attached to: ${db_networks}). Refusing to deploy." ;;
  esac
fi

# Readiness is polled but NEVER repaired: if it does not come up, that is an operator
# problem, not something a deployment should paper over by restarting the container.
db_ready=0
for _ in $(seq 1 "${DB_READY_ATTEMPTS}"); do
  if docker exec "${db_container}" pg_isready -U "${CHAT_POSTGRES_USER}" -d "${CHAT_POSTGRES_DB}" >/dev/null 2>&1; then
    db_ready=1; break
  fi
  sleep 2
done
if [ "${db_ready}" -ne 1 ]; then
  fail "chat-db did not report ready in time. It was NOT restarted or recreated. Investigate the running database before deploying."
fi

if ! docker exec "${db_container}" psql -U "${CHAT_POSTGRES_USER}" -d "${CHAT_POSTGRES_DB}" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "the expected database could not be queried. Refusing to deploy."
fi

echo "  database validated in place — not started, not restarted, not recreated"
echo "    container $(printf '%.12s' "${db_container}")  volume ${db_volume}  health ${db_health}"

# ---------------------------------------------------------------------------
step "3/9 verified backup"
# The deployment consumes the .verified MARKER, not merely the exit code. The marker is
# written only after the archive has been restored into an isolated scratch database and
# its expected tables confirmed queryable.
# ---------------------------------------------------------------------------
# Counts verified markers WITHOUT a pipeline.
#
# `ls | wc -l` looks obvious and is wrong here: under `set -o pipefail`, `ls` fails when
# the glob matches nothing, that failure propagates through the pipeline, and `set -e`
# then kills the script at the assignment — before the backup has even run. The `if`
# form (rather than `[ -e "$f" ] && n=...`) matters too: a `for` loop returns its last
# command's status, so the shorthand would make an empty directory look like an error.
count_verified() {
  local n=0 f
  for f in "${BACKUP_DIR}"/*.verified; do
    if [ -e "${f}" ]; then n=$(( n + 1 )); fi
  done
  printf '%s' "${n}"
}
mkdir -p "${BACKUP_DIR}"
before_count=$(count_verified)
BACKUP_DIR="${BACKUP_DIR}" bash "${BACKUP_SCRIPT}" || fail "backup script failed — refusing to migrate"

newest_verified=$(ls -1t "${BACKUP_DIR}"/*.verified 2>/dev/null | head -1 || true)
[ -n "${newest_verified}" ] || fail "no .verified marker produced — refusing to migrate"
after_count=$(count_verified)
[ "${after_count}" -gt "${before_count}" ] || fail "no NEW verified backup was produced — refusing to migrate"

archive="${newest_verified%.verified}"
[ -s "${archive}" ] || fail "verified marker present but archive is missing or empty: ${archive}"
echo "  verified backup: ${archive}"

# ---------------------------------------------------------------------------
step "4/9 record the rollback target (BEFORE anything is rebuilt or replaced)"
#
# Records the IMMUTABLE image ID (sha256) of the container currently serving, not a tag.
# A tag is mutable: the build in the next step can move `innovera-chat-runner:latest` to
# the NEW image, so rolling back "to the tag" afterwards would restore the very code
# being rolled back from. The digest cannot be moved.
# ---------------------------------------------------------------------------
ROLLBACK_FILE="${DEPLOY_ROLLBACK_FILE:-.deploy-rollback}"
ROLLBACK_TAG="${DEPLOY_ROLLBACK_TAG:-innovera-chat-runner:rollback-previous}"
app_container="$(${COMPOSE} ps -q chat-app 2>/dev/null | head -1 || true)"

if [ -n "${app_container}" ]; then
  previous_image_id="$(docker inspect --format '{{.Image}}' "${app_container}" 2>/dev/null || true)"
  if [ -z "${previous_image_id}" ]; then
    fail "an application container exists but its image ID could not be read — refusing to deploy without a rollback target"
  fi

  # RETAIN the image, not just its digest.
  #
  # Recording the digest is necessary but NOT sufficient. The build in step 5 moves the
  # release tag onto the new image, which leaves this one untagged; once its container is
  # replaced in step 7 nothing references it, and an untagged unreferenced image is
  # eligible for the container runtime's image garbage collection. (Observed under Docker
  # with the containerd image store: the previous image was gone by the time a rollback
  # was attempted.) Rollback then fails closed — correct, but unable to restore service.
  #
  # A retention tag keeps exactly ONE previous image resident: the immediately previous
  # one, which is the only revision this rollback contract supports. The tag is a
  # LIFETIME anchor only — rollback still resolves through the immutable digest recorded
  # below, never through this mutable tag.
  if ! docker tag "${previous_image_id}" "${ROLLBACK_TAG}" 2>/dev/null; then
    fail "could not retain the previous image as ${ROLLBACK_TAG} — refusing to deploy without a rollback target that is guaranteed to still exist"
  fi

  {
    printf 'image_id=%s\n' "${previous_image_id}"
    printf 'container_id=%s\n' "${app_container}"
    printf 'retained_tag=%s\n' "${ROLLBACK_TAG}"
    printf 'recorded_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${ROLLBACK_FILE}"
  echo "  rollback target: ${previous_image_id}"
  echo "  retained as:     ${ROLLBACK_TAG} (prevents garbage collection; rollback still uses the digest)"
else
  {
    printf 'image_id=none\n'
    printf 'recorded_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${ROLLBACK_FILE}"
  echo "  no existing application container — NO application rollback target exists"
  echo "  (a failed deployment here cannot be rolled back to a previous revision)"
fi

# ---------------------------------------------------------------------------
step "5/9 build images"
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  SKIP_BUILD=1 — reusing existing images"
else
  ${COMPOSE} build chat-app || fail "runner image build failed"
  ${COMPOSE} --profile manual build chat-migrator || fail "migrator image build failed"
  echo "  runner and migrator built from the same source"
fi

# ---------------------------------------------------------------------------
step "6/9 migrations (BEFORE the application is replaced)"
#
# If this exits non-zero the deployment STOPS here. The old application is still
# running and still serving. The database state is UNKNOWN until assessed: Prisma
# applies migrations file by file and PostgreSQL cannot run every DDL statement
# transactionally, so a failure may leave none, some, or one file fully and the next
# partially applied.
#
# DO NOT automatically restore the backup. See DEPLOYMENT.md for the assessment
# procedure — restoring discards every conversation written since the archive.
# ---------------------------------------------------------------------------
# --no-deps is REQUIRED, not cosmetic: `compose run` starts depends_on services by
# default, and starting chat-db here would converge it to the new definition and
# recreate the running database. Step 2 already proved it is up and healthy.
if ! ${COMPOSE} --profile manual run --rm --no-deps chat-migrator; then
  cat >&2 <<'MIGFAIL'

DEPLOY FAILED: migration did not complete.

  The application has NOT been replaced. The previous version is still running.
  The database state is UNKNOWN until assessed — it may have no, some, or partially
  applied statements.

  DO NOT restore the backup automatically. Instead:
    1. inspect `prisma migrate status` AND the actual schema (they can disagree)
    2. determine which statements were applied
    3. assess whether the RUNNING application is still compatible with that schema
    4. restore from the verified backup only if neither version can work

MIGFAIL
  exit 1
fi
echo "  migrations applied"

# ---------------------------------------------------------------------------
step "7/9 replace the application (service interruption begins here)"
# ---------------------------------------------------------------------------
# --no-deps for the same reason: without it, `up` would also converge chat-db and
# recreate the database as a side effect of replacing the APPLICATION.
${COMPOSE} up -d --no-deps --force-recreate chat-app || fail "could not start the new application container"

# ---------------------------------------------------------------------------
step "8/9 health gates (bounded — never an infinite loop)"
# ---------------------------------------------------------------------------
live=0
for _ in $(seq 1 "${LIVE_TIMEOUT}"); do
  if curl -fsS -o /dev/null "${APP_URL}/api/health/live" 2>/dev/null; then live=1; break; fi
  sleep 1
done
[ "${live}" -eq 1 ] || fail "/api/health/live did not return 200 within ${LIVE_TIMEOUT}s — roll back"
echo "  /api/health/live OK"

ready=0
for _ in $(seq 1 "${READY_TIMEOUT}"); do
  if curl -fsS -o /dev/null "${APP_URL}/api/health/ready" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "${ready}" -eq 1 ] || fail "/api/health/ready did not return 200 within ${READY_TIMEOUT}s — roll back"
echo "  /api/health/ready OK — service interruption ends here"

# ---------------------------------------------------------------------------
step "9/9 application smoke"
# ---------------------------------------------------------------------------
code=$(curl -s -o /tmp/deploy-page.$$ -w '%{http_code}' "${APP_URL}/") || fail "landing page request failed"
[ "${code}" = "200" ] || fail "landing page returned ${code}"

asset=$(grep -oE '/_next/static/[^"]+\.(css|js)' /tmp/deploy-page.$$ | head -1 || true)
[ -n "${asset}" ] || fail "no static asset reference found in the landing page"
acode=$(curl -s -o /dev/null -w '%{http_code}' "${APP_URL}${asset}")
[ "${acode}" = "200" ] || fail "static asset ${asset} returned ${acode}"

api=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -H 'sec-fetch-site: same-origin' -d '{"message":"deploy-smoke"}' "${APP_URL}/api/chat")
[ "${api}" = "401" ] || fail "signed-out /api/chat returned ${api}, expected 401"
rm -f /tmp/deploy-page.$$

echo "  landing page, static asset and signed-out API all correct"
printf '\nDEPLOYMENT COMPLETE\n  verified backup: %s\n' "${archive}"
