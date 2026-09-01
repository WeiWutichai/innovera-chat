/**
 * Controlled Clerk identity migration.
 *
 * ============================ WHY THIS IS PLAIN JAVASCRIPT ======================
 * This module is loaded by an OPERATOR CLI during a production cutover, not by the
 * application. It was previously TypeScript, and that made the CLI unrunnable: Node does
 * not resolve a `.js` import specifier to a `.ts` file, and stripping types needs Node 22
 * plus `--experimental-strip-types`. The defect survived review because the test suite
 * imported the MODULE through Vitest (which resolves TypeScript natively) and never
 * executed the CLI wrapper.
 *
 * Plain ESM removes the whole class of problem: it runs on any Node >= 18, needs no
 * flags, and can be exercised by a test that spawns the real CLI. Behaviour is unchanged
 * and is pinned by the same 48 tests; JSDoc carries the shapes the types used to.
 *
 * ============================== WHY THIS EXISTS =================================
 * Switching Clerk from the development instance to the production instance gives every
 * user a brand-new `clerkUserId` while their email stays the same. The ordinary sign-in
 * path handles that collision in `current-app-user.ts`, and it does so DELIBERATELY
 * DESTRUCTIVELY: it re-links by email and then forces `status = PENDING, role = USER`,
 * because in normal operation "a new Clerk account claiming an existing email" is exactly
 * what an account-takeover attempt looks like.
 *
 * That behaviour is correct and is NOT weakened here — `current-app-user.ts` is untouched,
 * and a test asserts it stays byte-identical to the approved M3 commit. But applied to the
 * one-time instance cutover it demotes the only ADMIN, and `makeAdmin` is itself gated by
 * `requireAdmin`, so the system reaches zero ACTIVE ADMINs with no way back.
 *
 * This module is the narrow, explicit alternative. Run BEFORE the new build is deployed,
 * it rebinds `clerkUserId` on ONE row the operator names, and changes nothing else. The
 * next sign-in then matches on `clerkUserId`, takes the upsert's UPDATE branch, and never
 * reaches the collision path at all.
 *
 * ================================ WHAT IT WILL NOT DO ===========================
 *  - It is not reachable from any route. It never reads an identifier from a request.
 *  - It never writes `id`, `role`, `status`, `email` or `dailyTokenLimit`.
 *  - It never creates a User row. A missing email is a refusal, not a signup.
 *  - It refuses to bind a Clerk id that already belongs to a different row, so it cannot
 *    merge two accounts or hand one person another's conversations.
 *  - It migrates ONE account per invocation. There is no bulk mode, and no mode that
 *    discovers Clerk ids for itself — the operator must obtain each id from the Clerk
 *    production dashboard.
 *  - It refuses if the change would reduce the number of ACTIVE ADMINs.
 *
 * ================================== CASE POLICY =================================
 * `User.email` is a case-sensitive unique btree and nothing in the application lowercases
 * addresses. The default match is therefore EXACT — byte for byte. An operator who knows
 * the production Clerk address differs only in case may pass `caseInsensitive`, which
 * matches case-insensitively but REFUSES when that matches more than one row, so a fold
 * can never silently pick the wrong account. Stored data is never rewritten to lower case.
 * =================================================================================
 */


/**
 * Conservative shape check for a Clerk user id.
 *
 * Clerk issues `user_` followed by an opaque base58-ish token. Accepting arbitrary long
 * strings would let a typo — or a pasted line of unrelated output — become a binding.
 *
 * THIS DOES NOT AND CANNOT DISTINGUISH A DEVELOPMENT ID FROM A PRODUCTION ONE. Both
 * instances issue identically-shaped ids. The operator must obtain the target id from the
 * Clerk PRODUCTION dashboard; no check here can substitute for that.
 */
const CLERK_USER_ID = /^user_[A-Za-z0-9]{16,64}$/;
const CLERK_USER_ID_MAX_LENGTH = 80;

export function isValidClerkUserId(value) {
  return value.length <= CLERK_USER_ID_MAX_LENGTH && CLERK_USER_ID.test(value);
}

