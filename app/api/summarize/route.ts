import { readFileSync } from "node:fs";
import {
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  pageSliceFor,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { resolveStoredFile } from "@/app/lib/local-files";
import { readPdfPages } from "@/app/lib/pdf-text";
import { captureWebpageSnapshot } from "@/app/lib/webpage-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SummaryRequest {
  paper?: {
    title?: string;
    abstract?: string;
    authors?: string[];
    venue?: string;
    year?: number | null;
    url?: string | null;
    doi?: string | null;
    localPath?: string | null;
  };
}

/**
 * The paper's own text for {{paper}}: the stored PDF read page-by-page (honoring
 * a {{paper[a:b]}} range, defaulting to the whole document), or a web snapshot of
 * the paper's URL when no local PDF exists. Grounding is best-effort — a missing
 * file or a challenge page just yields no text, and the summary leans on metadata.
 */
async function readPaperText(
  localPath: string | null | undefined,
  url: string | null | undefined,
  slice: ReturnType<typeof pageSliceFor>,
): Promise<string> {
  const stored = localPath ? resolveStoredFile("pdfs", localPath) : null;
  if (stored) {
    try {
      const bytes = new Uint8Array(readFileSync(stored.path));
      const { text } = await readPdfPages(bytes, slice ?? { start: 1, end: null });
      if (text) return text;
    } catch {
      // Unreadable PDF — fall through to the URL snapshot below.
    }
  }
  if (url?.startsWith("https")) {
    try {
      const snapshot = await captureWebpageSnapshot(new URL(url));
      return snapshot.text.slice(0, 32000);
    } catch {
      return "";
    }
  }
  return "";
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues();
    const body = (await request.json()) as SummaryRequest;
    const paper = body.paper;
    if (!paper?.title) {
      return Response.json({ error: "A paper title is required." }, { status: 400 });
    }
    const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
    if (!token) {
      return Response.json(
        { error: "AWS_BEARER_TOKEN_BEDROCK is not configured." },
        { status: 500 },
      );
    }
    const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
    const model = runtimeValue(runtime, "BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6");
    const configuredPrompt = runtimeValue(runtime, "STACKS_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT);
    // {{paper}} carries the paper's own text (the stored PDF, page-sliceable via
    // {{paper[a:b]}}, or a web snapshot); {{metadata}} carries the record fields.
    const slice = pageSliceFor(configuredPrompt, "paper");
    const paperText = await readPaperText(paper.localPath, paper.url, slice);
    const metadata = [
      `Title: ${paper.title}`,
      `Authors: ${(paper.authors ?? []).join(", ") || "Unknown"}`,
      `Venue: ${paper.venue ?? "Unknown"} (${paper.year ?? "n.d."})`,
      `DOI: ${paper.doi ?? "Not available"}`,
      `Abstract: ${paper.abstract ?? "Not available"}`,
    ].join("\n");
    const templatedPrompt = renderPromptTemplate(configuredPrompt, {
      paper: paperText || "Not available",
      metadata,
      title: paper.title,
      authors: (paper.authors ?? []).join(", ") || "Unknown",
      venue: paper.venue ?? "Unknown",
      year: String(paper.year ?? "n.d."),
      doi: paper.doi ?? "Not available",
      abstract: paper.abstract ?? "Not available",
    });
    const result = await invokeBedrockMessages({
      token,
      region,
      model,
      system: templatedPrompt,
      messages: [{
        role: "user",
        content: "Write the structured academic review defined by the system prompt. Cover every requested section, explicitly marking material that is not described or not applicable.",
      }],
      maxTokens: Math.max(128, Number(runtimeValue(runtime, "STACKS_MAX_TOKENS", "10000"))),
      temperature: Math.min(1, Math.max(0, Number(runtimeValue(runtime, "STACKS_TEMPERATURE", "0.2")))),
    });
    const summary = result.content;
    if (!summary) {
      return Response.json({ error: "No summary was generated." }, { status: 502 });
    }
    return Response.json({ summary, model, endpoint: result.endpoint, groundedWithReader: Boolean(paperText) });
  } catch (error) {
    if (error instanceof BedrockInvocationError) {
      return Response.json({ error: `Bedrock returned ${error.status}: ${error.message}` }, { status: 502 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Summary generation failed." },
      { status: 502 },
    );
  }
}
