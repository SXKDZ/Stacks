"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTheme, type ThemeMode } from "@/app/lib/use-theme";
import { feedVisualizationId, storeFeedVisualization } from "@/app/lib/feed-visualization";

type DiagramState =
  | { status: "loading" }
  | { status: "rendered"; svg: string; requestKey: string }
  | { status: "error"; requestKey: string };

// Mermaid keeps its configuration globally. Serialize renders so a theme
// change cannot reconfigure the library while another diagram is rendering.
let renderQueue: Promise<void> = Promise.resolve();

function renderDiagram(id: string, source: string, theme: ThemeMode): Promise<string> {
  const task = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "var(--font-ui)",
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderQueue = task.then(() => undefined, () => undefined);
  return task;
}

export function MermaidDiagram({ source, feedId, feedName }: { source: string; feedId: string; feedName: string }) {
  const reactId = useId();
  const { theme } = useTheme();
  const diagramId = useMemo(() => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId]);
  const visualizationId = useMemo(() => feedVisualizationId("mermaid", feedId, source), [feedId, source]);
  const requestKey = `${theme}\u0000${source}`;
  const [state, setState] = useState<DiagramState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void renderDiagram(diagramId, source, theme)
      .then((svg) => {
        if (!cancelled) setState({ status: "rendered", svg, requestKey });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", requestKey });
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, requestKey, source, theme]);

  if (state.status === "loading" || state.requestKey !== requestKey) {
    return <div className="markdown-media mermaid-diagram is-loading" role="status">Rendering diagram…</div>;
  }

  if (state.status === "error") {
    return (
      <div className="markdown-media mermaid-diagram is-error" role="group" aria-label="Mermaid diagram rendering error">
        <p>Could not render this Mermaid diagram. Check the diagram syntax.</p>
        <pre className="mermaid-diagram-source"><code>{source}</code></pre>
      </div>
    );
  }

  return (
    <div className="markdown-media mermaid-diagram feed-rich-content">
      <div className="feed-rich-actions mermaid-diagram-toolbar">
        <a
          href={`/feed/visualization?id=${encodeURIComponent(visualizationId)}`}
          target="_blank"
          rel="noreferrer"
          className="feed-rich-action mermaid-diagram-open"
          aria-label="Open in new window"
          onClick={() => {
            storeFeedVisualization(visualizationId, { kind: "mermaid", source, feedId, feedName, theme, createdAt: Date.now() });
          }}
        >
          <ExternalLink aria-hidden="true" />
        </a>
      </div>
      <div
        className="mermaid-diagram-canvas"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </div>
  );
}
