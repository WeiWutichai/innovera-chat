import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import {
  approveUser,
  disableUser,
  reactivateUser,
  makeAdmin,
  revokeAdmin,
} from "./actions";

export default async function AdminPage() {
  const admin = await requireAdmin();

  const [users, activeAdminCount] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.count({
      where: { role: "ADMIN", status: "ACTIVE" },
    }),
  ]);

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

      <section className="mx-auto max-w-7xl p-4 sm:p-8">
        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[40rem] text-left text-sm">
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
              {users.map((user) => {
                const isSelf = user.id === admin.id;

                // Removing this row would leave no ACTIVE ADMIN and lock the panel.
                const isLastActiveAdmin =
                  user.role === "ADMIN" &&
                  user.status === "ACTIVE" &&
                  activeAdminCount <= 1;

                return (
                  <tr
                    key={user.id}
                    className="border-t border-white/10"
                  >
                    <td className="p-4">
                      {user.name || "-"}
                      {isSelf && (
                        <span className="ml-2 rounded bg-white/10 px-2 py-0.5 text-xs text-white/60">
                          You
                        </span>
                      )}
                    </td>
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

                        {user.status === "ACTIVE" &&
                          !isSelf &&
                          !isLastActiveAdmin && (
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

                        {user.role === "ADMIN" && !isLastActiveAdmin && (
                          <form action={revokeAdmin}>
                            <input type="hidden" name="id" value={user.id} />
                            <button className="rounded-lg border border-white/20 px-3 py-2">
                              Revoke Admin
                            </button>
                          </form>
                        )}

                        {isLastActiveAdmin && (
                          <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/40">
                            Last active admin
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
