# INNOVERA AI — Production Deployment

Operational runbook. Phase 3A establishes the safety rules and the application-side
support for them. Commands that depend on the production container rework land in a
later phase and are marked accordingly.

---

## 1. Development never touches production

The production application server is a **separate git remote** from the development one.

| Remote | Points at | Used for |
| --- | --- | --- |
| `origin` | `github.com:WeiWutichai/innovera-chat` | All development. A bare `git push` goes here. |
| `production` | the production GPU host | Fetch only. **Push is disabled.** |

The remotes were renamed so the *safe* destination is the default and the dangerous one
must be named explicitly. Three layers protect production:

1. `remote.production.pushurl = DISABLED` — a push fails at the transport layer before
   any network call.
2. A **versioned** `pre-push` hook at `.githooks/pre-push` refuses any push whose remote
   is named `production`. It matches on the remote NAME only and contains no host or
   credential, so it is safe to commit. Deliberate override:
   `ALLOW_PRODUCTION_PUSH=1 git push production <ref>`.
3. `remote.pushDefault = origin` and `branch.main.remote = origin`.

> **A fresh clone must enable the hook:** `git config core.hooksPath .githooks`.
> `core.hooksPath` is local config and does not travel with a clone — which is exactly
> why the push-URL layer exists as the primary guard rather than the hook.

Normal development must not contact production at all: no fetch, no push, no database
connection, no LiteLLM call. The test suite enforces the database half of this — it
refuses any non-loopback `TEST_DATABASE_URL` and refuses a URL equal to `DATABASE_URL`.

---

## 2. Configuration categories

Values are **never** committed, logged, or baked into an image layer.

### Required secrets — runtime
Absence fails `/api/health/ready`, which stops a deployment before traffic moves.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Connection string for the chat database. |
| `CLERK_SECRET_KEY` | Clerk server key. |
| `LITELLM_API_KEY` | LiteLLM virtual key. |
| `LITELLM_BASE_URL` | LiteLLM endpoint. Reached over the internal network. |

### Required configuration — build time

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Publishable by design, but **inlined into the client bundle at build time**. Rotating it requires a rebuild, not a restart. Does **not** gate readiness — its absence breaks the browser app, not the server. |

**A production build FAILS if this variable is missing or blank.** Without that gate a
build succeeds and bakes an *empty* key into the bundle, producing an image that deploys
cleanly and then cannot sign anyone in, with no server-side symptom. The failure names the
variable and never its value. The gate is phase-aware: it runs during
`next build` only, never during `next start`, so a running container is never crashed over
configuration it can no longer change.

> Consequence: `npm run build` now requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to be set.

### Optional tunables
All have safe defaults and fall back with a warning naming the variable (never its
value): `CHAT_RATE_LIMIT_PER_MINUTE` (10), `CHAT_MAX_CONCURRENT_PER_USER` (2),
`CHAT_CONTEXT_CHAR_BUDGET` (20000), `CHAT_UPSTREAM_TIMEOUT_MS` (540000).

The context budget is deliberately far below the model's 65,536-token ceiling. It bounds
prefill cost, latency and KV-cache pressure — not model capability.

---

## 3. Test requirements before any deployment

All of the following must pass on the exact commit being deployed:

```
npm run typecheck      # tsc --noEmit
npm run lint           # zero errors, zero warnings
npm test               # unit + integration + migration
npm run test:runtime   # opt-in; builds and boots a real server
npm run build
```

`npm test` needs a PostgreSQL it can use. Resolution order:

1. `TEST_DATABASE_URL` if set (the CI path).
2. Otherwise an ephemeral cluster provisioned from a local `initdb`/`pg_ctl`.
3. Otherwise it **fails with instructions**. It never falls back to `DATABASE_URL`.

---

## 4. Backup and restore

**A backup that has not been restored is not a backup.** `scripts/backup.sh` refuses to
mark an archive verified until it has been restored into an isolated scratch database and
its row counts checked against the source.

The archive is PostgreSQL custom format written **directly to a file** — never piped
through `gzip`. Custom format is already compressed, and in a pipeline the exit status
belongs to the last command, so `pg_dump | gzip` yields a well-formed archive and a zero
exit status even when the dump died halfway.

Order of operations, each gated on the previous:

1. `pg_dump --format=custom` to a **temporary** filename; exit status checked.
2. `pg_restore --list` proves the archive is readable.
3. Atomic rename — only now does a file with the real backup name exist.
4. Restore into an isolated `restore_check_*` database.
5. **Structural verification:** every expected table (`User`, `Conversation`, `Message`,
   `Usage`) exists and can actually be queried. Restored row counts are **recorded** to a
   `.counts` sidecar for audit.
