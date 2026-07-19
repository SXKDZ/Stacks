import { isBrowserRequest, runtimeValues } from "@/app/lib/local-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get("x-pa-internal-runtime") !== "pa-runtime-v1" || isBrowserRequest(request)) {
    return Response.json({ error: "Internal runtime configuration is unavailable." }, { status: 403 });
  }
  return Response.json({ values: runtimeValues() });
}
