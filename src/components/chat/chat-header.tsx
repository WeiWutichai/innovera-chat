"use client";

import { UserButton } from "@clerk/nextjs";

type Props = {
  email: string;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
};

export default function ChatHeader({ email, sidebarOpen, onOpenSidebar }: Props) {
  return (
    // px-4 on mobile, px-6 from sm. gap-3 keeps the title clear of both controls.
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:h-16 sm:px-6">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open conversation history"
        aria-expanded={sidebarOpen}
        aria-controls="conversation-drawer"
        className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white lg:hidden"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <span className="font-medium">innovera-ai</span>

        {/* The email is the element that made the narrow header unreadable, so it
            appears only where there is width for it. */}
        <span className="ml-3 hidden text-xs text-white/40 lg:inline">{email}</span>
      </div>

      <div className="hidden shrink-0 lg:block">
        <UserButton />
      </div>
    </header>
  );
}
