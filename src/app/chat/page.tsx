import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@/lib/current-app-user";
import ChatInterface from "@/components/chat-interface";

export default async function ChatPage() {
  const user = await getCurrentAppUser();

  if (user.status !== "ACTIVE") {
    redirect("/pending");
  }

  return (
    <ChatInterface
      email={user.email}
      isAdmin={user.role === "ADMIN"}
    />
  );
}
