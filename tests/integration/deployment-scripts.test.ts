import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = process.cwd();
const DEPLOY = path.join(REPO, "scripts/deploy.sh");
const ROLLBACK = path.join(REPO, "scripts/rollback.sh");
const RETENTION = path.join(REPO, "scripts/backup-retention.sh");

let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(os.tmpdir(), "p3c-scripts-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Full runtime config so tests can isolate the one variable under test. */
function fullEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    ...process.env as Record<string, string>,
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/test",
    CLERK_SECRET_KEY: "synthetic-not-a-secret",
    LITELLM_API_KEY: "synthetic-not-a-secret",
    LITELLM_BASE_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
    CHAT_POSTGRES_USER: "testuser",
    CHAT_POSTGRES_DB: "testdb",
    // `true` makes every compose invocation a no-op, so these tests never touch Docker.
    DEPLOY_COMPOSE: "true",
    DEPLOY_LOCK_DIR: path.join(work, "lock"),
    BACKUP_DIR: path.join(work, "backups"),
    DEPLOY_ROLLBACK_FILE: path.join(work, "rollback-meta"),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as NodeJS.ProcessEnv;
}

async function runDeploy(env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await run("bash", [DEPLOY], { env, cwd: REPO });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("G. configuration validation gate", () => {
  it.each([
    "DATABASE_URL", "CLERK_SECRET_KEY", "LITELLM_API_KEY", "LITELLM_BASE_URL",
    "CHAT_POSTGRES_USER", "CHAT_POSTGRES_DB",
  ])(
    "refuses to deploy when %s is missing, naming it",
    async (name) => {
      const res = await runDeploy(fullEnv({ [name]: undefined }));

      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain("missing required runtime configuration");
      expect(res.stderr).toContain(name);
    }
  );

  it("refuses when the build-time Clerk key is missing", async () => {
    const res = await runDeploy(fullEnv({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined }));

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  it("never prints a configuration VALUE", async () => {
    const sentinel = "super-secret-sentinel-value";
    const res = await runDeploy(fullEnv({ CLERK_SECRET_KEY: sentinel, DATABASE_URL: undefined }));

    expect(res.stdout + res.stderr).not.toContain(sentinel);
  });

  it("stops before touching the database or backup", async () => {
    const res = await runDeploy(fullEnv({ DATABASE_URL: undefined }));
    expect(res.stdout).not.toContain("database ready");
    expect(res.stdout).not.toContain("verified backup");
  });
});

describe("fail-closed exit status", () => {
  it("propagates a failure through the EXIT trap instead of exiting 0", async () => {
    // Regression: a naive `trap 'rm -rf ...' EXIT` made the trap's last command the
    // script's status, so a failed deployment reported success.
    const res = await runDeploy(fullEnv({ DATABASE_URL: undefined }));
    expect(res.code).toBe(1);
  });

  it("releases the lock even while preserving the failure status", async () => {
    const lock = path.join(work, "lock");
    const res = await runDeploy(fullEnv({ CLERK_SECRET_KEY: undefined }));
    expect(res.code).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("M. deployment lock", () => {
  it("rejects a second deployment while one holds the lock", async () => {
    const lock = path.join(work, "lock");
    mkdirSync(lock, { recursive: true });
    // Complete metadata for a LIVE holder: this process is genuinely running.
    const boot = await run("bash", ["-c",
      'if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; ' +
      'elif sysctl -n kern.boottime >/dev/null 2>&1; then printf "%s" "$(hostname)-$(sysctl -n kern.boottime)"; ' +
      'else printf "%s" "$(hostname)-unknown-boot"; fi']).then((r) => r.stdout.trim());
    const host = await run("hostname", []).then((r) => r.stdout.trim());
    writeFileSync(path.join(lock, "pid"), String(process.pid));
    writeFileSync(path.join(lock, "boot"), boot + "\n");
    writeFileSync(path.join(lock, "host"), host + "\n");
    writeFileSync(path.join(lock, "started"), "now\n");

    const res = await runDeploy(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/another deployment is already running/i);
    expect(res.stderr).toContain(String(process.pid));
  });

  it("refuses on incomplete lock metadata rather than assuming it is stale", async () => {
    const lock = path.join(work, "lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, "pid"), "424242");   // no boot, no host

    const res = await runDeploy(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/metadata is missing or unreadable/i);
  });

  it("releases the lock when the deployment fails", async () => {
    const lock = path.join(work, "lock");
    await runDeploy(fullEnv({ DATABASE_URL: undefined }));
    expect(existsSync(lock)).toBe(false);
  });

  it("uses an atomic mkdir lock, not flock (absent on macOS)", async () => {
    const { stdout } = await run("grep", ["-c", "mkdir \"${LOCK_DIR}\"", DEPLOY]);
    expect(Number(stdout.trim())).toBeGreaterThan(0);
  });
});

describe("F. backup gate", () => {
  it("refuses to migrate when the backup script fails", async () => {
    const failing = path.join(work, "failing-backup.sh");
    writeFileSync(failing, "#!/usr/bin/env bash\necho 'simulated backup failure' >&2\nexit 1\n");
    await run("chmod", ["+x", failing]);

    const res = await runDeploy({ ...writeStubs(work).env, BACKUP_SCRIPT: failing });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/backup script failed/i);
    expect(res.stdout).not.toContain("migrations applied");
  });

  it("refuses to migrate when the backup exits 0 but produces no .verified marker", async () => {
    // Exit code alone must not be trusted — the marker is the gate.
    const hollow = path.join(work, "hollow-backup.sh");
    writeFileSync(hollow, "#!/usr/bin/env bash\nmkdir -p \"$BACKUP_DIR\"\ntouch \"$BACKUP_DIR/x.dump\"\nexit 0\n");
    await run("chmod", ["+x", hollow]);

    const res = await runDeploy({ ...writeStubs(work).env, BACKUP_SCRIPT: hollow });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no \.verified marker produced/i);
  });

  it("refuses when only a STALE verified backup exists (no new one produced)", async () => {
    const backups = path.join(work, "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(path.join(backups, "old.dump"), "archive");
    writeFileSync(path.join(backups, "old.dump.verified"), "");
    // BACKUP_DIR must stay pointed at the pre-seeded directory above.

    const noop = path.join(work, "noop-backup.sh");
    writeFileSync(noop, "#!/usr/bin/env bash\nexit 0\n");
    await run("chmod", ["+x", noop]);

    const res = await runDeploy({ ...writeStubs(work).env, BACKUP_SCRIPT: noop });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no NEW verified backup/i);
  });
});

describe("K. backup retention safety", () => {
  function seedVerified(dir: string, count: number) {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const name = path.join(dir, `innovera-chat-2026010${i % 10}T00000${i}Z.dump`);
      writeFileSync(name, `archive-${i}`);
      writeFileSync(`${name}.verified`, "");
      // Stagger mtimes so "newest" is unambiguous.
      const t = new Date(Date.now() - i * 86400_000);
      utimesSync(name, t, t);
      utimesSync(`${name}.verified`, t, t);
    }
  }

  it("keeps everything when under the retention count", async () => {
    const dir = path.join(work, "backups");
    seedVerified(dir, 5);

    await run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: dir } as NodeJS.ProcessEnv });

    expect(readdirSync(dir).filter((f) => f.endsWith(".dump"))).toHaveLength(5);
  });

  it("keeps 7 daily + 4 weekly and removes only the excess", async () => {
    const dir = path.join(work, "backups");
    seedVerified(dir, 15);

    await run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: dir } as NodeJS.ProcessEnv });

    expect(readdirSync(dir).filter((f) => f.endsWith(".dump"))).toHaveLength(11);
  });

  it("never deletes an UNVERIFIED archive", async () => {
    const dir = path.join(work, "backups");
    seedVerified(dir, 15);
    writeFileSync(path.join(dir, "brand-new-unverified.dump"), "in progress");

    await run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: dir } as NodeJS.ProcessEnv });

    expect(existsSync(path.join(dir, "brand-new-unverified.dump"))).toBe(true);
  });

  it("never deletes the newest verified archive", async () => {
    const dir = path.join(work, "backups");
    seedVerified(dir, 20);
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".dump"))
      .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;

    await run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: dir } as NodeJS.ProcessEnv });

    expect(existsSync(path.join(dir, newest))).toBe(true);
  });

  it("refuses to operate on a nonexistent directory", async () => {
    await expect(
      run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: path.join(work, "nope") } as NodeJS.ProcessEnv })
    ).rejects.toMatchObject({ code: 1 });
  });

  it("refuses to operate on / or $HOME", async () => {
    for (const bad of ["/", os.homedir()]) {
      await expect(
        run("bash", [RETENTION], { env: { ...process.env, BACKUP_DIR: bad } as NodeJS.ProcessEnv })
      ).rejects.toBeDefined();
    }
  });

  it("uses no bare wildcard rm", async () => {
    const { stdout } = await run("grep", ["-cE", String.raw`rm .*\*`, RETENTION]).catch(() => ({ stdout: "0" }));
    expect(Number(stdout.trim())).toBe(0);
  });
});

