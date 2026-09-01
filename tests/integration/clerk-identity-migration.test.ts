import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import {
  planMigration,
  applyMigration,
  surveyPrivilegedAccounts,
  maskEmail,
  isValidClerkUserId,
} from "../../scripts/lib/clerk-identity-migration.mjs";

/**
 * The controlled Clerk instance cutover.
 *
 * The failure this prevents is specific and total: switching Clerk instances re-links the
 * only ADMIN by email through `recoverFromEmailCollision`, which forces PENDING/USER —
 * and `makeAdmin` is gated by `requireAdmin`, so the system reaches zero ACTIVE ADMINs
 * with no way back. These tests prove the migration rebinds identity WITHOUT touching any
 * of that, and refuses in every case where it cannot be certain which account it is
 * looking at.
 */

const OWNER_EMAIL = "owner@innovera.test";
const OLD_CLERK = "user_2devAAAABBBBCCCCDDDDEEEEFF";
const NEW_CLERK = "user_2liveZZZZYYYYXXXXWWWWVVVV";

let ownerId: string;

async function seedOwnerWithData() {
  const owner = await seedUser({
    clerkUserId: OLD_CLERK,
    email: OWNER_EMAIL,
    role: "ADMIN",
    status: "ACTIVE",
  });

  const conversation = await prisma.conversation.create({
    data: { userId: owner.id, title: "existing conversation" },
  });

  await prisma.message.createMany({
    data: [
      { conversationId: conversation.id, role: "USER", content: "a question" },
      { conversationId: conversation.id, role: "ASSISTANT", content: "an answer" },
    ],
  });

  await prisma.usage.create({
    data: { userId: owner.id, promptTokens: 100, completionTokens: 200, totalTokens: 300 },
  });

  const file = await prisma.file.create({
    data: {
      userId: owner.id,
      storageKey: `${owner.id}/blob1`,
      filename: "report.xlsx",
      mimeType: "application/zip",
      sizeBytes: 40,
      checksum: "c".repeat(64),
      extractStatus: "EXTRACTED",
      extractedText: "REVENUE 12345",
    },
  });

  await prisma.conversationFile.create({
    data: { conversationId: conversation.id, fileId: file.id },
  });

  return owner.id;
}

beforeEach(async () => {
  await resetDatabase();
  ownerId = await seedOwnerWithData();
});

describe("the dry run is genuinely read-only", () => {
  it("reports the change without writing anything", async () => {
    const plan = await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK });

    expect(plan).toMatchObject({
      status: "would_change",
      userId: ownerId,
      previousClerkUserId: OLD_CLERK,
      nextClerkUserId: NEW_CLERK,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(after.clerkUserId).toBe(OLD_CLERK);
  });

  it("plans and applies the same decision", async () => {
    const plan = await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK });
    const applied = await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    if (plan.status !== "would_change" || applied.status !== "changed") {
      throw new Error("unexpected statuses");
    }

    // A dry run that disagreed with the real run would make the rehearsal worthless.
    expect(applied.userId).toBe(plan.userId);
    expect(applied.previousClerkUserId).toBe(plan.previousClerkUserId);
    expect(applied.nextClerkUserId).toBe(plan.nextClerkUserId);
  });
});

