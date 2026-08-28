# INNOVERA AI — Production Deployment

Operational runbook. Phase 3A establishes the safety rules and the application-side
support for them. Commands that depend on the production container rework land in a
later phase and are marked accordingly.

---

## 1. Development never touches production

The production application server is a **separate git remote** from the development one.

| Remote | Points at | Used for |
| --- | --- | --- |
| `github` | `github.com:WeiWutichai/innovera-chat` | All development. Branches, review, merge. |
| `origin` | the production GPU host | **Deployment only.** Never during normal work. |

> **A bare `git push` currently targets `origin`**, because local `main` tracks it. Until
> the remote-safety change lands, every push must name its remote explicitly:
> `git push github <branch>`. Never run a bare `git push` in this repository.

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

**Retention:** 7 daily + 4 weekly, stored **off the GPU host**. A backup on the same disk
as the volume it protects does not survive the failure that matters.

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
starting another. There is no pool, no cutover, and no blue/green.

**A short service interruption is expected.** It begins when the old container stops and
ends when the new one passes readiness. Health checks confirm the new instance came up
correctly; they do not gate a traffic switch, because there is no switch.

Sequence: verified backup → record the rollback target → validate configuration → check
migration status → run all gates → build → **migrate** → assess migration success →
recreate the container → wait for `/api/health/live` with a bounded timeout → wait for
`/api/health/ready` with a bounded timeout → smoke tests.

Health endpoints:

| Endpoint | Answers | Checks |
| --- | --- | --- |
| `GET /api/health/live` | Is the process alive? | Nothing. If it touched the database, a brief blip would make the healthcheck restart a healthy app. |
| `GET /api/health/ready` | Should this instance receive traffic? | Required runtime configuration, plus a `SELECT 1` bounded to 2s. |

The readiness timeout **stops waiting** for the query; it does not cancel it. No
cancellation request is sent to PostgreSQL and the statement runs to completion on its
connection. That is acceptable only because the probe is `SELECT 1` — trivial, holding no
locks. A heavier readiness query would need a server-side `statement_timeout` instead.

LiteLLM is **not** part of readiness. If the GPU backend is down the app still serves
history, admin and authentication, and returns a clean 502 for chat. Removing the whole
app over a partial dependency would be worse. Upstream health is a monitoring signal.

Neither endpoint reveals a failure reason in its body — the reason goes to the log.

---

## 7. Application rollback is **not** database rollback

Two separate decisions with separate blast radii. Make them separately, every time.

Rollback sequence: stop the failed new application → **confirm database compatibility
with the previous application** (mandatory; never skipped because it usually passes) →
start the previously recorded image → verify `/live` then `/ready` → run the same smoke
tests. A rollback is a deployment and gets the same verification.

Do **not** restore the database unless the compatibility assessment shows the schema
supports neither version.

### When rollback is unsafe

- **A destructive migration ran.** Dropped or retyped columns mean old code queries a
  schema that no longer exists. Use expand/contract: add the new shape, deploy code that
  writes both, backfill, contract in a *later* release. Never expand and contract in one
  deploy.
- **New-format data has been written** that the old version cannot interpret.
- **The migration failed midway.** Assess the actual schema first. This is the case the
  verified backup exists for.

---

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
