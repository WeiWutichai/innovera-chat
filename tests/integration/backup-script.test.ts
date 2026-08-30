import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, inject } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { withAdminConnection } from "../setup/admin-sql";

const run = promisify(execFile);

/**
 * Exercises scripts/backup.sh against the ISOLATED test database only.
 *
 * BACKUP_EXEC="" makes the script invoke pg_* binaries directly instead of going through
 * `docker compose exec`, which is how it runs in production. Failure paths are driven by
 * placing stub binaries earlier on PATH — that tests the script's real control flow
 * rather than a reimplementation of it.
 */
const databaseUrl = inject("databaseUrl");
const adminUrl = inject("adminUrl");
const SCRIPT = path.join(process.cwd(), "scripts/backup.sh");

let pgEnv: Record<string, string>;
let backupDir: string;
let stubDir: string;

beforeAll(() => {
  const url = new URL(databaseUrl);
  pgEnv = {
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGPASSWORD: decodeURIComponent(url.password),
    CHAT_POSTGRES_USER: decodeURIComponent(url.username),
    CHAT_POSTGRES_DB: url.pathname.replace(/^\//, ""),
    BACKUP_EXEC: "",
    // This suite exercises the POSTGRESQL half of the backup. File-storage capture
    // needs a running chat-app container to tar the volume from, which does not exist
    // here; the file half has its own suite in backup-file-storage.test.ts, including
    // the fail-closed path. Disabling it explicitly keeps these tests testing what they
    // were written to test.
    BACKUP_FILES: "0",
    // Skipping file capture now requires an explicit acknowledgement that the
    // result is INCOMPLETE. A normal deployment refuses this path entirely.
    BACKUP_ALLOW_DB_ONLY: "1",
  };
});

beforeEach(() => {
  backupDir = mkdtempSync(path.join(os.tmpdir(), "innovera-backup-test-"));
  stubDir = mkdtempSync(path.join(os.tmpdir(), "innovera-stub-bin-"));
});

afterEach(() => {
  // The suite must leave no archives or stub binaries behind.
  rmSync(backupDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

afterAll(async () => {
  // Any restore-check database a failing run might have left behind.
  await withAdminConnection(adminUrl, async (client) => {
    const rows = await client.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'restore_check_%'`
    );
    for (const row of rows) {
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
    }
  });
});

function stub(name: string, body: string) {
  const file = path.join(stubDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

async function runBackup(extraEnv: Record<string, string> = {}) {
  const env = {
    ...process.env,
    ...pgEnv,
    BACKUP_DIR: backupDir,
    ...extraEnv,
  } as NodeJS.ProcessEnv;

  try {
    const { stdout } = await run("bash", [SCRIPT], { env });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const files = () => readdirSync(backupDir);
const finals = () => files().filter((f) => f.endsWith(".dump"));
const temps = () => files().filter((f) => f.startsWith(".in-progress"));
const verified = () => files().filter((f) => f.endsWith(".verified"));

async function leftoverCheckDatabases() {
  return withAdminConnection(adminUrl, (client) =>
    client.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'restore_check_%'`
    )
  );
}

describe("successful backup", () => {
  it("produces a verified archive and cleans up", async () => {
    const result = await runBackup();

    expect(result.code).toBe(0);
    expect(finals()).toHaveLength(1);
    expect(verified()).toHaveLength(1);
    expect(temps()).toHaveLength(0);
    await expect(leftoverCheckDatabases()).resolves.toHaveLength(0);
  }, 120_000);

  it("writes a custom-format archive, not a gzip stream", async () => {
    await runBackup();
    const { stdout } = await run("file", [path.join(backupDir, finals()[0])]);

    expect(stdout.toLowerCase()).not.toContain("gzip");
  }, 120_000);
});

describe("failure paths fail closed", () => {
  it("fails when pg_dump returns non-zero, leaving no archive", async () => {
    stub("pg_dump", 'echo "simulated pg_dump failure" >&2; exit 1');
    const result = await runBackup({ PATH: `${stubDir}:${process.env.PATH}` });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("BACKUP FAILED");
    expect(finals()).toHaveLength(0);
    expect(temps()).toHaveLength(0);
    expect(verified()).toHaveLength(0);
  }, 120_000);

  it("fails when pg_dump exits 0 but writes an unreadable archive", async () => {
    stub("pg_dump", 'echo "this is not a pg_dump archive"; exit 0');
    const result = await runBackup({ PATH: `${stubDir}:${process.env.PATH}` });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not a readable pg_dump/i);
    // The archive never acquires the real name.
    expect(finals()).toHaveLength(0);
    expect(temps()).toHaveLength(0);
  }, 120_000);

  it("fails when the restore into the check database fails", async () => {
    stub(
      "pg_restore",
      `if [[ " $* " == *" --list "* ]]; then exec "$REAL_PG_RESTORE" "$@"; fi
       echo "simulated restore failure" >&2; exit 1`
    );
    const result = await runBackup({
      PATH: `${stubDir}:${process.env.PATH}`,
      REAL_PG_RESTORE: (await run("which", ["pg_restore"])).stdout.trim(),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/pg_restore into the restore-check database failed/i);
    expect(verified()).toHaveLength(0);
  }, 120_000);

  it("fails when the restore produces no application tables", async () => {
    // pg_restore reports success but restores nothing: structural verification must
    // still refuse to mark the archive verified.
    stub(
      "pg_restore",
      `if [[ " $* " == *" --list "* ]]; then exec "$REAL_PG_RESTORE" "$@"; fi
       exit 0`
    );
    const result = await runBackup({
      PATH: `${stubDir}:${process.env.PATH}`,
      REAL_PG_RESTORE: (await run("which", ["pg_restore"])).stdout.trim(),
    });

    expect(result.code).not.toBe(0);
    // The restore produced no tables while the source has four: the structural
    // comparison must reject it and name both sets.
    expect(result.stderr).toMatch(/restored table set differs from the source/i);
    expect(result.stderr).toMatch(/User/);
    expect(verified()).toHaveLength(0);
  }, 120_000);

  it("drops the restore-check database even when a later step fails", async () => {
    stub(
      "pg_restore",
      `if [[ " $* " == *" --list "* ]]; then exec "$REAL_PG_RESTORE" "$@"; fi
       exit 1`
    );
    await runBackup({
      PATH: `${stubDir}:${process.env.PATH}`,
      REAL_PG_RESTORE: (await run("which", ["pg_restore"])).stdout.trim(),
    });

    await expect(leftoverCheckDatabases()).resolves.toHaveLength(0);
  }, 120_000);
});

describe("live writes during a backup", () => {
  it("still verifies when the source is written to after the dump", async () => {
    // The application stays writable during a backup. A dump capturing N rows is valid
    // even though the live table already holds N+1 by the time verification runs.
    // Comparing restored counts against the moving source would fail a correct backup.
    stub(
      "pg_dump",
      `"$REAL_PG_DUMP" "$@"
       status=$?
       "$REAL_PSQL" -U "$CHAT_POSTGRES_USER" -d "$CHAT_POSTGRES_DB" -c \
         'INSERT INTO "User" (id, "clerkUserId", email, "updatedAt")
          VALUES ('"'"'race-user'"'"', '"'"'ck_race'"'"', '"'"'race@test.local'"'"', now())' \
         >/dev/null 2>&1
       exit $status`
    );

    const result = await runBackup({
      PATH: `${stubDir}:${process.env.PATH}`,
      REAL_PG_DUMP: (await run("which", ["pg_dump"])).stdout.trim(),
      REAL_PSQL: (await run("which", ["psql"])).stdout.trim(),
    });

    expect(result.code).toBe(0);
    expect(verified()).toHaveLength(1);
  }, 120_000);

  it("records restored counts for audit without comparing them to the source", async () => {
    await runBackup();

    const counts = files().filter((f) => f.endsWith(".counts"));
    expect(counts).toHaveLength(1);

    const body = readFileSync(path.join(backupDir, counts[0]), "utf8");
    expect(body).toContain("User");
    expect(body).toContain("Conversation");
    expect(body).toContain("Message");
    expect(body).toContain("Usage");
  }, 120_000);

  it("never claims equality with the live database", async () => {
    // Behaviour, not prose: comments are stripped first. The script's commentary
    // legitimately uses "mismatched" when describing correlated backup halves, which
    // has nothing to do with comparing row counts against a moving source.
    const code = readFileSync(path.join(process.cwd(), "scripts/backup.sh"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(code.toLowerCase()).not.toContain("mismatch");
  });
});

describe("safety", () => {
  it("refuses to run without required configuration", async () => {
    const env = { ...process.env, ...pgEnv, BACKUP_DIR: backupDir } as NodeJS.ProcessEnv;
    delete env.CHAT_POSTGRES_DB;

    await expect(run("bash", [SCRIPT], { env })).rejects.toMatchObject({ code: 1 });
  }, 60_000);

  it("hard-codes no credentials", async () => {
    const { stdout } = await run("grep", ["-cE", "password|PGPASSWORD=|postgres://", SCRIPT])
      .catch(() => ({ stdout: "0" }));

    expect(Number(stdout.trim())).toBe(0);
  });
});
