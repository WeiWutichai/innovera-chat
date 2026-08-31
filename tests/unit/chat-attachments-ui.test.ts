import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STATUS_TEXT, contextNoteFor, isImage, statusOf } from "@/lib/files/status";

/**
 * Structural guards for the attachment UI.
 *
 * Same approach as the Phase 4 mobile tests: assert the CLASS AND COPY CONTRACT rather
 * than rendered pixels, because the failures being prevented — a chip that overflows the
 * composer, or a chip that implies the AI read a file it never saw — are produced by
 * which classes and which words are present.
 */
const REPO = process.cwd();

function code(relative: string) {
  return readFileSync(path.join(REPO, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const chips = code("src/components/chat/attachment-chips.tsx");
const picker = code("src/components/chat/attachment-picker.tsx");
const composer = code("src/components/chat/composer.tsx");
const shell = code("src/components/chat/chat-interface.tsx");

describe("the chat UI is decomposed, not one monolith", () => {
  it("keeps every chat component under a reviewable size", () => {
    const sources = [
      "src/components/chat/chat-interface.tsx",
      "src/components/chat/chat-header.tsx",
      "src/components/chat/conversation-sidebar.tsx",
      "src/components/chat/message-list.tsx",
      "src/components/chat/composer.tsx",
      "src/components/chat/attachment-chips.tsx",
      "src/components/chat/attachment-picker.tsx",
    ];

    for (const source of sources) {
      const lines = readFileSync(path.join(REPO, source), "utf8").split("\n").length;
      expect(lines).toBeLessThan(420);
    }
  });

  it("no longer has a single chat-interface holding all the markup", () => {
    // The composer, sidebar and message list each own their own markup.
    expect(shell).not.toContain("<textarea");
    expect(shell).not.toContain("<aside");
    expect(composer).toContain("<textarea");
  });
});

describe("attaching and removing", () => {
  it("offers a way to attach on both mobile and desktop", () => {
    expect(composer).toContain("onOpenPicker");
    // The desktop control lives in the sm:flex hint row, which is hidden on mobile, so
    // mobile needs its own — otherwise attaching is impossible on a phone.
    expect(composer).toMatch(/sm:hidden[\s\S]{0,400}onOpenPicker/);
  });

  it("gives every active chip a labelled control that only deselects it", () => {
    // The wording matters: this removes the file from the MESSAGE, not from the
    // conversation, and the label has to say which.
    expect(chips).toContain("onDeactivate(file.id)");
    expect(chips).toContain("aria-label={`Remove ${file.filename} from this message`}");
  });

  it("offers a separate, differently labelled control that detaches for good", () => {
    expect(chips).toContain("onDetach(file.id)");
    expect(chips).toContain("aria-label={`Remove ${file.filename} from this conversation`}");
  });

  it("lets an inactive associated file be re-selected", () => {
    expect(chips).toContain("onActivate(file.id)");
    expect(chips).toContain("aria-label={`Use ${file.filename} in this message`}");
  });

  it("disables removal while a request is in flight", () => {
    expect(chips).toContain("disabled={disabled}");
    expect(composer).toContain("disabled={loading}");
  });

  it("lets a file be selected from previous uploads and uploaded fresh", () => {
    expect(picker).toContain('type="checkbox"');
    expect(picker).toContain('type="file"');
    expect(picker).toContain("multiple");
    // Uploads reuse the one audited endpoint rather than adding a second path.
    expect(picker).toContain('fetch("/api/files"');
  });

  it("locks out only files already ACTIVE, so an inactive one stays re-selectable", () => {
    expect(picker).toContain("activeIds.includes(file.id)");
    expect(picker).toContain("disabled={alreadyActive}");
    // Associated-but-inactive must not be treated as already attached.
    expect(picker).not.toContain("attachedIds");
  });
});

describe("status is shown honestly", () => {
  it("labels every extraction state", () => {
    for (const status of [
      "PENDING",
      "PROCESSING",
      "EXTRACTED",
      "PARTIAL",
      "UNSUPPORTED",
      "FAILED",
      "SKIPPED",
    ]) {
      expect(STATUS_TEXT[status]).toBeDefined();
      expect(STATUS_TEXT[status].label.length).toBeGreaterThan(0);
    }
  });

  it("marks exactly the two states the server will read", () => {
    const usable = Object.entries(STATUS_TEXT)
      .filter(([, v]) => v.usableAsContext)
      .map(([k]) => k);

    // Must mirror the server allowlist in eligibility.ts, or the UI promises something
    // the model never receives.
    expect(usable.sort()).toEqual(["EXTRACTED", "PARTIAL"]);
  });

  it("warns that the assistant cannot read images", () => {
    const note = contextNoteFor({ mimeType: "image/png", extractStatus: "UNSUPPORTED" });

    expect(note).toContain("รูปภาพ");
    expect(note).toContain("ข้อความเท่านั้น");
  });

  it("says plainly when the AI will not see a file", () => {
    for (const status of ["UNSUPPORTED", "FAILED", "PENDING", "PROCESSING", "SKIPPED"]) {
      expect(contextNoteFor({ mimeType: "text/plain", extractStatus: status })).toBe(
        "AI จะไม่เห็นเนื้อหาไฟล์นี้"
      );
    }
  });

  it("says a PARTIAL file is only partly visible", () => {
    expect(contextNoteFor({ mimeType: "text/plain", extractStatus: "PARTIAL" })).toContain(
      "บางส่วน"
    );
  });

  it("adds no note for a fully readable file", () => {
    expect(contextNoteFor({ mimeType: "text/plain", extractStatus: "EXTRACTED" })).toBeNull();
  });

  it("distinguishes active attachments from associated-but-inactive ones", () => {
    // Two rows, two labels. A single undifferentiated list would leave a user unable to
    // tell whether their question is grounded in a document or not.
    expect(chips).toContain("แนบในคำถามนี้");
    expect(chips).toContain("ยังไม่ได้ใช้");
    expect(chips).toContain("active.length > 0");
    expect(chips).toContain("inactive.length > 0");
  });

  it("marks in the transcript which associated files the next message will read", () => {
    const list = code("src/components/chat/message-list.tsx");

    expect(list).toContain("activeIds.includes(file.id)");
    expect(list).toContain("ใช้ในคำถามนี้");
  });

  it("sends only the active selection as fileIds", () => {
    expect(shell).toContain("const fileIds = active.map((f) => f.id)");
  });

  it("restores the association on open without activating anything", () => {
    const hook = code("src/components/chat/use-attachments.ts");

    expect(shell).toContain("hydrateAttachments(data.conversation.attachments ?? [])");
    // hydrate sets the association and clears activity.
    expect(hook).toMatch(/hydrate[\s\S]{0,200}setActiveIds\(\[\]\)/);
  });

  it("keeps the active selection after send, deliberately", () => {
    const hook = code("src/components/chat/use-attachments.ts");

    // Documented behaviour: the chips always match what the next message will read, so
    // a follow-up question about the same document needs no re-selection.
    //
    // Asserted on emitted code, not on the comment that explains it: the only ways the
    // selection can be cleared are `reset` (new chat) and `hydrate` (opening another
    // conversation), and neither is reachable from the send path.
    const send = shell.slice(shell.indexOf("async function sendMessage"));
    const sendBody = send.slice(0, send.indexOf("\n  }"));

    expect(sendBody).not.toContain("resetAttachments");
    expect(sendBody).not.toContain("hydrateAttachments");
    expect(sendBody).not.toContain("deactivate");

    // And the hook offers no bulk-clear that a future edit could wire into send.
    expect(hook).not.toContain("clearActive");
    expect((hook.match(/setActiveIds\(\[\]\)/g) ?? []).length).toBe(2); // reset + hydrate
  });

  it("renders the status on the chip and in the picker row", () => {
    expect(chips).toContain("statusOf(file.extractStatus)");
    expect(picker).toContain("statusOf(file.extractStatus)");
    expect(chips).toContain("contextNoteFor(file)");
    expect(picker).toContain("contextNoteFor(file)");
  });

  it("polls while extraction is still in flight", () => {
    // A file attached seconds after upload starts PENDING; without this the chip would
    // claim the AI cannot read it forever.
    expect(picker).toContain('f.extractStatus === "PENDING"');
    expect(picker).toContain('f.extractStatus === "PROCESSING"');
  });

  it("treats every image type as unreadable", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isImage(mime)).toBe(true);
    }

    expect(isImage("application/pdf")).toBe(false);
  });

  it("degrades safely for a status it has never seen", () => {
    const unknown = statusOf("SOMETHING_NEW");

    expect(unknown.usableAsContext).toBe(false);
    expect(unknown.label).toBe("SOMETHING_NEW");
  });
});

