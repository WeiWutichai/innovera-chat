import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Execution coverage for the operator CLI.
 *
 * ============================ THE GAP THIS CLOSES ===============================
 * The migration module had 48 passing tests, and the CLI wrapper was still unrunnable in
 * production: it imported `../src/lib/admin/clerk-identity-migration.js` while only a
 * `.ts` file existed, which no Node runtime resolves. Every one of those tests imported
 * the MODULE through Vitest, which resolves TypeScript natively — so nothing ever
 * executed `scripts/clerk-migrate-identity.mjs` itself, and the defect surfaced only when
 * an operator ran it against production during a cutover.
 *
 * These tests spawn the REAL CLI through the REAL `node` binary, with no bundler, no
 * alias resolution and no flags — the same way an operator invokes it. A broken import
 * fails here immediately.
 */

const CLI = path.resolve("scripts/clerk-migrate-identity.mjs");

/** A well-formed id, used only to prove it never appears in output. */
const TARGET_ID = "user_2testAAAABBBBCCCCDDDDEEEE";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "clerk-cli-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI exactly as production does: plain `node`, no flags. */
function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Present so the CLI reaches argument handling; never connected to, because every
      // case here returns before a query is issued.
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    },
  });

  return {
    code: result.status,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
    all: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeIdFile(name: string, contents: string) {
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe("the CLI actually loads", () => {
  it("starts under plain node with no flags and no bundler", () => {
    const r = runCli([]);

    // The decisive assertion: a module-resolution failure would appear here.
    expect(r.all).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(r.all).not.toContain("Cannot find module");
    expect(r.all).not.toContain("ERR_UNKNOWN_FILE_EXTENSION");
    expect(r.err).toContain("usage:");
    expect(r.code).toBe(2);
  });

  it("needs no --experimental-strip-types", () => {
    // The runner image ships Node 22, but developer machines may run 18 or 20. Requiring
    // a version-gated flag is what made this unverifiable in the first place.
    const r = runCli([]);
    expect(r.all).not.toMatch(/strip-types/i);
  });

  it("resolves every relative import to a file that exists", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const source = readFileSync(CLI, "utf8");
    const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);

    expect(specifiers.length).toBeGreaterThan(0);

    for (const spec of specifiers) {
      const resolved = path.resolve(path.dirname(CLI), spec);
      // Guards the exact defect: a `.js` specifier next to a `.ts` file.
      expect(existsSync(resolved), `unresolvable import: ${spec}`).toBe(true);
    }
  });

  it("imports no TypeScript at runtime", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(CLI, "utf8");

    expect(source).not.toMatch(/from\s+"\.[^"]*\.ts"/);
    expect(source).toContain("./lib/clerk-identity-migration.mjs");
  });
});

describe("--clerk-user-id-file", () => {
  it("accepts a file holding exactly one valid id", () => {
    const f = writeIdFile("valid", `${TARGET_ID}\n`);
    const r = runCli(["--clerk-user-id-file", f]);

    // No email supplied, so it falls through to usage — which proves the file itself was
    // read and accepted rather than refused.
    expect(r.all).not.toContain("REFUSED");
    expect(r.err).toContain("usage:");
  });

  it("accepts a CRLF-terminated file", () => {
    const f = writeIdFile("crlf", `${TARGET_ID}\r\n`);
    const r = runCli(["--clerk-user-id-file", f]);

    expect(r.all).not.toContain("REFUSED");
  });

  it("refuses a missing file", () => {
    const r = runCli(["--clerk-user-id-file", path.join(dir, "does-not-exist")]);

    expect(r.err).toContain("REFUSED");
    expect(r.err).toMatch(/cannot read/i);
    expect(r.code).toBe(1);
  });

  it("refuses an empty file", () => {
    const r = runCli(["--clerk-user-id-file", writeIdFile("empty", "")]);

    expect(r.err).toMatch(/REFUSED.*empty/i);
    expect(r.code).toBe(1);
  });

  it("refuses a whitespace-only file", () => {
    const r = runCli(["--clerk-user-id-file", writeIdFile("blank", "\n\n\r\n")]);

    expect(r.err).toMatch(/REFUSED.*empty/i);
  });

  it("refuses a file holding an invalid id", () => {
    const r = runCli(["--clerk-user-id-file", writeIdFile("bad", "not-a-clerk-id\n")]);

    expect(r.err).toMatch(/REFUSED.*valid Clerk user id/i);
    expect(r.code).toBe(1);
  });

  it("refuses a file with more than one non-empty line", () => {
    const f = writeIdFile("two", `${TARGET_ID}\nuser_2otherAAAABBBBCCCCDDDDEE\n`);
    const r = runCli(["--clerk-user-id-file", f]);

    // Two ids means the operator cannot know which one would be bound.
    expect(r.err).toMatch(/REFUSED.*2 non-empty lines/i);
    expect(r.code).toBe(1);
  });

  it("does not silently repair an id carrying stray spaces", () => {
    // Only CR/LF are stripped; anything else must fail validation rather than be fixed.
    const r = runCli(["--clerk-user-id-file", writeIdFile("spaced", ` ${TARGET_ID} \n`)]);

    expect(r.err).toMatch(/REFUSED/);
  });
});

