import { existsSync } from "node:fs";
import { join } from "node:path";
import { chooseDirectory } from "@/app/lib/local-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as { target?: string };
    const target = body.target === "local" ? "local" : body.target === "storage" ? "storage" : "remote";
    const path = await chooseDirectory(target);
    return Response.json({
      path,
      sourceExists: target === "local" && path ? existsSync(join(path, "papers.db")) : undefined,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The folder selector could not be opened." },
      { status: 500 },
    );
  }
}