6. Drop the scratch database, then write the `.verified` marker.

> **Restored counts are recorded, never compared against the live database.** The
> application stays writable during a backup, so the source moves on the moment the dump
> finishes — a dump capturing 1000 messages is perfectly valid when the live table already
> holds 1002. A strict comparison would fail correct backups and, worse, train whoever
> runs this to ignore the failure. Exact equality is only meaningful if the source is
> quiesced or both observations come from one consistent snapshot; neither is true here.

A cleanup trap drops the scratch database and removes the partial archive on **any** exit
path. The database port is never exposed; everything runs through the Compose service.

**Retention:** `scripts/backup-retention.sh` keeps **7 daily + 4 weekly** verified
archives. It operates only inside an explicitly configured `BACKUP_DIR`, refuses `/` and
`$HOME`, uses no bare wildcard `rm`, considers only archives carrying a `.verified`
marker, and never deletes the newest one.

> **PRODUCTION BLOCKER — off-host storage is not configured.** Retention runs locally
> only. A backup on the same disk as the volume it protects does not survive the failure
> that matters, and this host has already run out of disk once. An off-host destination
> must be chosen and configured before the first production deployment. No credentials or
> destinations have been invented here.

**Restoring rolls back data as well as schema.** It discards every conversation written
since the archive. Restore is for corruption and unrecoverable migration failure — never
for routine application rollback.

---

## 5. Migrations run before the application

**Rule: the new application must never become the serving version until migrations have
completed successfully.**

- `prisma migrate deploy` only. Never `prisma migrate dev` against production — it can
  reset the database and it authors new migrations.
- Migrations run as a **separate step**, not as part of application start. Coupling them
  makes a migration failure present as an application outage and forces the Prisma CLI
  into the serving image.

### If the migration fails

The database state is **unknown until assessed**. Prisma applies migrations file by file
and PostgreSQL cannot run every DDL statement transactionally, so a failure may leave
none, some, or one file fully and the next partially applied.

1. **Stop the deployment.** Do not start the new application.
2. **Do not automatically restore the database.**
3. Inspect `prisma migrate status` *and* the actual schema — disagreement is diagnostic.
4. Determine which statements were applied.
5. **Assess whether the old application is still compatible with the current schema.**
   It still serving is not evidence that it is safe.
6. Recover from the verified backup **only if** the schema supports neither version.

*(The migrator container itself lands in a later phase.)*

---

## 6. Deployment is a controlled single-replica restart

There is **one** application replica behind NGINX. Replacing it means stopping it and
starting another. **A short service interruption is expected**, from the moment the old
container stops until the new one passes readiness. Health checks confirm the new
instance came up; they do not gate a traffic switch, because there is no switch.

### Staging rehearsal

The commands below were executed against a disposable Colima stack. `scripts/deploy.sh`
accepts overrides so a rehearsal never touches production:

```
DEPLOY_COMPOSE="docker compose -f <rehearsal>.yml -p <project>" \
DEPLOY_APP_URL="http://127.0.0.1:<port>" \
BACKUP_DIR=<tmp>/backups BACKUP_EXEC="docker compose -f <rehearsal>.yml -p <project> exec -T chat-db" \
SKIP_BUILD=1 \
  bash scripts/deploy.sh
```

### Production deployment

```
bash scripts/deploy.sh
```

It performs, failing closed at every step:

| Step | Action | On failure |
| --- | --- | --- |
| 1 | Validate required configuration (names only, never values) | stop |
| 2 | Start and await the database | stop |
| 3 | **Verified backup** — must produce a NEW `.verified` marker | stop, before migrating |
| 4 | Build runner + migrator from the same source | stop |
| 5 | **Migrate** (one-shot container, before the app is replaced) | **stop — see below** |
| 6 | Recreate the application (**interruption starts**) | — |
| 7 | Bounded `/live` then `/ready` polls | roll back |
| 8 | Landing page, static asset, signed-out API smoke | roll back |

A **deployment lock** (atomic `mkdir`, not `flock` — absent on macOS) makes a second
concurrent deployment fail cleanly. The lock is released on every exit path while
preserving the failure status.

### Health endpoints

