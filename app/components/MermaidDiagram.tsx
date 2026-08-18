"use client";

import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import { useTheme, type ThemeMode } from "@/app/lib/use-theme";
import { feedVisualizationId, storeFeedVisualization } from "@/app/lib/feed-visualization";

type Diagram = { svg: string; width: number };

type DiagramState =
  | { status: "loading" }
  | { status: "rendered"; diagram: Diagram; requestKey: string }
  | { status: "error"; requestKey: string };

// Mermaid keeps its configuration globally. Serialize renders so a theme
// change cannot reconfigure the library while another diagram is rendering.
let renderQueue: Promise<void> = Promise.resolve();

// Mermaid sizes its SVG with width="100%" and an inline max-width holding the
// diagram's natural width. A percentage width contributes nothing to a
// shrink-to-fit box, so a block sized to its content collapsed to the 300px
// default of a replaced element. Publish the viewBox as the SVG's intrinsic
// size instead: the block then hugs a small diagram, CSS scales a large one to
// the space it has, and the natural width is what the legibility floor in
// .mermaid-diagram-canvas > svg measures against.
function withIntrinsicSize(svg: string): Diagram {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite)) return { svg, width: 0 };
  const [, , width, height] = viewBox;
  if (width <= 0 || height <= 0) return { svg, width: 0 };
  return {
    width,
    svg: svg
      .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, "$1")
      .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, "$1")
      .replace(/(<svg\b[^>]*?style="[^"]*?)max-width:[^;"]*;?/, "$1")
      .replace(/<svg\b/, `<svg width="${width}" height="${height}"`),
  };
}

function renderDiagram(id: string, source: string, theme: ThemeMode): Promise<Diagram> {
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
    return withIntrinsicSize(svg);
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
      .then((diagram) => {
        if (!cancelled) setState({ status: "rendered", diagram, requestKey });
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
    <div
      className="markdown-media mermaid-diagram feed-rich-content"
      style={{ "--diagram-natural-width": `${state.diagram.width}px` } as CSSProperties}
    >
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
        dangerouslySetInnerHTML={{ __html: state.diagram.svg }}
      />
    </div>
  );
}
