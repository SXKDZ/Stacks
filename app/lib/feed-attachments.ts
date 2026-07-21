import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inArray } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { papers } from "@/db/schema";
import { storedDirectory } from "@/app/lib/local-files";

/** A file the agent can read from its working directory to ground its work. */
export interface SnippetAttachment {
  /** Path relative to the snippet working dir, e.g. "attachments/paper.pdf". */
  relativePath: string;
  /** A short human label for the prompt (paper title or original filename). */
  label: string;
  /** Where it came from, for the prompt's phrasing. */
  kind: "paper-pdf" | "paper-html" | "upload";
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
 * Stage a snippet's attachments into `<workingDir>/attachments/` so the agent
 * (whose cwd is the working dir) can read them by relative path. Uploaded files
 * are written straight through; attached library papers contribute their local
 * PDF and/or HTML snapshot when present. Returns only what actually landed.
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
    attachments.push({ relativePath: `${ATTACHMENTS_DIR}/${name}`, label: file.name || name, kind: "upload" });
  }

  if (paperIds.length) {
    const database = await ensureDatabase();
    const rows = database
      .select({
        id: papers.id,
        title: papers.title,
        localPath: papers.localPath,
        htmlSnapshotPath: papers.htmlSnapshotPath,
      })
      .from(papers)
      .where(inArray(papers.id, paperIds))
      .all();

    for (const paper of rows) {
      const label = paper.title || paper.id;
      if (paper.localPath) {
        const source = join(storedDirectory("pdf"), paper.localPath);
        if (existsSync(source)) {
          ensureDir();
          const name = uniqueName(dir, safeName(paper.localPath));
          copyFileSync(source, join(dir, name));
          attachments.push({ relativePath: `${ATTACHMENTS_DIR}/${name}`, label, kind: "paper-pdf" });
          continue;
        }
      }
      if (paper.htmlSnapshotPath) {
        const source = join(storedDirectory("html"), paper.htmlSnapshotPath);
        if (existsSync(source)) {
          ensureDir();
          const name = uniqueName(dir, safeName(paper.htmlSnapshotPath));
          copyFileSync(source, join(dir, name));
          attachments.push({ relativePath: `${ATTACHMENTS_DIR}/${name}`, label, kind: "paper-html" });
        }
      }
    }
  }

  return attachments;
}
