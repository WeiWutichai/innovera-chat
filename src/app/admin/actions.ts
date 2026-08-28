"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";

export async function approveUser(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id"));

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  revalidatePath("/admin");
}

export async function disableUser(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id"));

  await prisma.user.update({
    where: { id },
    data: { status: "DISABLED" },
  });

  revalidatePath("/admin");
}

export async function reactivateUser(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id"));

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  revalidatePath("/admin");
}

export async function makeAdmin(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id"));

  await prisma.user.update({
    where: { id },
    data: {
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  revalidatePath("/admin");
}