async function runRollback(env: NodeJS.ProcessEnv, args: string[] = []) {
  try {
    const { stdout, stderr } = await run("bash", [ROLLBACK, ...args], { env, cwd: REPO });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("C. rollback metadata fails closed", () => {
  it("refuses when no metadata file exists and no image is given", async () => {
    const res = await runRollback(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no rollback metadata/i);
    expect(res.stderr).toMatch(/refusing to guess/i);
  });

  it("refuses when the metadata is malformed", async () => {
    writeFileSync(path.join(work, "rollback-meta"), "garbage without the expected field\n");

    const res = await runRollback(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/malformed/i);
  });

  it("refuses explicitly when no previous application existed", async () => {
    writeFileSync(path.join(work, "rollback-meta"), "image_id=none\nrecorded_at=x\n");

    const res = await runRollback(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/NO application rollback target/i);
    expect(res.stderr).toMatch(/nothing to roll back to/i);
  });

  it("refuses a recorded target that is a MUTABLE tag rather than a digest", async () => {
    // The whole point of the digest: a tag can be moved onto the broken image.
    writeFileSync(path.join(work, "rollback-meta"), "image_id=innovera-chat-runner:latest\n");

    const res = await runRollback(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not an immutable image ID/i);
  });

  it("refuses when the recorded image is absent from the local store", async () => {
    writeFileSync(
      path.join(work, "rollback-meta"),
      "image_id=sha256:0000000000000000000000000000000000000000000000000000000000000000\n"
    );

    const res = await runRollback(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not present in the local image store/i);
  });
});

describe("G. stale deployment lock", () => {
  function makeLock(fields: Record<string, string>) {
    const lock = path.join(work, "lock");
    mkdirSync(lock, { recursive: true });
    for (const [k, v] of Object.entries(fields)) writeFileSync(path.join(lock, k), v + "\n");
    return lock;
  }

  async function currentBoot() {
    const { stdout } = await run("bash", ["-c",
      'if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; ' +
      'elif sysctl -n kern.boottime >/dev/null 2>&1; then printf "%s" "$(hostname)-$(sysctl -n kern.boottime)"; ' +
      'else printf "%s" "$(hostname)-unknown-boot"; fi']);
    return stdout.trim();
  }
  async function hostname() {
    const { stdout } = await run("hostname", []);
    return stdout.trim();
  }

  it("refuses while the holder process is genuinely alive", async () => {
    makeLock({ pid: String(process.pid), boot: await currentBoot(), host: await hostname(), started: "now" });

    const res = await runDeploy(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/another deployment is already running/i);
    // Critical: a refused deployment must NOT delete a lock it does not own. The EXIT
    // trap is armed only after successful acquisition.
    expect(existsSync(path.join(work, "lock"))).toBe(true);
  });

  it("recovers a lock whose holder PID no longer exists (SIGKILL case)", async () => {
    // PID 2^22-ish is beyond any live process on these systems.
    makeLock({ pid: "4194301", boot: await currentBoot(), host: await hostname(), started: "earlier" });

    const res = await runDeploy(fullEnv({ DATABASE_URL: undefined }));

    // It proceeds past the lock (and then fails on config, as expected).
    expect(res.stderr).toMatch(/recovering a stale lock/i);
    expect(res.stderr).toMatch(/no longer running/i);
    expect(res.stderr).toMatch(/missing required runtime configuration/i);
  });

  it("recovers a lock taken before the current boot (reboot case)", async () => {
    makeLock({ pid: String(process.pid), boot: "boot-id-from-a-previous-boot", host: await hostname(), started: "before reboot" });

    const res = await runDeploy(fullEnv({ DATABASE_URL: undefined }));

    expect(res.stderr).toMatch(/recovering a stale lock/i);
    expect(res.stderr).toMatch(/before the current boot/i);
  });

  it("NEVER silently deletes a lock with missing metadata", async () => {
    const lock = makeLock({ started: "no pid, no boot" });

    const res = await runDeploy(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/metadata is missing or unreadable/i);
    expect(res.stderr).toMatch(/refusing to guess/i);
    // The lock must survive: we could not establish that it is stale.
    expect(existsSync(lock)).toBe(true);
  });

  it("refuses to recover a lock taken on a different host", async () => {
    makeLock({ pid: "4194301", boot: await currentBoot(), host: "some-other-machine", started: "x" });

    const res = await runDeploy(fullEnv());

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/another machine/i);
  });

  it("does not use age as evidence of staleness", async () => {
    // Staleness must be established from the holder's identity, never from elapsed time.
    const { stdout } = await run("grep", [
      "-ciE", String.raw`-mmin|-mtime|older[ _-]than|stale.*(seconds|minutes|hours)|LOCK_TIMEOUT`, DEPLOY,
    ]).catch(() => ({ stdout: "0" }));
    expect(Number(stdout.trim())).toBe(0);
  });
});


/**
 * Stub `docker` and `docker compose` so these tests never touch a daemon.
 *
 * The docker stub answers `inspect --format ...` from fixture env vars, matching on the
 * FORMAT STRING rather than argument position, because deploy.sh calls inspect both ways
 * (`inspect <id> --format <fmt>` and `inspect --format <fmt> <id>`).
 */
function writeStubs(
  work: string,
  opts: {
    dbId?: string;          // "" => no database container exists
    appId?: string;         // "" => no application container (first deployment)
    running?: string;
    health?: string;
    mount?: string;
    ports?: string;
    networks?: string;
    pgReadyRc?: number;
    psqlRc?: number;
    tagRc?: number;
  } = {}
) {
  const o = {
    dbId: "db-container-id",
    appId: "",
    running: "true",
    health: "healthy",
    mount: "volume:innovera-chat_chat_postgres_data",
    ports: "",
    networks: "innovera-chat_default ",
    pgReadyRc: 0,
    psqlRc: 0,
    tagRc: 0,
    ...opts,
  };

  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = path.join(work, "docker-calls");

  writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> "${calls}"`,
      'cmd="$1"; shift',
      'fmt=""; for a in "$@"; do case "$a" in *"{{"*) fmt="$a";; esac; done',
      'case "$cmd" in',
      "  inspect)",
      '    case "$fmt" in',
      `      *State.Running*)  printf '%s\\n' "\${FIX_RUNNING}";;`,
      `      *State.Health*)   printf '%s\\n' "\${FIX_HEALTH}";;`,
      `      *Destination*)    printf '%s\\n' "\${FIX_MOUNT}";;`,
      `      *PortBindings*)   printf '%s\\n' "\${FIX_PORTS}";;`,
      `      *Networks*)       printf '%s\\n' "\${FIX_NETWORKS}";;`,
      `      *State.Status*)   printf '%s\\n' "exited";;`,
      "      *.Image*)         echo 'sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';;",
      "      *) echo '';;",
      "    esac",
      "    ;;",
      '  exec)',
      '    for a in "$@"; do',
      '      case "$a" in',
      `        pg_isready) exit \${FIX_PGREADY};;`,
      `        psql)       exit \${FIX_PSQL};;`,
      "      esac",
      "    done",
      "    exit 0;;",
      `  tag)   exit \${FIX_TAGRC};;`,
      "  image) exit 0;;",
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );

  const compose = path.join(work, "compose-stub");
  writeFileSync(
    compose,
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> "${path.join(work, "compose-calls")}"`,
      'args="$*"',
      'case "$args" in',
      `  *"ps -aq chat-db"*) [ -n "\${FIX_DB_ID}" ] && echo "\${FIX_DB_ID}"; exit 0;;`,
      `  *"ps -q chat-app"*) [ -n "\${FIX_APP_ID}" ] && echo "\${FIX_APP_ID}"; exit 0;;`,
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );

  const backup = path.join(work, "backup-stub");
  writeFileSync(
    backup,
    [
      "#!/usr/bin/env bash",
      'mkdir -p "${BACKUP_DIR}"',
      'printf archive > "${BACKUP_DIR}/stub.dump"',
      // The real backup.sh writes a manifest declaring scope, and deploy.sh refuses to
      // migrate without one. The stub models that, or it would be testing a contract
      // the production script no longer has.
      'printf "backup_scope=complete\\n" > "${BACKUP_DIR}/stub.manifest"',
      'touch "${BACKUP_DIR}/stub.dump.verified"',
    ].join("\n"),
    { mode: 0o755 }
  );

  const env = fullEnv({
    PATH: `${bin}:${process.env.PATH}`,
    DEPLOY_COMPOSE: compose,
    BACKUP_SCRIPT: backup,
    DEPLOY_LIVE_TIMEOUT: "1",
    DEPLOY_APP_URL: "http://127.0.0.1:1",
    FIX_DB_ID: o.dbId,
    FIX_APP_ID: o.appId,
    FIX_RUNNING: o.running,
    FIX_HEALTH: o.health,
    FIX_MOUNT: o.mount,
    FIX_PORTS: o.ports,
    FIX_NETWORKS: o.networks,
    FIX_PGREADY: String(o.pgReadyRc),
    FIX_PSQL: String(o.psqlRc),
    FIX_TAGRC: String(o.tagRc),
  });

  return { env, calls, composeCalls: path.join(work, "compose-calls") };
}

