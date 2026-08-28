import { prisma } from "@/lib/prisma";
import type { UserRole, UserStatus } from "@prisma/client";

let counter = 0;

export async function seedUser(overrides: {
  clerkUserId?: string;
  email?: string;
  name?: string | null;
  role?: UserRole;
  status?: UserStatus;
  dailyTokenLimit?: number;
} = {}) {
  counter += 1;

  return prisma.user.create({
    data: {
      clerkUserId: overrides.clerkUserId ?? `clerk_test_${counter}`,
      email: overrides.email ?? `user${counter}@test.local`,
      name: overrides.name ?? null,
      role: overrides.role ?? "USER",
      status: overrides.status ?? "ACTIVE",
      ...(overrides.dailyTokenLimit !== undefined
        ? { dailyTokenLimit: overrides.dailyTokenLimit }
        : {}),
    },
  });
}

export function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}