describe("privilege and identity are preserved", () => {
  it("keeps ADMIN as ADMIN", async () => {
    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(after.role).toBe("ADMIN");
  });

  it("keeps ACTIVE as ACTIVE", async () => {
    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(after.status).toBe("ACTIVE");
  });

  it("leaves User.id unchanged", async () => {
    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(after.id).toBe(ownerId);
    expect(await prisma.user.count()).toBe(1);
  });

  it("rebinds the Clerk identity and nothing else", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    expect(after.clerkUserId).toBe(NEW_CLERK);
    // Every other column byte-for-byte identical.
    expect({ ...after, clerkUserId: null, updatedAt: null }).toEqual({
      ...before,
      clerkUserId: null,
      updatedAt: null,
    });
  });

  it("preserves every piece of FK-owned data", async () => {
    const before = {
      conversations: await prisma.conversation.count({ where: { userId: ownerId } }),
      messages: await prisma.message.count(),
      usage: await prisma.usage.findFirstOrThrow({ where: { userId: ownerId } }),
      files: await prisma.file.findFirstOrThrow({ where: { userId: ownerId } }),
      links: await prisma.conversationFile.count(),
    };

    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    expect(await prisma.conversation.count({ where: { userId: ownerId } })).toBe(before.conversations);
    expect(await prisma.message.count()).toBe(before.messages);
    expect(await prisma.conversationFile.count()).toBe(before.links);

    const usage = await prisma.usage.findFirstOrThrow({ where: { userId: ownerId } });
    expect(usage.totalTokens).toBe(before.usage.totalTokens);

    const file = await prisma.file.findFirstOrThrow({ where: { userId: ownerId } });
    expect(file.extractedText).toBe(before.files.extractedText);
    expect(file.storageKey).toBe(before.files.storageKey);
  });

  it("never reduces the number of active admins", async () => {
    const before = await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });

    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    expect(await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(before);
    expect(before).toBe(1);
  });
});

describe("it refuses rather than guessing", () => {
  it("refuses an email that does not exist", async () => {
    const result = await applyMigration(prisma, {
      email: "nobody@innovera.test",
      clerkUserId: NEW_CLERK,
      expectedUserId: ownerId,
    });

    expect(result).toMatchObject({ status: "refused", reason: "email_not_found" });
    // Crucially it does NOT create an account.
    expect(await prisma.user.count()).toBe(1);
  });

  it("refuses a Clerk id already bound to a different account", async () => {
    await seedUser({ clerkUserId: NEW_CLERK, email: "someone.else@innovera.test" });

    const result = await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    expect(result).toMatchObject({
      status: "refused",
      reason: "clerk_id_belongs_to_another_user",
    });

    // No merge, no takeover: both rows keep their own identity.
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });

  it("never writes a userId supplied by anything but the operator's own arguments", async () => {
    // The module takes an email and a Clerk id and reads the row itself; there is no
    // parameter through which a caller could name the User.id to modify.
    const result = await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK });

    if (result.status !== "would_change") throw new Error("expected would_change");
    expect(result.userId).toBe(ownerId);
  });
});

describe("case policy is explicit", () => {
  it("does NOT match a different casing by default", async () => {
    // User.email is a case-sensitive unique btree and nothing lowercases addresses, so
    // silently folding case could bind the wrong account.
    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL.toUpperCase(),
      clerkUserId: NEW_CLERK,
      expectedUserId: ownerId,
    });

    expect(result).toMatchObject({ status: "refused", reason: "email_not_found" });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });

  it("matches a different casing only when explicitly opted in", async () => {
    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL.toUpperCase(),
      clerkUserId: NEW_CLERK,
      caseInsensitive: true,
      expectedUserId: ownerId,
    });

    expect(result).toMatchObject({ status: "changed", userId: ownerId });
  });

  it("refuses a case-insensitive match that is ambiguous", async () => {
    // Two rows differing only in case can both exist, because the unique index is
    // case-sensitive. Folding case must not pick one at random.
    await seedUser({ clerkUserId: "user_2otherAAAABBBBCCCCDDDDEE", email: OWNER_EMAIL.toUpperCase() });

    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
      caseInsensitive: true,
      expectedUserId: ownerId,
    });

    expect(result).toMatchObject({ status: "refused", reason: "ambiguous_email" });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });
});

