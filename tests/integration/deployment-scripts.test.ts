import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, statSync } from "node:fs";
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

    const res = await runDeploy(fullEnv({ BACKUP_SCRIPT: failing }));

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/backup script failed/i);
    expect(res.stdout).not.toContain("migrations applied");
  });

  it("refuses to migrate when the backup exits 0 but produces no .verified marker", async () => {
    // Exit code alone must not be trusted — the marker is the gate.
    const hollow = path.join(work, "hollow-backup.sh");
    writeFileSync(hollow, "#!/usr/bin/env bash\nmkdir -p \"$BACKUP_DIR\"\ntouch \"$BACKUP_DIR/x.dump\"\nexit 0\n");
    await run("chmod", ["+x", hollow]);

    const res = await runDeploy(fullEnv({ BACKUP_SCRIPT: hollow }));

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no \.verified marker produced/i);
  });

  it("refuses when only a STALE verified backup exists (no new one produced)", async () => {
    const backups = path.join(work, "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(path.join(backups, "old.dump"), "archive");
    writeFileSync(path.join(backups, "old.dump.verified"), "");

    const noop = path.join(work, "noop-backup.sh");
    writeFileSync(noop, "#!/usr/bin/env bash\nexit 0\n");
    await run("chmod", ["+x", noop]);

    const res = await runDeploy(fullEnv({ BACKUP_SCRIPT: noop }));

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
