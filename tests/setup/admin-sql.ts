import { PrismaClient } from "@prisma/client";

/**
 * Runs maintenance SQL (CREATE/DROP DATABASE) against a given connection URL.
 *
 * Uses the already-installed Prisma client with a runtime datasource override rather
 * than adding a separate driver dependency. The schema is irrelevant here — only raw
 * statements are issued.
 */
export async function withAdminConnection<T>(
  url: string,
  fn: (client: PrismaClient) => Promise<T>
): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

export function withDatabase(baseUrl: string, database: string) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
