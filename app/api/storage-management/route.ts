import { execFileSync } from "node:child_process";
import { cpSync, existsSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDatabase } from "@/db/bootstrap";
import { getRawConnection } from "@/db/client";
import { databasePath, ensureLibraryDirectories, libraryRoot, setLibraryRoot, settingsPath } from "@/db/library-paths";
import { papers } from "@/db/schema";
import { inspectStorage } from "@/app/lib/local-files";

const PLATFORM_LABELS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** Backend/runtime facts shown in the Doctor's System card. */
function systemInfo() {
  let sqliteVersion = "";
  try {
    const row = getRawConnection(databasePath()).prepare("select sqlite_version() as v").get() as { v?: string };
    sqliteVersion = row?.v ?? "";
  } catch {
    // Non-fatal; leave blank.
  }
  // The AI feed drives a local `claude` CLI; report whether it's available.
  let claudeVersion = "";
  try {
    claudeVersion = execFileSync(process.env.STACKS_CLAUDE_BIN?.trim() || "claude", ["--version"], {
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    // CLI not installed / not on PATH.
  }
  return {
    runtime: `Node.js ${process.version}`,
    database: sqliteVersion ? `SQLite ${sqliteVersion} (better-sqlite3)` : "SQLite (better-sqlite3)",
    platform: `${PLATFORM_LABELS[platform()] ?? platform()} ${release()} · ${arch()}`,
    filesystemAvailable: true,
    claudeCli: claudeVersion || null,
  };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StorageManagementRequest {
  operation?: "inspect" | "clean" | "repair" | "clean-orphans" | "move";
  confirmed?: boolean;
  targetDirectory?: string;
}

// The actual orphaned entity records (id + label), so the Doctor can list them
// before the user removes them — not just a count.
const orphanRecordQueries = {
  authors: "SELECT id, display_name AS label FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors) ORDER BY display_name",
  venues: "SELECT id, name AS label FROM venues WHERE id NOT IN (SELECT venue_id FROM papers WHERE venue_id IS NOT NULL) ORDER BY name",
  collections: "SELECT id, name AS label FROM collections WHERE id NOT IN (SELECT collection_id FROM paper_collections) ORDER BY name",
} as const;

/**
 * Move the whole library to `targetDirectory`: a transactionally-consistent
 * copy of library.db plus settings.json and the pdfs/ and html_snapshots/
 * assets, then repoint storage.json so the next libraryRoot() resolves there.
 * Returns the new root. The original folder is left in place (the UI's second
 * confirmation covers removing it manually, or a later cleanup).
 */
async function moveLibrary(targetDirectory: string): Promise<string> {
  const target = resolve(targetDirectory.trim());
  const current = resolve(libraryRoot());
  if (!target) {
    throw new Error("Choose a destination folder for the Stacks library.");
  }
  if (target === current) {
    throw new Error("The destination is already the current library folder.");
  }
  if (target.startsWith(`${current}/`) || current.startsWith(`${target}/`)) {
    throw new Error("The destination must not be nested inside the current library folder (or vice versa).");
  }
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error("The destination's parent folder does not exist. Choose a valid location.");
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      throw new Error("The destination path is a file. Choose a folder.");
    }
    if (existsSync(join(target, "library.db"))) {
      throw new Error("The destination already contains a Stacks library (library.db). Choose an empty or new folder.");
    }
  }

  // Ensure schema init has run and the connection is open before snapshotting.
  await ensureDatabase();
  ensureLibraryDirectories(target);

  // Consistent DB snapshot via SQLite's backup API (never a torn file copy).
  const source = getRawConnection(databasePath());
  await source.backup(join(target, "library.db"));

  // Copy settings.json and the managed asset trees if present.
  const currentSettings = settingsPath();
  if (existsSync(currentSettings)) {
    cpSync(currentSettings, join(target, "settings.json"));
  }
  for (const dir of ["pdfs", "html_snapshots"]) {
    const from = join(current, dir);
    if (existsSync(from)) {
      cpSync(from, join(target, dir), { recursive: true });
    }
  }

  // Repoint Stacks at the new folder. getLibraryDb reopens on the changed path.
  setLibraryRoot(target);
  await ensureDatabase();
  return target;
}

const countedTables = [
  "papers",
  "authors",
  "venues",
  "collections",
  "paper_authors",
  "paper_collections",
] as const;

function absolutePath(value: string | null): boolean {
  return Boolean(value && (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)));
}

