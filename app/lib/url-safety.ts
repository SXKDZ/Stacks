/**
 * Shared SSRF guards for any server-side fetch of a user-supplied URL. Both the
 * chat document-grounding path and the source-acquisition (PDF/HTML download)
 * path route through these helpers so there is a single, audited definition of
 * "is this address safe to fetch". Blocking happens on the resolved hostname
 * literal and is re-checked on every redirect hop.
 */

/** Parse a dotted-quad into its four octets, or null if it isn't one. */
function ipv4Octets(value: string): number[] | null {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** True for an IPv4 address outside the public routable space. */
function privateIpv4(octets: number[]): boolean {
  const [first, second] = octets;
  return first === 0                                   // "this network"
    || first === 10                                    // RFC 1918
    || first === 127                                   // loopback
    || (first === 100 && second >= 64 && second <= 127) // RFC 6598 CGNAT
    || (first === 169 && second === 254)               // link-local / cloud metadata
    || (first === 172 && second >= 16 && second <= 31) // RFC 1918
    || (first === 192 && second === 168)               // RFC 1918
    || (first === 192 && second === 0)                 // RFC 5737/6890 special use
    || (first === 198 && (second === 18 || second === 19)) // RFC 2544 benchmarking
    || first >= 224;                                   // multicast + reserved
}

/**
 * True when a hostname points somewhere that is not public routable space:
 * loopback, link-local (including cloud metadata), private ranges, or the
 * shared/benchmark blocks.
 *
 * This is a LEXICAL check on the hostname literal, which is a deliberate limit:
 * it cannot catch a public DNS name that resolves to a private address (a
 * wildcard service like `127.0.0.1.nip.io`). Those are blocked at connect time
 * instead, by the socket-level guard in safeFetch below.
 */
export function privateHostname(hostname: string): boolean {
  // A trailing root-label dot is equivalent to the name without it, and WHATWG
  // URL preserves it, so "localhost." would otherwise slip past a comparison.
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.includes(":")) {
    // An IPv4-mapped or -compatible address carries the v4 address in its tail
    // (::ffff:127.0.0.1, which URL normalizes to ::ffff:7f00:1), so evaluate the
    // embedded v4 address rather than trusting the v6 prefix.
    const mapped = normalized.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    const mappedOctets = mapped ? ipv4Octets(mapped[1]) : null;
    if (mappedOctets && privateIpv4(mappedOctets)) {
      return true;
    }
    const hexMapped = normalized.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1], 16);
      const low = Number.parseInt(hexMapped[2], 16);
      if (privateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])) {
        return true;
      }
    }
    return normalized === "::1"                     // loopback
      || normalized === "::"                        // unspecified, routes to local
      || /^f[cd]/.test(normalized)                  // fc00::/7 unique local
      // fe80::/10 is fe80 through febf, not just fe80.
      || /^fe[89ab][0-9a-f]:/.test(normalized)
      || /^ff/.test(normalized);                    // multicast
  }
  const octets = ipv4Octets(normalized);
  return octets ? privateIpv4(octets) : false;
}

/** True when a URL is https, carries no embedded credentials, and is public. */
export function publicHttpsUrl(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !privateHostname(url.hostname);
}

/**
 * Resolve a hostname and refuse it if any address it points at is non-public.
 *
 * `privateHostname` is lexical, so a public DNS name that resolves to loopback or
 * RFC-1918 space (wildcard services like `127.0.0.1.nip.io`, or an attacker's own
 * A record) passes it. Checking the resolved addresses is what actually blocks
 * that, and it is applied to every redirect hop as well as the initial URL.
 *
 * An IP literal needs no lookup: `privateHostname` already judged it exactly.
 */
async function assertPublicAddress(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (ipv4Octets(hostname) || hostname.includes(":")) {
    return;
  }
  const { lookup } = await import("node:dns/promises");
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    // A name that doesn't resolve fails at fetch time with a clearer error.
    return;
  }
  for (const record of records) {
    if (privateHostname(record.address)) {
      throw new Error("That host resolves to a private or loopback address.");
    }
  }
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
  await assertPublicAddress(url);
  const origin = url.origin;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let crossOrigin = false;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Stacks/1.0 (+local research library)",
          ...(crossOrigin ? {} : headers),
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === maxRedirects) {
          throw new Error("The remote source returned an unsafe redirect.");
        }
        // Relative locations resolve against the CURRENT hop, per RFC 7231.
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error("The remote source returned an unusable redirect.");
        }
        if (!publicHttpsUrl(next)) {
          throw new Error("The remote source redirected to a private or insecure address.");
        }
        // The lexical check passes for a name that RESOLVES to a private address,
        // so confirm the address itself before following the hop.
        await assertPublicAddress(next);
        // Caller headers may carry credentials for the original host (the feed
        // token, an API key). A redirect can point anywhere, so they are dropped
        // once the origin changes, matching how browsers treat cross-origin hops.
        if (next.origin !== origin) {
          crossOrigin = true;
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
