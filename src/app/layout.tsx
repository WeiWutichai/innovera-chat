import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "INNOVERA AI",
  description: "Private AI Platform by INNOVERA",
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
