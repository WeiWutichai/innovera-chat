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

### File storage configuration

Every value is clamped to an absolute ceiling the environment cannot raise, so an
operator typo degrades to something safe rather than creating an unbounded upload path.

| Variable | Default | Ceiling |
| --- | --- | --- |
| `FILE_MAX_SIZE_MB` | 25 | 100 |
| `FILE_MAX_PER_UPLOAD` | 10 | 50 |
| `FILE_MAX_BATCH_MB` | 50 | 200 |
| `FILE_STORAGE_QUOTA_MB` | 2048 | 51200 |
| `FILE_UPLOADS_PER_MINUTE` | 20 | 120 |
| `FILE_STORAGE_ROOT` | `/data/files` | — |

Uploads use their own rate-limit bucket, separate from chat: one 25 MB upload and one
chat message are not equivalent work, and charging them to the same window would either
throttle conversation or under-protect uploads.

The four limits are independent and all are enforced:

- **25 MB** per individual file
- **10 files** selected per batch
- **50 MB** total accepted payload per request — this is the one that bounds peak memory
- **2 GB** stored per user

The aggregate cap matters because the first two alone permit 10 x 25 MB = 250 MB in a
single request. Uploads are buffered to compare the declared size against the real bytes,
so that is 250 MB in the heap of a single-replica container that is also serving AI
generation. The batch cap is checked from declared sizes **before any file is read into
memory and before any blob is written**.

**NGINX note.** The chat vhost currently sets `client_max_body_size 10M`, which is below
both `FILE_MAX_SIZE_MB` and `FILE_MAX_BATCH_MB`. Raising it is a separate, reviewed NGINX
change scoped to the upload path, not applied globally.

When it is raised, it must be set **above** `FILE_MAX_BATCH_MB`, not equal to it, and not
merely to `FILE_MAX_SIZE_MB`. A multipart request carries boundary markers and per-part
headers on top of the file bytes, so a 50 MB payload arrives as slightly more than 50 MB
on the wire. Sizing NGINX exactly at the application limit would reject valid uploads at
the proxy with a bare 413, before the application could return its own explanatory error.
Roughly `FILE_MAX_BATCH_MB + 5M` is a reasonable margin.

### Storage quota is concurrency-safe

Admission is serialised per user by a PostgreSQL row lock taken inside the same
transaction that measures usage and inserts the row:

```
BEGIN
  SELECT id FROM "User" WHERE id = $1 FOR UPDATE   -- serialises this user only
  SELECT SUM("sizeBytes") FROM "File" WHERE "userId" = $1
  INSERT INTO "File" ...                            -- or reject
COMMIT
```

Without it, two concurrent 25 MB uploads against 30 MB of remaining quota both observe
30 MB free and both commit. The lock is on the **User** row, so different users never
block each other.

The blob is written to storage **before** this transaction opens. That ordering is
deliberate: a row without a blob is a visible file whose download fails forever and which
consumes quota, whereas a blob without a row is invisible, consumes no quota, and is
reclaimable. A crash at any point can only produce the harmless kind — which is also why
there is no reservation table, and therefore no expiry logic and no phantom reservations
to reconcile.

### Database validation overrides

| Variable | Effect |
| --- | --- |
| `DEPLOY_DB_VOLUME` | Require this exact named volume on `chat-db` |
| `DEPLOY_DB_NETWORK` | Require `chat-db` to be attached to this private network |
| `AI_NETWORK_NAME` | The shared AI network `chat-db` must **not** be on (default `innovera_default`) |
| `DEPLOY_DB_READY_ATTEMPTS` | Readiness polls, 2s apart, for an already-running database (default 30) |

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

### 4.1 File storage is part of the backup (M1 onward)

**Once uploaded files exist, a PostgreSQL dump is no longer a complete backup.** The
`File` rows would restore with no bytes behind them and every download would 404 — a
restore that reports success and has silently lost user data.

`scripts/backup.sh` therefore captures both halves under one timestamp:

