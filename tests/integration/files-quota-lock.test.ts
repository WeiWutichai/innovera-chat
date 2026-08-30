import { describe, it, expect, beforeEach, afterAll, inject } from "vitest";
import { PrismaClient } from "@prisma/client";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";

/**
 * Deterministic proof that the quota critical section is serialised by PostgreSQL.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE END-TO-END TEST
 * --------------------------------------------------
 * files-quota-concurrency.test.ts issues real concurrent uploads through the route with
 * Promise.all. That is valuable regression coverage, but it is NOT proof: against a fast
 * local PostgreSQL the first transaction usually commits before the second one opens, so
 * the second correctly observes the first's row and refuses — with or without the lock.
 * A test that passes when the protection is removed proves nothing about the protection.
 *
 * These tests therefore drive two SEPARATE connections and control the interleaving by
 * hand, holding transaction A open across the point where transaction B tries to enter.
 * That is the interleaving the lock exists to handle, and it cannot occur by accident.
 */
const databaseUrl = inject("databaseUrl");

/** Two independent clients so the transactions cannot share a connection. */
const clientA = new PrismaClient({ datasourceUrl: databaseUrl });
const clientB = new PrismaClient({ datasourceUrl: databaseUrl });

let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const user = await seedUser({ clerkUserId: "ck_lock", email: "lock@test.local" });
  userId = user.id;
});

afterAll(async () => {
  await clientA.$disconnect();
  await clientB.$disconnect();
});

/** Resolves to "blocked" if `promise` has not settled within `ms`. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "blocked"> {
  return Promise.race([
    promise,
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

describe("SELECT ... FOR UPDATE serialises the same user", () => {
  it("blocks a second transaction while the first holds the row", async () => {
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // Transaction A: take the lock, then hold it open on the gate.
    const txA = clientA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        await gate;
        return "A done";
      },
      { timeout: 15_000 }
    );

    // Give A time to actually acquire the lock.
    await new Promise((r) => setTimeout(r, 200));

    // Transaction B wants the same row. It must WAIT.
    const txB = clientB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        return "B done";
      },
      { timeout: 15_000 }
    );

    const bWhileAHolds = await raceTimeout(txB, 600);
    expect(bWhileAHolds).toBe("blocked");

    releaseA();
    await txA;

    // Once A commits, B proceeds.
    await expect(txB).resolves.toBe("B done");
  });

  it("makes the second transaction observe the first transaction's write", async () => {
    // This is the property the quota check depends on: measuring usage inside the lock
    // means the measurement reflects every committed row, including one written by a
    // transaction that was in flight moments earlier.
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = clientA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        await tx.file.create({
          data: {
            userId,
            storageKey: `${userId}/aaaa1111aaaa1111aaaa1111aaaa1111`,
            filename: "a.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 2_000_000,
            checksum: "a".repeat(64),
          },
        });
        await gate;
        return "A committed";
      },
      { timeout: 15_000 }
    );

    await new Promise((r) => setTimeout(r, 200));

    let observedByB = -1;

    const txB = clientB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const agg = await tx.file.aggregate({ _sum: { sizeBytes: true }, where: { userId } });
        observedByB = agg._sum.sizeBytes ?? 0;
        return "B measured";
      },
      { timeout: 15_000 }
    );

    // B is still waiting, so it has measured nothing yet.
    expect(await raceTimeout(txB, 600)).toBe("blocked");
    expect(observedByB).toBe(-1);

    releaseA();
    await txA;
    await txB;

    // Without the lock B would have measured 0 here and admitted a second file.
    expect(observedByB).toBe(2_000_000);
  });

  it("does not block a DIFFERENT user's transaction", async () => {
    // Row-level, not table-level: unrelated users must not queue behind each other.
    const other = await seedUser({ clerkUserId: "ck_other_lock", email: "other@test.local" });

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = clientA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        await gate;
        return "A done";
      },
      { timeout: 15_000 }
    );

    await new Promise((r) => setTimeout(r, 200));

    const txB = clientB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${other.id} FOR UPDATE`;
        return "B done";
      },
      { timeout: 15_000 }
    );

    // B targets a different row and must complete immediately.
    await expect(raceTimeout(txB, 1500)).resolves.toBe("B done");

    releaseA();
    await txA;
  });
});

describe("the production code path takes the lock", () => {
  it("issues SELECT ... FOR UPDATE inside the admission transaction", async () => {
    // Guards against a future refactor quietly dropping the lock, which the end-to-end
    // test would not reliably catch.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/files/service.ts", "utf8");

    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");

    expect(code).toMatch(/FOR UPDATE/);
    // And it must be inside the transaction that also creates the row.
    const txBody = code.slice(code.indexOf("prisma.$transaction"));
    expect(txBody.indexOf("FOR UPDATE")).toBeGreaterThan(-1);
    expect(txBody.indexOf("FOR UPDATE")).toBeLessThan(txBody.indexOf("tx.file.create"));
  });

  it("measures usage inside the same transaction as the insert", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/files/service.ts", "utf8");
    const txBody = source.slice(source.indexOf("prisma.$transaction"));

    // Measuring outside the transaction would make the lock decorative.
    const lockAt = txBody.indexOf("FOR UPDATE");
    const measureAt = txBody.indexOf("tx.file.aggregate");
    const insertAt = txBody.indexOf("tx.file.create");

    // Asserted explicitly: indexOf returns -1 for a missing lock, and -1 would satisfy
    // a naive "measure comes after lock" comparison vacuously.
    expect(lockAt).toBeGreaterThan(-1);
    expect(measureAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(measureAt);
  });

  it("computes quota from committed rows, with no reservation table", async () => {
    // No reservation table means no expiry logic and no phantom reservations to
    // reconcile after a crash.
    const models = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );

    expect(models.map((m) => m.tablename)).not.toContain("FileReservation");
    expect(models.map((m) => m.tablename)).not.toContain("StorageReservation");
  });
});
