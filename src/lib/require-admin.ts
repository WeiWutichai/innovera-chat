import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@/lib/current-app-user";

export async function requireAdmin() {
  const user = await getCurrentAppUser();

  if (user.status !== "ACTIVE") {
    redirect("/pending");
  }

  if (user.role !== "ADMIN") {
    redirect("/chat");
  }

  return user;
}
