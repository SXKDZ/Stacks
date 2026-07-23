import packageMetadata from "@/package.json";

export const dynamic = "force-dynamic";

const RELEASES_ENDPOINT = "https://api.github.com/repos/SXKDZ/Stacks/releases/latest";

function versionParts(value: string): number[] {
  return value.replace(/^v/i, "").split(".").map((part) => Number(part.match(/^\d+/)?.[0] ?? 0));
}

function newerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      return (left[index] ?? 0) > (right[index] ?? 0);
    }
  }
  return false;
}

export async function GET(request: Request): Promise<Response> {
  const currentVersion = packageMetadata.version;
  const check = new URL(request.url).searchParams.get("check") === "1";
  if (!check) {
    return Response.json({ currentVersion, checked: false });
  }
  try {
    const response = await fetch(RELEASES_ENDPOINT, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Stacks/${currentVersion}`,
      },
    });
    if (!response.ok) {
      return Response.json({
        currentVersion,
        checked: true,
        updateAvailable: false,
        latestVersion: null,
        message: response.status === 404 ? "No published GitHub release is available yet." : `GitHub release check returned ${response.status}.`,
      });
    }
    const release = await response.json() as { tag_name?: string; html_url?: string; name?: string; published_at?: string };
    const latestVersion = release.tag_name?.replace(/^v/i, "") || currentVersion;
    return Response.json({
      currentVersion,
      checked: true,
      latestVersion,
      updateAvailable: newerVersion(latestVersion, currentVersion),
      releaseName: release.name || release.tag_name || latestVersion,
      releaseUrl: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : null,
      publishedAt: release.published_at ?? null,
      message: newerVersion(latestVersion, currentVersion) ? `Stacks ${latestVersion} is available.` : "Stacks is up to date.",
    });
  } catch (error) {
    return Response.json({
      currentVersion,
      checked: true,
      updateAvailable: false,
      latestVersion: null,
      message: error instanceof Error ? `Update check unavailable: ${error.message}` : "Update check unavailable.",
    });
  }
}
