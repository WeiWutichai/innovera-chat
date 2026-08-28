import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd());

/**
 * Refuses to write to or delete anything inside the real repository.
 *
 * The runtime suite generates a probe route and a full .next build. Both must land in a
 * throwaway copy: a crash mid-test must never leave the developer's working tree
 * mutated, and teardown must never be able to delete their real build output.
 */
export function assertOutsideRepository(target: string) {
  const resolved = path.resolve(target);

  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(
      `[runtime-safety] Refusing to create or remove "${resolved}": it is inside the ` +
        `repository at "${REPO_ROOT}". Runtime tests operate only on a temporary copy.`
    );
  }
}

/** Only what `next build` and `next start` actually need. */
const COPIED_ENTRIES = [
  "src",
  "public",
  "prisma",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
];

const PROBE_SOURCE = `export async function GET(req: Request) {
  const started = Date.now();
  let abortFired = false;
  req.signal.addEventListener("abort", () => {
    abortFired = true;
    console.log("PROBE abort_fired_after_ms=" + (Date.now() - started));
  });
  const upstream = req.headers.get("x-probe-upstream");
  try {
    const res = await fetch(upstream + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "probe", messages: [{ role: "user", content: "probe" }] }),
      signal: req.signal,
    });
    console.log("PROBE completed status=" + res.status + " abortFired=" + abortFired);
    return Response.json({ abortFired });
  } catch (error) {
    console.log("PROBE threw name=" + (error as Error).name + " abortFired=" + abortFired);
    return Response.json({ abortFired, name: (error as Error).name });
  }
}
`;

/**
 * Materialises node_modules inside the temporary project.
 *
 * A symlink is not an option: Turbopack rejects one that points outside the project
 * root ("Symlink [project]/node_modules is invalid"). Copy-on-write clones make this
 * cheap where the filesystem supports it — on APFS ~750MB of packages clone in a few
 * seconds and consume no additional disk. Elsewhere it degrades to a real copy, which
 * is why the runtime suite is opt-in rather than part of `npm test`.
 */
function copyNodeModules(root: string) {
  assertOutsideRepository(root);

  const source = path.join(REPO_ROOT, "node_modules");
  const destination = path.join(root, "node_modules");

  const attempts =
    process.platform === "darwin"
      ? [["cp", ["-Rc", source, destination]]]
      : [["cp", ["-a", "--reflink=auto", source, destination]]];

  for (const [command, args] of attempts) {
    try {
      execFileSync(command as string, args as string[], { stdio: "ignore" });
      return;
    } catch {
      /* fall through to the portable copy */
    }
  }

  cpSync(source, destination, { recursive: true });
}

export type TempProject = { root: string; remove: () => void };

/**
 * Builds a disposable copy of the project under os.tmpdir(), with the probe route
 * injected into the COPY only. node_modules is symlinked rather than copied — it is
 * read-only for a build, and copying it would cost hundreds of megabytes.
 */
export function createTemporaryProject(): TempProject {
  const root = mkdtempSync(path.join(os.tmpdir(), "innovera-runtime-"));
  assertOutsideRepository(root);

  for (const entry of COPIED_ENTRIES) {
    const from = path.join(REPO_ROOT, entry);
    if (existsSync(from)) {
      cpSync(from, path.join(root, entry), { recursive: true });
    }
  }

  copyNodeModules(root);

  const probeDir = path.join(root, "src/app/api/runtime-probe");
  assertOutsideRepository(probeDir);
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(path.join(probeDir, "route.ts"), PROBE_SOURCE);

  return {
    root,
    remove: () => {
      assertOutsideRepository(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Clerk placeholders. Syntactically valid so the server can boot; they belong to no
 * Clerk instance and are generated per run, so nothing secret-shaped is ever committed.
 */
export function placeholderEnv(): Record<string, string> {
  return {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      "pk_test_" + Buffer.from("clerk.runtime-test.lcl.dev$").toString("base64"),
    CLERK_SECRET_KEY: "sk_test_" + "0".repeat(40),
    // Never a real database: the runtime suite only exercises unauthenticated paths.
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  };
}

export type RunningServer = { port: number; stop: () => Promise<void>; log: () => string };

/** Builds and starts the temporary copy. The real repository is never the cwd. */
export async function buildAndStart(project: TempProject): Promise<RunningServer> {
  assertOutsideRepository(project.root);

  const env = { ...process.env, ...placeholderEnv() };

  execFileSync("npx", ["next", "build"], { cwd: project.root, env, stdio: "pipe" });

  const port = await freePort();
  let output = "";

  const child: ChildProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: project.root,
    env,
  });
  child.stdout?.on("data", (c) => (output += c));
  child.stderr?.on("data", (c) => (output += c));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`[runtime] server did not become ready:\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status > 0) break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    port,
    log: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}
