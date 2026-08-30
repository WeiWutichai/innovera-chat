import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@/lib/current-app-user";
import FileWorkspace from "@/components/files/file-workspace";

export default async function FilesPage() {
  const user = await getCurrentAppUser();

  if (user.status !== "ACTIVE") {
    redirect("/pending");
  }

  return <FileWorkspace />;
}
