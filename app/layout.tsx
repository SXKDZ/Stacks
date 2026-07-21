import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stacks",
  description:
    "A modern research library for papers, authors, venues, collections, discovery, and grounded AI reading assistance.",
  applicationName: "Stacks",
  keywords: [
    "research papers",
    "literature review",
    "academic library",
    "research assistant",
    "Stacks",
  ],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Stacks",
    description:
      "Read, organize, summarize, and discuss your Stacks library in one modern workspace.",
    type: "website",
    images: [{ url: "/og-paper-assistant.png", width: 1774, height: 887 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Stacks",
    description:
      "Read, organize, summarize, and discuss your Stacks library in one modern workspace.",
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