describe("it is idempotent and reversible", () => {
  it("reports already_bound on a second identical run", async () => {
    const first = await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });
    const second = await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });

    expect(first.status).toBe("changed");
    expect(second).toMatchObject({ status: "already_bound", userId: ownerId });
  });

  it("leaves the row identical after a rerun", async () => {
    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });
    const once = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });
    const twice = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    expect(twice).toEqual(once);
  });

  it("reverses cleanly using the recorded previous id", async () => {
    const forward = await applyMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK, expectedUserId: ownerId });
    if (forward.status !== "changed") throw new Error("expected changed");

    const back = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: forward.rollback.previousClerkUserId,
      expectedUserId: forward.rollback.userId,
    });

    expect(back.status).toBe("changed");

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
    expect(owner.role).toBe("ADMIN");
    expect(owner.status).toBe("ACTIVE");
  });
});

describe("the survey is read-only and masks addresses", () => {
  it("lists who must be pre-bound without printing full addresses", async () => {
    const rows = await surveyPrivilegedAccounts(prisma);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ownerId, role: "ADMIN", status: "ACTIVE" });
    expect(rows[0].email).not.toContain("owner@");
    expect(rows[0].email).toContain("@innovera.test");
    expect(rows[0].clerkUserIdPrefix).toHaveLength(8);
  });

  it("masks an address without losing its domain", () => {
    expect(maskEmail("owner@innovera.test")).toBe("o****@innovera.test");
    expect(maskEmail("a@b.co")).toBe("a**@b.co");
    expect(maskEmail("not-an-email")).toBe("***");
  });
});

describe("normal collision recovery is NOT weakened", () => {
  it("leaves current-app-user.ts demoting an uncontrolled re-link", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/current-app-user.ts", "utf8");

    // The migration tool is the narrow exception; the ordinary path must still treat a
    // new Clerk account claiming an existing email as a takeover attempt.
    expect(source).toMatch(/status:\s*"PENDING"/);
    expect(source).toMatch(/role:\s*"USER"/);
    expect(source).not.toContain("clerk-identity-migration");
  });

  it("is not reachable from any route", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      "grep -rl 'clerk-identity-migration' src/ 2>/dev/null || true",
      { encoding: "utf8" }
    ).trim();

    // A migration tool importable from application code would be a takeover endpoint.
    // It now lives under scripts/ precisely so it cannot be bundled into the app.
    expect(hits).toBe("");
  });
});

describe("apply requires an explicit confirmed target", () => {
  it("refuses --apply with no confirmation at all", async () => {
    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
    });

    expect(result).toMatchObject({ status: "refused", reason: "missing_target_confirmation" });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });

  it("refuses when the confirmed User.id is not the row the email resolves to", async () => {
    const other = await seedUser({
      clerkUserId: "user_2thirdAAAABBBBCCCCDDDDEEE",
      email: "third@innovera.test",
    });

    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
      expectedUserId: other.id,
    });

    // Guards the window between reading a dry run and acting on it: if the address now
    // resolves elsewhere, the apply must not land on a row the operator never inspected.
    expect(result).toMatchObject({ status: "refused", reason: "target_confirmation_mismatch" });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });

  it("does not require confirmation for a read-only plan", async () => {
    const plan = await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK });

    expect(plan.status).toBe("would_change");
  });
});

