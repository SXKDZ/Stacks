import { readFeedWorkflows, writeFeedWorkflows } from "@/app/lib/local-settings";
import { readWorkflowMeta } from "@/app/lib/workflow-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StoredWorkflow { id: string; name: string; description: string; script: string }

/** Coerce arbitrary input into a clean saved-workflow list. Each entry keeps its
 *  script and derives name/description from the script's `meta` (falling back to
 *  the posted values), so the list always reflects what the script actually is. */
function normalize(input: unknown): StoredWorkflow[] {
  if (!Array.isArray(input)) return [];
  const out: StoredWorkflow[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const script = typeof entry.script === "string" ? entry.script : "";
    if (!script.trim()) continue;
    const meta = readWorkflowMeta(script);
    out.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `wf-${crypto.randomUUID()}`,
      name: (meta?.name ?? (typeof entry.name === "string" ? entry.name : "Untitled workflow")).slice(0, 80),
      description: (meta?.description ?? (typeof entry.description === "string" ? entry.description : "")).slice(0, 300),
      script: script.slice(0, 200000),
    });
  }
  return out;
}

/** The user's saved workflows (empty list if none saved yet). */
export async function GET(): Promise<Response> {
  return Response.json({ workflows: readFeedWorkflows() ?? [] });
}

/** Replace the saved workflows with the posted set. Reports which entries have
 *  an unparseable meta so the UI can flag them. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { workflows?: unknown };
  const workflows = normalize(body.workflows);
  writeFeedWorkflows(workflows);
  return Response.json({ workflows });
}
