import { auth, currentUser } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

function isEmailUniqueViolation(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;

  return Array.isArray(target)
    ? target.includes("email")
    : String(target ?? "").includes("email");
}

// Reached only when the User.email unique constraint rejects the upsert. Before this
// existed the constraint threw P2002 out of every authenticated render, which 500'd
// every page for that account with no admin recovery path.
async function recoverFromEmailCollision(
  clerkUserId: string,
  email: string,
  name: string | null
) {
  const existingByClerkId = await prisma.user.findUnique({
    where: { clerkUserId },
  });

  if (existingByClerkId) {
    // This account already exists locally and tried to move to an address another
    // account owns. Keep it usable on its current email rather than failing the render.
    const preserved = await prisma.user.update({
      where: { clerkUserId },
      data: { name },
    });

    console.warn(
      JSON.stringify({
        event: "user.email_conflict_skipped",
        userId: preserved.id,
      })
    );

    return preserved;
  }

  // No local row for this Clerk identity, but the address is already taken: the same
  // person signing in through a new Clerk account. Re-link so conversations survive,
  // but force re-approval so a new identity can never silently inherit an ACTIVE or
  // ADMIN row. Role is left intact; an admin still has to approve the re-link.
  const relinked = await prisma.user.update({
    where: { email },
    data: { clerkUserId, name, status: "PENDING" },
  });

  console.warn(
    JSON.stringify({
      event: "user.email_relinked_pending_reapproval",
      userId: relinked.id,
    })
  );

  return relinked;
}

export async function getCurrentAppUser() {
  const { isAuthenticated, userId, redirectToSignIn } = await auth();

  if (!isAuthenticated || !userId) {
    return redirectToSignIn();
  }

  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk user not found");
  }

  const primaryEmail =
    clerkUser.emailAddresses.find(
      (email) => email.id === clerkUser.primaryEmailAddressId
    )?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress;

  if (!primaryEmail) {
    throw new Error("User email not found");
  }

  const name =
    [clerkUser.firstName, clerkUser.lastName]
      .filter(Boolean)
      .join(" ") || null;

  try {
    return await prisma.user.upsert({
      where: {
        clerkUserId: userId,
      },
      update: {
        email: primaryEmail,
        name,
      },
      create: {
        clerkUserId: userId,
        email: primaryEmail,
        name,
        status: "PENDING",
        role: "USER",
      },
    });
  } catch (error) {
    if (!isEmailUniqueViolation(error)) {
      throw error;
    }

    return recoverFromEmailCollision(userId, primaryEmail, name);
  }
}