```
innovera-chat-<id>.dump            PostgreSQL, custom format, restore-verified
innovera-chat-<id>.files.tar.gz    file storage volume, tar.gz, readability-verified
innovera-chat-<id>.manifest        correlation record + SHA-256 of both artefacts
innovera-chat-<id>.dump.verified   written LAST, only when everything above succeeded
```

The ordering is deliberate. The file archive is written **after** the database has been
proven restorable and **before** the `.verified` marker, so a file-storage failure fails
the whole backup closed. A run that produced a verified database dump and no file
archive would look complete and would not be.

Skipping file capture requires **two** independent flags, and a production deployment
cannot use that path at all:

| Context | Behaviour |
| --- | --- |
| `BACKUP_FILES=0` alone | **Refused.** `backup.sh` exits with an explanation |
| `BACKUP_FILES=0` + `BACKUP_ALLOW_DB_ONLY=1` | Allowed. Manifest records `backup_scope=database-only` |
| Either flag set during `deploy.sh` | **Refused at step 1**, before anything migrates |
| Manifest scope is not `complete` | `deploy.sh` refuses to migrate |

One variable was too easy to set by accident — a stale export, a copied command line —
and the consequence is a backup carrying the `.verified` marker while omitting every
uploaded file. The second flag means a database-only backup can only be produced by
someone who wrote down that they wanted one.

The manifest's `backup_scope` field is what consumers should branch on: `complete`
asserts both halves are present, `database-only` states plainly that they are not.

| Variable | Purpose |
| --- | --- |
| `BACKUP_FILES` | `0` to skip file capture. Default `1` |
| `BACKUP_FILES_EXEC` | How to reach the volume. Default `docker compose exec -T chat-app` |
| `BACKUP_FILES_ROOT` | Storage root inside that container. Default `/data/files` |

### 4.2 Restore rehearsal

```
CHAT_POSTGRES_USER=... bash scripts/restore-rehearsal.sh <backup-id>
```

Restores into a **scratch** database and a **scratch** directory — it never touches the
production database or the production volume. It proves five things:

1. the manifest exists and both recorded checksums still match the artefacts
2. the database archive restores
3. the file archive extracts
4. **every `File` row has a corresponding blob**
5. every blob's size matches the size recorded in the database

Point 4 is the one that matters, and it is the check a database-only backup cannot pass.

**Legacy backups remain restorable and are not retroactively marked corrupt.** A manifest
written before `backup_scope` existed is reported as LEGACY and restores normally. A
backup with no file archive and no `File` rows passes. One with no file archive but
`File` rows present fails loudly as INCOMPLETE — the correct verdict, because that
pairing genuinely cannot be fully restored. A manifest claiming `backup_scope=complete`
while `files_enabled=0` is rejected as self-contradictory before anything is restored.

### 4.3 Off-host copies must include both artefacts

The Gate 3 procedure now covers three files per backup, not one: the `.dump`, the
`.files.tar.gz` and the `.manifest`. Copying only the database archive off-host
reproduces exactly the incompleteness this section exists to prevent.

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
| 2 | **Validate the already-running database, read-only** — never starts, restarts or creates it | stop |
| 3 | **Verified backup** — must produce a NEW `.verified` marker | stop, before migrating |
| 4 | **Record the rollback target** — the running image's immutable id, and retain that image under a tag so it cannot be garbage-collected | stop |
| 5 | Build runner + migrator from the same source | stop |
| 6 | **Migrate** (one-shot container, before the app is replaced) | **stop — see below** |
| 7 | Recreate the application (**interruption starts**) | — |
| 8 | Bounded `/live` then `/ready` polls | roll back |
| 9 | Landing page, static asset, signed-out API smoke | roll back |

### The deployment never touches the database container

**A normal deployment does not start, restart, recreate or create PostgreSQL.** Step 2
validates an existing database read-only and stops if it cannot.

This is not caution for its own sake — it fixes an observed production incident. Step 2
used to run `docker compose up -d chat-db`. Compose **converges**: when a service
definition differs from the running container's, `up` *recreates* that container. The
first production deployment that carried a changed compose file therefore restarted live
PostgreSQL as a side effect of deploying the *application*. The data survived only
because the named volume did, and every in-flight query failed during the gap.

