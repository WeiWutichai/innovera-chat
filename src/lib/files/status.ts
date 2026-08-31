/**
 * Extraction status, as shown to a person.
 *
 * Shared by the file workspace and the chat composer so the two can never drift into
 * describing the same file differently — a file called "อ่านแล้ว" in one place and
 * "ไม่รองรับ" in the other would be worse than either label alone.
 *
 * Every string states what actually happened. None of them implies the assistant can
 * read a file it cannot: UNSUPPORTED and FAILED say plainly that the content was not
 * read, rather than showing an empty preview that reads as "this file is blank".
 */
export type FileStatusPresentation = {
  label: string;
  tone: string;
  hint: string;
  /** True when this file's text may reach the model. Mirrors the server allowlist. */
  usableAsContext: boolean;
};

export const STATUS_TEXT: Record<string, FileStatusPresentation> = {
  PENDING: {
    label: "รอประมวลผล",
    tone: "text-white/40",
    hint: "กำลังรอคิวอ่านเนื้อหา",
    usableAsContext: false,
  },
  PROCESSING: {
    label: "กำลังอ่าน",
    tone: "text-sky-300",
    hint: "กำลังอ่านเนื้อหาไฟล์",
    usableAsContext: false,
  },
  EXTRACTED: {
    label: "อ่านแล้ว",
    tone: "text-emerald-300",
    hint: "อ่านเนื้อหาได้ครบถ้วน",
    usableAsContext: true,
  },
  PARTIAL: {
    label: "อ่านบางส่วน",
    tone: "text-amber-300",
    hint: "อ่านได้บางส่วนเท่านั้น",
    usableAsContext: true,
  },
  UNSUPPORTED: {
    label: "ไม่รองรับ",
    tone: "text-white/40",
    hint: "เก็บและดาวน์โหลดได้ แต่อ่านเนื้อหาไม่ได้",
    usableAsContext: false,
  },
  FAILED: {
    label: "อ่านไม่สำเร็จ",
    tone: "text-red-300",
    hint: "ไม่สามารถอ่านเนื้อหาไฟล์นี้ได้",
    usableAsContext: false,
  },
  SKIPPED: {
    label: "ไม่ได้อ่าน",
    tone: "text-white/40",
    hint: "อัปโหลดก่อนระบบอ่านไฟล์จะเปิดใช้งาน",
    usableAsContext: false,
  },
};

export function statusOf(status: string): FileStatusPresentation {
  return (
    STATUS_TEXT[status] ?? {
      label: status,
      tone: "text-white/40",
      hint: "",
      usableAsContext: false,
    }
  );
}

/** Images are stored and downloadable, but the assistant is text-only. */
export function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * What the composer tells the user about whether the AI can use this file.
 *
 * Deliberately honest in both directions: it never promises the AI will read a file it
 * will not, and it never stays silent about a file the user has attached expecting it to
 * be read.
 */
export function contextNoteFor(file: { mimeType: string; extractStatus: string }): string | null {
  if (isImage(file.mimeType)) {
    return "AI อ่านรูปภาพไม่ได้ (ระบบรองรับข้อความเท่านั้น)";
  }

  const presentation = statusOf(file.extractStatus);

  if (presentation.usableAsContext) {
    return file.extractStatus === "PARTIAL" ? "AI จะเห็นเนื้อหาบางส่วน" : null;
  }

  return "AI จะไม่เห็นเนื้อหาไฟล์นี้";
}
