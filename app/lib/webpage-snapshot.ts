import { webkit, type Browser } from "playwright";
import { publicHttpsUrl } from "@/app/lib/url-safety";

/**
 * Local webpage capture, ported from PaperCLI's WebpageSnapshotService.
 * Renders a URL in headless WebKit, inlines stylesheets and images as data URLs,
 * and returns a fully self-contained HTML string plus the readable text. Nothing is
 * sent to a third-party reader service: the page is fetched and rendered here.
 *
 * SECURITY NOTE: a real browser makes its own network requests, so it is NOT
 * covered by the SSRF guards in url-safety — the guards are applied to the
 * top-level URL here (public https only), but sub-resource fetches the page
 * issues are the browser's. Stacks is a local single-user tool; this is an accepted
 * trade for full-page fidelity. Do not expose this to untrusted multi-tenant use.
 */

const NAV_TIMEOUT = 60_000;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export interface WebpageSnapshot {
  html: string;
  text: string;
  title: string;
  finalUrl: string;
}

/**
 * Signals of a bot-challenge / error / paywall interstitial rather than the real
 * page. When any of these match we refuse to save the snapshot so a "Verifying
 * your browser" page is never stored as if it were the paper.
 */
const BLOCKED_MARKERS = [
  /verifying your browser/i,
  /checking your browser/i,
  /just a moment/i,
  /enable javascript and cookies to continue/i,
  /challenge[- ]?(?:required|verification|platform)/i,
  /cf-challenge|cf_chl_|__cf_chl/i,
  // A bare "captcha" or "access denied" appears in legitimate security papers, so
  // both require the surrounding phrasing of an actual interstitial.
  /(?:complete|solve|verify)[^.\n]{0,30}captcha/i,
  /captcha[^.\n]{0,30}(?:required|verification|challenge)/i,
  /access denied[^.\n]{0,40}(?:you do not have permission|reference #|error)/i,
  /attention required/i,
  /are you a robot/i,
];

/** True when rendered HTML/title looks like a challenge, captcha, or block page. */
export function looksBlocked(html: string, title: string): boolean {
  // A challenge marker can sit past the first few kilobytes (below a long <head>),
  // and a page whose interstitial was missed is stored as if it were the paper.
  // Scanning the whole document is cheap next to rendering it.
  const haystack = `${title}\n${html}`;
  return BLOCKED_MARKERS.some((marker) => marker.test(haystack));
}

/** Strip scripts/styles and collapse the full page to readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    // One pass, so a double-escaped sequence is not decoded twice. Replacing
    // `&amp;` first turned `&amp;lt;script&amp;gt;` into real angle brackets, i.e.
    // manufactured markup out of text the page had deliberately escaped.
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (_match, entity: string) => {
      switch (entity.toLowerCase()) {
        case "nbsp": return " ";
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return '"';
        default: return "'";
      }
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  sharedBrowser = await webkit.launch({ headless: true });
  return sharedBrowser;
}

/** Inline stylesheets and images as data URLs so the saved HTML renders offline. */
const INLINE_ASSETS_SCRIPT = `async () => {
  const toDataUrl = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size > 3_000_000) return null; // skip very large assets
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  };
  // Inline stylesheets.
  for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))) {
    try {
      const res = await fetch(link.href);
      if (!res.ok) continue;
      const css = await res.text();
      const style = document.createElement('style');
      style.textContent = css;
      link.replaceWith(style);
    } catch {}
  }
  // Inline images.
  for (const img of Array.from(document.querySelectorAll('img[src]'))) {
    if (img.src.startsWith('data:')) continue;
    const dataUrl = await toDataUrl(img.src);
    if (dataUrl) { img.setAttribute('src', dataUrl); img.removeAttribute('srcset'); }
  }
}`;

/**
 * Render a public https URL and return a self-contained snapshot. Throws on a
 * detected challenge/error page (callers should surface the message and NOT
 * create/save a record).
 */
export async function captureWebpageSnapshot(url: URL): Promise<WebpageSnapshot> {
  if (!publicHttpsUrl(url)) {
    throw new Error("Only public https:// URLs can be snapshotted.");
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    javaScriptEnabled: true,
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(url.href, { waitUntil: "networkidle", timeout: NAV_TIMEOUT }).catch(async (error) => {
      // networkidle can time out on long-polling pages; fall back to domcontentloaded.
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      if (error instanceof Error && !/networkidle|Timeout/i.test(error.message)) {
        throw error;
      }
      return page.mainFrame() ? null : null;
    });
    const status = response?.status?.() ?? 0;
    if (status >= 400) {
      throw new Error(`The page returned ${status} ${response?.statusText?.() ?? ""}`.trim() + ".");
    }
    // Trigger lazy content, then inline sub-resources for an offline-safe file.
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(INLINE_ASSETS_SCRIPT).catch(() => {});
    const html = await page.content();
    const title = (await page.title()) || url.hostname;
    const finalUrl = page.url();

    if (looksBlocked(html, title)) {
      throw new Error("The page returned a bot-challenge or verification screen, so no snapshot was saved. Open it in your browser and import the downloaded PDF instead.");
    }
    if (Buffer.byteLength(html) > MAX_SNAPSHOT_BYTES) {
      throw new Error("The rendered page is too large to snapshot.");
    }
    return { html, text: htmlToText(html), title, finalUrl };
  } finally {
    await context.close();
  }
}
