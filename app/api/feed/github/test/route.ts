import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { verifyRepo, GitHubError } from "@/app/lib/github-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Verify the GitHub inbox settings can reach the repo. The token in the request
 * body (an unsaved draft the user just typed) takes precedence; otherwise the
 * saved token from settings.json is used, so "Test" works before or after save.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as { repo?: string; token?: string };
    const runtime = await resolveRuntimeValues();
    const repo = (body.repo ?? runtimeValue(runtime, "STACKS_GITHUB_REPO")).trim();
    const token = (body.token ?? runtimeValue(runtime, "GITHUB_TOKEN")).trim();
    if (!repo) {
      return Response.json({ error: "Enter a repository first." }, { status: 400 });
    }
    if (!token) {
      return Response.json({ error: "Enter or save an access token first." }, { status: 400 });
    }
    const result = await verifyRepo({ repo, token });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof GitHubError || error instanceof Error
      ? error.message
      : "The connection could not be verified.";
    return Response.json({ error: message }, { status: 400 });
  }
}
