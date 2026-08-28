import { prisma } from "@/lib/prisma";

/** Wipes all application tables between tests. Order is irrelevant thanks to CASCADE. */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Usage","Message","Conversation","User" RESTART IDENTITY CASCADE'
  );
}

export { prisma };
