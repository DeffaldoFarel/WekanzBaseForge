import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WekanzBaseForge - Backend Platform Console",
  description: "Next-generation backend platform with SQLite, Auth, Storage, and Serverless Functions",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
