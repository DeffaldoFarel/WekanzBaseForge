import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WekanzBaseForge",
  description: "Learning project: build your own backend platform",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
