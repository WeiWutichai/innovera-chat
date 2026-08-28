import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stand-in for `@clerk/nextjs/server`.
 *
 * Clerk is a third-party identity provider; faking it at the module boundary is the
 * supported seam (`vi.mock`), and it is the only thing these tests fake — the route
 * handlers, Prisma queries, transactions and isolation levels are all real.
 *
 * Actor state lives in AsyncLocalStorage so concurrent requests can run as *different*
 * users simultaneously, which the admin write-skew test requires.
 */
export type TestActor = {
  userId: string | null;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
};

const storage = new AsyncLocalStorage<TestActor>();
let fallbackActor: TestActor = { userId: null };

function currentActor(): TestActor {
  return storage.getStore() ?? fallbackActor;
}

/** Run `fn` with the given actor as the signed-in user. */
export function actingAs<T>(actor: TestActor, fn: () => Promise<T>): Promise<T> {
  return storage.run(actor, fn);
}

/** Set the actor used when no actingAs scope is active. */
export function setDefaultActor(actor: TestActor) {
  fallbackActor = actor;
}

/** Convenience: nobody is signed in. */
export function signedOut() {
  fallbackActor = { userId: null };
}

// ---- the mocked Clerk surface -------------------------------------------------

export async function auth() {
  const actor = currentActor();

  return {
    userId: actor.userId,
    isAuthenticated: Boolean(actor.userId),
    redirectToSignIn: () => {
      const error = new Error("REDIRECT_TO_SIGN_IN") as Error & { isRedirect: boolean };
      error.isRedirect = true;
      throw error;
    },
  };
}

export async function currentUser() {
  const actor = currentActor();

  if (!actor.userId) return null;

  return {
    id: actor.userId,
    primaryEmailAddressId: "eid_1",
    emailAddresses: [{ id: "eid_1", emailAddress: actor.email }],
    firstName: actor.firstName ?? null,
    lastName: actor.lastName ?? null,
  };
}
