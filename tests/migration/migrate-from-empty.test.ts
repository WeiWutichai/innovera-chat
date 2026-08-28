import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { withAdminConnection, withDatabase } from "../setup/admin-sql";
import { assertSafeDatabaseUrl } from "../setup/guards";

const adminUrl = inject("adminUrl");
const dbName = `innovera_migration_${randomBytes(5).toString("hex")}`;

let url: string;
let client: PrismaClient;

/** Applies the real migrations to a database created empty for this suite alone. */
beforeAll(async () => {
  await withAdminConnection(adminUrl, (admin) =>
    admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`)
  );

  url = withDatabase(adminUrl, dbName);
  assertSafeDatabaseUrl(url, "migration test database URL");

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  client = new PrismaClient({ datasourceUrl: url });
}, 120_000);

afterAll(async () => {
  await client?.$disconnect();
  await withAdminConnection(adminUrl, (admin) =>
    admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  );
});

const indexes = () =>
  client.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Usage'`
  );

describe("migrating from an empty database", () => {
  it("applies every migration cleanly", async () => {
    const status = execFileSync("npx", ["prisma", "migrate", "status"], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });

    expect(status).toContain("Database schema is up to date!");
  });

  it("reports no pending migration", async () => {
    const applied = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at`
    );

    expect(applied.map((m) => m.migration_name)).toEqual([
      "20260827163847_init",
      "20260828104547_usage_userid_createdat_index",
    ]);
  });

  it("creates every application table", async () => {
    const tables = await client.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );

    expect(tables.map((t) => t.tablename)).toEqual(
      expect.arrayContaining(["Conversation", "Message", "Usage", "User"])
    );
  });
});

describe("Usage indexes", () => {
  it("creates the composite index the daily quota depends on", async () => {
    const names = (await indexes()).map((i) => i.indexname);
    expect(names).toContain("Usage_userId_createdAt_idx");
  });

  it("no longer carries the redundant single-column userId index", async () => {
    const names = (await indexes()).map((i) => i.indexname);
    expect(names).not.toContain("Usage_userId_idx");
  });

  it("orders the composite index (userId, createdAt)", async () => {
    const def = (await indexes()).find((i) => i.indexname === "Usage_userId_createdAt_idx")!.indexdef;
    expect(def).toMatch(/\("userId", "createdAt"\)/);
  });

  it("plans the daily-quota aggregate as an index scan on the composite", async () => {
    const plan = await client.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN SELECT sum("totalTokens") FROM "Usage" WHERE "userId" = 'x' AND "createdAt" >= now()`
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain("Usage_userId_createdAt_idx");
    expect(text).not.toMatch(/Seq Scan on "?Usage"?/);
  });
});

describe("referential integrity", () => {
  it("cascades deletes on every foreign key", async () => {
    const rules = await client.$queryRawUnsafe<
      { table_name: string; delete_rule: string }[]
    >(`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name
    `);

    expect(rules).toHaveLength(3);
    for (const rule of rules) expect(rule.delete_rule).toBe("CASCADE");
  });

  it("declares the expected enums", async () => {
    const enums = await client.$queryRawUnsafe<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`
    );

    expect(enums.map((e) => e.typname)).toEqual(["MessageRole", "UserRole", "UserStatus"]);
  });
});

describe("schema/migration drift", () => {
  it("has no difference between the migrated database and schema.prisma", () => {
    // --exit-code: 0 means no drift, 2 means the schema and database disagree.
    const result = execFileSync(
      "npx",
      [
        "prisma", "migrate", "diff",
        "--from-url", url,
        "--to-schema-datamodel", "prisma/schema.prisma",
        "--exit-code",
      ],
      { env: process.env, encoding: "utf8" }
    );

    expect(result).toContain("No difference detected");
  });
});