function readCalls(f: string) {
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

describe("database validation — a normal deploy never creates or restarts the database", () => {
  // The production defect this guards: `docker compose up -d chat-db` CONVERGES, so a
  // changed service definition recreated the live PostgreSQL container as a side effect
  // of deploying the application.

  it("A. existing healthy database: never runs compose up/run against it, and continues", async () => {
    const { env, composeCalls } = writeStubs(work);
    const res = await runDeploy(env);

    const compose = readCalls(composeCalls);
    // The ONLY compose verb allowed against chat-db is the read-only `ps`.
    expect(compose).toMatch(/ps -aq chat-db/);
    expect(compose).not.toMatch(/up .*chat-db/);
    expect(compose).not.toMatch(/restart .*chat-db/);
    expect(compose).not.toMatch(/start .*chat-db/);
    // and it got past step 2
    expect(res.stdout).toMatch(/database validated in place/);
    expect(res.stdout).toMatch(/not started, not restarted, not recreated/);
  });

  it("B. existing STOPPED database: fails closed and never starts it", async () => {
    const { env, composeCalls } = writeStubs(work, { running: "false" });
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/exists but is not running/i);
    expect(res.stderr).toMatch(/will NOT start it/i);
    expect(readCalls(composeCalls)).not.toMatch(/up .*chat-db/);
    expect(res.stdout).not.toMatch(/3\/9 verified backup/);
  });

  it("C. existing UNHEALTHY database: fails closed", async () => {
    const { env, composeCalls } = writeStubs(work, { health: "unhealthy" });
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/reports health 'unhealthy'/i);
    expect(readCalls(composeCalls)).not.toMatch(/up .*chat-db/);
  });

  it("D. database ABSENT: normal deploy fails closed and creates no empty database", async () => {
    const { env, composeCalls } = writeStubs(work, { dbId: "" });
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no chat-db container exists/i);
    expect(res.stderr).toMatch(/bootstrap-db\.sh/);
    // the whole point: nothing was created
    expect(readCalls(composeCalls)).not.toMatch(/up .*chat-db/);
  });

  it("E. wrong named volume: fails closed", async () => {
    const { env } = writeStubs(work, { mount: "volume:some-other-volume" });
    env.DEPLOY_DB_VOLUME = "innovera-chat_chat_postgres_data";
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not the expected 'innovera-chat_chat_postgres_data'/);
  });

  it("E2. missing or anonymous data mount: fails closed", async () => {
    const missing = await runDeploy(writeStubs(work, { mount: "" }).env);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/no mount at \/var\/lib\/postgresql\/data/i);

    rmSync(work, { recursive: true, force: true });
    work = mkdtempSync(path.join(os.tmpdir(), "p3c-scripts-"));
    const bind = await runDeploy(writeStubs(work, { mount: "bind:" }).env);
    expect(bind.code).not.toBe(0);
    expect(bind.stderr).toMatch(/not a named volume/i);
  });

  it("F. database publishing a host port: fails closed", async () => {
    const { env } = writeStubs(work, { ports: "5432/tcp " });
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/publishes host port/i);
  });

  it("G. database attached to the shared AI network: fails closed", async () => {
    const { env } = writeStubs(work, {
      networks: "innovera-chat_default innovera_default ",
    });
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/attached to the shared AI network/i);
  });

  it("G2. database missing the expected private network: fails closed", async () => {
    const { env } = writeStubs(work, { networks: "some-other-net " });
    env.DEPLOY_DB_NETWORK = "innovera-chat_default";
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not attached to the expected private network/i);
  });

  it("H. healthy database with readiness succeeding: step 2 passes", async () => {
    const { env } = writeStubs(work);
    const res = await runDeploy(env);

    expect(res.stdout).toMatch(/2\/9 database validation/);
    expect(res.stdout).toMatch(/database validated in place/);
    expect(res.stdout).toMatch(/3\/9 verified backup/);
  });

  it("readiness failure does not trigger a restart", async () => {
    const { env, composeCalls } = writeStubs(work, { pgReadyRc: 1 });
    env.DEPLOY_DB_READY_ATTEMPTS = "1";
    const res = await runDeploy(env);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/did not report ready/i);
    expect(res.stderr).toMatch(/NOT restarted or recreated/i);
    expect(readCalls(composeCalls)).not.toMatch(/up .*chat-db/);
  });

  it("migrator and app replacement use --no-deps so compose cannot converge chat-db", async () => {
    // Without --no-deps, `compose run`/`up` start depends_on services, which would
    // recreate the database at step 6 or 7 instead of step 2 — same bug, later.
    const deploy = readFileSync(DEPLOY, "utf8");
    const runLine = deploy.split("\n").find((l) => l.includes("run --rm") && !l.trim().startsWith("#"));
    const upLine = deploy.split("\n").find((l) => l.includes("up -d") && l.includes("chat-app") && !l.trim().startsWith("#"));
    expect(runLine).toContain("--no-deps");
    expect(upLine).toContain("--no-deps");

    const rollback = readFileSync(ROLLBACK, "utf8");
    const rbLine = rollback.split("\n").find((l) => l.includes("up -d") && !l.trim().startsWith("#"));
    expect(rbLine).toContain("--no-deps");
  });

  it("deploy.sh contains no executable `compose up` against chat-db", async () => {
    const code = readFileSync(DEPLOY, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/up -d chat-db/);
  });
});

