import { describe, it, expect, beforeAll, beforeEach, afterEach, inject } from "vitest";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { withAdminConnection } from "../setup/admin-sql";

const run = promisify(execFile);

/**
 * Exercises the M1 backup extension against the ISOLATED test database only.
 *
 * BACKUP_EXEC="" runs pg_* directly rather than through `docker compose exec`.
 * BACKUP_FILES_EXEC is set to a stub that tars a local directory, standing in for
 * `docker compose exec chat-app` — the script's real control flow is exercised, only the
 * transport is substituted.
 */
const databaseUrl = inject("databaseUrl");
const BACKUP = path.join(process.cwd(), "scripts/backup.sh");
const REHEARSAL = path.join(process.cwd(), "scripts/restore-rehearsal.sh");

let pgEnv: Record<string, string>;
let backupDir: string;
let filesDir: string;
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
  };
});

beforeEach(() => {
  backupDir = mkdtempSync(path.join(os.tmpdir(), "m1-backup-"));
  filesDir = mkdtempSync(path.join(os.tmpdir(), "m1-files-"));
  stubDir = mkdtempSync(path.join(os.tmpdir(), "m1-stub-"));
});

afterEach(() => {
  for (const d of [backupDir, filesDir, stubDir]) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Stands in for `docker compose exec -T chat-app`. The script appends `tar -czf - -C
 * <root> .`, so the stub simply executes that against the local files directory.
 */
function fileExecStub(): string {
  const p = path.join(stubDir, "files-exec");
  writeFileSync(p, ["#!/usr/bin/env bash", 'exec "$@"'].join("\n"), { mode: 0o755 });
  return p;
}

/** A stub that always fails, to drive the fail-closed path. */
function failingFileExec(): string {
  const p = path.join(stubDir, "failing-exec");
  writeFileSync(p, ["#!/usr/bin/env bash", "exit 1"].join("\n"), { mode: 0o755 });
  return p;
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...(process.env as Record<string, string>),
    ...pgEnv,
    BACKUP_DIR: backupDir,
    BACKUP_FILES_ROOT: filesDir,
    BACKUP_FILES_EXEC: fileExecStub(),
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

async function backup(overrides: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run("bash", [BACKUP], { env: env(overrides) });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * Runs maintenance SQL against the isolated test database. withAdminConnection takes the
 * URL first and yields a PrismaClient, so raw statements go through $executeRawUnsafe.
 */
async function sqlExec(statements: string[]) {
  await withAdminConnection(databaseUrl, async (client) => {
    for (const statement of statements) {
      await client.$executeRawUnsafe(statement);
    }
  });
}

function seedBlobs(entries: Array<{ key: string; content: string }>) {
  for (const { key, content } of entries) {
    const full = path.join(filesDir, key);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function manifestFor(id: string): Record<string, string> {
  const raw = readFileSync(path.join(backupDir, `innovera-chat-${id}.manifest`), "utf8");
  return Object.fromEntries(
    raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      })
  );
}

/** Backup id from the archive path the script prints on success. */
function backupIdFrom(stdout: string): string {
  const match = stdout.trim().split("\n").pop()!.match(/innovera-chat-(\w+)\.dump$/);
  if (!match) throw new Error(`no archive path in output: ${stdout}`);
  return match[1];
}

describe("file storage is captured alongside the database", () => {
  it("produces a database archive, a file archive and a manifest", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "blob one" }]);

    const res = await backup();
    expect(res.code).toBe(0);

    const id = backupIdFrom(res.stdout);

    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.dump`))).toBe(true);
    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.files.tar.gz`))).toBe(true);
    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.manifest`))).toBe(true);
    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.dump.verified`))).toBe(true);
  });

  it("correlates both halves under one backup id", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);

    const id = backupIdFrom((await backup()).stdout);
    const m = manifestFor(id);

    expect(m.backup_id).toBe(id);
    expect(m.database_archive).toBe(`innovera-chat-${id}.dump`);
    expect(m.files_archive).toBe(`innovera-chat-${id}.files.tar.gz`);
    expect(m.files_enabled).toBe("1");
  });

  it("records a SHA-256 for each artefact that matches the file on disk", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "checksum me" }]);

    const id = backupIdFrom((await backup()).stdout);
    const m = manifestFor(id);

    const sha = (p: string) =>
      createHash("sha256").update(readFileSync(p)).digest("hex");

    expect(m.database_sha256).toBe(sha(path.join(backupDir, m.database_archive)));
    expect(m.files_sha256).toBe(sha(path.join(backupDir, m.files_archive)));
  });

  it("counts the archived objects", async () => {
    seedBlobs([
      { key: "user1/aaaa", content: "1" },
      { key: "user1/bbbb", content: "2" },
      { key: "user2/cccc", content: "3" },
    ]);

    const m = manifestFor(backupIdFrom((await backup()).stdout));
    expect(Number(m.files_object_count)).toBe(3);
  });

  it("archives paths relative to the storage root, never absolute", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);

    const id = backupIdFrom((await backup()).stdout);
    const { stdout } = await run("tar", [
      "-tzf",
      path.join(backupDir, `innovera-chat-${id}.files.tar.gz`),
    ]);

    // Absolute paths in a tar would restore over the real filesystem.
    expect(stdout).not.toMatch(/^\//m);
    expect(stdout).toContain("user1/aaaa");
  });
});