`--no-deps` on the migrator `run` and on both application `up` commands (deploy and
rollback) closes the same hole one step later: `compose run` and `compose up` start
`depends_on` services by default, so without it they would converge `chat-db` at step 6
or 7 instead. Step 2 has already proved the database is up and healthy, so nothing is
lost by not waiting on the dependency condition.

What step 2 verifies before allowing a deployment to continue:

| Check | Why it fails closed |
| --- | --- |
| A `chat-db` container exists | Creating one here would start an **empty** database and then migrate into it — the app would come up healthy serving no data |
| It is running | A database that stopped unexpectedly must be understood by an operator; starting it could resume a half-shut-down instance |
| Health is `healthy` (or no healthcheck is defined) | Never migrate against a database that reports unhealthy |
| `/var/lib/postgresql/data` is a **named** volume | An anonymous or missing mount means the data does not survive a recreate |
| The volume matches `DEPLOY_DB_VOLUME`, when set | Guards against deploying at the wrong database |
| No host port is published | The database must be reachable only from the private chat network |
| It is **not** on the shared AI network | Otherwise everything on that network can reach the database |
| It is on `DEPLOY_DB_NETWORK`, when set | Confirms the expected private network |
| `pg_isready` and a `SELECT 1` succeed | Readiness is polled, never repaired |

If any check fails the deployment stops **before** the backup, migration and replacement
steps. It never attempts a fix: a stopped, unhealthy or missing database is an incident,
not a deployment step.

### Bootstrap is a separate, explicit operation

```
bash scripts/bootstrap-db.sh
```

Creating database infrastructure is deliberate and separately approved. `bootstrap-db.sh`
refuses to run if a `chat-db` container already exists — it **creates**, it never adopts,
restarts or repairs. It runs no migrations and restores no data; the deployment runs
migrations, and restoring is a manual decision (§4).

The two are kept apart so the only way to end up with an empty production database is to
ask for one explicitly.

Step 4 runs **before** anything is rebuilt or replaced, and does two things. It records the
`sha256` image id of the container currently serving — a tag would be useless, because the
build in step 5 moves the release tag onto the new image. It also re-tags that image as
`innovera-chat-runner:rollback-previous`. The tag is a **lifetime anchor only**: once the
release tag moves and the old container is replaced, the previous image is untagged and
unreferenced, and the container runtime's image garbage collection is free to delete it —
observed under Docker's containerd image store, where the rollback target was already gone
by the time a rollback was attempted. Rollback still resolves through the recorded digest,
never through this tag.

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
bash scripts/rollback.sh                 # use the target recorded by deploy.sh (preferred)
bash scripts/rollback.sh <sha256:...>    # explicit immutable image id
```

It takes an **immutable image id, never a tag**, and refuses anything that is not a
`sha256:` value — rolling back "to the tag" would redeploy the very revision being rolled
back from.

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
| `Content-Security-Policy` | **Application**, currently `Report-Only`. NGINX was confirmed to send no `add_header` at all, so there is no intersection risk. See §8.1. |
| `Cache-Control: no-store` | **Application**, scoped to `/api/:path*` only. Static assets keep immutable caching. |


### 8.1 Content-Security-Policy lifecycle

The policy is built in `next.config.ts`. The Clerk origin is **derived from the
publishable key**, not hardcoded: Clerk encodes its Frontend API host in the key
(`pk_<env>_<base64>` decoding to `"<host>$"`), which is exactly how `@clerk/shared`
resolves it and where `clerk.browser.js` is loaded from. The policy therefore always
matches the key baked into the bundle.

```
REPORT-ONLY  ──▶  browser validation  ──▶  ENFORCING  ──▶  public-launch gate
  (now)            (sign-in, chat,          CSP_ENFORCE=1     HIGH finding closed
                    streaming, admin)       + rebuild
