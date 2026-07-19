import {
  containsPaperPlaceholder,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  streamBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { groundedDocumentText } from "@/app/lib/document-grounding";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    pdfUrl?: string | null;
    htmlUrl?: string | null;
  };
  papers?: Array<NonNullable<ChatRequest["paper"]>>;
  pdfStartPage?: number;
  pdfEndPage?: number;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues();
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
    const configuredPdfPages = Math.min(20, Math.max(1, Number(runtimeValue(runtime, "PA_PDF_PAGES", "10")) || 10));
    const pdfStartPage = Math.min(20, Math.max(1, Math.floor(Number(body.pdfStartPage) || 1)));
    const pdfEndPage = Math.min(20, Math.max(pdfStartPage, Math.floor(Number(body.pdfEndPage) || (pdfStartPage + configuredPdfPages - 1))));
    // Fetch every paper's document text concurrently (each can take seconds),
    // then apply the shared character budget deterministically in paper order so
    // the result is stable regardless of which fetch finishes first.
    const documentContexts = await Promise.all(
      papers.map((paper) =>
        groundedDocumentText({
          requestUrl: request.url,
          pdfUrl: paper.pdfUrl,
          htmlUrl: paper.htmlUrl,
          startPage: pdfStartPage,
          endPage: pdfEndPage,
        }).catch(() => null),
      ),
    );
    let remainingDocumentCharacters = 60_000;
    let groundedPapers = 0;
    const paperContexts: string[] = [];
    const groundingSources: Array<{ title: string; grounded: boolean; source: string }> = [];
    for (const [index, paper] of papers.entries()) {
      const documentContext = documentContexts[index];
      const attachedText = documentContext?.text.slice(0, remainingDocumentCharacters) ?? "";
      remainingDocumentCharacters -= attachedText.length;
      if (attachedText) {
        groundedPapers += 1;
      }
      groundingSources.push({
        title: paper.title ?? `Paper ${index + 1}`,
        grounded: Boolean(attachedText),
        source: attachedText ? (documentContext?.label ?? "document text") : "metadata only",
      });
      paperContexts.push([
        `Paper ${index + 1}`,
        `Title: ${paper.title ?? "Unknown"}`,
        `Authors: ${(paper.authors ?? []).join(", ") || "Unknown"}`,
        `Venue: ${paper.venue ?? "Unknown"} (${paper.year ?? "n.d."})`,
        `Abstract: ${paper.abstract ?? "Not available"}`,
        `Library summary: ${paper.summary ?? "Not available"}`,
        `Researcher notes: ${paper.notes ?? "None"}`,
        ...(attachedText ? [`${documentContext?.label}:\n${attachedText}`] : []),
      ].join("\n"));
    }
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
    const grounding = {
      paperCount: papers.length,
      groundedPapers,
      pdfStartPage,
      pdfEndPage,
      sources: groundingSources,
    };
    const streamOptions = {
      token,
      region,
      model,
      system: `${systemPrompt}\n\nGive concise, useful next steps. Format responses as GitHub-flavored Markdown. Use $...$ for inline mathematics and $$...$$ on separate lines for display equations. Use fenced code blocks when code is useful.`,
      messages,
      maxTokens: Math.max(128, Number(runtimeValue(runtime, "PA_MAX_TOKENS", "1200"))),
      temperature: Math.min(1, Math.max(0, Number(runtimeValue(runtime, "PA_TEMPERATURE", "0.25")))),
      // Forward the client's abort so stopping generation cancels the upstream
      // Bedrock request rather than letting it run (and bill) to completion.
      signal: request.signal,
    };

    // Buffered fallback: some preview proxies and hosts cannot forward a
    // `text/event-stream` response, which surfaces in the browser as a bare
    // "Failed to fetch". When the client opts out of streaming (Accept: json),
    // collect the whole completion and return it as a single JSON payload.
    const wantsStream = (request.headers.get("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      let content = "";
      let usage: Record<string, unknown> | null = null;
      for await (const chunk of streamBedrockMessages(streamOptions)) {
        if (chunk.type === "text" && chunk.text) {
          content += chunk.text;
        } else if (chunk.type === "usage") {
          usage = chunk.usage;
        }
      }
      return Response.json({
        content: content || "I could not produce a response for that question.",
        model,
        usage,
        grounding,
      });
    }

    const encoder = new TextEncoder();
    const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(frame("meta", { model, grounding }));
        let produced = false;
        let usage: Record<string, unknown> | null = null;
        try {
          for await (const chunk of streamBedrockMessages(streamOptions)) {
            if (chunk.type === "text" && chunk.text) {
              produced = true;
              controller.enqueue(frame("delta", { text: chunk.text }));
            } else if (chunk.type === "usage") {
              usage = chunk.usage;
            }
          }
          if (!produced) {
            controller.enqueue(frame("delta", { text: "I could not produce a response for that question." }));
          }
          controller.enqueue(frame("done", { usage }));
        } catch (error) {
          const message = error instanceof BedrockInvocationError
            ? `Bedrock returned ${error.status}: ${error.message}`
            : error instanceof Error ? error.message : "The assistant request failed.";
          controller.enqueue(frame("error", { message }));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof BedrockInvocationError) {
      return Response.json({ error: `Bedrock returned ${error.status}: ${error.message}` }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "The assistant request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
