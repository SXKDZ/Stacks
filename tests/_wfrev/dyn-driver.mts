import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STACKS_LIBRARY_DIR = mkdtempSync(join(tmpdir(), "wfdyn-"));
const { readWorkflowMeta } = await import("/Users/SXKDZ/Documents/Coding/Repository/PaperAssistant/app/lib/workflow-runtime.ts");
const meta = readWorkflowMeta('export const meta = { name: "n", description: "d" };\nimport("node:fs");');
console.log("META " + JSON.stringify(meta));
await new Promise((r) => setTimeout(r, 200));
console.log("SURVIVED");
