import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto")
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", baseUrl).toString();

  return {
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
      images: [{ url: socialImage, width: 1730, height: 909, alt: "Stacks — Your research, in one place." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Stacks",
      description:
        "Read, organize, summarize, and discuss your Stacks library in one modern workspace.",
      images: [socialImage],
    },
  };
}

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