describe("fail-closed on file storage failure", () => {
  it("does not mark the backup verified when the file archive fails", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);

    const res = await backup({ BACKUP_FILES_EXEC: failingFileExec() });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/file storage archive failed/i);

    // The worst outcome would be a verified database dump with no file archive: it
    // looks complete and is not.
    const verified = readdirSync(backupDir).filter((f) => f.endsWith(".verified"));
    expect(verified).toHaveLength(0);
  });

  it("writes no manifest when the file archive fails", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);

    await backup({ BACKUP_FILES_EXEC: failingFileExec() });

    const manifests = readdirSync(backupDir).filter((f) => f.endsWith(".manifest"));
    expect(manifests).toHaveLength(0);
  });

  it("leaves no partial file archive behind", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);

    await backup({ BACKUP_FILES_EXEC: failingFileExec() });

    const partials = readdirSync(backupDir).filter((f) => f.endsWith(".partial"));
    expect(partials).toHaveLength(0);
  });
});

describe("explicit opt-out", () => {
  it("records files_enabled=0 rather than silently omitting the archive", async () => {
    const id = backupIdFrom((await backup({ BACKUP_FILES: "0", BACKUP_ALLOW_DB_ONLY: "1" })).stdout);
    const m = manifestFor(id);

    expect(m.files_enabled).toBe("0");
    expect(m.files_archive).toBeUndefined();
    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.files.tar.gz`))).toBe(false);
  });

  it("still verifies the database backup when files are opted out", async () => {
    const res = await backup({ BACKUP_FILES: "0", BACKUP_ALLOW_DB_ONLY: "1" });
    expect(res.code).toBe(0);

    const id = backupIdFrom(res.stdout);
    expect(existsSync(path.join(backupDir, `innovera-chat-${id}.dump.verified`))).toBe(true);
  });
});

describe("existing PostgreSQL guarantees are not weakened", () => {
  it("still refuses to verify when pg_dump fails", async () => {
    const stub = path.join(stubDir, "pg_dump");
    writeFileSync(stub, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    chmodSync(stub, 0o755);

    const res = await backup({ PATH: `${stubDir}:${process.env.PATH}` });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/pg_dump/i);
  });

  it("still performs the isolated restore verification", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);
    const res = await backup();

    expect(res.stdout).toContain("restoring into restore_check_");
    expect(res.stdout).toContain("verifying restored structure");
  });

  it("orders file archiving AFTER the database is proven restorable", async () => {
    seedBlobs([{ key: "user1/aaaa", content: "x" }]);
    const { stdout } = await backup();

    const restoreAt = stdout.indexOf("verifying restored structure");
    const filesAt = stdout.indexOf("archiving file storage");
    // The step-8 marker specifically. A bare "verified" also matches step 5's
    // "restored tables verified queryable", which would compare the wrong position.
    const verifiedAt = stdout.indexOf("[8/8] verified");

    expect(restoreAt).toBeGreaterThan(-1);
    expect(filesAt).toBeGreaterThan(restoreAt);
    expect(verifiedAt).toBeGreaterThan(filesAt);
  });
});

describe("restore rehearsal", () => {
  async function rehearse(id: string, overrides: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await run("bash", [REHEARSAL, id], {
        env: { ...env(), RESTORE_SCRATCH_DIR: mkdtempSync(path.join(os.tmpdir(), "m1-rest-")), ...overrides },
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("passes for a complete backup with matching blobs", async () => {
    await sqlExec([
      `DELETE FROM "File"`,
      `DELETE FROM "User"`,
      `INSERT INTO "User" (id,"clerkUserId",email,role,status,"dailyTokenLimit","createdAt","updatedAt")
         VALUES ('u_rehearse','ck_rehearse','rehearse@test.local','USER','ACTIVE',50000,now(),now())`,
      `INSERT INTO "File" (id,"userId","storageKey",filename,"mimeType","sizeBytes",checksum,"extractStatus","createdAt")
         VALUES ('f1','u_rehearse','u_rehearse/blob1','a.txt','text/plain',5,'deadbeef','SKIPPED',now())`,
    ]);

    seedBlobs([{ key: "u_rehearse/blob1", content: "12345" }]);

    const id = backupIdFrom((await backup()).stdout);
    const res = await rehearse(id);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("RESTORE REHEARSAL PASSED");
    expect(res.stdout).toMatch(/1 File row\(s\) checked/);
  });

  it("FAILS when a File row has no corresponding blob", async () => {
    // The failure this whole design exists to catch: a database-only backup restores
    // rows whose downloads all 404.
    await sqlExec([
      `DELETE FROM "File"`,
      `DELETE FROM "User"`,
      `INSERT INTO "User" (id,"clerkUserId",email,role,status,"dailyTokenLimit","createdAt","updatedAt")
         VALUES ('u_orphan','ck_orphan','orphan@test.local','USER','ACTIVE',50000,now(),now())`,
      `INSERT INTO "File" (id,"userId","storageKey",filename,"mimeType","sizeBytes",checksum,"extractStatus","createdAt")
         VALUES ('f_orphan','u_orphan','u_orphan/missing','a.txt','text/plain',5,'deadbeef','SKIPPED',now())`,
    ]);

    // Storage is empty: the row has no blob.
    seedBlobs([{ key: "u_orphan/unrelated", content: "x" }]);

    const id = backupIdFrom((await backup()).stdout);
    const res = await rehearse(id);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/have no blob in the archive/i);
  });

  it("FAILS when a blob size disagrees with the database", async () => {
    await sqlExec([
      `DELETE FROM "File"`,
      `DELETE FROM "User"`,
      `INSERT INTO "User" (id,"clerkUserId",email,role,status,"dailyTokenLimit","createdAt","updatedAt")
         VALUES ('u_size','ck_size','size@test.local','USER','ACTIVE',50000,now(),now())`,
      `INSERT INTO "File" (id,"userId","storageKey",filename,"mimeType","sizeBytes",checksum,"extractStatus","createdAt")
         VALUES ('f_size','u_size','u_size/blob','a.txt','text/plain',999,'deadbeef','SKIPPED',now())`,
    ]);

    seedBlobs([{ key: "u_size/blob", content: "short" }]);

    const id = backupIdFrom((await backup()).stdout);
    const res = await rehearse(id);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/do not match the size recorded/i);
  });

  it("FAILS when an artefact changed after the manifest was written", async () => {
    seedBlobs([{ key: "u1/blob", content: "x" }]);
    const id = backupIdFrom((await backup()).stdout);

    // Corrupt the archive after the fact.
    writeFileSync(path.join(backupDir, `innovera-chat-${id}.files.tar.gz`), "tampered");

    const res = await rehearse(id);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/checksum does not match/i);
  });

  it("reports a database-only backup as incomplete when File rows exist", async () => {
    await sqlExec([
      `DELETE FROM "File"`,
      `DELETE FROM "User"`,
      `INSERT INTO "User" (id,"clerkUserId",email,role,status,"dailyTokenLimit","createdAt","updatedAt")
         VALUES ('u_incomplete','ck_inc','inc@test.local','USER','ACTIVE',50000,now(),now())`,
      `INSERT INTO "File" (id,"userId","storageKey",filename,"mimeType","sizeBytes",checksum,"extractStatus","createdAt")
         VALUES ('f_inc','u_incomplete','u_incomplete/blob','a.txt','text/plain',1,'x','SKIPPED',now())`,
    ]);

    const id = backupIdFrom((await backup({ BACKUP_FILES: "0", BACKUP_ALLOW_DB_ONLY: "1" })).stdout);
    const res = await rehearse(id);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/INCOMPLETE/);
  });

  it("accepts a pre-M1 database-only backup with no File rows", async () => {
    // Backward compatibility: backups taken before M1 remain restorable and must not be
    // reported as broken.
    await sqlExec([
      `DELETE FROM "File"`,
    ]);

    const id = backupIdFrom((await backup({ BACKUP_FILES: "0", BACKUP_ALLOW_DB_ONLY: "1" })).stdout);
    const res = await rehearse(id);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("no blobs required");
  });

  it("refuses an unknown backup id rather than guessing", async () => {
    const res = await rehearse("20990101T000000Z");

    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no manifest/i);
  });
});
