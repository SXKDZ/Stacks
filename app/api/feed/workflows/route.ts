import { readFeedWorkflows, writeFeedWorkflows } from "@/app/lib/local-settings";
import { readWorkflowMeta } from "@/app/lib/workflow-runtime";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedWorkflowsRequestSchema, IncomingWorkflowSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StoredWorkflow { id: string; name: string; description: string; script: string }

/** Coerce arbitrary input into a clean saved-workflow list. Each entry keeps its
 *  script and derives name/description from the script's `meta` (falling back to
 *  the posted values), so the list always reflects what the script actually is.
 *  Entries without a script are skipped rather than failing the whole save. */
/** Most workflows a person writes; also the cap on how much work one save can
 *  cost, since reading each entry's meta runs its script under a 1s vm budget. */
const MAX_SAVED_WORKFLOWS = 100;

function normalize(input: unknown): StoredWorkflow[] {
  if (!Array.isArray(input)) return [];
  const out: StoredWorkflow[] = [];
  // Bounded: readWorkflowMeta below executes each entry's script, so an unbounded
  // list of hostile scripts would occupy the server one vm timeout at a time.
  for (const raw of input.slice(0, MAX_SAVED_WORKFLOWS)) {
    const entry = parseWith(IncomingWorkflowSchema, raw);
    if (!entry.ok) continue;
    const script = entry.data.script;
    if (!script.trim()) continue;
    const meta = readWorkflowMeta(script);
    out.push({
      id: entry.data.id || `wf-${crypto.randomUUID()}`,
      name: (meta?.name ?? entry.data.name ?? "Untitled workflow").slice(0, 80),
      description: (meta?.description ?? entry.data.description ?? "").slice(0, 300),
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
  const parsed = parseWith(FeedWorkflowsRequestSchema, await request.json().catch(() => ({})));
  // A body that carries no workflows array is a malformed request, not an
  // instruction to save an empty list: answering 200 after replacing the saved
  // set with [] silently deleted every workflow the user had written.
  if (!parsed.ok || !Array.isArray(parsed.data.workflows)) {
    return Response.json({ error: "Send a workflows array to save." }, { status: 400 });
  }
  const workflows = normalize(parsed.data.workflows);
  writeFeedWorkflows(workflows);
  return Response.json({ workflows });
}