describe("Clerk id format is validated conservatively", () => {
  it.each([
    ["empty", ""],
    ["no prefix", "2abcdefghijklmnopqrstuvwx"],
    ["wrong prefix", "usr_2abcdefghijklmnopqrstuvwx"],
    ["too short", "user_2abc"],
    ["oversized", "user_" + "a".repeat(200)],
    ["whitespace", "user_2abcdefghijklmnop qrstuv"],
    ["punctuation", "user_2abcdef;DROP TABLE users"],
    ["a whole pasted line", 'user_2abc" --clerk-user-id user_2def'],
    ["an email by mistake", "owner@innovera.test"],
  ])("refuses a %s id", async (_label, badId) => {
    expect(isValidClerkUserId(badId)).toBe(false);

    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: badId,
      expectedUserId: ownerId,
    });

    expect(result).toMatchObject({ status: "refused", reason: "invalid_clerk_user_id" });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
  });

  it("accepts a realistically shaped id", () => {
    expect(isValidClerkUserId("user_2abcdefghijklmnopqrstuvwx")).toBe(true);
  });

  it("cannot tell a development id from a production one, and does not pretend to", () => {
    // Both instances issue identically-shaped ids. The operator must take the target from
    // the Clerk production dashboard; no local check substitutes for that.
    expect(isValidClerkUserId("user_2devAAAABBBBCCCCDDDDEEEEFF")).toBe(true);
    expect(isValidClerkUserId("user_2liveZZZZYYYYXXXXWWWWVVVV")).toBe(true);
  });
});

describe("non-admin accounts keep their own role and status", () => {
  it("keeps a plain USER as USER", async () => {
    const plain = await seedUser({
      clerkUserId: "user_2plainAAAABBBBCCCCDDDDEE",
      email: "plain@innovera.test",
      role: "USER",
      status: "ACTIVE",
    });

    await applyMigration(prisma, {
      email: "plain@innovera.test",
      clerkUserId: "user_2plainNEWAAAABBBBCCCCDD",
      expectedUserId: plain.id,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: plain.id } });
    expect(after.role).toBe("USER");
    expect(after.status).toBe("ACTIVE");
    expect(after.id).toBe(plain.id);
  });

  it("keeps PENDING as PENDING — migration never approves anyone", async () => {
    const pending = await seedUser({
      clerkUserId: "user_2pendAAAABBBBCCCCDDDDEEE",
      email: "pending@innovera.test",
      role: "USER",
      status: "PENDING",
    });

    await applyMigration(prisma, {
      email: "pending@innovera.test",
      clerkUserId: "user_2pendNEWAAAABBBBCCCCDDD",
      expectedUserId: pending.id,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe("PENDING");
    expect(after.role).toBe("USER");
  });

  it("keeps a DISABLED account disabled", async () => {
    const disabled = await seedUser({
      clerkUserId: "user_2disAAAABBBBCCCCDDDDEEEE",
      email: "disabled@innovera.test",
      status: "DISABLED",
    });

    await applyMigration(prisma, {
      email: "disabled@innovera.test",
      clerkUserId: "user_2disNEWAAAABBBBCCCCDDDD",
      expectedUserId: disabled.id,
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: disabled.id } });
    expect(after.status).toBe("DISABLED");
  });
});

describe("the last ACTIVE ADMIN cannot be damaged", () => {
  it("migrating the sole admin leaves the admin count at one", async () => {
    expect(await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(1);

    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
      expectedUserId: ownerId,
    });

    expect(result.status).toBe("changed");
    expect(await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(1);
  });

  it("verifies the admin count inside the transaction, not merely afterwards", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("scripts/lib/clerk-identity-migration.mjs", "utf8");
    const tx = source.slice(source.indexOf("db.$transaction"));

    // Both counts and every verification must sit inside the transaction, or a failure
    // would leave the rebinding committed.
    expect(tx.indexOf("adminsBefore")).toBeGreaterThan(-1);
    expect(tx.indexOf("adminsAfter")).toBeGreaterThan(-1);
    expect(tx.indexOf("adminsAfter < adminsBefore")).toBeGreaterThan(tx.indexOf("user.update"));
    expect(source).toContain('isolationLevel: "Serializable"');
  });
});

