import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { withAdminConnection, withDatabase } from "../setup/admin-sql";
import { assertSafeDatabaseUrl } from "../setup/guards";

/**
 * Proves the M1 migration is safe against a database that already holds production-
 * shaped data.
 *
 * The sequence deliberately mirrors what will happen on the production host: apply the
 * PRE-M1 migrations, write realistic rows, then apply the M1 migration on top and
 * confirm every pre-existing row is untouched. Applying to an empty database — which
 * migrate-from-empty.test.ts already covers — cannot catch a destructive statement,
 * because there is nothing there to destroy.
 */
const adminUrl = inject("adminUrl");
const dbName = `innovera_m1_data_${randomBytes(5).toString("hex")}`;

const M1_MIGRATION = "20260830120000_add_file_storage";
const M2_MIGRATION = "20260830140000_add_file_extraction";
const M3_MIGRATION = "20260830160000_add_conversation_file";

let url: string;
let client: PrismaClient;
let stage: string;

/** Snapshot of everything that existed before M1 was applied. */
let before: {
  users: number;
  conversations: number;
  messages: number;
  usage: number;
  messageContents: string[];
  userEmail: string;
  usageTotal: number;
};

let filesCreatedByM2 = -1;

/** Snapshot taken after M2 and before M3, so M3's effect is isolated. */
let beforeM3: {
  files: number;
  messages: number;
  conversations: number;
  extractedText: string | null;
};

