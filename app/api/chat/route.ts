import {
  containsPaperPlaceholder,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";

export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  messages?: ChatMessage[];
  paper?: {
    title?: string;
    abstract?: string;
    summary?: string;
    notes?: string;
    authors?: string[];
    venue?: string;
    year?: number | null;
  };
  papers?: Array<NonNullable<ChatRequest["paper"]>>;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues(request);
    const body = (await request.json()) as ChatRequest;
    const messages = (body.messages ?? [])
      .filter((message) => message.content.trim())
      .slice(-12);
    if (!messages.length) {
      return Response.json({ error: "Ask a question to begin." }, { status: 400 });
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
    const papers = (body.papers?.length ? body.papers : body.paper ? [body.paper] : []).slice(0, 8);
    const paperContexts = papers.map((paper, index) => [
          `Paper ${index + 1}`,
          `Title: ${paper.title ?? "Unknown"}`,
          `Authors: ${(paper.authors ?? []).join(", ") || "Unknown"}`,
          `Venue: ${paper.venue ?? "Unknown"} (${paper.year ?? "n.d."})`,
          `Abstract: ${paper.abstract ?? "Not available"}`,
          `Library summary: ${paper.summary ?? "Not available"}`,
          `Researcher notes: ${paper.notes ?? "None"}`,
        ].join("\n"));
    const paperContext = paperContexts.length
      ? paperContexts.join("\n\n---\n\n")
      : "No paper is selected. Help with the research library as a whole.";
    const configuredPrompt = runtimeValue(runtime, "PA_CHAT_SYSTEM_PROMPT", DEFAULT_CHAT_SYSTEM_PROMPT);
    const replacements: Record<string, string> = {
      paper_count: String(paperContexts.length),
      papers: paperContext,
    };
    for (let index = 0; index < 8; index += 1) {
      replacements[`paper${index + 1}`] = paperContexts[index] ?? "Not selected.";
    }
    const templatedPrompt = renderPromptTemplate(configuredPrompt, replacements);
    const systemPrompt = containsPaperPlaceholder(configuredPrompt)
      ? templatedPrompt
      : `${templatedPrompt}\n\nSelected paper context:\n${paperContext}`;
    const result = await invokeBedrockMessages({
      token,
      region,
      model,
      system: `${systemPrompt}\n\nGive concise, useful next steps. Format responses as GitHub-flavored Markdown. Use $...$ for inline mathematics and $$...$$ on separate lines for display equations. Use fenced code blocks when code is useful.`,
      messages,
      maxTokens: Math.min(8192, Math.max(128, Number(runtimeValue(runtime, "PA_MAX_TOKENS", "1200")))),
      temperature: Math.min(1, Math.max(0, Number(runtimeValue(runtime, "PA_TEMPERATURE", "0.25")))),
    });
    return Response.json({
      content: result.content || "I could not produce a response for that question.",
      model,
      endpoint: result.endpoint,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof BedrockInvocationError) {
      return Response.json({ error: `Bedrock returned ${error.status}: ${error.message}` }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "The assistant request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
