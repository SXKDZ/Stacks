/**
 * Shapes returned by the Bedrock endpoints Stacks calls.
 *
 * This is third-party JSON over the network: the most genuinely untrusted input
 * in the app after the agent. The previous casts leaned on optional chaining all
 * the way down, so an unexpected shape (an API version change, an error body
 * returned with a 200, a proxy's HTML) silently produced an empty summary rather
 * than an error the caller could report.
 *
 * Both response schemas are deliberately tolerant about *extra* fields (the
 * provider adds them over time) and strict about the part we read.
 */
import { z } from "zod";

/** A text block in either endpoint's content array. */
const TextBlockSchema = z.object({ text: z.string().optional() }).loose();

/** The Mantle (Anthropic-compatible) messages response. */
export const MantleResponseSchema = z.object({
  content: z.array(TextBlockSchema).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
}).loose();

/** The OpenAI-compatible Responses API response from bedrock-mantle. */
export const OpenAIResponsesResponseSchema = z.object({
  // `output_text` is exposed by compatible clients and accepted here as a
  // defensive fallback; the raw HTTP response normally carries message content
  // inside `output`.
  output_text: z.string().optional(),
  output: z.array(z.object({
    content: z.array(z.object({
      type: z.string().optional(),
      text: z.string().optional(),
    }).loose()).optional(),
  }).loose()).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
}).loose();

/** The Bedrock Runtime converse response. */
export const RuntimeResponseSchema = z.object({
  output: z.object({
    message: z.object({
      content: z.array(TextBlockSchema).optional(),
    }).loose().optional(),
  }).loose().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
}).loose();

/** An AWS error body, used only to surface a readable upstream message. */
export const UpstreamErrorSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).loose().optional(),
}).loose();

/**
 * Join a content array's text blocks into one string.
 *
 * Non-text blocks are dropped rather than joined as empty strings: with reasoning
 * enabled the reply arrives as `[reasoningContent, text]`, and mapping every block
 * put a blank line at the top of every summary. The thinking itself is deliberately
 * not surfaced; only the answer is.
 */
export function joinTextBlocks(blocks: Array<{ text?: string }> | undefined): string {
  return (blocks ?? [])
    .map((block) => block.text ?? "")
    .filter((text) => text !== "")
    .join("\n")
    .trim();
}

/** Read the answer text while ignoring reasoning and tool-call output items. */
export function openAIResponseText(response: z.infer<typeof OpenAIResponsesResponseSchema>): string {
  if (response.output_text?.trim()) {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => !part.type || part.type === "output_text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** One entry from the Bedrock inference-profiles listing. */
export const InferenceProfileSummarySchema = z.object({
  inferenceProfileId: z.string().optional(),
  inferenceProfileName: z.string().optional(),
  status: z.string().optional(),
}).loose();

/** The inference-profiles listing (the Runtime model catalogue). */
export const InferenceProfilesResponseSchema = z.object({
  inferenceProfileSummaries: z.array(InferenceProfileSummarySchema).optional(),
  message: z.string().optional(),
}).loose();

/** The Mantle model catalogue. */
export const MantleModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().optional() }).loose()).optional(),
}).loose();
