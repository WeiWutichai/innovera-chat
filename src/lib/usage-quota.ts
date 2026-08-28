import { prisma } from "@/lib/prisma";

// Thailand is a fixed UTC+7 with no daylight saving, so the day boundary is exact
// arithmetic and needs no timezone database.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC instant at which the current Asia/Bangkok calendar day began. */
export function startOfBangkokDayUtc(now: Date = new Date()): Date {
  const shifted = now.getTime() + BANGKOK_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS);
}

/** Tokens the user has actually consumed since the start of the Bangkok day. */
export async function getTokensUsedToday(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const result = await prisma.usage.aggregate({
    _sum: { totalTokens: true },
    where: {
      userId,
      createdAt: { gte: startOfBangkokDayUtc(now) },
    },
  });

  return result._sum.totalTokens ?? 0;
}

export type QuotaCheck = {
  withinQuota: boolean;
  used: number;
  limit: number;
};

/**
 * Quota is evaluated from usage already recorded, because a completion's true cost is
 * unknowable until the model has produced it. A request that starts under the limit is
 * therefore always allowed to finish, and the day can overshoot by the cost of the
 * requests that were already in flight when the limit was crossed.
 *
 * That overshoot is bounded because a concurrency slot is acquired BEFORE this check:
 * at most `maxConcurrentPerUser` requests can be racing it at any moment.
 */
export async function checkDailyQuota(
  userId: string,
  dailyTokenLimit: number,
  now: Date = new Date()
): Promise<QuotaCheck> {
  const used = await getTokensUsedToday(userId, now);

  return {
    withinQuota: used < dailyTokenLimit,
    used,
    limit: dailyTokenLimit,
  };
}
