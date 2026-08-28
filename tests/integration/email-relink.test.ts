import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));
vi.mock("next/cache", () => import("../setup/next-stubs"));
vi.mock("next/navigation", () => import("../setup/next-stubs"));

import { getCurrentAppUser } from "@/lib/current-app-user";
import { approveUser } from "@/app/admin/actions";
import { actingAs } from "../setup/clerk";
import { prisma, resetDatabase } from "../setup/database";
import { seedUser, formData } from "../setup/seed";

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("Clerk identity re-link on an email collision", () => {
  it("re-links the existing row and resets BOTH status and role", async () => {
    const old = await seedUser({
      clerkUserId: "ck_old", email: "reuse@t.local", name: "Old", role: "ADMIN", status: "ACTIVE",
    });

    const relinked = await actingAs(
      { userId: "ck_new", email: "reuse@t.local", firstName: "New" },
      () => getCurrentAppUser()
    );

    expect(relinked).toMatchObject({
      id: old.id,
      clerkUserId: "ck_new",
      status: "PENDING",
      role: "USER",
    });
  });

  it("preserves conversations and messages across the re-link", async () => {
    const old = await seedUser({ clerkUserId: "ck_old", email: "reuse@t.local", role: "ADMIN" });
    await prisma.conversation.create({
      data: {
        userId: old.id,
        title: "history that must survive",
        messages: { create: [{ role: "USER", content: "q" }, { role: "ASSISTANT", content: "a" }] },
      },
    });

    await actingAs({ userId: "ck_new", email: "reuse@t.local" }, () => getCurrentAppUser());

    await expect(prisma.conversation.count({ where: { userId: old.id } })).resolves.toBe(1);
    await expect(prisma.message.count()).resolves.toBe(2);
    await expect(prisma.user.count()).resolves.toBe(1);
  });

  it("approving a re-linked account does NOT restore ADMIN", async () => {
    await seedUser({ clerkUserId: "ck_old", email: "reuse@t.local", role: "ADMIN" });
    const relinked = await actingAs({ userId: "ck_new", email: "reuse@t.local" }, () =>
      getCurrentAppUser()
    );
    await seedUser({ clerkUserId: "ck_adm", email: "adm@t.local", role: "ADMIN" });

    await actingAs({ userId: "ck_adm", email: "adm@t.local" }, () =>
      approveUser(formData({ id: relinked.id }))
    );

    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: relinked.id } })
    ).resolves.toMatchObject({ status: "ACTIVE", role: "USER" });
  });

  it("keeps an existing account usable when its new email is already taken", async () => {
    await seedUser({ clerkUserId: "ck_one", email: "taken@t.local" });
    const two = await seedUser({ clerkUserId: "ck_two", email: "two@t.local", status: "ACTIVE" });

    // ck_two's Clerk email changed to one ck_one already owns.
    const result = await actingAs({ userId: "ck_two", email: "taken@t.local", firstName: "Two" }, () =>
      getCurrentAppUser()
    );

    expect(result).toMatchObject({ id: two.id, email: "two@t.local", status: "ACTIVE" });
    await expect(prisma.user.count()).resolves.toBe(2);
  });

  it("provisions a brand-new Clerk identity as PENDING/USER", async () => {
    const created = await actingAs({ userId: "ck_fresh", email: "fresh@t.local" }, () =>
      getCurrentAppUser()
    );

    expect(created).toMatchObject({ status: "PENDING", role: "USER", email: "fresh@t.local" });
  });

  it("never resets role or status for an ordinary returning user", async () => {
    const user = await seedUser({
      clerkUserId: "ck_ret", email: "ret@t.local", role: "ADMIN", status: "ACTIVE",
    });

    const again = await actingAs({ userId: "ck_ret", email: "ret@t.local", firstName: "Renamed" }, () =>
      getCurrentAppUser()
    );

    expect(again).toMatchObject({ id: user.id, role: "ADMIN", status: "ACTIVE" });
  });
});
