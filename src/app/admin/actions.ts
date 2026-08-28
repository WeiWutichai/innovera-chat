"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";

function readTargetId(formData: FormData) {
  const id = formData.get("id");

  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Missing target user id");
  }

  return id;
}

// The admin panel is reachable only by an ACTIVE ADMIN and there is no in-app way to
// create the first one, so removing the last active admin locks everybody out of user
// management permanently — recoverable only by direct SQL against the database.
async function assertNotLastActiveAdmin(targetId: string) {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { role: true, status: true },
  });

  if (!target) {
    throw new Error("Target user not found");
  }

  if (target.role !== "ADMIN" || target.status !== "ACTIVE") {
    return;
  }

  const activeAdminCount = await prisma.user.count({
    where: { role: "ADMIN", status: "ACTIVE" },
  });

  if (activeAdminCount <= 1) {
    throw new Error("Cannot remove the last active administrator");
  }
}

export async function approveUser(formData: FormData) {
  await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  revalidatePath("/admin");
}

export async function disableUser(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  if (id === admin.id) {
    throw new Error("Administrators cannot disable their own account");
  }

  await assertNotLastActiveAdmin(id);

  await prisma.user.update({
    where: { id },
    data: { status: "DISABLED" },
  });

  revalidatePath("/admin");
}

export async function reactivateUser(formData: FormData) {
  await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  revalidatePath("/admin");
}

export async function makeAdmin(formData: FormData) {
  await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: {
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  revalidatePath("/admin");
}

export async function revokeAdmin(formData: FormData) {
  await requireAdmin();

  const id = readTargetId(formData);

  await assertNotLastActiveAdmin(id);

  await prisma.user.update({
    where: { id },
    data: { role: "USER" },
  });

  revalidatePath("/admin");
}
