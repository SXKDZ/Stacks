import { ScholarlyProviderError, searchProvider } from "@/app/lib/scholarly";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { parseRequest } from "@/app/lib/schemas/parse";
import { DiscoverRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues();
    const parsed = await parseRequest(DiscoverRequestSchema, request);
    if (!parsed.ok) {
      return errorResponse("Enter a topic, title, DOI, or author to search.");
    }
    const query = parsed.data.query;
    const provider = parsed.data.provider ?? "semantic-scholar";
    const results = await searchProvider(provider, query, {
      semanticScholarApiKey: runtimeValue(runtime, "SEMANTIC_SCHOLAR_API_KEY"),
      serpApiKey: runtimeValue(runtime, "SERPAPI_KEY"),
    });
    return Response.json({ requestedProvider: provider, resolvedProvider: provider, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery search failed.";
    const status = error instanceof ScholarlyProviderError ? error.status : 502;
    return errorResponse(message, status);
  }
}
