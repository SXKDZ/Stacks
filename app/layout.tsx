import type { Metadata } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stacks",
  description:
    "A research library to read, organize, and discuss your papers, with AI help.",
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
  },
  twitter: {
    card: "summary",
    title: "Stacks",
    description:
      "Read, organize, summarize, and discuss your Stacks library in one modern workspace.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('stacks-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){document.documentElement.dataset.theme='dark'}" }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
