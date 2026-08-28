import { UserButton } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@/lib/current-app-user";

export default async function PendingPage() {
  const user = await getCurrentAppUser();

  if (user.status === "ACTIVE") {
    redirect("/chat");
  }

  if (user.status === "DISABLED") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-white">
        <div className="w-full max-w-lg rounded-2xl border border-red-500/20 bg-white/5 p-8 text-center">
          <h1 className="text-2xl font-semibold">Account Disabled</h1>
          <p className="mt-3 text-white/60">
            บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ INNOVERA
          </p>
          <div className="mt-6 flex justify-center">
            <UserButton />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-white">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <div className="mb-6 text-4xl">⏳</div>

        <h1 className="text-2xl font-semibold">
          รอการอนุมัติบัญชี
        </h1>

        <p className="mt-3 text-white/60">
          สมัครสมาชิกสำเร็จแล้ว ผู้ดูแลระบบ INNOVERA
          กำลังตรวจสอบบัญชีของคุณ
        </p>

        <p className="mt-4 text-sm text-white/40">
          {user.email}
        </p>

        <div className="mt-6 flex justify-center">
          <UserButton />
        </div>
      </div>
    </main>
  );
}
