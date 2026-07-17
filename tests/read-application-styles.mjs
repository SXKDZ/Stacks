import { readFile } from "node:fs/promises";

const globalsUrl = new URL("../app/globals.css", import.meta.url);

export async function readApplicationStyles() {
  const globals = await readFile(globalsUrl, "utf8");
  const modulePaths = Array.from(
    globals.matchAll(/@import\s+["']\.\/styles\/([^"']+)["'];/g),
    (match) => match[1],
  );
  const modules = await Promise.all(
    modulePaths.map((modulePath) =>
      readFile(new URL(`../app/styles/${modulePath}`, import.meta.url), "utf8"),
    ),
  );

  return [globals, ...modules].join("\n");
}
