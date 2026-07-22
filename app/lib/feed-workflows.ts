import { FEED_SKILL_ICONS, DEFAULT_FEED_SKILL_ICON } from "@/app/lib/feed-skills";

/**
 * Feed workflows: an ordered chain of prompt STEPS the agent runs across resume
 * turns, with an approval gate between each step. A skill is a single prompt; a
 * workflow strings several together (e.g. Summarize → Extract metadata → Propose
 * add-to-library). Users add/edit/remove/reorder them in Settings → Feed
 * workflows, or import one from a JS/JSON file. They persist in settings.json,
 * so the shape is JSON-serializable (icons stored by name, like skills).
 */
export interface FeedWorkflowStep {
  /** A short label for the step, shown as it runs. */
  label: string;
  /** The instruction sent to the agent for this step. */
  prompt: string;
}

export interface FeedWorkflow {
  id: string;
  label: string;
  icon: string;
  steps: FeedWorkflowStep[];
}

/** The seed workflows, used when the user has none saved yet. */
export const DEFAULT_FEED_WORKFLOWS: FeedWorkflow[] = [
  {
    id: "triage-and-file",
    label: "Triage & file",
    icon: "wand",
    steps: [
      {
        label: "Summarize",
        prompt: "Read the attached paper (or the link/note above) and write a careful, section-by-section technical summary. Only state what is explicitly in the source; never infer unreported results.",
      },
      {
        label: "Extract metadata",
        prompt: "From the same source, extract the paper's metadata: title, authors (full list), year, venue, paperType (conference/journal/workshop/preprint/other), DOI, and arXiv id if present. List anything you could not find.",
      },
      {
        label: "Propose add-to-library",
        prompt: "Propose adding this paper to the library with the metadata you extracted (a stacks-proposals block). Set paperType and venue. Do not claim it was added — it queues for my approval.",
      },
    ],
  },
];

/** Validate + normalize a workflows array from settings.json or the API. */
export function normalizeFeedWorkflows(value: unknown): FeedWorkflow[] {
  if (!Array.isArray(value)) {
    return DEFAULT_FEED_WORKFLOWS;
  }
  const workflows: FeedWorkflow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
    const steps: FeedWorkflowStep[] = [];
    for (const step of rawSteps) {
      if (!step || typeof step !== "object") continue;
      const stepRecord = step as Record<string, unknown>;
      const prompt = typeof stepRecord.prompt === "string" ? stepRecord.prompt.trim() : "";
      if (!prompt) continue;
      const stepLabel = typeof stepRecord.label === "string" && stepRecord.label.trim()
        ? stepRecord.label.trim().slice(0, 60)
        : `Step ${steps.length + 1}`;
      steps.push({ label: stepLabel, prompt: prompt.slice(0, 4000) });
    }
    if (!label || steps.length === 0) continue;
    const icon = typeof candidate.icon === "string" && FEED_SKILL_ICONS[candidate.icon]
      ? candidate.icon
      : DEFAULT_FEED_SKILL_ICON;
    const id = typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : `workflow-${workflows.length}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    workflows.push({ id, label: label.slice(0, 60), icon, steps });
  }
  return workflows;
}

/**
 * Parse a workflow (or several) out of an imported JS/JSON file's text. Accepts:
 *  - a JSON array of workflows, or a single workflow object
 *  - a JS module exporting `workflow`/`workflows`/`default` as an object literal
 * The object literal is read with a permissive JSON extraction (the file is
 * user-supplied text, never executed), then run through normalizeFeedWorkflows.
 */
export function parseWorkflowFile(source: string): FeedWorkflow[] {
  const text = source.trim();
  if (!text) return [];
  // First try straight JSON (array or object).
  const direct = tryJson(text);
  if (direct !== undefined) {
    return normalizeFeedWorkflows(Array.isArray(direct) ? direct : [direct]);
  }
  // Otherwise pull the value assigned to an export and JSON-parse that slice.
  const assignment = text.match(/export\s+(?:const|default)\s+(?:workflows?|default)?\s*=?\s*/);
  const start = assignment ? text.indexOf(assignment[0]) + assignment[0].length : -1;
  const literal = start >= 0 ? extractBalanced(text.slice(start)) : "";
  const parsed = literal ? tryJson(jsObjectToJson(literal)) : undefined;
  if (parsed === undefined) return [];
  return normalizeFeedWorkflows(Array.isArray(parsed) ? parsed : [parsed]);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Slice the first balanced {...} or [...] region from the start of `text`. */
function extractBalanced(text: string): string {
  const open = text.search(/[[{]/);
  if (open < 0) return "";
  const openChar = text[open];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

/** Best-effort convert a JS object literal to JSON: quote keys, drop trailing
 *  commas, normalize single-quoted strings. Good enough for a config literal. */
function jsObjectToJson(literal: string): string {
  return literal
    // single- or backtick-quoted strings → double-quoted (no escaping of inner
    // doubles beyond the common case; config values rarely contain quotes)
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => `"${inner.replace(/"/g, '\\"')}"`)
    .replace(/`((?:[^`\\]|\\.)*)`/g, (_m, inner: string) => `"${inner.replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`)
    // unquoted object keys → quoted
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    // trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, "$1");
}
