import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assertSafeDatabaseUrl } from "./guards";

export type PostgresHandle = {
  /** Connection URL for the maintenance ("postgres") database. */
  baseUrl: string;
  /** How the cluster was obtained, for reporting. */
  source: "TEST_DATABASE_URL" | "ephemeral-native";
  teardown: () => Promise<void>;
};

function binaryOnPath(name: string) {
  return spawnSync("which", [name], { encoding: "utf8" }).status === 0;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Provision a PostgreSQL cluster for the test run.
 *
 * A: TEST_DATABASE_URL is provided  -> use it (the CI path; nothing is provisioned).
 * B: initdb/pg_ctl are on PATH      -> ephemeral native cluster under os.tmpdir().
 * C: neither                        -> fail with instructions.
 *
 * There is deliberately no Docker or Testcontainers path, and never any fallback to
 * the application's DATABASE_URL.
 */
export async function provisionPostgres(): Promise<PostgresHandle> {
  const external = process.env.TEST_DATABASE_URL;

  if (external) {
    assertSafeDatabaseUrl(external, "TEST_DATABASE_URL");
    return { baseUrl: external, source: "TEST_DATABASE_URL", teardown: async () => {} };
  }

  if (!binaryOnPath("initdb") || !binaryOnPath("pg_ctl")) {
    throw new Error(
      "[test-setup] No test database available.\n\n" +
        "  Either provide one:\n" +
        "      TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm test\n\n" +
        "  or install PostgreSQL so an ephemeral cluster can be provisioned:\n" +
        "      macOS:  brew install postgresql@16\n" +
        "      Debian: sudo apt-get install postgresql\n\n" +
        "  Tests never fall back to the application's DATABASE_URL."
    );
  }

  // Data directory under os.tmpdir(). The socket directory is created separately and
  // kept short: PostgreSQL rejects Unix socket paths over 103 bytes, and the macOS
  // temp directory alone is long enough to blow that limit.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "innovera-pgdata-"));
  const socketRoot = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const socketDir = mkdtempSync(path.join(socketRoot, "ivpg-"));
  const password = randomBytes(18).toString("hex");
  const pwFile = path.join(dataDir, "..", `ivpg-pw-${randomBytes(6).toString("hex")}`);
  const port = await freePort();

  let started = false;

  const teardown = async () => {
    try {
      if (started) {
        spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { encoding: "utf8" });
      }
    } catch {
      /* fall through to directory removal */
    }
    for (const dir of [dataDir, socketDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    try {
      rmSync(pwFile, { force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    writeFileSync(pwFile, password, { mode: 0o600 });
    execFileSync(
      "initdb",
      ["-D", dataDir, "-U", "testuser", "--auth-local=trust", "--auth-host=scram-sha-256", `--pwfile=${pwFile}`],
      { stdio: "ignore" }
    );
    rmSync(pwFile, { force: true });

    execFileSync(
      "pg_ctl",
      [
        "-D", dataDir,
        "-o", `-p ${port} -c listen_addresses=127.0.0.1 -k ${socketDir} -c fsync=off -c full_page_writes=off`,
        "-l", path.join(dataDir, "server.log"),
        "-w", "-t", "60",
        "start",
      ],
      { stdio: "ignore" }
    );
    started = true;
  } catch (error) {
    await teardown();
    throw new Error(
      `[test-setup] Failed to start an ephemeral PostgreSQL cluster: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Ensure the cluster dies with the runner even on an abrupt exit.
  const onExit = () => {
    if (started) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
  };
  process.once("exit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  const baseUrl = `postgresql://testuser:${password}@127.0.0.1:${port}/postgres`;
  assertSafeDatabaseUrl(baseUrl, "ephemeral cluster URL");

  return { baseUrl, source: "ephemeral-native", teardown };
}
