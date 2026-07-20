import {
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
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
  };
}

async function readSource(url: string): Promise<string> {
  // Best-effort readable text from a locally-rendered snapshot. Grounding is
  // optional here, so a challenge/error page just yields no extra context
  // (the summary falls back to metadata) rather than surfacing an error.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return "";
    }
    const snapshot = await captureWebpageSnapshot(parsed);
    return snapshot.text.slice(0, 28000);
  } catch {
    return "";
  }
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
    const sourceText = paper.url?.startsWith("https")
      ? await readSource(paper.url)
      : "";
    const context = [
      `Title: ${paper.title}`,
      `Authors: ${(paper.authors ?? []).join(", ") || "Unknown"}`,
      `Venue: ${paper.venue ?? "Unknown"} (${paper.year ?? "n.d."})`,
      `DOI: ${paper.doi ?? "Not available"}`,
      `Abstract: ${paper.abstract ?? "Not available"}`,
      sourceText ? `Extracted paper content:\n${sourceText}` : "",
    ].filter(Boolean).join("\n\n");
    const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
    const model = runtimeValue(runtime, "BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6");
    const configuredPrompt = runtimeValue(runtime, "STACKS_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT);
    const templatedPrompt = renderPromptTemplate(configuredPrompt, {
      paper: context,
      paper1: context,
      paper_count: "1",
      title: paper.title,
      authors: (paper.authors ?? []).join(", ") || "Unknown",
      venue: paper.venue ?? "Unknown",
      year: String(paper.year ?? "n.d."),
      doi: paper.doi ?? "Not available",
      abstract: paper.abstract ?? "Not available",
      source_text: sourceText || "Not available",
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
      maxTokens: Math.max(128, Number(runtimeValue(runtime, "STACKS_MAX_TOKENS", "1400"))),
      temperature: Math.min(1, Math.max(0, Number(runtimeValue(runtime, "STACKS_TEMPERATURE", "0.2")))),
    });
    const summary = result.content;
    if (!summary) {
      return Response.json({ error: "No summary was generated." }, { status: 502 });
    }
    return Response.json({ summary, model, endpoint: result.endpoint, groundedWithReader: Boolean(sourceText) });
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