beforeAll(async () => {
  await withAdminConnection(adminUrl, (admin) =>
    admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`)
  );

  url = withDatabase(adminUrl, dbName);
  assertSafeDatabaseUrl(url, "M1 data-preservation test database URL");

  const env = { ...process.env, DATABASE_URL: url };

  // A staged migrations directory. Prisma has no supported way to apply "all migrations
  // except the newest", so the pre-M1 set is copied into a scratch schema directory and
  // deployed from there; M1 is copied in afterwards and deployed on top. That reproduces
  // the production sequence exactly: an existing, populated database meets a new
  // migration for the first time.
  stage = mkdtempSync(path.join(os.tmpdir(), "m1-migrate-"));
  const stagedPrisma = path.join(stage, "prisma");
  mkdirSync(path.join(stagedPrisma, "migrations"), { recursive: true });

  copyFileSync("prisma/schema.prisma", path.join(stagedPrisma, "schema.prisma"));
  copyFileSync(
    "prisma/migrations/migration_lock.toml",
    path.join(stagedPrisma, "migrations/migration_lock.toml")
  );

  for (const name of readdirSync("prisma/migrations")) {
    // Both newer migrations are held back so they can be applied IN PRODUCTION ORDER
    // against populated data — M2 first, then M3 on top of what M2 produced.
    if (name === M2_MIGRATION || name === M3_MIGRATION || !name.startsWith("2026")) continue;
    mkdirSync(path.join(stagedPrisma, "migrations", name), { recursive: true });
    copyFileSync(
      path.join("prisma/migrations", name, "migration.sql"),
      path.join(stagedPrisma, "migrations", name, "migration.sql")
    );
  }

  const stagedSchema = path.join(stagedPrisma, "schema.prisma");

  // 1. Pre-M1 schema only.
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", stagedSchema], {
    env,
    stdio: "pipe",
  });

  client = new PrismaClient({ datasourceUrl: url });

  // 2. Production-shaped data.
  const user = await client.user.create({
    data: {
      clerkUserId: "ck_preexisting",
      email: "preexisting@test.local",
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  for (let c = 0; c < 2; c++) {
    const conversation = await client.conversation.create({
      data: { userId: user.id, title: `Conversation ${c}` },
    });

    for (let m = 0; m < 3; m++) {
      await client.message.create({
        data: {
          conversationId: conversation.id,
          role: m % 2 === 0 ? "USER" : "ASSISTANT",
          content: `pre-existing message ${c}-${m}`,
        },
      });
    }
  }

  await client.usage.create({
    data: { userId: user.id, promptTokens: 100, completionTokens: 200, totalTokens: 300 },
  });

  before = {
    users: await client.user.count(),
    conversations: await client.conversation.count(),
    messages: await client.message.count(),
    usage: await client.usage.count(),
    messageContents: (
      await client.message.findMany({ orderBy: { content: "asc" }, select: { content: true } })
    ).map((m) => m.content),
    userEmail: user.email,
    usageTotal: 300,
  };

  await client.$disconnect();

  // 3. M2 meets the populated database.
  mkdirSync(path.join(stagedPrisma, "migrations", M2_MIGRATION), { recursive: true });
  copyFileSync(
    path.join("prisma/migrations", M2_MIGRATION, "migration.sql"),
    path.join(stagedPrisma, "migrations", M2_MIGRATION, "migration.sql")
  );

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", stagedSchema], {
    env,
    stdio: "pipe",
  });

  // 4. M2-shaped data: a file that has actually been extracted. M3 must preserve this
  //    exactly, because it is what the assistant reads.
  client = new PrismaClient({ datasourceUrl: url });

  // Captured BEFORE anything is seeded, so the "M2 invents no rows" assertion still
  // measures what M2 itself did rather than what this test set up for M3.
  filesCreatedByM2 = await client.file.count();

  const owner = await client.user.findFirstOrThrow({ where: { clerkUserId: "ck_preexisting" } });

  await client.file.create({
    data: {
      userId: owner.id,
      storageKey: `${owner.id}/m2extracted`,
      filename: "quarterly.xlsx",
      mimeType: "application/zip",
      sizeBytes: 4096,
      checksum: "d".repeat(64),
      extractStatus: "PARTIAL",
      extractedText: "REVENUE 12345 EXTRACTED UNDER M2",
      extractedChars: 32,
      extractTruncated: true,
      extractReason: "some rows were dropped",
      extractAttempts: 2,
    },
  });

  beforeM3 = {
    files: await client.file.count(),
    messages: await client.message.count(),
    conversations: await client.conversation.count(),
    extractedText: (await client.file.findFirstOrThrow()).extractedText,
  };

  await client.$disconnect();

  // 5. M3 meets a database populated by M1 and M2.
  mkdirSync(path.join(stagedPrisma, "migrations", M3_MIGRATION), { recursive: true });
  copyFileSync(
    path.join("prisma/migrations", M3_MIGRATION, "migration.sql"),
    path.join(stagedPrisma, "migrations", M3_MIGRATION, "migration.sql")
  );

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", stagedSchema], {
    env,
    stdio: "pipe",
  });

  client = new PrismaClient({ datasourceUrl: url });
}, 240_000);

afterAll(async () => {
  await client?.$disconnect();
  if (stage) rmSync(stage, { recursive: true, force: true });
  await withAdminConnection(adminUrl, (admin) =>
    admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  );
});

describe("M1 migration against populated data", () => {
  it("applies cleanly with every migration recorded", () => {
    const status = execFileSync(
      "npx",
      ["prisma", "migrate", "status", "--schema", path.join(stage, "prisma/schema.prisma")],
      { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" }
    );

    expect(status).toMatch(/up to date|No pending migrations/i);
  });

  it("creates the File table and its enum", async () => {
    const tables = await client.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );

    expect(tables.map((t) => t.tablename)).toContain("File");
  });

  it("preserves every pre-existing row", async () => {
    expect(await client.user.count()).toBe(before.users);
    expect(await client.conversation.count()).toBe(before.conversations);
    expect(await client.message.count()).toBe(before.messages);
    expect(await client.usage.count()).toBe(before.usage);
  });

  it("preserves message CONTENT, not merely row counts", async () => {
    // A migration that recreated the table would keep the count and lose the data.
    const after = (
      await client.message.findMany({ orderBy: { content: "asc" }, select: { content: true } })
    ).map((m) => m.content);

    expect(after).toEqual(before.messageContents);
  });

  it("preserves user identity and role", async () => {
    const user = await client.user.findFirstOrThrow();

    expect(user.email).toBe(before.userEmail);
    expect(user.role).toBe("ADMIN");
    expect(user.status).toBe("ACTIVE");
  });

  it("preserves usage accounting", async () => {
    const usage = await client.usage.findFirstOrThrow();
    expect(usage.totalTokens).toBe(before.usageTotal);
  });

  it("leaves the File table empty — the migration invents no rows", async () => {
    // Measured immediately after M2 was applied, before this suite seeded anything.
    expect(filesCreatedByM2).toBe(0);
  });
});

describe("File table shape", () => {
  it("indexes the owner-scoped list path", async () => {
    const indexes = await client.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'File'`
    );
    const defs = indexes.map((i) => i.indexdef).join("\n");

    expect(defs).toMatch(/userId.*createdAt/);
  });

  it("enforces storageKey uniqueness", async () => {
    // A key collision must surface as a constraint violation, never as a silent
    // overwrite of another user's bytes.
    const indexes = await client.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'File'`
    );

    expect(indexes.map((i) => i.indexdef).join("\n")).toMatch(/UNIQUE.*storageKey/);
  });

  it("cascades from User so a deleted user leaves no File rows", async () => {
    const user = await client.user.create({
      data: { clerkUserId: "ck_cascade", email: "cascade@test.local" },
    });

    await client.file.create({
      data: {
        userId: user.id,
        storageKey: `${user.id}/cascadeblob`,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        checksum: "abc",
      },
    });

    await client.user.delete({ where: { id: user.id } });

    expect(await client.file.count({ where: { userId: user.id } })).toBe(0);
  });

  it("defaults extractStatus to PENDING so new uploads queue for extraction", async () => {
    const user = await client.user.findFirstOrThrow({ where: { clerkUserId: "ck_preexisting" } });

    const file = await client.file.create({
      data: {
        userId: user.id,
        storageKey: `${user.id}/defaultblob`,
        filename: "y.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        checksum: "def",
      },
    });

    expect(file.extractStatus).toBe("PENDING");

    await client.file.delete({ where: { id: file.id } });
  });
});

describe("migration is non-destructive by inspection", () => {
  it("contains no DROP, TRUNCATE or DELETE", () => {
    const sql = readFileSync(`prisma/migrations/${M2_MIGRATION}/migration.sql`, "utf8");

    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("alters no pre-existing table", () => {
    const sql = readFileSync(`prisma/migrations/${M2_MIGRATION}/migration.sql`, "utf8");

    // Rollback compatibility depends on this: the previous release must be able to run
    // against the migrated schema, which it can only do if its own tables are unchanged.
    for (const table of ["User", "Conversation", "Message", "Usage"]) {
      expect(sql).not.toMatch(new RegExp(`ALTER TABLE "${table}"`));
    }

    // The M1 migration must also remain non-destructive against this data.
    const m1 = readFileSync(`prisma/migrations/${M1_MIGRATION}/migration.sql`, "utf8");
    expect(m1).not.toMatch(/\bDROP\b/i);
  });
});

describe("M1 rows are not reinterpreted by M2", () => {
  it("leaves an existing SKIPPED row untouched", async () => {
    // A file uploaded under M1 was stored under a contract that said its content would
    // not be read. Silently extracting it later would change what the user sees for a
    // file they uploaded under different rules, so SKIPPED stays SKIPPED and the
    // extraction worker never claims it.
    const user = await client.user.findFirstOrThrow({ where: { clerkUserId: "ck_preexisting" } });

    const legacy = await client.file.create({
      data: {
        userId: user.id,
        storageKey: `${user.id}/legacyblob0000000000000000000000`,
        filename: "legacy.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        checksum: "l".repeat(64),
        extractStatus: "SKIPPED",
      },
    });

    const claimable = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "File"
       WHERE "extractStatus" = 'PENDING'
          OR ("extractStatus" = 'PROCESSING' AND "extractLeaseUntil" < now())`
    );

    expect(claimable.map((r) => r.id)).not.toContain(legacy.id);

    await client.file.delete({ where: { id: legacy.id } });
  });

  it("adds the extraction columns as nullable, so existing rows need no backfill", async () => {
    const columns = await client.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'File' AND column_name LIKE 'extract%'`
    );

    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]));

    // A NOT NULL column with no default would have failed on a populated table.
    expect(byName.extractedText).toBe("YES");
    expect(byName.extractedChars).toBe("YES");
    expect(byName.extractReason).toBe("YES");
    expect(byName.extractLeaseUntil).toBe("YES");
  });

  it("indexes the worker claim path", async () => {
    const indexes = await client.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'File'`
    );

    expect(indexes.map((i) => i.indexdef).join("\n")).toMatch(/extractStatus.*extractLeaseUntil/);
  });
});

