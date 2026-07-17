import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(projectRoot, "app", "globals.css");
const outputPath = path.join(projectRoot, "public", "color-audit.html");
const entryCss = await readFile(cssPath, "utf8");
const importedFiles = [...entryCss.matchAll(/@import\s+["']\.\/styles\/([^"']+)["']/g)]
  .map((match) => path.join(projectRoot, "app", "styles", match[1]));
const sources = [cssPath, ...importedFiles];
const colorPattern = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g;
const colors = new Map();

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseHex(value) {
  const raw = value.slice(1);
  const expanded = raw.length <= 4 ? [...raw].map((character) => character + character).join("") : raw;
  if (![6, 8].includes(expanded.length)) return null;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function parseRgb(value) {
  const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  if (delta === 0) return { h: 0, s: 0, l: lightness * 100 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function selectorAtIndex(css, index) {
  const blockStart = css.lastIndexOf("{", index);
  const blockEnd = css.lastIndexOf("}", index);
  if (blockStart < 0 || blockEnd > blockStart) return "";
  const previousOpen = css.lastIndexOf("{", blockStart - 1);
  const previousClose = css.lastIndexOf("}", blockStart - 1);
  return css.slice(Math.max(previousOpen, previousClose) + 1, blockStart).trim();
}

function isInteractiveSelector(selector) {
  return /:(?:hover|focus|focus-visible|focus-within|active)|\.is-(?:active|selected|open)|\[(?:aria-pressed|data-state)/i.test(selector);
}

function describeColor(value) {
  const rgb = value.startsWith("#") ? parseHex(value) : parseRgb(value);
  if (!rgb) return { family: "HSL/dynamic", risk: false, details: "Review visually" };
  const hsl = rgbToHsl(rgb);
  const chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  let family = "neutral";
  // Near-white and near-gray colors can report high HSL saturation despite
  // having almost no visible chroma. Keep them out of the purple review set.
  if (hsl.s >= 12 && chroma >= 10) {
    if (hsl.l < 25) family = hsl.h >= 195 && hsl.h < 260 ? "navy" : "deep neutral";
    else if (hsl.h < 15 || hsl.h >= 345) family = "red";
    else if (hsl.h < 45) family = "orange";
    else if (hsl.h < 70) family = "yellow";
    else if (hsl.h < 165) family = "green";
    else if (hsl.h < 195) family = "cyan";
    else if (hsl.h < 222) family = "blue";
    else if (hsl.h < 260) family = "periwinkle";
    else if (hsl.h < 315) family = "purple";
    else family = "rose";
  }
  const risk = (family === "periwinkle" || family === "purple") && hsl.l >= 25 && rgb.a > 0.02;
  return {
    family,
    risk,
    details: `h ${hsl.h.toFixed(0)}° · s ${hsl.s.toFixed(0)}% · l ${hsl.l.toFixed(0)}% · c ${chroma.toFixed(0)} · a ${rgb.a.toFixed(2)}`,
  };
}

for (const sourcePath of sources) {
  const css = await readFile(sourcePath, "utf8");
  const lines = css.split(/\r?\n/);
  const relativePath = path.relative(projectRoot, sourcePath);
  let sourceOffset = 0;
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(colorPattern)) {
      const literal = match[0];
      const key = literal.toLowerCase().replaceAll(/\s+/g, " ");
      const existing = colors.get(key) ?? { literal, lines: [], variables: new Set() };
      const selector = selectorAtIndex(css, sourceOffset + (match.index ?? 0));
      existing.lines.push({ file: relativePath, number: index + 1, source: line.trim(), selector, interactive: isInteractiveSelector(selector) });
      const variable = line.match(/(--[\w-]+)\s*:/)?.[1];
      if (variable) existing.variables.add(variable);
      colors.set(key, existing);
    }
    sourceOffset += line.length + 1;
  }
}

const entries = [...colors.values()]
  .map((entry) => {
    const described = describeColor(entry.literal);
    return { ...entry, ...described, interactiveRisk: described.risk && entry.lines.some((line) => line.interactive) };
  })
  .sort((left, right) => Number(right.interactiveRisk) - Number(left.interactiveRisk) || Number(right.risk) - Number(left.risk) || right.lines.length - left.lines.length || left.literal.localeCompare(right.literal));
const riskCount = entries.filter((entry) => entry.risk).length;
const interactiveRiskCount = entries.filter((entry) => entry.interactiveRisk).length;
const cards = entries.map((entry) => {
  const references = entry.lines.slice(0, 8).map(({ file, number, source, interactive }) => `<li><b>${escapeHtml(file)}:${number}${interactive ? '<em class="state">interactive</em>' : ""}</b><code>${escapeHtml(source)}</code></li>`).join("");
  const overflow = entry.lines.length > 8 ? `<li class="more">+${entry.lines.length - 8} more references</li>` : "";
  return `<article class="color-card" data-risk="${entry.risk}" data-interactive-risk="${entry.interactiveRisk}" data-family="${entry.family}">
    <div class="swatch" style="--swatch:${escapeHtml(entry.literal)}"></div>
    <div class="color-copy">
      <div class="color-heading"><code>${escapeHtml(entry.literal)}</code><span class="count">${entry.lines.length} use${entry.lines.length === 1 ? "" : "s"}</span></div>
      <p><span class="family ${entry.risk ? "risk" : ""}">${entry.family}</span>${escapeHtml(entry.details)}</p>
      ${entry.variables.size ? `<p class="variables">${[...entry.variables].map(escapeHtml).join(", ")}</p>` : ""}
      <details><summary>Source references</summary><ul>${references}${overflow}</ul></details>
    </div>
  </article>`;
}).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Paper Assistant color audit</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f7fb; color:#172033; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header { position:sticky; top:0; z-index:2; padding:24px clamp(20px,4vw,56px) 18px; background:rgba(244,247,251,.94); border-bottom:1px solid #dbe3ed; backdrop-filter:blur(14px); }
    h1 { margin:0 0 6px; font-size:clamp(26px,3vw,40px); letter-spacing:-.035em; }
    header p { margin:0; color:#5e6b80; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
    .toolbar button { border:1px solid #cbd7e5; border-radius:9px; background:#fff; color:#263349; font:inherit; font-weight:700; padding:9px 13px; cursor:pointer; transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease; }
    .toolbar button:hover { background:#eef7fe; border-color:#9bcdf3; color:#086dc4; }
    .toolbar button[aria-pressed="true"] { background:#168dec; border-color:#168dec; color:#fff; }
    .toolbar button[aria-pressed="true"]:hover { background:#0874c9; border-color:#0874c9; color:#fff; }
    main { padding:24px clamp(20px,4vw,56px) 64px; }
    .summary { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:20px; color:#5e6b80; }
    .summary strong { color:#172033; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; }
    .color-card { display:grid; grid-template-columns:82px minmax(0,1fr); overflow:hidden; min-height:168px; background:#fff; border:1px solid #dbe3ed; border-radius:14px; box-shadow:0 8px 28px rgba(33,56,85,.07); }
    .swatch { background:var(--swatch); border-right:1px solid #dbe3ed; }
    .color-copy { min-width:0; padding:16px; }
    .color-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .color-heading code { overflow-wrap:anywhere; font-weight:800; }
    .count { flex:none; color:#68758a; font-size:12px; }
    .color-copy p { display:flex; align-items:center; gap:8px; margin:10px 0; color:#68758a; font-size:13px; }
    .family { padding:3px 7px; border-radius:999px; background:#eef3f8; color:#45546b; font-size:11px; font-weight:800; text-transform:uppercase; }
    .family.risk { background:#fff0f3; color:#b42345; }
    .state { display:inline-block; margin-left:5px; color:#b42345; font-size:9px; font-style:normal; font-weight:800; letter-spacing:.04em; text-transform:uppercase; }
    .variables { color:#086dc4 !important; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    details { margin-top:12px; }
    summary { cursor:pointer; color:#086dc4; font-size:12px; font-weight:800; }
    ul { margin:10px 0 0; padding:0; list-style:none; }
    li { display:grid; grid-template-columns:minmax(132px,max-content) minmax(0,1fr); gap:7px; margin:6px 0; color:#6a7689; font-size:11px; }
    li code { overflow-wrap:anywhere; white-space:normal; }
    li.more { display:block; font-style:italic; }
    [hidden] { display:none !important; }
    @media (max-width:540px) { .grid { grid-template-columns:1fr; } .color-card { grid-template-columns:62px minmax(0,1fr); } }
    @media print { header { position:static; } .toolbar { display:none; } main { padding:16px; } .grid { grid-template-columns:repeat(2,1fr); } .color-card { break-inside:avoid; box-shadow:none; } }
  </style>
</head>
<body>
  <header>
    <h1>Paper Assistant color audit</h1>
    <p>Generated from <code>app/globals.css</code> and its ordered functional modules. Chromatic periwinkle and purple literals are separated from cross-hue interactive-state mismatches.</p>
    <div class="toolbar" aria-label="Color filters">
      <button type="button" data-filter="all" aria-pressed="true">All ${entries.length}</button>
      <button type="button" data-filter="interactive-risk" aria-pressed="false">Interactive mismatch ${interactiveRiskCount}</button>
      <button type="button" data-filter="risk" aria-pressed="false">Palette review ${riskCount}</button>
      <button type="button" data-filter="blue" aria-pressed="false">Blue</button>
      <button type="button" data-filter="neutral" aria-pressed="false">Neutral</button>
    </div>
  </header>
  <main>
    <div class="summary"><span><strong>${entries.length}</strong> unique literals</span><span><strong>${entries.reduce((total, entry) => total + entry.lines.length, 0)}</strong> total references</span><span><strong>${interactiveRiskCount}</strong> interactive mismatches</span><span><strong>${riskCount}</strong> intentional/palette-review colors</span></div>
    <section class="grid">${cards}</section>
  </main>
  <script>
    const buttons = [...document.querySelectorAll('[data-filter]')];
    const cards = [...document.querySelectorAll('.color-card')];
    for (const button of buttons) button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
      for (const card of cards) card.hidden = filter === 'interactive-risk' ? card.dataset.interactiveRisk !== 'true' : filter === 'risk' ? card.dataset.risk !== 'true' : filter === 'all' ? false : card.dataset.family !== filter;
    });
  </script>
</body>
</html>`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(`Color audit: ${entries.length} unique literals, ${interactiveRiskCount} interactive mismatches, ${riskCount} palette-review colors -> ${outputPath}`);
