#!/usr/bin/env node
/**
 * Controlled Clerk identity migration — CLI.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed, and --apply also
 * requires --confirm-user-id echoing the User.id the dry run reported.
 *
 * Run this BEFORE deploying the build that carries the production Clerk key. Rebinding
 * first means the first sign-in matches on clerkUserId and takes the upsert's UPDATE
 * branch, so role and status are never touched. Running it AFTER the demotion has already
 * happened also works, but then role and status must be restored separately — which is
 * the situation this tool exists to avoid.
 *
 *   Survey who needs pre-binding (read-only, addresses masked):
 *     node scripts/clerk-migrate-identity.mjs --survey
 *
 *   Dry run one account (read-only):
 *     node scripts/clerk-migrate-identity.mjs --email owner@example.com \
 *       --clerk-user-id user_2xxxxxxxxxxxxxxxxxxxxxxxxx
 *
 *   Apply it (note the confirmation from the dry run):
 *     node scripts/clerk-migrate-identity.mjs --email owner@example.com \
 *       --clerk-user-id user_2xxxxxxxxxxxxxxxxxxxxxxxxx \
 *       --confirm-user-id <User.id from the dry run> --apply
 *
 * ONE ACCOUNT PER INVOCATION. There is no bulk mode by design.
 *
 * The target Clerk user id must be read from the Clerk PRODUCTION dashboard. This tool
 * cannot tell a development id from a production one — they are shaped identically — and
 * it never contacts Clerk to find out.
 *
 * DATABASE_URL must be set. No key, token or session value is read, printed or written by
 * this tool; email addresses appear masked.
 */
import { PrismaClient } from "@prisma/client";
import {
  planMigration,
  applyMigration,
  surveyPrivilegedAccounts,
  maskEmail,
} from "../src/lib/admin/clerk-identity-migration.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const has = (name) => process.argv.includes(`--${name}`);

function usage() {
  console.error("usage:");
  console.error("  --survey");
  console.error("  --email <address> --clerk-user-id <user_...> [--case-insensitive]");
  console.error("  --email <address> --clerk-user-id <user_...> --confirm-user-id <User.id> --apply");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    return 2;
  }

  const db = new PrismaClient();

  try {
    if (has("survey")) {
      const rows = await surveyPrivilegedAccounts(db);

      console.log("Accounts that are ADMIN and/or ACTIVE (addresses masked, read-only):\n");
      for (const r of rows) {
        console.log(
          `  ${r.role.padEnd(5)} ${r.status.padEnd(8)} ${r.email.padEnd(28)} User.id=${r.userId} clerk=${r.clerkUserIdPrefix}...`
        );
      }

      const admins = rows.filter((r) => r.role === "ADMIN" && r.status === "ACTIVE").length;
      console.log(
        `\n${admins} ACTIVE ADMIN(s). Every one must be pre-bound before the Clerk cutover,`
      );
      console.log("or the first sign-in demotes them to PENDING/USER with no way back.");
      return 0;
    }

    const email = arg("email");
    const clerkUserId = arg("clerk-user-id");

    if (!email || !clerkUserId) {
      usage();
      return 2;
    }

    const applying = has("apply");
    const confirmUserId = arg("confirm-user-id");

    if (applying && !confirmUserId) {
      console.error("--apply requires --confirm-user-id with the User.id from the dry run.");
      usage();
      return 2;
    }

    const input = {
      email,
      clerkUserId,
      caseInsensitive: has("case-insensitive"),
      ...(confirmUserId ? { expectedUserId: confirmUserId } : {}),
    };

    const result = applying
      ? await applyMigration(db, input)
      : await planMigration(db, input);

    switch (result.status) {
      case "refused":
        console.error(`REFUSED (${result.reason}): ${result.detail}`);
        return 1;

      case "already_bound":
        console.log(
          `ALREADY BOUND — ${maskEmail(result.matchedEmail)} (User.id=${result.userId}) is already bound to ${result.nextClerkUserId}. Nothing to do.`
        );
        return 0;

      case "would_change":
        console.log("DRY RUN — nothing was written.\n");
        console.log(`  matched      ${maskEmail(result.matchedEmail)}`);
        console.log(`  User.id      ${result.userId}`);
        console.log(`  role         ${result.role}      (unchanged by this migration)`);
        console.log(`  status       ${result.userStatus}      (unchanged by this migration)`);
        console.log(`  clerkUserId  ${result.previousClerkUserId}`);
        console.log(`            -> ${result.nextClerkUserId}`);
        console.log("\n  To apply, re-run with:");
        console.log(`    --confirm-user-id ${result.userId} --apply`);
        return 0;

      case "changed":
        console.log("APPLIED.\n");
        console.log(`  matched      ${maskEmail(result.matchedEmail)}`);
        console.log(`  User.id      ${result.userId}      (verified unchanged)`);
        console.log(`  role         ${result.role}      (verified unchanged)`);
        console.log(`  status       ${result.userStatus}      (verified unchanged)`);
        console.log(`  clerkUserId  ${result.rollback.previousClerkUserId}`);
        console.log(`            -> ${result.rollback.targetClerkUserId}`);
        console.log("\n  ROLLBACK INSTRUCTION — record this now:");
        console.log(`    User.id              ${result.rollback.userId}`);
        console.log(`    previous clerkUserId ${result.rollback.previousClerkUserId}`);
        console.log(`    target   clerkUserId ${result.rollback.targetClerkUserId}`);
        console.log(`    command              ${result.rollback.command}`);
        return 0;

      default:
        return 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    // Never a stack trace: this runs against production data and its output is pasted
    // into tickets.
    console.error(`FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  }
);