```

**The HIGH finding this addresses remains OPEN until enforcing mode is live.**
`Report-Only` observes and reports; it blocks nothing.

Validation before promoting — exercise each in a real browser with the console open and
confirm no violation is reported:

- Clerk sign-in, sign-up, and sign-out
- an authenticated chat turn, including streaming
- the admin panel
- avatar images and any Clerk bot-protection challenge

Two `'unsafe-inline'` allowances are present and are **structural, not shortcuts**:

- `script-src` — Next.js 16 emits the streaming RSC payload as bare inline `<script>`
  blocks with no nonce and no hash (verified in this repository's build output:
  `(self.__next_f=self.__next_f||[]).push(...)`). Removing it requires nonce propagation
  through middleware, which is the prerequisite for enforcing mode.
- `style-src` — the build emits inline `style="..."` attributes, which cannot carry a
  nonce.

`'unsafe-eval'` is deliberately **absent**. If Report-Only shows a need for it, treat
that as a finding to review rather than a directive to add.

Promotion is `CSP_ENFORCE=1`. Next resolves `headers()` at **build time** into the routes
manifest, so this is a rebuild-and-redeploy — not a runtime toggle on a live container.

`Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` were evaluated and
**deliberately not enabled**. Both can interfere with Clerk's popup and redirect sign-in
flows, and that cannot be verified without a real Clerk instance in a browser. They are
deferred to a later hardening phase rather than enabled untested.

### 8.2 `APP_CANONICAL_ORIGIN`

The chat API's cross-site check uses `Sec-Fetch-Site` as its primary signal. When a
client omits that header, the fallback compares the request `Origin` against a fixed
canonical origin.

**`APP_CANONICAL_ORIGIN` MUST be explicitly configured before public production launch.**
Set it to the exact public origin, e.g. `https://chat.ai.innovera.co.th`.

| State | Behaviour |
| --- | --- |
| Set and valid | `Origin` is compared against it. `Host` and `X-Forwarded-Host` are ignored entirely. |
| Set but unparseable, or a non-http(s) scheme | **Fails closed** — the request is refused. A typo must not silently downgrade the check. |
| Unset | Falls back to comparing `Origin` against the `Host` header. Acceptable for local and test use only. |

The fallback never reads `X-Forwarded-Host`. That header is supplied by the client and
NGINX does not set it, so comparing `Origin` against it allowed an attacker to satisfy
the check using two headers they controlled.


---

## 9. First administrator

There is **no in-app path** to create the first ADMIN — `/admin` is reachable only by an
existing ACTIVE ADMIN. The first one is promoted by direct SQL against the database.
Losing every ADMIN is recoverable only the same way, which is why the application refuses
to disable or demote the last active administrator.

---

### Rate limiting and replica count

Application rate limiting, concurrency slots and quota accounting are **per-process and
in-memory** (`src/lib/rate-limiter.ts`). That is correct for the documented
single-replica topology and nothing else.

**Scaling to more than one replica requires a shared-state rate limiter first.** With two
replicas the effective limit silently doubles and concurrency caps stop binding. Limits
also reset on every deployment, since the process restarts.

There is **no edge or IP-level rate limiting**. Every application limit keys on the
authenticated user, so it only engages after sign-in; unauthenticated request volume is
unbounded. Adding `limit_req_zone` / `limit_req` in NGINX is a **public-launch gate**,
deliberately excluded from application code.

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
- [ ] **Rollback target recorded** — the currently running image id, before deploying,
      and that image retained under a tag so image garbage collection cannot remove it.

### Public-launch gates (in addition to the above)

- [ ] **DNS** — `chat.ai.innovera.co.th` resolves to the production address at the authority.
- [ ] **TLS** — certificate issued and HTTPS validated end to end.
- [ ] **`APP_CANONICAL_ORIGIN`** configured to the public origin (§8.2).
- [ ] **CSP promoted** from `Report-Only` to enforcing after browser validation (§8.1).
- [ ] **NGINX edge/IP rate limiting** implemented and validated.
- [ ] **Clerk sign-in / sign-out** tested through the real HTTPS hostname.
- [ ] **Authenticated chat streaming** tested through the real HTTPS hostname.
- [ ] **Final port/exposure verification** — 3002 loopback only, database unpublished.

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
