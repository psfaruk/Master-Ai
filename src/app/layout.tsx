import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "QX Signal Aggregator — 3-App Consensus Dashboard",
  description: "Aggregates CALL/PUT signals from 3 Quotex analysis apps and shows per-pair consensus (2-bot agree / 3-bot agree).",
  keywords: ["Quotex", "signals", "CALL", "PUT", "trading", "dashboard", "consensus"],
  authors: [{ name: "QX Aggregator" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "QX Signal Aggregator",
    description: "3-app consensus CALL/PUT dashboard",
    siteName: "QX Aggregator",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "QX Signal Aggregator",
    description: "3-app consensus CALL/PUT dashboard",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
