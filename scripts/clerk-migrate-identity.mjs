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
 *   Supply the target id from a file instead of the command line:
 *     node scripts/clerk-migrate-identity.mjs --email owner@example.com \
 *       --clerk-user-id-file /path/to/id --confirm-user-id <User.id> --apply
 *
 * --clerk-user-id-file exists so the target identity never has to appear on the command
 * line (where `ps` and shell history can see it), in .env.local, or in a chat transcript.
 * It is mutually exclusive with --clerk-user-id.
 *
 * RUNTIME: plain ESM, no TypeScript, no flags. It runs on any Node >= 18. An earlier
 * revision imported a .ts module through a .js specifier, which no Node runtime resolves;
 * the CLI could not start at all. See scripts/lib/clerk-identity-migration.mjs.
 *
 * DATABASE_URL must be set. No key, token or session value is read, printed or written by
 * this tool; email addresses appear masked and the target id is never printed in full.
 */

/** Never emit a target id in full — not in output, not in an error. */
function maskId(id) {
  return typeof id === "string" && id.length > 8 ? `${id.slice(0, 8)}\u2026` : "\u2026";
}

/**
 * Reads exactly one Clerk user id from a file.
 *
 * Returns { id } or { error } — and the error NEVER contains the file's contents, so a
 * malformed file cannot leak the value it holds into a terminal or a ticket.
 */
function readClerkIdFile(path) {
  let raw;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: `cannot read --clerk-user-id-file at the given path` };
  }

  // Only CR/LF are stripped. A value carrying stray spaces stays invalid rather than
  // being silently repaired into something that passes validation.
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/^[\r\n]+|[\r\n]+$/g, ""));
  const values = lines.filter((l) => l.length > 0);

  if (values.length === 0) return { error: "--clerk-user-id-file is empty" };
  if (values.length > 1) {
    return { error: `--clerk-user-id-file contains ${values.length} non-empty lines; expected exactly 1` };
  }

  if (!isValidClerkUserId(values[0])) {
    return { error: "--clerk-user-id-file does not contain a valid Clerk user id" };
  }

  return { id: values[0] };
}
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  planMigration,
  applyMigration,
  surveyPrivilegedAccounts,
  maskEmail,
  isValidClerkUserId,
} from "./lib/clerk-identity-migration.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const has = (name) => process.argv.includes(`--${name}`);

function usage() {
  console.error("usage:");
  console.error("  --survey");
  console.error("  --email <address> (--clerk-user-id <user_...> | --clerk-user-id-file <path>) [--case-insensitive]");
  console.error("  --email <address> (--clerk-user-id <user_...> | --clerk-user-id-file <path>) --confirm-user-id <User.id> --apply");
  console.error("");
  console.error("  --clerk-user-id and --clerk-user-id-file are mutually exclusive.");
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
    const inlineId = arg("clerk-user-id");
    const idFile = arg("clerk-user-id-file");

    if (inlineId && idFile) {
      console.error("REFUSED: --clerk-user-id and --clerk-user-id-file are mutually exclusive.");
      usage();
      return 2;
    }

    let clerkUserId = inlineId;

    if (idFile) {
      const read = readClerkIdFile(idFile);

      if (read.error) {
        // The message names the problem, never the value.
        console.error(`REFUSED: ${read.error}`);
        return 1;
      }

      clerkUserId = read.id;
    }

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
          `ALREADY BOUND — ${maskEmail(result.matchedEmail)} (User.id=${result.userId}) is already bound to ${maskId(result.nextClerkUserId)}. Nothing to do.`
        );
        return 0;

      case "would_change":
        console.log("DRY RUN — nothing was written.\n");
        console.log(`  matched      ${maskEmail(result.matchedEmail)}`);
        console.log(`  User.id      ${result.userId}`);
        console.log(`  role         ${result.role}      (unchanged by this migration)`);
        console.log(`  status       ${result.userStatus}      (unchanged by this migration)`);
        console.log(`  clerkUserId  ${maskId(result.previousClerkUserId)}`);
        console.log(`            -> ${maskId(result.nextClerkUserId)}`);
        console.log("\n  To apply, re-run with:");
        console.log(`    --confirm-user-id ${result.userId} --apply`);
        return 0;

      case "changed":
        console.log("APPLIED.\n");
        console.log(`  matched      ${maskEmail(result.matchedEmail)}`);
        console.log(`  User.id      ${result.userId}      (verified unchanged)`);
        console.log(`  role         ${result.role}      (verified unchanged)`);
        console.log(`  status       ${result.userStatus}      (verified unchanged)`);
        console.log(`  clerkUserId  ${maskId(result.rollback.previousClerkUserId)}`);
        console.log(`            -> ${maskId(result.rollback.targetClerkUserId)}`);
        // ROLLBACK INSTRUCTION.
        //
        // The PREVIOUS id is printed in full, deliberately and as the sole exception.
        // Only this tool ever learns it: it is read from the database and immediately
        // overwritten, so masking it would make the migration irreversible. It is the
        // superseded DEVELOPMENT identity, not the production one being introduced.
        //
        // The TARGET id stays masked — the operator supplied it and already holds it,
        // so printing it back would put the production identity into terminal
        // scrollback and pasted tickets for no operational gain.
        console.log("\n  ROLLBACK INSTRUCTION — record this now:");
        console.log(`    User.id              ${result.rollback.userId}`);
        console.log(`    previous clerkUserId ${result.rollback.previousClerkUserId}   <- needed to reverse`);
        console.log(`    target   clerkUserId ${maskId(result.rollback.targetClerkUserId)}`);
        console.log(`    reverse with         --clerk-user-id ${result.rollback.previousClerkUserId} --confirm-user-id ${result.rollback.userId} --apply`);
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
