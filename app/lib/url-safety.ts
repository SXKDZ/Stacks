/**
 * Shared SSRF guards for any server-side fetch of a user-supplied URL. Both the
 * chat document-grounding path and the source-acquisition (PDF/HTML download)
 * path route through these helpers so there is a single, audited definition of
 * "is this address safe to fetch". Blocking happens on the resolved hostname
 * literal and is re-checked on every redirect hop.
 */

/** True when a hostname points at loopback, link-local, or RFC-1918 space. */
export function privateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".local") || normalized === "::1"
    || (normalized.includes(":") && (/^f[cd]/.test(normalized) || normalized.startsWith("fe80:")))) {
    return true;
  }
  const match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const [, firstValue, secondValue] = match;
  const first = Number(firstValue);
  const second = Number(secondValue);
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/** True when a URL is https, carries no embedded credentials, and is public. */
export function publicHttpsUrl(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !privateHostname(url.hostname);
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Fetch a public https URL with manual redirect handling: every hop is
 * re-validated with publicHttpsUrl so a public URL cannot bounce the request
 * onto a private/loopback/metadata address. Returns the final Response with its
 * body still readable (callers stream and byte-cap it themselves).
 */
export async function safeFetch(url: URL, options: SafeFetchOptions = {}): Promise<Response> {
  if (!publicHttpsUrl(url)) {
    throw new Error("Only public https:// URLs can be fetched.");
  }
  const { headers = {}, timeoutMs = 40_000, maxRedirects = 4 } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Stacks/1.0 (+local research library)", ...headers },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === maxRedirects) {
          throw new Error("The remote source returned an unsafe redirect.");
        }
        const next = new URL(location, current);
        if (!publicHttpsUrl(next)) {
          throw new Error("The remote source redirected to a private or insecure address.");
        }
        current = next;
        continue;
      }
      return response;
    }
    throw new Error("The remote source redirected too many times.");
  } finally {
    clearTimeout(timeout);
  }
}
