import { basename } from "node:path";
import { ensureDatabase } from "@/db/bootstrap";
import { papers } from "@/db/schema";
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
  // PRAGMAs, orphan cleanup, and per-table counts are maintenance SQL that maps
  // cleanly to the raw connection Drizzle owns; run them there.
  const raw = database.$client;
  if (clean) {
    const cleanup = raw.transaction(() => {
      raw.prepare(`DELETE FROM paper_authors
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR author_id NOT IN (SELECT id FROM authors)`).run();
      raw.prepare(`DELETE FROM paper_collections
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR collection_id NOT IN (SELECT id FROM collections)`).run();
      raw.prepare(`DELETE FROM paper_tags
        WHERE paper_id NOT IN (SELECT id FROM papers)
           OR tag_id NOT IN (SELECT id FROM tags)`).run();
    });
    cleanup();
  }

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
  const orphanedTags = raw.prepare(`SELECT COUNT(*) AS count FROM paper_tags pt
    LEFT JOIN papers p ON p.id = pt.paper_id
    LEFT JOIN tags t ON t.id = pt.tag_id
    WHERE p.id IS NULL OR t.id IS NULL`).get() as { count: number };
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