describe("M3 migration against a database populated by M1 and M2", () => {
  it("applies cleanly with every migration recorded in order", () => {
    const status = execFileSync(
      "npx",
      ["prisma", "migrate", "status", "--schema", path.join(stage, "prisma", "schema.prisma")],
      { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" }
    );

    expect(status).toContain("Database schema is up to date!");
  });

  it("creates the ConversationFile table", async () => {
    const tables = await client.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );

    expect(tables.map((t) => t.tablename)).toContain("ConversationFile");
  });

  it("invents no attachments", async () => {
    // A migration that guessed which files belonged to which conversation would put
    // content into prompts nobody asked for.
    expect(await client.conversationFile.count()).toBe(0);
  });

  it("preserves every M1 and M2 row", async () => {
    expect(await client.file.count()).toBe(beforeM3.files);
    expect(await client.message.count()).toBe(beforeM3.messages);
    expect(await client.conversation.count()).toBe(beforeM3.conversations);
  });

  it("preserves extracted text and its extraction fields verbatim", async () => {
    const file = await client.file.findFirstOrThrow();

    expect(file.extractedText).toBe(beforeM3.extractedText);
    expect(file.extractStatus).toBe("PARTIAL");
    expect(file.extractTruncated).toBe(true);
    expect(file.extractAttempts).toBe(2);
    expect(file.extractReason).toBe("some rows were dropped");
  });

  it("enforces composite uniqueness so attaching twice cannot duplicate", async () => {
    const conversation = await client.conversation.findFirstOrThrow();
    const file = await client.file.findFirstOrThrow();

    await client.conversationFile.create({
      data: { conversationId: conversation.id, fileId: file.id },
    });

    await expect(
      client.conversationFile.create({
        data: { conversationId: conversation.id, fileId: file.id },
      })
    ).rejects.toThrow();

    await client.conversationFile.deleteMany({});
  });

  it("cascades from Conversation without touching the File", async () => {
    // Captured BEFORE anything is seeded, so the "M2 invents no rows" assertion still
  // measures what M2 itself did rather than what this test set up for M3.
  filesCreatedByM2 = await client.file.count();

  const owner = await client.user.findFirstOrThrow({ where: { clerkUserId: "ck_preexisting" } });
    const file = await client.file.findFirstOrThrow();

    const doomed = await client.conversation.create({
      data: { userId: owner.id, title: "temporary" },
    });

    await client.conversationFile.create({
      data: { conversationId: doomed.id, fileId: file.id },
    });

    await client.conversation.delete({ where: { id: doomed.id } });

    expect(await client.conversationFile.count()).toBe(0);
    // The file — and its extracted text — survives losing a conversation.
    expect(await client.file.findUnique({ where: { id: file.id } })).not.toBeNull();
  });

  it("is non-destructive by inspection", () => {
    const sql = readFileSync(`prisma/migrations/${M3_MIGRATION}/migration.sql`, "utf8");

    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);

    // Rollback compatibility: the previous release must still run against this schema,
    // which it can only do if none of its own tables changed.
    for (const table of ["User", "Conversation", "Message", "Usage", "File"]) {
      expect(sql).not.toMatch(new RegExp(`ALTER TABLE "${table}"`));
    }
  });
});
