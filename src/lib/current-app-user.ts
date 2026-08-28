import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

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

  return prisma.user.upsert({
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
}