describe("explicit database bootstrap", () => {
  const BOOTSTRAP = path.join(REPO, "scripts/bootstrap-db.sh");

  it("refuses to adopt, restart or repair an existing database", async () => {
    const { env } = writeStubs(work, { dbId: "already-here" });
    try {
      await run("bash", [BOOTSTRAP], { env, cwd: REPO });
      throw new Error("expected bootstrap to fail");
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      expect(err.code).not.toBe(0);
      expect(err.stderr).toMatch(/already exists/i);
      expect(err.stderr).toMatch(/will not adopt, restart, or repair/i);
    }
  });

  it("creates the database only when none exists", async () => {
    const { env, composeCalls } = writeStubs(work, { dbId: "" });
    // compose stub reports nothing on the first `ps`, so bootstrap proceeds to `up`.
    await run("bash", [BOOTSTRAP], { env, cwd: REPO }).catch(() => undefined);
    expect(readCalls(composeCalls)).toMatch(/up -d chat-db/);
  });

  it("never runs migrations or restores data", async () => {
    const src = readFileSync(BOOTSTRAP, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(src).not.toMatch(/prisma|migrate deploy|pg_restore|DROP DATABASE/);
  });
});

describe("rollback target retention", () => {
  // Recording the digest is not enough on its own. The step-5 build moves the release tag
  // onto the NEW image, leaving the previous one untagged; once its container is replaced
  // nothing references it and the runtime's image GC may delete it. Rollback then fails
  // closed — correct, but unable to restore service. deploy.sh therefore also retains the
  // image under a tag. These tests stub docker and compose so they never touch a daemon.
  // Delegates to the shared stub builder so these tests exercise the SAME step-2
  // database validation the deployment now performs.
  function stubs(tagSucceeds: boolean) {
    return writeStubs(work, {
      appId: "fake-container-id",
      tagRc: tagSucceeds ? 0 : 1,
    }).env;
  }

  it("retains the previous image under a tag and records it", async () => {
    const env = stubs(true);
    await runDeploy(env);

    const meta = readFileSync(path.join(work, "rollback-meta"), "utf8");
    expect(meta).toMatch(/^image_id=sha256:[0-9a-f]{64}$/m);
    expect(meta).toMatch(/^retained_tag=.+$/m);
  });

  it("honours DEPLOY_ROLLBACK_TAG", async () => {
    const env = stubs(true);
    env.DEPLOY_ROLLBACK_TAG = "innovera-chat-runner:custom-retention";
    await runDeploy(env);

    const meta = readFileSync(path.join(work, "rollback-meta"), "utf8");
    expect(meta).toContain("retained_tag=innovera-chat-runner:custom-retention");
  });

  it("refuses to deploy when the previous image cannot be retained", async () => {
    // Failing closed matters: continuing would replace the application while leaving a
    // rollback target that image GC is free to delete.
    const res = await runDeploy(stubs(false));

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/could not retain the previous image/i);
    expect(res.stdout).not.toMatch(/5\/9 build images/);
  });

  it("invents no rollback target — and retains nothing — on a first deployment", async () => {
    // With a healthy database but NO application container there is no previous release.
    // Retention must not run at all: tagging something arbitrary here would manufacture a
    // rollback target pointing at the wrong revision.
    const { env, calls } = writeStubs(work, { appId: "" });

    await runDeploy(env);

    const meta = readFileSync(path.join(work, "rollback-meta"), "utf8");
    expect(meta).toContain("image_id=none");
    expect(meta).not.toMatch(/retained_tag=/);
    expect(readCalls(calls)).not.toMatch(/^tag /m);
  });

  it("resolves rollback through the digest, never the retention tag", async () => {
    // The tag is a lifetime anchor only. rollback.sh must still reject a tag as a target.
    const rollback = readFileSync(ROLLBACK, "utf8");
    expect(rollback).toMatch(/not an immutable image ID/);
    expect(rollback).not.toMatch(/rollback-previous/);
  });
});

