import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "INNOVERA AI",
  description: "Private AI Platform by INNOVERA",
};

/**
 * viewportFit: "cover" is REQUIRED for env(safe-area-inset-*) to report anything other
 * than 0 on iOS. Without it the composer's bottom padding silently collapses and the
 * Send button sits under the home indicator on notched devices.
 *
 * maximumScale is deliberately NOT set: capping it blocks pinch-zoom, which is an
 * accessibility regression for anyone who needs to magnify the conversation.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="th">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
