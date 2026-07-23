#!/usr/bin/env node
// Tag-driven release, in two halves that never push to the protected `main`:
//
//   prepare — bump the version and roll the changelog's Unreleased section into
//             a dated entry on a `release/vX.Y.Z` branch, then open a PR. The
//             bump is reviewed and CI-checked like any other change.
//   notes   — print the changelog section for a version. Used by the publish
//             workflow (.github/workflows/release.yml) to build the GitHub
//             release body; kept here so there is one source of truth.
//
// The actual publish happens in CI when a `v*` tag is pushed (tags are not
// branch-protected), so no step here ever needs to bypass branch protection.
//
// Usage:
//   node scripts/release.mjs prepare patch          # 0.1.0 -> 0.1.1
//   node scripts/release.mjs prepare minor          # 0.1.0 -> 0.2.0
//   node scripts/release.mjs prepare major          # 0.1.0 -> 1.0.0
//   node scripts/release.mjs prepare 1.2.3          # explicit version
//   node scripts/release.mjs prepare patch --dry-run
//   node scripts/release.mjs notes v1.2.3           # print that version's notes
//
// `prepare` preconditions: run on the default branch with a clean working tree,
// in sync with origin, with `gh` authenticated. The changelog must have content
// under `## [Unreleased]` (that becomes the release notes).

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

/** Extract the changelog body for a version ("1.2.3" or "v1.2.3"). */
function notesFor(changelog, version) {
  const clean = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(clean)) fail(`"${version}" is not a version (expected X.Y.Z or vX.Y.Z)`);
  const escaped = clean.replace(/\./g, "\\.");
  const section = new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?:\\n## \\[|\\n\\[[^\\]]+\\]: )`).exec(changelog);
  if (!section) fail(`CHANGELOG.md has no entry for ${clean}`);
  const body = section[1].trim();
  if (!body) fail(`CHANGELOG.md entry for ${clean} is empty`);
  return body;
}

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const command = positional[0];
const changelogPath = join(root, "CHANGELOG.md");

// --- notes: print a version's changelog section (no git/side effects) ---------
if (command === "notes") {
  const version = positional[1];
  if (!version) fail("usage: release.mjs notes <X.Y.Z|vX.Y.Z>");
  process.stdout.write(notesFor(readFileSync(changelogPath, "utf8"), version) + "\n");
  process.exit(0);
}

// --- prepare: bump + roll changelog on a release branch, open a PR ------------
if (command !== "prepare") {
  fail("usage: release.mjs prepare <patch|minor|major|X.Y.Z> [--dry-run]  |  release.mjs notes <version>");
}

const dryRun = args.includes("--dry-run");
const kind = positional[1];
if (!kind) fail("specify a bump: patch | minor | major | X.Y.Z");

// Preflight: clean tree on the default branch, in sync with origin.
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (branch !== DEFAULT_BRANCH) fail(`must prepare a release from ${DEFAULT_BRANCH}, on ${branch}`);
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
const releaseBranch = `release/${tag}`;

if (git(["tag", "-l", tag]).trim()) fail(`tag ${tag} already exists`);
if (git(["ls-remote", "--heads", "origin", releaseBranch]).trim()) fail(`branch ${releaseBranch} already exists on origin`);

// Roll the changelog's Unreleased section into a dated version entry.
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

console.log(`release: prepare ${current} -> ${next}  (branch ${releaseBranch}, ${today})`);
console.log("release notes:\n" + notes.split("\n").map((line) => "  " + line).join("\n"));

if (dryRun) {
  console.log("release: --dry-run, no changes written");
  process.exit(0);
}

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(changelogPath, updatedChangelog);

// Commit the bump on a release branch and push it. Nothing here touches `main`
// directly: the PR merge does that through the normal, protected path, and the
// tag (pushed after merge) triggers the publish workflow.
git(["checkout", "-b", releaseBranch], { capture: true });
git(["add", "package.json", "CHANGELOG.md"], { capture: true });
git(["commit", "-m", `chore(release): v${next}`], { capture: true });
git(["push", "-u", "origin", releaseBranch], { capture: true });

const prBody = `Release ${tag}. Merging this rolls the version bump into \`main\`; pushing the \`${tag}\` tag afterward publishes the GitHub release.\n\n## Release notes\n\n${notes}\n\n## After merge\n\n\`\`\`\ngit checkout main && git pull\ngit tag -a ${tag} -m "Stacks ${next}" && git push origin ${tag}\n\`\`\``;
execFileSync("gh", ["pr", "create", "--repo", REPO, "--base", DEFAULT_BRANCH, "--head", releaseBranch, "--title", `chore(release): ${tag}`, "--body", prBody], {
  cwd: root,
  stdio: "inherit",
});

// Return to the default branch so the working copy isn't left on the release branch.
git(["checkout", DEFAULT_BRANCH], { capture: true });

console.log(`\nrelease: opened the ${tag} PR. Review + merge it, then tag the merge commit:`);
console.log(`  git checkout ${DEFAULT_BRANCH} && git pull`);
console.log(`  git tag -a ${tag} -m "Stacks ${next}" && git push origin ${tag}`);
console.log(`The publish workflow builds, tests, and creates the GitHub release from that tag.`);
