import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { provisionPostgres, type PostgresHandle } from "./postgres";
import { assertSafeDatabaseUrl } from "./guards";
import { withAdminConnection, withDatabase } from "./admin-sql";

const TEST_DB = "innovera_test";

let handle: PostgresHandle | null = null;

/**
 * Provisions the cluster once per run, creates a single test database, and applies the
 * real Prisma migrations to it. Values reach workers through provide/inject.
 */
export default async function setup(project: TestProject) {
  handle = await provisionPostgres();

  await withAdminConnection(handle.baseUrl, async (client) => {
    await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await client.$executeRawUnsafe(`CREATE DATABASE ${TEST_DB}`);
  });

  const databaseUrl = withDatabase(handle.baseUrl, TEST_DB);
  assertSafeDatabaseUrl(databaseUrl, "test database URL");

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
  });

  project.provide("databaseUrl", databaseUrl);
  project.provide("adminUrl", handle.baseUrl);
  project.provide("postgresSource", handle.source);

  return async () => {
    await handle?.teardown();
    handle = null;
  };
}

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
    adminUrl: string;
    postgresSource: string;
  }
}
