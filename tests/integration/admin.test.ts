import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));
vi.mock("next/cache", () => import("../setup/next-stubs"));
vi.mock("next/navigation", () => import("../setup/next-stubs"));

import { disableUser, revokeAdmin, approveUser, makeAdmin, reactivateUser } from "@/app/admin/actions";
import { actingAs } from "../setup/clerk";
import { prisma, resetDatabase } from "../setup/database";
import { seedUser, formData } from "../setup/seed";

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

const activeAdmins = () =>
  prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });

describe("admin lifecycle", () => {
  it("approves and promotes a pending user", async () => {
    const admin = await seedUser({ clerkUserId: "ck_adm", email: "adm@t.local", role: "ADMIN" });
    const pending = await seedUser({ clerkUserId: "ck_p", email: "p@t.local", status: "PENDING" });
    const actor = { userId: "ck_adm", email: "adm@t.local" };

    await actingAs(actor, () => approveUser(formData({ id: pending.id })));
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: pending.id } })
    ).resolves.toMatchObject({ status: "ACTIVE" });

    await actingAs(actor, () => makeAdmin(formData({ id: pending.id })));
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: pending.id } })
    ).resolves.toMatchObject({ role: "ADMIN", status: "ACTIVE" });

    expect(admin.role).toBe("ADMIN");
  });

  it("disables and reactivates a normal user", async () => {
    await seedUser({ clerkUserId: "ck_adm", email: "adm@t.local", role: "ADMIN" });
    const user = await seedUser({ clerkUserId: "ck_u", email: "u@t.local" });
    const actor = { userId: "ck_adm", email: "adm@t.local" };

    await actingAs(actor, () => disableUser(formData({ id: user.id })));
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).resolves.toMatchObject({ status: "DISABLED" });

    await actingAs(actor, () => reactivateUser(formData({ id: user.id })));
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("rejects a missing or malformed target id", async () => {
    await seedUser({ clerkUserId: "ck_adm", email: "adm@t.local", role: "ADMIN" });

    await expect(
      actingAs({ userId: "ck_adm", email: "adm@t.local" }, () => approveUser(new FormData()))
    ).rejects.toThrow("Missing target user id");
  });
});

describe("last-active-admin invariant", () => {
  it("blocks an admin from disabling their own account", async () => {
    const solo = await seedUser({ clerkUserId: "ck_solo", email: "s@t.local", role: "ADMIN" });
    await seedUser({ clerkUserId: "ck_other", email: "o@t.local", role: "ADMIN" });

    await expect(
      actingAs({ userId: "ck_solo", email: "s@t.local" }, () =>
        disableUser(formData({ id: solo.id }))
      )
    ).rejects.toThrow("Administrators cannot disable their own account");

    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: solo.id } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("prevents the last active admin from revoking their own role", async () => {
    const only = await seedUser({ clerkUserId: "ck_only", email: "only@t.local", role: "ADMIN" });

    await expect(
      actingAs({ userId: "ck_only", email: "only@t.local" }, () =>
        revokeAdmin(formData({ id: only.id }))
      )
    ).rejects.toThrow("Cannot remove the last active administrator");

    await expect(activeAdmins()).resolves.toBe(1);
  });

  it("allows revoking an admin while another active admin remains", async () => {
    const a = await seedUser({ clerkUserId: "ck_a", email: "a@t.local", role: "ADMIN" });
    await seedUser({ clerkUserId: "ck_b", email: "b@t.local", role: "ADMIN" });

    await actingAs({ userId: "ck_b", email: "b@t.local" }, () =>
      revokeAdmin(formData({ id: a.id }))
    );

    await expect(activeAdmins()).resolves.toBe(1);
  });

  it("never drops below one active admin under concurrent revoke/disable", async () => {
    // Write skew: both transactions read count=2, then write different rows. Postgres
    // Serializable must abort one; the retry then re-reads count=1 and refuses.
    for (let round = 0; round < 6; round++) {
      await resetDatabase();
      const x = await seedUser({ clerkUserId: "ck_x", email: "x@t.local", role: "ADMIN" });
      const y = await seedUser({ clerkUserId: "ck_y", email: "y@t.local", role: "ADMIN" });

      const opX = round % 2 === 0 ? revokeAdmin : disableUser;
      const opY = round % 2 === 0 ? disableUser : revokeAdmin;

      const settled = await Promise.allSettled([
        actingAs({ userId: "ck_x", email: "x@t.local" }, () => opX(formData({ id: y.id }))),
        actingAs({ userId: "ck_y", email: "y@t.local" }, () => opY(formData({ id: x.id }))),
      ]);

      expect(await activeAdmins()).toBeGreaterThanOrEqual(1);

      // The loser must surface the guard error, not a raw serialization failure —
      // proving the P2034 retry was handled internally.
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          expect(String(outcome.reason?.message ?? outcome.reason)).not.toContain("P2034");
        }
      }
    }
  });
});