// Entities left with no papers after deletions. Authors/venues/collections are
// shared records, so deleting a paper never removes them — they accumulate as
// orphans the Doctor can report and clean.
const orphanedEntityQueries = {
  authors: "SELECT COUNT(*) AS count FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)",
  venues: "SELECT COUNT(*) AS count FROM venues WHERE id NOT IN (SELECT venue_id FROM papers WHERE venue_id IS NOT NULL)",
  collections: "SELECT COUNT(*) AS count FROM collections WHERE id NOT IN (SELECT collection_id FROM paper_collections)",
} as const;

/** Remove dangling associations and then any entities left with no papers. */
function cleanOrphans(raw: import("better-sqlite3").Database): void {
  const cleanup = raw.transaction(() => {
    raw.prepare(`DELETE FROM paper_authors
      WHERE paper_id NOT IN (SELECT id FROM papers)
         OR author_id NOT IN (SELECT id FROM authors)`).run();
    raw.prepare(`DELETE FROM paper_collections
      WHERE paper_id NOT IN (SELECT id FROM papers)
         OR collection_id NOT IN (SELECT id FROM collections)`).run();
    // Then drop entities left with no papers (dangling associations are gone,
    // so these NOT IN checks see the reconciled join tables).
    raw.prepare("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)").run();
    raw.prepare("DELETE FROM venues WHERE id NOT IN (SELECT venue_id FROM papers WHERE venue_id IS NOT NULL)").run();
    raw.prepare("DELETE FROM collections WHERE id NOT IN (SELECT collection_id FROM paper_collections)").run();
  });
  cleanup();
}

