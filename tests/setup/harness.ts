import { beforeAll, afterAll, beforeEach } from "vitest";
import { UpstreamServer } from "./upstream";
import { resetDatabase, prisma } from "./database";
import { __resetLimiters } from "@/lib/rate-limiter";
import { signedOut } from "./clerk";

/**
 * Standard wiring for a chat integration suite: an ephemeral upstream server, a clean
 * database, and reset process-wide limiter state before every test.
 */
export function setupChatHarness() {
  const upstream = new UpstreamServer();

  beforeAll(async () => {
    process.env.LITELLM_BASE_URL = await upstream.start();
    process.env.LITELLM_API_KEY = "test-key-not-a-secret";
  });

  afterAll(async () => {
    await upstream.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    __resetLimiters();
    upstream.reset();
    signedOut();
  });

  return upstream;
}