describe("the rollback plan is returned, not reconstructed from console history", () => {
  it("carries the three identifiers needed to reverse the change", async () => {
    const result = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
      expectedUserId: ownerId,
    });

    if (result.status !== "changed") throw new Error("expected changed");

    expect(result.rollback).toMatchObject({
      userId: ownerId,
      previousClerkUserId: OLD_CLERK,
      targetClerkUserId: NEW_CLERK,
    });
    expect(result.rollback.command).toContain(OLD_CLERK);
    expect(result.rollback.command).toContain(ownerId);
  });

  it("restores the previous binding when the rollback plan is followed", async () => {
    const forward = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: NEW_CLERK,
      expectedUserId: ownerId,
    });

    if (forward.status !== "changed") throw new Error("expected changed");

    const back = await applyMigration(prisma, {
      email: OWNER_EMAIL,
      clerkUserId: forward.rollback.previousClerkUserId,
      expectedUserId: forward.rollback.userId,
    });

    expect(back.status).toBe("changed");

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.clerkUserId).toBe(OLD_CLERK);
    expect(owner.role).toBe("ADMIN");
    expect(owner.status).toBe("ACTIVE");
  });

  it("needs no database table of its own", async () => {
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const names = tables.map((t) => t.tablename);

    expect(names).not.toContain("ClerkMigration");
    expect(names).not.toContain("IdentityMigration");
    expect(names).not.toContain("MigrationAudit");
  });
});

describe("no secret material appears in any output", () => {
  it("emits no key, token or session value in any outcome", async () => {
    const outcomes = [
      await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: NEW_CLERK }),
      await applyMigration(prisma, {
        email: OWNER_EMAIL,
        clerkUserId: NEW_CLERK,
        expectedUserId: ownerId,
      }),
      await planMigration(prisma, { email: "nobody@x.test", clerkUserId: NEW_CLERK }),
      await planMigration(prisma, { email: OWNER_EMAIL, clerkUserId: "bad" }),
    ];

    const text = JSON.stringify(outcomes) + JSON.stringify(await surveyPrivilegedAccounts(prisma));

    for (const pattern of [/sk_live_/, /sk_test_/, /pk_live_/, /pk_test_/, /sess_/, /Bearer /]) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("never reads a Clerk key from the environment", async () => {
    const { readFileSync } = await import("node:fs");
    const toolSource = readFileSync("scripts/lib/clerk-identity-migration.mjs", "utf8");
    const cli = readFileSync("scripts/clerk-migrate-identity.mjs", "utf8");

    for (const source of [toolSource, cli]) {
      expect(source).not.toContain("CLERK_SECRET_KEY");
      expect(source).not.toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
      expect(source).not.toContain("@clerk/");
    }
  });

  it("masks addresses in the survey and in every outcome", async () => {
    const survey = await surveyPrivilegedAccounts(prisma);
    const plan = await planMigration(prisma, { email: "nobody@innovera.test", clerkUserId: NEW_CLERK });

    expect(JSON.stringify(survey)).not.toContain("owner@");
    if (plan.status !== "refused") throw new Error("expected refusal");
    expect(plan.detail).not.toContain("nobody@");
    expect(plan.detail).toContain("@innovera.test");
  });
});

describe("the normal authentication path is untouched", () => {
  it("current-app-user.ts is byte-identical to the approved M3 commit", async () => {
    const { execSync } = await import("node:child_process");

    const committed = execSync(
      "git show 94668448501e39372897e46c82a09642dbfb043d:src/lib/current-app-user.ts",
      { encoding: "utf8" }
    );
    const working = execSync("cat src/lib/current-app-user.ts", { encoding: "utf8" });

    // The migration must not have been made to work by relaxing normal sign-in.
    expect(working).toBe(committed);
  });

  it("changes no file outside the three migration paths", async () => {
    const { execSync } = await import("node:child_process");

    const changed = execSync(
      "git status --porcelain 94668448501e39372897e46c82a09642dbfb043d",
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0);

    const allowed = [
      "scripts/clerk-migrate-identity.mjs",
      "src/lib/admin/",
      "tests/integration/clerk-identity-migration.test.ts",
    ];

    for (const path of changed) {
      expect(allowed.some((a) => path.startsWith(a))).toBe(true);
    }
  });
});
