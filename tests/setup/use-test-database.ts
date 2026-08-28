import { inject } from "vitest";
import { assertSafeDatabaseUrl } from "./guards";

// Runs before any test module is imported, so `@/lib/prisma` constructs its client
// against the test database and never the application's own DATABASE_URL.
const databaseUrl = inject("databaseUrl");
assertSafeDatabaseUrl(databaseUrl, "injected test database URL");
process.env.DATABASE_URL = databaseUrl;

// Upstream is always an ephemeral local server started per test file. Set a placeholder
// so nothing can inherit a real endpoint from the developer's shell.
process.env.LITELLM_BASE_URL = "http://127.0.0.1:1";
process.env.LITELLM_API_KEY = "test-not-a-secret";

// Clerk is mocked at the module boundary, so no real key is ever used — but readiness
// validates that the variable is PRESENT, and a deployment missing it is genuinely not
// ready. A placeholder keeps that check meaningful without introducing a secret.
process.env.CLERK_SECRET_KEY = "test-clerk-placeholder-not-a-secret";
