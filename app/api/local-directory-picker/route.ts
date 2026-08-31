import { chooseDirectory } from "@/app/lib/local-settings";
import { parseWith } from "@/app/lib/schemas/parse";
import { DirectoryPickerRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = parseWith(DirectoryPickerRequestSchema, await request.json().catch(() => ({})));
    const requestedTarget = parsed.ok ? parsed.data.target : undefined;
    const path = await chooseDirectory(requestedTarget === "storage" ? "storage" : "remote");
    return Response.json({ path });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The folder selector could not be opened." },
      { status: 500 },
    );
  }
}