describe("--clerk-user-id and --clerk-user-id-file are mutually exclusive", () => {
  it("refuses when both are supplied", () => {
    const f = writeIdFile("mx", `${TARGET_ID}\n`);
    const r = runCli(["--email", "a@b.test", "--clerk-user-id", TARGET_ID, "--clerk-user-id-file", f]);

    expect(r.err).toMatch(/mutually exclusive/i);
    expect(r.code).toBe(2);
  });

  it("still accepts --clerk-user-id alone, for compatibility", () => {
    const r = runCli(["--clerk-user-id", TARGET_ID]);

    expect(r.all).not.toContain("REFUSED");
    expect(r.err).toContain("usage:");
  });
});

describe("the target id never reaches output", () => {
  it("is absent from every refusal message", () => {
    const cases = [
      ["--clerk-user-id-file", writeIdFile("leak-two", `${TARGET_ID}\n${TARGET_ID}\n`)],
      ["--email", "a@b.test", "--clerk-user-id", TARGET_ID, "--clerk-user-id-file", writeIdFile("leak-mx", `${TARGET_ID}\n`)],
    ];

    for (const args of cases) {
      const r = runCli(args);
      // A ticket pasted from this output must not carry the production identity.
      expect(r.all).not.toContain(TARGET_ID);
    }
  });

  it("never echoes file contents", () => {
    const secretish = "user_2SECRETVALUEAAAABBBBCCCC";
    const r = runCli(["--clerk-user-id-file", writeIdFile("leak-bad", `${secretish}\nsecond\n`)]);

    expect(r.all).not.toContain(secretish);
    expect(r.all).not.toContain("second");
  });

  it("masks the TARGET id everywhere it is printed", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(CLI, "utf8");

    expect(source).toContain("function maskId(");

    // The target is the id the operator supplied. Printing it back would put the
    // production identity into scrollback for no operational gain.
    const targets = [...source.matchAll(/\$\{([^}]*(?:next|target)ClerkUserId[^}]*)\}/gi)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const expr of targets) {
      expect(expr, `unmasked TARGET id printed: ${expr}`).toContain("maskId");
    }
  });

  it("prints the PREVIOUS id in full, because rollback depends on it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(CLI, "utf8");

    // Deliberate and documented: only this tool ever learns the previous binding — it is
    // read from the database and then overwritten. Masking it would make the migration
    // irreversible, which is a worse failure than printing a superseded dev identity.
    expect(source).toMatch(/previous clerkUserId \$\{result\.rollback\.previousClerkUserId\}/);
    expect(source).toMatch(/needed to reverse/);
  });

  it("never contacts Clerk", async () => {
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync(CLI, "utf8");
    const lib = readFileSync("scripts/lib/clerk-identity-migration.mjs", "utf8");

    for (const source of [cli, lib]) {
      expect(source).not.toContain("@clerk/");
      expect(source).not.toMatch(/fetch\(|https:\/\/api\.clerk/);
      expect(source).not.toContain("CLERK_SECRET_KEY");
    }
  });
});