async function databaseDiagnostic(clean: boolean) {
  const database = await ensureDatabase();
  // PRAGMAs, orphan cleanup, and per-table counts are maintenance SQL that maps
  // cleanly to the raw connection Drizzle owns; run them there.
  const raw = database.$client;
  if (clean) {
    cleanOrphans(raw);
  }
  // The actual orphaned records (capped), so the Doctor can list them.
  const orphanRecords = Object.fromEntries(
    Object.entries(orphanRecordQueries).map(([key, query]) => {
      const rows = raw.prepare(`${query} LIMIT 200`).all() as Array<{ id: string; label: string }>;
      return [key, rows] as const;
    }),
  ) as Record<keyof typeof orphanRecordQueries, Array<{ id: string; label: string }>>;
  const orphanedEntities = Object.fromEntries(
    Object.entries(orphanedEntityQueries).map(([key, query]) => {
      const row = raw.prepare(query).get() as { count: number };
      return [key, Number(row?.count ?? 0)] as const;
    }),
  ) as Record<keyof typeof orphanedEntityQueries, number>;

  const integrityResult = raw.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  const foreignKeyResult = raw.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
  const paperRows = database
    .select({ id: papers.id, localPath: papers.localPath, htmlSnapshotPath: papers.htmlSnapshotPath })
    .from(papers)
    .all();
  const orphanedAuthors = raw.prepare(`SELECT COUNT(*) AS count FROM paper_authors pa
    LEFT JOIN papers p ON p.id = pa.paper_id
    LEFT JOIN authors a ON a.id = pa.author_id
    WHERE p.id IS NULL OR a.id IS NULL`).get() as { count: number };
  const orphanedCollections = raw.prepare(`SELECT COUNT(*) AS count FROM paper_collections pc
    LEFT JOIN papers p ON p.id = pc.paper_id
    LEFT JOIN collections c ON c.id = pc.collection_id
    WHERE p.id IS NULL OR c.id IS NULL`).get() as { count: number };
  const tableCounts = Object.fromEntries(countedTables.map((table) => {
    const result = raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, Number(result?.count ?? 0)] as const;
  })) as Record<string, number>;
  const absolutePdfPaths = paperRows.filter((paper) => absolutePath(paper.localPath)).map((paper) => paper.localPath as string);
  const absoluteHtmlPaths = paperRows.filter((paper) => absolutePath(paper.htmlSnapshotPath)).map((paper) => paper.htmlSnapshotPath as string);
  const integrityValues = integrityResult.flatMap((row) => Object.values(row).map(String));
  const integrityOk = integrityValues.length > 0 && integrityValues.every((value) => value.toLowerCase() === "ok");
  return {
    integrityOk,
    integrityMessages: integrityValues,
    foreignKeyEnforced: true,
    foreignKeyViolations: foreignKeyResult.length,
    tableCounts,
    orphanedAssociations: {
      paperAuthors: Number(orphanedAuthors?.count ?? 0),
      paperCollections: Number(orphanedCollections?.count ?? 0),
    },
    orphanedEntities,
    orphanRecords,
    absolutePdfPaths,
    absoluteHtmlPaths,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as StorageManagementRequest;
    if (body.operation === "move") {
      if (!body.confirmed) {
        return Response.json({ error: "Moving the library requires explicit confirmation." }, { status: 400 });
      }
      if (!body.targetDirectory?.trim()) {
        return Response.json({ error: "Choose a destination folder for the Stacks library." }, { status: 400 });
      }
      await moveLibrary(body.targetDirectory);
      // Fall through to return a fresh inspection of the now-current library.
    }
    // A targeted orphan cleanup: remove dangling associations + entities with no
    // papers, without the full path-repair pass.
    if (body.operation === "clean-orphans") {
      if (!body.confirmed) {
        return Response.json({ error: "Removing orphaned records requires explicit confirmation." }, { status: 400 });
      }
      const database = await ensureDatabase();
      cleanOrphans(database.$client);
    }
    const clean = body.operation === "clean" || body.operation === "repair";
    if (clean && !body.confirmed) {
      return Response.json({ error: "Cleanup requires explicit confirmation." }, { status: 400 });
    }
    const databaseHealth = await databaseDiagnostic(clean);
    const paperRecords = databaseHealth.tableCounts.papers ?? 0;

    // The library is a local SQLite file with real PDF/HTML assets on disk;
    // inspect them against the paths the database references.
    const database = await ensureDatabase();
    const assetRows = database
      .select({ localPath: papers.localPath, htmlSnapshotPath: papers.htmlSnapshotPath })
      .from(papers)
      .all();
    const referencedPdf = assetRows
      .map((row) => (row.localPath ? basename(row.localPath) : null))
      .filter((name): name is string => Boolean(name));
    const referencedHtml = assetRows
      .map((row) => (row.htmlSnapshotPath ? basename(row.htmlSnapshotPath) : null))
      .filter((name): name is string => Boolean(name));
    const papersWithoutLocalAsset = assetRows.filter(
      (row) => !row.localPath?.trim() && !row.htmlSnapshotPath?.trim(),
    ).length;
    const storage = inspectStorage(referencedPdf, referencedHtml, clean);

    return Response.json({
      mode: "local",
      capabilities: {
        databaseChecks: true,
        fileChecks: true,
        repairs: ["orphaned-associations", "orphaned-entities", "orphaned-files"],
        folderMove: true,
      },
      libraryRoot: storage.libraryRoot,
      libraryExists: true,
      databasePresent: storage.databaseExists,
      settingsPresent: true,
      databaseHealth,
      systemHealth: systemInfo(),
      assets: [],
      paperRecords,
      referencedPdfFiles: referencedPdf.length,
      presentPdfFiles: storage.pdf.present,
      missingPdfFiles: storage.pdf.missing,
      missingPdfPaths: storage.pdf.missingPaths,
      referencedHtmlFiles: referencedHtml.length,
      presentHtmlFiles: storage.html.present,
      missingHtmlFiles: storage.html.missing,
      missingHtmlPaths: storage.html.missingPaths,
      invalidPdfPaths: databaseHealth.absolutePdfPaths,
      invalidHtmlPaths: databaseHealth.absoluteHtmlPaths,
      invalidReferences: databaseHealth.absolutePdfPaths.length + databaseHealth.absoluteHtmlPaths.length,
      papersWithoutLocalAsset,
      paperIdsWithoutLocalAsset: [],
      storedPdfFiles: storage.pdf.storedFiles,
      storedPdfBytes: storage.pdf.storedBytes,
      storedHtmlFiles: storage.html.storedFiles,
      storedHtmlBytes: storage.html.storedBytes,
      totalFiles: storage.totalFiles,
      totalBytes: storage.totalBytes,
      orphanedFiles: storage.orphanedFiles,
      orphanedBytes: storage.orphanedBytes,
      removedFiles: storage.removedFiles,
      removedBytes: storage.removedBytes,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Stacks storage could not be inspected." },
      { status: 400 },
    );
  }
}
