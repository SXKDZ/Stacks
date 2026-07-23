#!/usr/bin/env node
// Cut a Stacks release: bump the version, roll the changelog's Unreleased
// section into a dated entry, commit, tag, push, and publish a GitHub release.
//
// Usage:
//   node scripts/release.mjs patch          # 0.1.0 -> 0.1.1
//   node scripts/release.mjs minor          # 0.1.0 -> 0.2.0
//   node scripts/release.mjs major          # 0.1.0 -> 1.0.0
//   node scripts/release.mjs 1.2.3          # explicit version
//   node scripts/release.mjs patch --dry-run # print the plan, change nothing
//
// Preconditions: run on the default branch with a clean working tree, in sync
// with origin, and with the `gh` CLI authenticated. The changelog must have
// content under `## [Unreleased]` (that becomes the release notes).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BRANCH = "main";
const REPO = "SXKDZ/Stacks";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, { capture = true } = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}

function bump(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`current version "${version}" is not plain semver (major.minor.patch)`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (kind === "major") { major += 1; minor = 0; patch = 0; }
  else if (kind === "minor") { minor += 1; patch = 0; }
  else if (kind === "patch") { patch += 1; }
  else if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  else fail(`unknown bump "${kind}" (use patch | minor | major | X.Y.Z)`);
  return `${major}.${minor}.${patch}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const kind = args.find((arg) => !arg.startsWith("--"));
if (!kind) fail("specify a bump: patch | minor | major | X.Y.Z");

// Preflight: clean tree on the default branch, in sync with origin.
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (branch !== DEFAULT_BRANCH) fail(`must release from ${DEFAULT_BRANCH}, on ${branch}`);
if (git(["status", "--porcelain"]).trim()) fail("working tree is not clean; commit or stash first");
git(["fetch", "origin", DEFAULT_BRANCH], { capture: true });
if (git(["rev-parse", "HEAD"]).trim() !== git(["rev-parse", `origin/${DEFAULT_BRANCH}`]).trim()) {
  fail(`local ${DEFAULT_BRANCH} is not in sync with origin/${DEFAULT_BRANCH}; pull/push first`);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const next = bump(current, kind);
const tag = `v${next}`;

if (git(["tag", "-l", tag]).trim()) fail(`tag ${tag} already exists`);

// Roll the changelog's Unreleased section into a dated version entry.
const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const unreleased = /## \[Unreleased\]\s*([\s\S]*?)\n## \[/.exec(changelog);
if (!unreleased) fail("CHANGELOG.md has no `## [Unreleased]` section followed by a prior version");
const notes = unreleased[1].trim();
if (!notes) fail("CHANGELOG.md `## [Unreleased]` is empty; add entries before releasing");

// Use an injected date (UTC) so the entry is deterministic and testable.
const today = (process.env.RELEASE_DATE || new Date().toISOString()).slice(0, 10);
const updatedChangelog = changelog
  .replace(/## \[Unreleased\]\s*/, `## [Unreleased]\n\n## [${next}] - ${today}\n\n`)
  .replace(/\[Unreleased\]: .*/, `[Unreleased]: https://github.com/${REPO}/compare/${tag}...HEAD`)
  .replace(new RegExp(`(\\[Unreleased\\]: .*\\n)`), `$1[${next}]: https://github.com/${REPO}/releases/tag/${tag}\n`);

console.log(`release: ${current} -> ${next}  (tag ${tag}, ${today})`);
console.log("release notes:\n" + notes.split("\n").map((line) => "  " + line).join("\n"));

if (dryRun) {
  console.log("release: --dry-run, no changes written");
  process.exit(0);
}

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(changelogPath, updatedChangelog);

git(["add", "package.json", "CHANGELOG.md"], { capture: true });
git(["commit", "-m", `chore(release): v${next}`], { capture: true });
git(["tag", "-a", tag, "-m", `Stacks ${next}`], { capture: true });
git(["push", "origin", DEFAULT_BRANCH], { capture: true });
git(["push", "origin", tag], { capture: true });

execFileSync("gh", ["release", "create", tag, "--repo", REPO, "--title", `Stacks ${next}`, "--notes", notes], {
  cwd: root,
  stdio: "inherit",
});

console.log(`release: published ${tag} at https://github.com/${REPO}/releases/tag/${tag}`);
