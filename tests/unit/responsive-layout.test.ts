import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Structural guards for the mobile layout.
 *
 * These assert the CLASS CONTRACT rather than rendered pixels: the failure being
 * prevented — a permanently-visible 288px sidebar on a 375px viewport, and a Send
 * button pushed outside its flex container — is produced entirely by which utility
 * classes are present. A jsdom render cannot catch either, because jsdom applies no
 * CSS and computes no layout.
 */
const REPO = process.cwd();

/**
 * Strips comments before asserting. Several of these files explain in prose exactly
 * which utility they avoid ("word-break:break-all is deliberately NOT used"), so a
 * naive substring check matches the explanation and reports a failure that is really
 * a passing implementation. The assertions below are about emitted code.
 */
function code(relative: string) {
  return readFileSync(path.join(REPO, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/**
 * The chat UI is split across several components (M3), so the class contract these tests
 * guard is now spread over several files. They are concatenated in LAYOUT ORDER — shell,
 * sidebar, message list, composer, picker — so `indexOf`-based slicing below still finds
 * the right element, and every assertion keeps the exact meaning it had when the markup
 * lived in one file.
 */
const CHAT_SOURCES = [
  "src/components/chat/chat-interface.tsx",
  "src/components/chat/chat-header.tsx",
  "src/components/chat/conversation-sidebar.tsx",
  "src/components/chat/message-list.tsx",
  "src/components/chat/composer.tsx",
  "src/components/chat/attachment-chips.tsx",
  "src/components/chat/attachment-picker.tsx",
];

const chat = CHAT_SOURCES.map(code).join("\n");
const layout = code("src/app/layout.tsx");
const admin = code("src/app/admin/page.tsx");

/** The <aside> opening tag, where the drawer/sidebar behaviour is declared. */
function asideTag() {
  const start = chat.indexOf("<aside");
  return chat.slice(start, chat.indexOf(">", chat.indexOf("className", start) + 200));
}

describe("mobile sidebar / drawer", () => {
  it("is translated off-canvas by default and only slides in when opened", () => {
    const tag = asideTag();
    expect(tag).toContain("-translate-x-full");
    expect(tag).toContain("translate-x-0");
    expect(tag).toContain("sidebarOpen");
  });

  it("returns to a static column at the desktop breakpoint", () => {
    const tag = asideTag();
    expect(tag).toContain("lg:static");
    expect(tag).toContain("lg:translate-x-0");
    expect(tag).toContain("lg:w-72");
  });

  it("is never wider than min(85vw,320px) on mobile", () => {
    // w-72 (288px) was 77% of a 375px iPhone — the original root cause.
    const tag = asideTag();
    expect(tag).toContain("w-[min(85vw,320px)]");
    expect(tag).not.toMatch(/className="[^"]*\bw-72\b(?![^"]*lg:)/);
  });

  it("exposes a drawer trigger that is hidden on desktop", () => {
    expect(chat).toMatch(/aria-label="Open conversation history"/);
    expect(chat).toMatch(/aria-controls="conversation-drawer"/);
    expect(chat).toMatch(/aria-expanded=\{sidebarOpen\}/);
  });

  it("can be dismissed by backdrop, close button and Escape", () => {
    expect(chat).toMatch(/onClick=\{\(\) => setSidebarOpen\(false\)\}[\s\S]{0,200}aria-hidden="true"/);
    expect(chat).toContain('aria-label="Close conversation history"');
    expect(chat).toMatch(/event\.key === "Escape"/);
  });

  it("locks body scroll while open and restores the previous value", () => {
    expect(chat).toContain('document.body.style.overflow = "hidden"');
    expect(chat).toContain("document.body.style.overflow = previous");
  });

  it("closes when a conversation is opened or a new chat starts", () => {
    const open = chat.slice(chat.indexOf("async function openConversation"));
    expect(open.slice(0, 500)).toContain("setSidebarOpen(false)");
    const fresh = chat.slice(chat.indexOf("function newChat"));
    expect(fresh.slice(0, 300)).toContain("setSidebarOpen(false)");
  });

  it("hands the drawer its state and close handler rather than duplicating them", () => {
    // The decomposition must not fork drawer state: one owner, passed down.
    expect(chat).toContain("sidebarOpen={sidebarOpen}");
    expect(chat).toContain("onClose={() => setSidebarOpen(false)}");
  });
});

describe("composer", () => {
  function composerRow() {
    const i = chat.indexOf("flex items-end gap-2");
    return chat.slice(i, i + 2500);
  }

  it("uses a flex row whose textarea can actually shrink", () => {
    const row = composerRow();
    // min-w-0 is the fix: a flex item defaults to min-width:auto and refuses to shrink
    // below its content, which is what pushed the button out of the container.
    expect(row).toContain("min-w-0");
    expect(row).toContain("flex-1");
  });

  it("keeps the action button from shrinking or overflowing", () => {
    const row = composerRow();
    expect(row).toMatch(/shrink-0[^"]*"[\s\S]{0,80}>\s*Send/);
  });

  it("has a 48px minimum height on mobile and auto-grows to a bounded maximum", () => {
    expect(chat).toContain("min-h-12");
    expect(chat).toContain("max-h-40");
    expect(chat).toContain("overflow-y-auto bg-transparent");
    expect(chat).toContain("Math.min(el.scrollHeight, 160)");
  });

  it("resets height before measuring so the box can shrink again", () => {
    expect(chat).toContain('el.style.height = "auto"');
  });

  it("hides the non-shrinkable Thai hint row below sm", () => {
    // That row is what overflowed: justify-between with un-shrinkable text.
    expect(chat).toMatch(/mt-3 hidden items-center justify-between gap-3 sm:flex/);
  });

  it("preserves Enter / Shift+Enter semantics", () => {
    expect(chat).toContain('e.key === "Enter" &&');
    expect(chat).toContain("!e.shiftKey");
    expect(chat).toContain("!e.nativeEvent.isComposing");
  });

  it("carries safe-area padding for the iOS home indicator", () => {
    expect(chat).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
  });
});

describe("viewport sizing", () => {
  it("uses dynamic viewport height, not 100vh", () => {
    // 100vh on iOS Safari is the height with the address bar hidden, which pushed the
    // composer below the fold.
    expect(chat).toContain("h-dvh");
    expect(chat).not.toContain("h-screen");
  });

  it("declares viewport-fit=cover so safe-area insets resolve", () => {
    expect(layout).toContain('viewportFit: "cover"');
    expect(layout).toContain('width: "device-width"');
  });

  it("does not block pinch-zoom", () => {
    expect(layout).not.toContain("maximumScale");
    expect(layout).not.toContain("userScalable");
  });

  it("has exactly one scroll container for the conversation", () => {
    const overflowY = chat.match(/overflow-y-auto/g) ?? [];
    // A full inventory, so a new one cannot appear unnoticed:
    //   1. the conversation area          (chat-interface)
    //   2. the chat history list          (conversation-sidebar)
    //   3. the textarea                   (composer)
    //   4. the file list in the picker    (attachment-picker, M3)
    // The conversation itself still scrolls in exactly one place — no nested duplicate.
    expect(overflowY.length).toBe(4);

    const shell = code("src/components/chat/chat-interface.tsx");
    expect((shell.match(/overflow-y-auto/g) ?? []).length).toBe(1);
  });
});

describe("text wrapping", () => {
  it("wraps by word, never character-by-character", () => {
    expect(chat).toContain("break-words");
    // break-all would split ordinary Thai and English mid-word on every line.
    expect(chat).not.toContain("break-all");
  });

  it("gives bubbles mobile-appropriate maximum widths", () => {
    expect(chat).toContain("max-w-[88%]");
    expect(chat).toContain("sm:max-w-[80%]");
    expect(chat).toContain("max-w-full break-words");
  });
});

describe("desktop layout is preserved", () => {
  it("keeps the two-column layout at lg", () => {
    expect(asideTag()).toContain("lg:shrink-0");
    expect(chat).toContain('<section className="flex min-w-0 flex-1 flex-col">');
  });

  it("keeps the email in the header only at lg", () => {
    expect(chat).toMatch(/hidden text-xs text-white\/40 lg:inline/);
  });

  it("keeps the dark theme and branding", () => {
    expect(chat).toContain("bg-zinc-950 text-white");
    expect(chat).toContain("INNOVERA AI");
  });
});

describe("admin table does not widen the page", () => {
  it("scrolls inside its own container", () => {
    expect(admin).toContain("overflow-x-auto");
    expect(admin).not.toContain("overflow-hidden rounded-2xl");
  });

  it("keeps columns legible while scrolling", () => {
    expect(admin).toContain("min-w-[40rem]");
  });
});

describe("touch targets", () => {
  it("gives every essential control at least 44px", () => {
    expect(chat).toMatch(/h-11 w-11[^"]*lg:hidden/);          // hamburger + close
    expect(chat).toContain("min-h-11 w-full rounded-xl");      // New Chat
    expect(chat).toContain("min-h-11 w-full truncate");        // conversation rows
    expect(chat).toMatch(/h-11 shrink-0 rounded-lg bg-white/);  // Send (mobile)
  });
});