| Endpoint | Answers | Checks |
| --- | --- | --- |
| `GET /api/health/live` | Is the process alive? | Nothing. Used by the Docker healthcheck. |
| `GET /api/health/ready` | Should this instance receive traffic? | Required config + a 2s-bounded `SELECT 1`. Used by the deploy gate only. |

`/ready` is deliberately **not** the Docker healthcheck: a brief database blip must not
make Docker kill a healthy application. Verified — with the database stopped, `/ready`
returned 503 while `/live` stayed 200 and Docker health remained `healthy`.

LiteLLM is **not** part of readiness.

### If the migration fails

The deployment stops. The application is **not** replaced and the previous version keeps
serving — verified by container id before and after.

**The database state is UNKNOWN until assessed.** Do not automatically restore. Follow
§5.

## 7. Application rollback is **not** database rollback

```
bash scripts/rollback.sh <previous-image-tag>
```

Stops the failed application, starts the recorded previous image, re-runs the `/live`,
`/ready` and smoke gates. It **never** touches the database: it contains no
`pg_restore`, no `DROP DATABASE`, no `migrate resolve`, no `migrate reset`. Verified —
applied-migration count and table count were identical before and after.

**Before rolling back you must assess** whether the previous application is compatible
with the current schema. That cannot be automated.

For **this release specifically**, the pending production migration is the `Usage` index
swap, which is backward-compatible with the previous application. **Do not generalise
that to future migrations.**

### Database recovery — manual incident procedure

Restoring a backup rolls back **data as well as schema** and discards every conversation
written since it was taken. It is for corruption and unrecoverable migration failure —
never a routine consequence of an application problem. See §4 for the restore command.

## 8. Security header ownership

| Header | Owner |
| --- | --- |
| `Strict-Transport-Security` | **NGINX.** It terminates TLS; the app is reached over plain HTTP on loopback and cannot know whether the client used TLS. |
| `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` | **Application** (`next.config.ts`). |
| `Content-Security-Policy` | **Neither, for now.** Browsers enforce the intersection of every CSP received, so a second policy from NGINX would silently break Clerk sign-in. Adding one requires confirming NGINX sends none, then a `Report-Only` period. |

---

## 9. First administrator

There is **no in-app path** to create the first ADMIN — `/admin` is reachable only by an
existing ACTIVE ADMIN. The first one is promoted by direct SQL against the database.
Losing every ADMIN is recoverable only the same way, which is why the application refuses
to disable or demote the last active administrator.

---

## 10. Production deployment checklist — BLOCKERS

These have **not** been performed. They are required before the first real deployment.

- [ ] **Backup taken against the real production database**, restore verified, `.verified`
      marker retained, archive copied **off-host**, and filename / timestamp / checksum
      recorded. Deliberately not executed during development — it runs immediately before
      the approved deployment, after a full staging rehearsal.
- [ ] **Off-host backup destination configured** (see §4).
- [ ] **NGINX `proxy_read_timeout` confirmed ≥ the application AI timeout** (540 s).
- [ ] **Confirm NGINX sends no Content-Security-Policy** before the application ever adds
      one — two policies are enforced as an intersection and would break Clerk sign-in.
- [ ] **First ADMIN exists** (see §9) — there is no in-app path to create one.
- [ ] **Rollback target recorded** — the currently running image id, before deploying.

## 11. NGINX / TLS expectations

Documented for reference. **Not modified by this work.**

- Proxies to `127.0.0.1:3002`, the only address the application binds.
- **Terminates HTTPS.** The existing Let's Encrypt certificate is retained.
- **Owns HSTS.** The application must never send `Strict-Transport-Security`: it is
  reached over plain HTTP on loopback and cannot know whether the client used TLS.
- `proxy_read_timeout` / `proxy_send_timeout` must exceed the application's AI generation
  timeout (`CHAT_UPSTREAM_TIMEOUT_MS`, default 540 s) so the proxy does not sever a
  request the application is still legitimately serving.
- The application owns `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and
  `Permissions-Policy`. Duplicating them at the proxy is harmless; duplicating CSP is not.

## 12. Graceful shutdown — what `stop_grace_period` actually provides

`stop_grace_period: 30s` gives the container a **bounded window for graceful termination**
after `SIGTERM`, and may allow in-flight requests to complete.

It does **not** prove the browser is still connected, that NGINX still holds the upstream
request, that LiteLLM still holds its side, or that vLLM finishes generating. A chat turn
spans four hops; a grace period bounds only one of them.

No application-level request draining is implemented, deliberately: with a single replica
there is nowhere to drain traffic to.
