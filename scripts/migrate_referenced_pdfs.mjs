import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink, utimes } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    destination: { type: "string" },
    database: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

if (!values.source || !values.destination || !values.database) {
  throw new Error("Usage: node scripts/migrate_referenced_pdfs.mjs --source <legacy-pdfs> --destination <library-pdfs> --database <d1.sqlite> [--apply]");
}

const sourceDirectory = resolve(values.source);
const destinationDirectory = resolve(values.destination);
const databasePath = resolve(values.database);

if (!existsSync(sourceDirectory)) throw new Error(`Legacy PDF folder does not exist: ${sourceDirectory}`);
if (!existsSync(databasePath)) throw new Error(`Library database does not exist: ${databasePath}`);

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function isPortablePdf(filename) {
  return filename === basename(filename) && extname(filename).toLowerCase() === ".pdf" && filename !== ".pdf";
}

async function pdfNames(directory) {
  if (!existsSync(directory)) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".pdf")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database.prepare(`
  SELECT DISTINCT local_path AS localPath
  FROM papers
  WHERE local_path IS NOT NULL AND trim(local_path) <> ''
  ORDER BY local_path
`).all();
database.close();

const references = rows.map((row) => String(row.localPath));
const invalidReferences = references.filter((filename) => !isPortablePdf(filename));
const validReferences = references.filter(isPortablePdf);
const referenceSet = new Set(validReferences);
const sourceNames = await pdfNames(sourceDirectory);
const destinationNamesBefore = await pdfNames(destinationDirectory);
const sourceSet = new Set(sourceNames);
const destinationSetBefore = new Set(destinationNamesBefore);
const sourceExtras = sourceNames.filter((filename) => !referenceSet.has(filename));
const destinationExtrasBefore = destinationNamesBefore.filter((filename) => !referenceSet.has(filename));

const alreadyPresent = [];
const copyCandidates = [];
const missingSource = [];
const conflicts = [];
let bytesToCopy = 0;

for (const filename of validReferences) {
  const sourcePath = join(sourceDirectory, filename);
  const destinationPath = join(destinationDirectory, filename);
  const sourceExists = sourceSet.has(filename);
  const destinationExists = destinationSetBefore.has(filename);

  if (destinationExists) {
    if (sourceExists) {
      const [sourceHash, destinationHash] = await Promise.all([sha256(sourcePath), sha256(destinationPath)]);
      if (sourceHash !== destinationHash) {
        conflicts.push(filename);
        continue;
      }
    }
    alreadyPresent.push(filename);
    continue;
  }

  if (!sourceExists) {
    missingSource.push(filename);
    continue;
  }

  const sourceStats = await stat(sourcePath);
  bytesToCopy += sourceStats.size;
  copyCandidates.push({ filename, sourcePath, destinationPath, sourceStats });
}

const copied = [];
if (values.apply && !invalidReferences.length && !conflicts.length && !missingSource.length) {
  await mkdir(destinationDirectory, { recursive: true });
  for (const candidate of copyCandidates) {
    await copyFile(candidate.sourcePath, candidate.destinationPath, constants.COPYFILE_EXCL);
    const [sourceHash, destinationHash] = await Promise.all([sha256(candidate.sourcePath), sha256(candidate.destinationPath)]);
    if (sourceHash !== destinationHash) {
      await unlink(candidate.destinationPath);
      throw new Error(`Verification failed while copying ${candidate.filename}; the incomplete destination copy was removed.`);
    }
    await utimes(candidate.destinationPath, candidate.sourceStats.atime, candidate.sourceStats.mtime);
    copied.push(candidate.filename);
  }
}

const destinationNamesAfter = await pdfNames(destinationDirectory);
const destinationSetAfter = new Set(destinationNamesAfter);
const unresolvedAfter = validReferences.filter((filename) => !destinationSetAfter.has(filename));
const destinationExtrasAfter = destinationNamesAfter.filter((filename) => !referenceSet.has(filename));

const report = {
  mode: values.apply ? "apply" : "dry-run",
  sourceDirectory,
  destinationDirectory,
  databasePath,
  referencedPdfs: references.length,
  validPortableReferences: validReferences.length,
  invalidReferences,
  alreadyPresent: alreadyPresent.length,
  wouldCopy: copyCandidates.length,
  copied: copied.length,
  bytesToCopy,
  missingSource,
  conflicts,
  sourceExtras,
  destinationExtrasBefore,
  destinationPdfCountAfter: destinationNamesAfter.length,
  destinationExtrasAfter,
  unresolvedAfter,
};

console.log(JSON.stringify(report, null, 2));

if (invalidReferences.length || conflicts.length || missingSource.length || (values.apply && unresolvedAfter.length)) {
  process.exitCode = 1;
}
