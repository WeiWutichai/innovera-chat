"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type UserRole, type UserStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { logInfo } from "@/lib/log";

const MAX_SERIALIZATION_RETRIES = 3;

function readTargetId(formData: FormData) {
  const id = formData.get("id");

  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Missing target user id");
  }

  return id;
}

// P2034 is Prisma's "write conflict or deadlock, please retry", which is how a
// Postgres serialization failure (SQLSTATE 40001) surfaces.
function isSerializationFailure(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

async function withSerializationRetry<T>(
  operation: () => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

type GuardedUserUpdate = {
  status?: UserStatus;
  role?: UserRole;
};

// The admin panel is reachable only by an ACTIVE ADMIN and there is no in-app way to
// create the first one, so dropping to zero locks everybody out of user management
// permanently — recoverable only by direct SQL against the database.
//
// Counting and writing must therefore be one atomic unit. Read separately, two
// concurrent operations both observe count=2 and both succeed, leaving zero. That is
// textbook write skew, which Postgres' Serializable Snapshot Isolation detects: the
// count's read predicate covers the row the other transaction writes, so one is
// aborted with a serialization failure and retried here.
async function updateWithoutRemovingLastActiveAdmin(
  targetId: string,
  data: GuardedUserUpdate
) {
  await withSerializationRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: targetId },
          select: { role: true, status: true },
        });

        if (!target) {
          throw new Error("Target user not found");
        }

        const removesAnActiveAdmin =
          target.role === "ADMIN" && target.status === "ACTIVE";

        if (removesAnActiveAdmin) {
          const activeAdminCount = await tx.user.count({
            where: { role: "ADMIN", status: "ACTIVE" },
          });

          if (activeAdminCount <= 1) {
            throw new Error(
              "Cannot remove the last active administrator"
            );
          }
        }

        await tx.user.update({
          where: { id: targetId },
          data,
        });
      },
      {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      }
    )
  );
}

export async function approveUser(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  logInfo("admin.user_approved", { actorId: admin.id, targetId: id });

  revalidatePath("/admin");
}

export async function disableUser(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  if (id === admin.id) {
    throw new Error("Administrators cannot disable their own account");
  }

  await updateWithoutRemovingLastActiveAdmin(id, {
    status: "DISABLED",
  });

  logInfo("admin.user_disabled", { actorId: admin.id, targetId: id });

  revalidatePath("/admin");
}

export async function reactivateUser(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });

  logInfo("admin.user_reactivated", { actorId: admin.id, targetId: id });

  revalidatePath("/admin");
}

export async function makeAdmin(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  await prisma.user.update({
    where: { id },
    data: {
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  logInfo("admin.admin_granted", { actorId: admin.id, targetId: id });

  revalidatePath("/admin");
}

export async function revokeAdmin(formData: FormData) {
  const admin = await requireAdmin();

  const id = readTargetId(formData);

  await updateWithoutRemovingLastActiveAdmin(id, {
    role: "USER",
  });

  logInfo("admin.admin_revoked", { actorId: admin.id, targetId: id });

  revalidatePath("/admin");
}
