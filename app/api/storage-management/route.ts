import { basename } from "node:path";
import { ensureDatabase } from "@/db/bootstrap";
import { inspectStorage } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StorageManagementRequest {
  operation?: "inspect" | "clean" | "repair" | "move";
  confirmed?: boolean;
}

const countedTables = [
  "papers",
  "authors",
  "venues",
  "collections",
  "paper_authors",
  "paper_collections",
  "tags",
  "paper_tags",
  "app_settings",
] as const;

function absolutePath(value: string | null): boolean {
  return Boolean(value && (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)));
}

async function databaseDiagnostic(clean: boolean) {
  const database = await ensureDatabase();
  if (clean) {
    await database.batch([
      database.prepare(`DELETE FROM paper_authors
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR author_id NOT IN (SELECT id FROM authors)`),
      database.prepare(`DELETE FROM paper_collections
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR collection_id NOT IN (SELECT id FROM collections)`),
      database.prepare(`DELETE FROM paper_tags
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR tag_id NOT IN (SELECT id FROM tags)`),
    ]);
  }

  const [integrityResult, foreignKeyResult, paperRows, orphanedAuthors, orphanedCollections, orphanedTags] = await Promise.all([
    database.prepare("PRAGMA quick_check").all<Record<string, unknown>>(),
    database.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>(),
    database.prepare("SELECT id, local_path, html_snapshot_path FROM papers").all<{ id: string; local_path: string | null; html_snapshot_path: string | null }>(),
    database.prepare(`SELECT COUNT(*) AS count FROM paper_authors pa
      LEFT JOIN papers p ON p.id = pa.paper_id
      LEFT JOIN authors a ON a.id = pa.author_id
      WHERE p.id IS NULL OR a.id IS NULL`).first<{ count: number }>(),
    database.prepare(`SELECT COUNT(*) AS count FROM paper_collections pc
      LEFT JOIN papers p ON p.id = pc.paper_id
      LEFT JOIN collections c ON c.id = pc.collection_id
      WHERE p.id IS NULL OR c.id IS NULL`).first<{ count: number }>(),
    database.prepare(`SELECT COUNT(*) AS count FROM paper_tags pt
      LEFT JOIN papers p ON p.id = pt.paper_id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.id IS NULL OR t.id IS NULL`).first<{ count: number }>(),
  ]);
  const tableCounts = Object.fromEntries(await Promise.all(countedTables.map(async (table) => {
    const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
    return [table, Number(result?.count ?? 0)] as const;
  }))) as Record<string, number>;
  const absolutePdfPaths = paperRows.results.filter((paper) => absolutePath(paper.local_path)).map((paper) => paper.local_path as string);
  const absoluteHtmlPaths = paperRows.results.filter((paper) => absolutePath(paper.html_snapshot_path)).map((paper) => paper.html_snapshot_path as string);
  const integrityValues = integrityResult.results.flatMap((row) => Object.values(row).map(String));
  const integrityOk = integrityValues.length > 0 && integrityValues.every((value) => value.toLowerCase() === "ok");
  return {
    integrityOk,
    integrityMessages: integrityValues,
    foreignKeyEnforced: true,
    foreignKeyViolations: foreignKeyResult.results.length,
    tableCounts,
    orphanedAssociations: {
      paperAuthors: Number(orphanedAuthors?.count ?? 0),
      paperCollections: Number(orphanedCollections?.count ?? 0),
      paperTags: Number(orphanedTags?.count ?? 0),
    },
    absolutePdfPaths,
    absoluteHtmlPaths,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as StorageManagementRequest;
    if (body.operation === "move") {
      return Response.json(
        { error: "Move the library folder from the filesystem, then update ~/.paperassistant/storage.json." },
        { status: 409 },
      );
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
    const assetRows = await database
      .prepare("SELECT local_path, html_snapshot_path FROM papers")
      .all<{ local_path: string | null; html_snapshot_path: string | null }>();
    const referencedPdf = assetRows.results
      .map((row) => (row.local_path ? basename(row.local_path) : null))
      .filter((name): name is string => Boolean(name));
    const referencedHtml = assetRows.results
      .map((row) => (row.html_snapshot_path ? basename(row.html_snapshot_path) : null))
      .filter((name): name is string => Boolean(name));
    const papersWithoutLocalAsset = assetRows.results.filter(
      (row) => !row.local_path?.trim() && !row.html_snapshot_path?.trim(),
    ).length;
    const storage = inspectStorage(referencedPdf, referencedHtml, clean);

    return Response.json({
      mode: "local",
      capabilities: {
        databaseChecks: true,
        fileChecks: true,
        repairs: ["orphaned-associations", "orphaned-files"],
        folderMove: false,
      },
      libraryRoot: storage.libraryRoot,
      libraryExists: true,
      databasePresent: storage.databaseExists,
      settingsPresent: true,
      databaseHealth,
      systemHealth: {
        runtime: "Node.js",
        database: "SQLite (library.db)",
        filesystemAvailable: true,
      },
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
      { error: error instanceof Error ? error.message : "PA storage could not be inspected." },
      { status: 400 },
    );
  }
}