describe("attachments do not break the mobile composer", () => {
  it("never lets a chip widen the composer", () => {
    // min-w-0 + truncate is what keeps a long filename from pushing the row wider than
    // the viewport, which is the same failure Phase 4 fixed for the Send button.
    expect(chips).toContain("min-w-0");
    expect(chips).toContain("max-w-full");
    expect(chips).toContain("truncate");
    expect(chips).toContain("flex-wrap");
  });

  it("keeps the remove control at a 44px touch target on mobile", () => {
    expect(chips).toMatch(/h-11 w-11[^"]*sm:h-7/);
  });

  it("keeps the picker within the viewport and scrolling internally", () => {
    expect(picker).toContain("max-h-[85dvh]");
    expect(picker).toContain("overflow-y-auto");
    expect(picker).toContain("min-h-0");
  });

  it("carries safe-area padding in the picker's action row", () => {
    expect(picker).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
  });

  it("gives the picker controls 44px targets", () => {
    expect(picker).toMatch(/min-h-11/);
    expect(picker).toMatch(/h-11 w-11/);
  });

  it("uses dvh rather than vh in the picker", () => {
    expect(picker).not.toContain("max-h-[85vh]");
    expect(picker).not.toContain("h-screen");
  });
});

describe("file content never reaches the browser through the chat UI", () => {
  it("has no component reading an extractedText field", () => {
    for (const source of [chips, picker, composer, shell]) {
      expect(source).not.toContain("extractedText");
    }
  });

  it("renders no attachment field through dangerouslySetInnerHTML", () => {
    for (const source of [chips, picker, composer, shell]) {
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
