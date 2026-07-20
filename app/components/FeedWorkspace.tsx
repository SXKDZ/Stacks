"use client";

import { Home, Rss } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface FeedSettings {
  feedEnabled?: boolean;
}

export default function FeedWorkspace() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: FeedSettings | null) => {
        if (!cancelled) {
          setEnabled(Boolean(data?.feedEnabled));
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <main className="chat-workspace-loading">
        <span className="assistant-orb"><Rss size={18} /></span>
        <p>Opening your feed…</p>
      </main>
    );
  }

  if (!enabled) {
    return (
      <main className="chat-workspace-loading">
        <p>The AI feed is turned off. Enable it in Settings → AI &amp; models → AI feed.</p>
        <Link href="/"><Home size={16} /> Return to library</Link>
      </main>
    );
  }

  return (
    <main className="chat-workspace-loading">
      <div className="chat-empty-state">
        <span className="message-avatar"><Rss size={26} /></span>
        <div>
          <h1>Your AI feed</h1>
          <p>Capture anything — a paper, a link, a note — and an agent will work on it. Snippets will appear here.</p>
        </div>
      </div>
      <Link href="/"><Home size={16} /> Return to library</Link>
    </main>
  );
}
