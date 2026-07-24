import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inArray } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { papers } from "@/db/schema";

/**
 * A thing the agent can ground its work on. Two shapes:
 *   - upload: a file the user uploaded, staged under the snippet working dir and
 *     read by relative path (the agent's cwd is the working dir).
 *   - paper: a reference to a library paper by id. We do NOT copy the paper's
 *     PDF/HTML into the working dir (that duplicated potentially huge files per
 *     feed turn); the agent reads the original's text through the token-gated
 *     API at /api/feed/library/papers/<paperId>/text.
 *
 * `paper-pdf`/`paper-html` are legacy kinds from when papers were copied in;
 * old feeds still carry them (with a relativePath) and keep rendering.
 */
export interface SnippetAttachment {
  kind: "upload" | "paper" | "paper-pdf" | "paper-html";
  /** A short human label for the prompt/UI (paper title or original filename). */
  label: string;
  /** Uploads (and legacy staged papers): path relative to the working dir. */
  relativePath?: string;
  /** Referenced library papers: the paper id the agent reads by API. */
  paperId?: string;
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const ATTACHMENTS_DIR = "attachments";

/** Strip path separators so a filename can't escape the attachments dir. */
function safeName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  return base || "file";
}

/** Avoid clobbering: file.pdf, file-1.pdf, file-2.pdf … */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  let counter = 1;
  while (existsSync(join(dir, `${stem}-${counter}${ext}`))) {
    counter += 1;
  }
  return `${stem}-${counter}${ext}`;
}

/**
 * Collect a snippet's attachments. Uploaded files are staged into
 * `<workingDir>/attachments/` so the agent can read them by relative path.
 * Attached library papers are referenced by id (no copy): the agent reads their
 * text through the API. Returns only what actually resolved.
 */
export async function collectSnippetAttachments(
  workingDir: string,
  files: File[],
  paperIds: string[],
): Promise<SnippetAttachment[]> {
  const attachments: SnippetAttachment[] = [];
  const dir = join(workingDir, ATTACHMENTS_DIR);
  const ensureDir = () => mkdirSync(dir, { recursive: true });

  for (const file of files) {
    if (!file.size || file.size > MAX_UPLOAD_BYTES) {
      continue;
    }
    ensureDir();
    const name = uniqueName(dir, safeName(file.name));
    const bytes = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(dir, name), bytes, { flag: "wx" });
    attachments.push({ kind: "upload", relativePath: `${ATTACHMENTS_DIR}/${name}`, label: file.name || name });
  }

  if (paperIds.length) {
    const database = await ensureDatabase();
    const rows = database
      .select({ id: papers.id, title: papers.title })
      .from(papers)
      .where(inArray(papers.id, paperIds))
      .all();
    // Preserve the order the user attached them in, and skip ids that no longer
    // exist. No file copy: the reference is just the id the agent reads by API.
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const paperId of paperIds) {
      const paper = byId.get(paperId);
      if (paper) {
        attachments.push({ kind: "paper", paperId: paper.id, label: paper.title || paper.id });
      }
    }
  }

  return attachments;
}
