import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(projectRoot, "app", "globals.css");
const entryCss = await readFile(cssPath, "utf8");
const sources = [
  cssPath,
  ...[...entryCss.matchAll(/@import\s+["']\.\/styles\/([^"']+)["']/g)]
    .map((match) => path.join(projectRoot, "app", "styles", match[1])),
];
const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

function parseHex(value) {
  const raw = value.slice(1);
  const expanded = raw.length <= 4 ? [...raw].map((character) => character + character).join("") : raw;
  if (![6, 8].includes(expanded.length)) return null;
  return {
    kind: "hex",
    alphaHex: expanded.length === 8 ? expanded.slice(6, 8) : "",
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function parseRgb(value) {
  const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return {
    kind: match[4] === undefined ? "rgb" : "rgba",
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h / 60;
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (section < 1) [red, green] = [chroma, intermediate];
  else if (section < 2) [red, green] = [intermediate, chroma];
  else if (section < 3) [green, blue] = [chroma, intermediate];
  else if (section < 4) [green, blue] = [intermediate, chroma];
  else if (section < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];
  const match = l - chroma / 2;
  return {
    r: Math.round((red + match) * 255),
    g: Math.round((green + match) * 255),
    b: Math.round((blue + match) * 255),
  };
}

function toHex(channel) {
  return channel.toString(16).padStart(2, "0");
}

function normalizeColor(value) {
  const parsed = value.startsWith("#") ? parseHex(value) : parseRgb(value);
  if (!parsed || parsed.a <= 0.02) return value;
  const hsl = rgbToHsl(parsed);
  const isPurpleRisk = hsl.s >= 0.12 && hsl.h >= 222 && hsl.h < 315;
  if (!isPurpleRisk) return value;

  const normalized = hslToRgb({ ...hsl, h: 205 });
  if (parsed.kind === "hex") {
    return `#${toHex(normalized.r)}${toHex(normalized.g)}${toHex(normalized.b)}${parsed.alphaHex}`;
  }
  if (parsed.kind === "rgba") {
    return `rgba(${normalized.r}, ${normalized.g}, ${normalized.b}, ${parsed.a})`;
  }
  return `rgb(${normalized.r}, ${normalized.g}, ${normalized.b})`;
}

let changedFiles = 0;
let changedLiterals = 0;
for (const sourcePath of sources) {
  const css = await readFile(sourcePath, "utf8");
  const updated = css.replace(colorPattern, (literal) => {
    const replacement = normalizeColor(literal);
    if (replacement !== literal) changedLiterals += 1;
    return replacement;
  });
  if (updated !== css) {
    await writeFile(sourcePath, updated, "utf8");
    changedFiles += 1;
  }
}

console.log(`Normalized ${changedLiterals} purple-risk references across ${changedFiles} CSS files.`);
