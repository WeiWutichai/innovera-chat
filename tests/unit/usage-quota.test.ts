import { describe, it, expect } from "vitest";
import { startOfBangkokDayUtc } from "@/lib/usage-quota";

/** Thailand is a fixed UTC+7 with no daylight saving, so the boundary is exact. */
describe("Asia/Bangkok day boundary", () => {
  it("starts the day at 17:00Z the previous calendar day", () => {
    const start = startOfBangkokDayUtc(new Date("2026-08-28T05:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-27T17:00:00.000Z");
  });

  it("does not roll over just before Bangkok midnight", () => {
    // 16:59:59Z == 23:59:59 Bangkok, still the same Bangkok day.
    const start = startOfBangkokDayUtc(new Date("2026-08-28T16:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-08-27T17:00:00.000Z");
  });

  it("rolls over exactly at Bangkok midnight", () => {
    const start = startOfBangkokDayUtc(new Date("2026-08-28T17:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-28T17:00:00.000Z");
  });

  it("is not the UTC day boundary", () => {
    // 02:00Z on the 28th is 09:00 Bangkok — the Bangkok day began on the 27th UTC.
    const start = startOfBangkokDayUtc(new Date("2026-08-28T02:00:00.000Z"));
    expect(start.getUTCDate()).toBe(27);
    expect(start.getUTCHours()).toBe(17);
  });

  it("is not a rolling 24-hour window", () => {
    const morning = startOfBangkokDayUtc(new Date("2026-08-28T06:00:00.000Z"));
    const evening = startOfBangkokDayUtc(new Date("2026-08-28T15:00:00.000Z"));
    expect(morning.getTime()).toBe(evening.getTime());
  });

  it("advances by exactly 24 hours across a day change", () => {
    const day1 = startOfBangkokDayUtc(new Date("2026-08-28T10:00:00.000Z"));
    const day2 = startOfBangkokDayUtc(new Date("2026-08-29T10:00:00.000Z"));
    expect(day2.getTime() - day1.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