describe("M1 file volume does not weaken the Phase 3E database guards", () => {
  const compose = () => readFileSync(path.join(REPO, "docker-compose.yml"), "utf8");

  /** The body of one compose service, up to the next top-level service or key. */
  function serviceBlock(name: string): string {
    const src = compose();
    const start = src.indexOf(`  ${name}:`);
    if (start < 0) throw new Error(`no service ${name}`);
    const rest = src.slice(start + 1);
    const nextIdx = rest.search(/\n {2}[a-z-]+:\n|\nvolumes:|\nnetworks:/);
    return rest.slice(0, nextIdx < 0 ? undefined : nextIdx);
  }

  it("mounts the file volume on chat-app", () => {
    expect(serviceBlock("chat-app")).toContain("chat_file_storage:/data/files");
  });

  it("does NOT mount the file volume on chat-db", () => {
    // Sharing the volume would put the database and the blobs in one failure domain,
    // and a compromise of either would reach the other.
    expect(serviceBlock("chat-db")).not.toContain("chat_file_storage");
  });

  it("leaves chat-db's data volume untouched", () => {
    expect(serviceBlock("chat-db")).toContain("chat_postgres_data:/var/lib/postgresql/data");
  });

  it("declares the file volume at the top level", () => {
    expect(compose()).toMatch(/^volumes:[\s\S]*chat_file_storage:/m);
  });

  it("still validates the database read-only, with no start or restart", () => {
    // The Phase 3E contract. Adding a volume must not have reintroduced convergence.
    const deploy = readFileSync(DEPLOY, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");

    expect(deploy).not.toMatch(/up -d chat-db/);
    expect(deploy).toMatch(/ps -aq chat-db/);
    expect(deploy).toContain("database validated in place");
  });

  it("still passes --no-deps everywhere compose could converge chat-db", () => {
    const deploy = readFileSync(DEPLOY, "utf8").split("\n").filter((l) => !l.trim().startsWith("#"));

    const runLine = deploy.find((l) => l.includes("run --rm"));
    const upLine = deploy.find((l) => l.includes("up -d") && l.includes("chat-app"));

    expect(runLine).toContain("--no-deps");
    expect(upLine).toContain("--no-deps");
  });

  it("still guards the database volume and network identity", () => {
    const deploy = readFileSync(DEPLOY, "utf8");

    expect(deploy).toContain("DEPLOY_DB_VOLUME");
    expect(deploy).toContain("DEPLOY_DB_NETWORK");
    expect(deploy).toMatch(/publishes host port/);
    expect(deploy).toMatch(/shared AI network/);
  });

  it("creates the mount point owned by the runtime user in the image", () => {
    // Docker seeds an empty named volume from the image path INCLUDING ownership. If the
    // directory is not created as node, the volume is root-owned and uid 1000 cannot
    // write — a failure that appears only in production, never in a dev run.
    const dockerfile = readFileSync(path.join(REPO, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/mkdir -p \/data\/files && chown node:node \/data\/files/);
    expect(dockerfile.indexOf("chown node:node /data/files")).toBeLessThan(
      dockerfile.indexOf("USER node")
    );
  });
});

describe("a production deployment cannot use a database-only backup", () => {
  /**
   * Once file storage holds data, a PostgreSQL dump alone restores File rows with no
   * bytes behind them — a backup that reports success and has silently lost every
   * upload. These tests prove the deployment refuses that combination before migrating.
   */
  // Reuses the shared stub builder so docker/compose behave exactly as they do for the
  // other deployment tests; only the backup-mode variables differ.
  const stubbedDeployEnv = (overrides: Record<string, string> = {}) => ({
    ...writeStubs(work, { appId: "fake-container-id" }).env,
    ...overrides,
  });

  it("REFUSES when BACKUP_FILES=0", async () => {
    const res = await runDeploy(stubbedDeployEnv({ BACKUP_FILES: "0" }));

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/cannot use a database-only backup/i);
    // Refused before the backup step even runs.
    expect(res.stdout).not.toMatch(/3\/9 verified backup/);
  });

  it("REFUSES when BACKUP_ALLOW_DB_ONLY is set, even with BACKUP_FILES=1", async () => {
    // The legacy escape hatch must not be reachable from a deployment by any route.
    const res = await runDeploy(
      stubbedDeployEnv({ BACKUP_FILES: "1", BACKUP_ALLOW_DB_ONLY: "1" })
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/cannot use a database-only backup/i);
  });

  it("names both variables in the refusal so the cause is unambiguous", async () => {
    const res = await runDeploy(stubbedDeployEnv({ BACKUP_FILES: "0" }));

    expect(res.stderr).toContain("BACKUP_FILES=0");
    expect(res.stderr).toMatch(/BACKUP_ALLOW_DB_ONLY/);
    expect(res.stderr).toMatch(/not be recoverable/i);
  });

  it("requires the backup manifest to declare scope=complete", async () => {
    // Even with the flags unset, the deployment verifies what the backup actually
    // produced rather than trusting the .verified marker alone.
    const deploy = readFileSync(DEPLOY, "utf8");

    expect(deploy).toContain("backup_scope=");
    expect(deploy).toMatch(/scope.*!=.*"complete"/);
    expect(deploy).toMatch(/Refusing to migrate/);
  });
});

describe("backup.sh requires two flags to skip file capture", () => {
  it("refuses BACKUP_FILES=0 without the acknowledgement flag", async () => {
    const backup = path.join(REPO, "scripts/backup.sh");

    try {
      await run("bash", [backup], {
        env: fullEnv({
          BACKUP_FILES: "0",
          BACKUP_DIR: path.join(work, "backups"),
          CHAT_POSTGRES_USER: "nobody",
          CHAT_POSTGRES_DB: "nothing",
          BACKUP_EXEC: "true",
        }),
        cwd: REPO,
      });
      throw new Error("expected refusal");
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      expect(err.code).not.toBe(0);
      expect(err.stderr).toMatch(/requires BACKUP_ALLOW_DB_ONLY=1/);
    }
  });

  it("explains what a database-only backup does not protect", () => {
    const backup = readFileSync(path.join(REPO, "scripts/backup.sh"), "utf8");
    expect(backup).toMatch(/does NOT restore uploaded files/);
  });
});
