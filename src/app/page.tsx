import Link from "next/link";
import {
  Show,
  UserButton,
} from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-8 py-6">
        <div>
          <h1 className="text-xl font-semibold">INNOVERA AI</h1>
          <p className="text-sm text-white/50">Private AI Platform</p>
        </div>

        <div className="flex items-center gap-3">
          <Show when="signed-out">
            <Link
              href="/sign-in"
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              Sign in
            </Link>

            <Link
              href="/sign-up"
              className="rounded-lg bg-white px-4 py-2 text-black"
            >
              Create account
            </Link>
          </Show>

          <Show when="signed-in">
            <Link
              href="/chat"
              className="rounded-lg bg-white px-4 py-2 text-black"
            >
              Open AI
            </Link>

            <UserButton />
          </Show>
        </div>
      </header>

      <section className="mx-auto flex min-h-[75vh] max-w-5xl flex-col items-center justify-center px-8 text-center">
        <p className="mb-4 text-sm uppercase tracking-[0.3em] text-white/40">
          INNOVERA PRIVATE AI
        </p>

        <h2 className="max-w-3xl text-5xl font-semibold leading-tight">
          AI สำหรับทีมและธุรกิจของคุณ
        </h2>

        <p className="mt-6 max-w-2xl text-lg text-white/60">
          Secure private AI powered by INNOVERA infrastructure.
        </p>

        <Show when="signed-out">
          <div className="mt-10 flex gap-4">
            <Link
              href="/sign-up"
              className="rounded-xl bg-white px-6 py-3 font-medium text-black"
            >
              สมัครใช้งาน
            </Link>

            <Link
              href="/sign-in"
              className="rounded-xl border border-white/20 px-6 py-3 font-medium"
            >
              เข้าสู่ระบบ
            </Link>
          </div>
        </Show>

        <Show when="signed-in">
          <Link
            href="/chat"
            className="mt-10 rounded-xl bg-white px-6 py-3 font-medium text-black"
          >
            เข้าใช้งาน INNOVERA AI
          </Link>
        </Show>
      </section>
    </main>
  );
}
