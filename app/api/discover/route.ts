import type { DiscoveryProvider } from "@/app/lib/types";
import { ScholarlyProviderError, searchProvider } from "@/app/lib/scholarly";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";

export const dynamic = "force-dynamic";

interface DiscoverRequest {
  query?: string;
  provider?: DiscoveryProvider;
}

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues();
    const body = await request.json() as DiscoverRequest;
    const query = body.query?.trim();
    if (!query) {
      return errorResponse("Enter a topic, title, DOI, or author to search.");
    }
    const provider = body.provider ?? "semantic-scholar";
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
