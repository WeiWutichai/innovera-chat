#!/usr/bin/env bash
#
# INNOVERA AI — explicit database infrastructure bootstrap.
#
# THIS IS NOT PART OF A DEPLOYMENT. It exists so that creating the database is a
# deliberate act with its own approval, rather than something an application deployment
# does implicitly when it happens to find nothing running.
#
# scripts/deploy.sh will REFUSE to create a database. That refusal is the point: a
# deployment that silently brought up an empty PostgreSQL would then migrate into it and
# leave a perfectly healthy-looking application serving no data. Separating the two means
# the only way to get an empty database is to ask for one.
#
# This script also refuses to adopt, restart, or repair an EXISTING database. Bootstrap
# creates; it never fixes. A broken database is an incident, not a deployment step.
#
# Overridable for rehearsal (never for production):
#   DEPLOY_COMPOSE   compose command   (default: docker compose)

set -Eeuo pipefail

COMPOSE="${DEPLOY_COMPOSE:-docker compose}"

: "${CHAT_POSTGRES_USER:?CHAT_POSTGRES_USER must be set}"
: "${CHAT_POSTGRES_DB:?CHAT_POSTGRES_DB must be set}"

fail() { printf 'BOOTSTRAP FAILED: %s\n' "$*" >&2; exit 1; }

# `ps -aq` so a stopped container counts as existing. Bootstrapping "over" a stopped
# database would create a second one or silently adopt the old volume.
existing="$(${COMPOSE} ps -aq chat-db 2>/dev/null | head -1 || true)"
if [ -n "${existing}" ]; then
  fail "a chat-db container already exists ($(printf '%.12s' "${existing}")). Bootstrap CREATES database infrastructure; it will not adopt, restart, or repair an existing database. If it is stopped or unhealthy, that is an incident to investigate directly."
fi

cat <<'NOTICE'

  DATABASE BOOTSTRAP — creates a NEW, EMPTY PostgreSQL instance.

  No data is restored. If this environment previously held data, restoring it is a
  separate, manual decision (see DEPLOYMENT.md §4). Migrations are NOT run here; the
  deployment runs them.

NOTICE

echo "creating the database service..."
${COMPOSE} up -d chat-db || fail "could not create the database service"

db_container="$(${COMPOSE} ps -aq chat-db 2>/dev/null | head -1 || true)"
[ -n "${db_container}" ] || fail "the database service did not produce a container"

ready=0
for _ in $(seq 1 60); do
  if docker exec "${db_container}" pg_isready -U "${CHAT_POSTGRES_USER}" -d "${CHAT_POSTGRES_DB}" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
[ "${ready}" -eq 1 ] || fail "the database did not become ready within 120s"

volume="$(docker inspect "${db_container}" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
[ -n "${volume}" ] || fail "the database came up without a named volume at /var/lib/postgresql/data"

printf '\nBOOTSTRAP COMPLETE\n'
printf '  container: %.12s\n  volume:    %s\n' "${db_container}" "${volume}"
printf '\nNow verify this is the database you intended, then run scripts/deploy.sh.\n'
