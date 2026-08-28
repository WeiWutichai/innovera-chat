import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import {
  approveUser,
  disableUser,
  reactivateUser,
  makeAdmin,
} from "./actions";

export default async function AdminPage() {
  await requireAdmin();

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-8 py-5">
        <div>
          <h1 className="text-xl font-semibold">INNOVERA AI Admin</h1>
          <p className="text-sm text-white/40">User Management</p>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/chat" className="text-sm text-white/70">
            Chat
          </Link>
          <UserButton />
        </div>
      </header>

      <section className="mx-auto max-w-7xl p-8">
        <div className="overflow-hidden rounded-2xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-white/50">
              <tr>
                <th className="p-4">User</th>
                <th className="p-4">Email</th>
                <th className="p-4">Role</th>
                <th className="p-4">Status</th>
                <th className="p-4">Created</th>
                <th className="p-4">Actions</th>
              </tr>
            </thead>

            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-t border-white/10"
                >
                  <td className="p-4">{user.name || "-"}</td>
                  <td className="p-4">{user.email}</td>
                  <td className="p-4">{user.role}</td>
                  <td className="p-4">{user.status}</td>
                  <td className="p-4">
                    {user.createdAt.toLocaleString()}
                  </td>

                  <td className="p-4">
                    <div className="flex flex-wrap gap-2">
                      {user.status === "PENDING" && (
                        <form action={approveUser}>
                          <input type="hidden" name="id" value={user.id} />
                          <button className="rounded-lg bg-emerald-500 px-3 py-2 text-black">
                            Approve
                          </button>
                        </form>
                      )}

                      {user.status === "DISABLED" && (
                        <form action={reactivateUser}>
                          <input type="hidden" name="id" value={user.id} />
                          <button className="rounded-lg bg-blue-500 px-3 py-2 text-white">
                            Reactivate
                          </button>
                        </form>
                      )}

                      {user.status === "ACTIVE" && (
                        <form action={disableUser}>
                          <input type="hidden" name="id" value={user.id} />
                          <button className="rounded-lg border border-red-500/40 px-3 py-2 text-red-300">
                            Disable
                          </button>
                        </form>
                      )}

                      {user.role !== "ADMIN" && (
                        <form action={makeAdmin}>
                          <input type="hidden" name="id" value={user.id} />
                          <button className="rounded-lg border border-white/20 px-3 py-2">
                            Make Admin
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