/** Masks an address for output. Migration runs are logged, and addresses are personal data. */
export function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0) return "***";

  const local = email.slice(0, at);
  const domain = email.slice(at);

  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, local.length - 1))}${domain}`;
}

function rollbackFor(userId, previous, target) {
  return {
    userId,
    previousClerkUserId: previous,
    targetClerkUserId: target,
    command:
      `node scripts/clerk-migrate-identity.mjs --email <same address> ` +
      `--clerk-user-id ${previous} --confirm-user-id ${userId} --apply`,
  };
}

async function findByEmail(db, email, caseInsensitive) {
  const select = {
    id: true,
    email: true,
    clerkUserId: true,
    role: true,
    status: true,
  };

  if (!caseInsensitive) {
    const row = await db.user.findUnique({ where: { email }, select });
    return row ? [row] : [];
  }

  return db.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select,
    orderBy: { id: "asc" },
  });
}

/**
 * Read-only. Reports exactly what `apply` would do, and refuses for the same reasons.
 *
 * The dry run and the real run share this function, so a plan that reports `would_change`
 * cannot be followed by an apply that does something different.
 */
export async function planMigration(db, input) {
  if (!isValidClerkUserId(input.clerkUserId)) {
    return {
      status: "refused",
      reason: "invalid_clerk_user_id",
      detail:
        "target id is not a plausible Clerk user id (expected user_ followed by 16-64 alphanumerics)",
    };
  }

  const caseInsensitive = input.caseInsensitive ?? false;
  const rows = await findByEmail(db, input.email, caseInsensitive);

  if (rows.length === 0) {
    return {
      status: "refused",
      reason: "email_not_found",
      detail: `no User row matches ${maskEmail(input.email)}${caseInsensitive ? " (case-insensitive)" : " (exact match)"}`,
    };
  }

  if (rows.length > 1) {
    // Only reachable under caseInsensitive: the unique index guarantees one exact match.
    return {
      status: "refused",
      reason: "ambiguous_email",
      detail: `${rows.length} rows match ${maskEmail(input.email)} case-insensitively; refusing rather than guessing`,
    };
  }

  const target = rows[0];

  if (input.expectedUserId !== undefined && input.expectedUserId !== target.id) {
    return {
      status: "refused",
      reason: "target_confirmation_mismatch",
      detail:
        "the confirmed User.id does not match the row this address resolves to; re-run the dry run",
    };
  }

  if (target.clerkUserId === input.clerkUserId) {
    return {
      status: "already_bound",
      userId: target.id,
      nextClerkUserId: input.clerkUserId,
      matchedEmail: target.email,
    };
  }

  const holder = await db.user.findUnique({
    where: { clerkUserId: input.clerkUserId },
    select: { id: true },
  });

  if (holder && holder.id !== target.id) {
    return {
      status: "refused",
      reason: "clerk_id_belongs_to_another_user",
      detail:
        "that Clerk identity is already bound to a different account; refusing to merge two accounts",
    };
  }

  return {
    status: "would_change",
    userId: target.id,
    previousClerkUserId: target.clerkUserId,
    nextClerkUserId: input.clerkUserId,
    matchedEmail: target.email,
    role: target.role,
    userStatus: target.status,
  };
}

/**
 * Applies the rebinding inside ONE Serializable transaction.
 *
 * Serializable, not the default: the resolve, the ownership check, the write and the
 * post-write verification must not be interleaved with a concurrent `revokeAdmin` or
 * `disableUser`. That is the same isolation level `admin/actions.ts` uses to protect the
 * last-active-admin invariant, and this path must not be the weak one.
 *
 * Everything below happens inside that transaction, and any mismatch throws — so the
 * write is rolled back and the row is left exactly as it was.
 */
export async function applyMigration(db, input) {
  // Required for apply, optional for plan: the operator must echo back the User.id the
  // dry run showed them, so an apply cannot land on a row they never inspected.
  if (!input.expectedUserId) {
    return {
      status: "refused",
      reason: "missing_target_confirmation",
      detail:
        "--apply requires --confirm-user-id with the User.id reported by the dry run",
    };
  }

  try {
    return await db.$transaction(
      async (tx) => {
        const client = tx;

        // 1. Resolve, validate and confirm the target — inside the transaction.
        const plan = await planMigration(client, input);

        // Idempotent: a second run of the same migration is a no-op, not an error, so a
        // retried or half-finished cutover can simply be run again.
        if (plan.status !== "would_change") return plan;

        // 2. Record the binding and privileges as they are right now.
        const before = await client.user.findUniqueOrThrow({
          where: { id: plan.userId },
          select: { id: true, clerkUserId: true, role: true, status: true, email: true },
        });

        const adminsBefore = await client.user.count({
          where: { role: "ADMIN", status: "ACTIVE" },
        });

        // 3. The only write. `id`, `role`, `status`, `email` and `dailyTokenLimit` are
        //    absent by design, not by omission.
        await client.user.update({
          where: { id: plan.userId },
          data: { clerkUserId: input.clerkUserId },
        });

        // 4. Verify — still inside the transaction, so any failure rolls the write back.
        const after = await client.user.findUniqueOrThrow({
          where: { id: plan.userId },
          select: { id: true, clerkUserId: true, role: true, status: true, email: true },
        });

        if (after.id !== before.id) throw new Error("verification failed: User.id changed");
        if (after.role !== before.role) throw new Error("verification failed: role changed");
        if (after.status !== before.status) throw new Error("verification failed: status changed");
        if (after.email !== before.email) throw new Error("verification failed: email changed");
        if (after.clerkUserId !== input.clerkUserId) {
          throw new Error("verification failed: clerkUserId was not rebound");
        }

        const adminsAfter = await client.user.count({
          where: { role: "ADMIN", status: "ACTIVE" },
        });

        if (adminsAfter < adminsBefore) {
          throw new Error("verification failed: active admin count decreased");
        }

        return {
          status: "changed",
          userId: plan.userId,
          previousClerkUserId: before.clerkUserId,
          nextClerkUserId: input.clerkUserId,
          matchedEmail: before.email,
          role: after.role,
          userStatus: after.status,
          rollback: rollbackFor(plan.userId, before.clerkUserId, input.clerkUserId),
        };
      },
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    // A failed verification must surface as a refusal, not a stack trace. The write has
    // already been rolled back by the transaction.
    const message = error instanceof Error ? error.message : "unknown error";

    if (message.startsWith("verification failed")) {
      return { status: "refused", reason: "verification_failed", detail: message };
    }

    throw error;
  }
}

/** Read-only survey: who must be pre-bound before the cutover. Addresses are masked. */
export async function surveyPrivilegedAccounts(db) {
  const rows = await db.user.findMany({
    where: { OR: [{ role: "ADMIN" }, { status: "ACTIVE" }] },
    select: { id: true, email: true, role: true, status: true, clerkUserId: true },
    orderBy: [{ role: "asc" }, { id: "asc" }],
  });

  return rows.map((r) => ({
    userId: r.id,
    email: maskEmail(r.email),
    role: r.role,
    status: r.status,
    // Enough to tell one binding from another without reproducing the whole id.
    clerkUserIdPrefix: r.clerkUserId.slice(0, 8),
  }));
}
