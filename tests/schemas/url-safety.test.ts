/**
 * The SSRF guard. Every server-side fetch of a user-supplied URL routes through
 * it (source acquisition, web import, document grounding), so a hole here lets a
 * crafted paper record read the cloud metadata endpoint or a service on the
 * user's own machine.
 *
 * The cases are the encodings an attacker actually reaches for. Each was verified
 * to bypass the previous implementation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { privateHostname, publicHttpsUrl } from "../../app/lib/url-safety.ts";

/** Judge a host the way the guard sees it, through WHATWG URL normalization. */
function blocked(host: string): boolean {
  return privateHostname(new URL(`https://${host}/path`).hostname);
}

test("blocks loopback in every spelling", () => {
  for (const host of ["127.0.0.1", "127.1.1.1", "[::1]", "localhost", "LOCALHOST"]) {
    assert.ok(blocked(host), `${host} must be refused`);
  }
});

test("blocks an IPv4 address mapped into IPv6", () => {
  // URL rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], which matched none of the
  // old prefix checks, so loopback was reachable through this spelling alone.
  for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[::ffff:a00:1]"]) {
    assert.ok(blocked(host), `${host} must be refused`);
  }
});

test("blocks the unspecified address, which routes to the local host", () => {
  assert.ok(blocked("[::]"));
  assert.ok(blocked("0.0.0.0"));
});

test("blocks a trailing-dot fully-qualified name", () => {
  // The root label is preserved by URL, so "localhost." is not string-equal to
  // "localhost" and used to slip through.
  assert.ok(blocked("localhost."));
  assert.ok(blocked("example.local."));
  assert.ok(blocked("printer.local"));
});

test("blocks the whole IPv6 link-local range, not just fe80", () => {
  // fe80::/10 spans fe80 through febf; only the literal fe80 prefix was checked.
  for (const host of ["[fe80::1]", "[fe90::1]", "[feb0::1]", "[FEB0::1]", "[febf::1]"]) {
    assert.ok(blocked(host), `${host} is link-local and must be refused`);
  }
  // Unique local addresses too.
  assert.ok(blocked("[fc00::1]"));
  assert.ok(blocked("[fd12:3456::1]"));
});

test("blocks the cloud metadata address", () => {
  // The single most valuable SSRF target: instance credentials.
  assert.ok(blocked("169.254.169.254"));
  assert.ok(blocked("169.254.0.1"));
});

test("blocks the shared, benchmark, and multicast blocks", () => {
  assert.ok(blocked("100.64.0.1"), "RFC 6598 CGNAT is the LAN range on many carrier networks");
  assert.ok(blocked("100.127.255.1"));
  assert.ok(blocked("198.18.0.1"), "RFC 2544 benchmarking");
  assert.ok(blocked("192.0.0.1"), "RFC 6890 special use");
  assert.ok(blocked("224.0.0.1"), "multicast");
  assert.ok(blocked("255.255.255.255"));
});

test("blocks every RFC 1918 range", () => {
  for (const host of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.1", "192.168.0.1"]) {
    assert.ok(blocked(host), `${host} must be refused`);
  }
  // Just outside the 172.16/12 block is public.
  assert.equal(blocked("172.15.0.1"), false);
  assert.equal(blocked("172.32.0.1"), false);
});

test("still allows the public hosts the app actually fetches", () => {
  for (const host of [
    "arxiv.org",
    "example.com",
    "api.semanticscholar.org",
    "openreview.net",
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "[2606:4700:4700::1111]",
  ]) {
    assert.equal(blocked(host), false, `${host} is public and must be allowed`);
  }
});

test("publicHttpsUrl also refuses plaintext and embedded credentials", () => {
  assert.ok(publicHttpsUrl(new URL("https://arxiv.org/abs/1706.03762")));
  // http is refused: the snapshot capture and the SSRF guard both require TLS.
  assert.equal(publicHttpsUrl(new URL("http://arxiv.org/abs/1706.03762")), false);
  // Credentials in the URL would be forwarded to whatever the host turns out to be.
  assert.equal(publicHttpsUrl(new URL("https://user:pass@arxiv.org/x")), false);
  assert.equal(publicHttpsUrl(new URL("https://user@arxiv.org/x")), false);
  // Non-http(s) schemes.
  for (const raw of ["ftp://example.com/x", "file:///etc/passwd", "data:text/html,hi"]) {
    assert.equal(publicHttpsUrl(new URL(raw)), false, `${raw} must be refused`);
  }
  // A private host is refused even over https.
  assert.equal(publicHttpsUrl(new URL("https://127.0.0.1/x")), false);
  // A non-standard port on a public host is fine (many mirrors use one).
  assert.ok(publicHttpsUrl(new URL("https://arxiv.org:8443/abs/1")));
});

test("htmlToText decodes entities once, so escaped markup stays inert", async () => {
  // Replacing &amp; before &lt;/&gt; decoded a double-escaped sequence twice, so
  // text the page had deliberately escaped came out as real angle brackets.
  const { htmlToText } = await import("../../app/lib/webpage-snapshot.ts");
  assert.equal(
    htmlToText("<p>&amp;lt;img src=x onerror=alert(1)&amp;gt;</p>"),
    "&lt;img src=x onerror=alert(1)&gt;",
  );
  // Single-escaped entities still decode normally.
  assert.equal(htmlToText("<p>a &lt;b&gt; c &amp; d</p>"), "a <b> c & d");
  assert.equal(htmlToText("<p>a&nbsp;b</p>"), "a b");
  const longPage = "x".repeat(25_000);
  assert.equal(htmlToText(`<main>${longPage}</main>`), longPage, "readable webpage text is not truncated");
});

test("the bot-challenge heuristic does not reject legitimate security papers", async () => {
  const { looksBlocked } = await import("../../app/lib/webpage-snapshot.ts");
  // A bare "captcha" or "access denied" appears in real paper titles, and a false
  // positive here refuses the import permanently.
  assert.equal(
    looksBlocked("<body>We study CAPTCHA recognition with deep nets.</body>", "Deep Learning for CAPTCHA Recognition"),
    false,
  );
  assert.equal(looksBlocked("<body>Our access denied policy analysis…</body>", "On Access Denied Semantics"), false);

  // Real interstitials are still caught, including one below a long <head>, which
  // the old 4000-character window missed entirely.
  assert.ok(looksBlocked("<body>Please complete the captcha to continue</body>", "Just a moment..."));
  assert.ok(looksBlocked(`<head>${"x".repeat(6000)}</head><body>Checking your browser before accessing</body>`, "Loading"));
  assert.ok(looksBlocked("<body>Verifying your browser, please wait</body>", ""));
});
