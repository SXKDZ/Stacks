import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paper Assistant",
  description:
    "A modern research library for papers, authors, venues, collections, discovery, and grounded AI reading assistance.",
  applicationName: "Paper Assistant",
  keywords: [
    "research papers",
    "literature review",
    "academic library",
    "research assistant",
    "Paper Assistant",
  ],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Paper Assistant",
    description:
      "Read, organize, summarize, and discuss your PA library in one modern workspace.",
    type: "website",
    images: [{ url: "/og-paper-assistant.png", width: 1774, height: 887 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Paper Assistant",
    description:
      "Read, organize, summarize, and discuss your PA library in one modern workspace.",
    images: ["/og-paper-assistant.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('pa-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){document.documentElement.dataset.theme='dark'}" }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
