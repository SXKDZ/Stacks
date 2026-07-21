import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedSnippets } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import {
  createIssue,
  listComments,
  listOpenIssues,
  postComment,
  GitHubError,
  type GitHubConfig,
} from "@/app/lib/github-sync";
import { feedWorkingDir, isFeedRunning, runFeedAgent } from "@/app/lib/feed-agent";
import { buildFollowUpPrompt, buildForkPrompt, buildSnippetPrompt } from "@/app/lib/feed-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Only prose turns are mirrored to GitHub — tool calls and raw proposal blocks
// are local implementation detail, not something to read on a phone.
const MIRRORED_KINDS = new Set(["text", "result"]);

function mirrorLabel(role: string): string {
  return role === "user" ? "**You:**" : "**Agent:**";
}

/**
 * Reconcile the local feeds with their GitHub issues, one manual pass:
 *   outbound — create an issue per feed, mirror new local messages as comments;
 *   inbound  — new issues become new feeds; new human comments become reply
 *              turns. Agents run asynchronously, so their replies are mirrored
 *              on the next sync. Loop-safe: Stacks-authored comments carry a
 *              marker and every mirrored/ingested message stores its comment id.
 */
export async function POST(): Promise<Response> {
  const runtime = await resolveRuntimeValues();
  const repo = runtimeValue(runtime, "STACKS_GITHUB_REPO");
  const token = runtimeValue(runtime, "GITHUB_TOKEN");
  if (!repo || !token) {
    return Response.json({ error: "Set the GitHub repo and access token in Settings → Integrations first." }, { status: 400 });
  }
  const config: GitHubConfig = { repo, token };

  const database = await ensureDatabase();
  const counts = { issuesCreated: 0, commentsPosted: 0, feedsCreated: 0, repliesQueued: 0, commentsIngested: 0 };

  try {
    // 1. OUTBOUND — ensure every feed has an issue, then mirror any local
    //    messages that haven't been pushed yet.
    const feeds = database.select().from(feedSnippets).all();
    for (const feed of feeds) {
      let issueNumber = feed.issueNumber;
      if (!issueNumber) {
        issueNumber = await createIssue(config, { title: feed.title, body: feed.instruction || feed.title });
        database.update(feedSnippets).set({ issueNumber }).where(eq(feedSnippets.id, feed.id)).run();
        counts.issuesCreated += 1;
      }
      const messages = database
        .select()
        .from(feedMessages)
        .where(eq(feedMessages.snippetId, feed.id))
        .orderBy(asc(feedMessages.createdAt))
        .all();
      for (const message of messages) {
        if (message.githubCommentId || !MIRRORED_KINDS.has(message.kind)) continue;
        const content = message.content.trim();
        if (!content) continue;
        const commentId = await postComment(config, issueNumber, `${mirrorLabel(message.role)}\n\n${content}`);
        database.update(feedMessages).set({ githubCommentId: commentId }).where(eq(feedMessages.id, message.id)).run();
        counts.commentsPosted += 1;
      }
    }

    // 2. INBOUND — reconcile open issues into feeds and new comments into turns.
    const linked = new Map<number, typeof feeds[number]>();
    for (const feed of database.select().from(feedSnippets).all()) {
      if (feed.issueNumber) linked.set(feed.issueNumber, feed);
    }
    const issues = await listOpenIssues(config);
    for (const issue of issues) {
      if (issue.isPullRequest) continue;
      const feed = linked.get(issue.number);

      if (!feed) {
        // A brand-new issue (opened from a phone): start a feed for it.
        const id = `feed-${crypto.randomUUID()}`;
        const sessionId = crypto.randomUUID();
        const now = new Date().toISOString();
        const instruction = [issue.title, issue.body].filter(Boolean).join("\n\n").trim();
        database.insert(feedSnippets).values({
          id,
          title: issue.title.slice(0, 120) || "Untitled",
          instruction,
          status: "queued",
          sessionId: "",
          issueNumber: issue.number,
          createdAt: now,
          updatedAt: now,
        }).run();
        const prompt = buildSnippetPrompt({ instruction, freeText: "", attachments: [] });
        void runFeedAgent({ snippetId: id, sessionId, prompt, resume: false }).catch(() => {});
        counts.feedsCreated += 1;
        continue;
      }

      // An existing feed: ingest human comments Stacks hasn't seen yet.
      const seen = new Set(
        database
          .select({ id: feedMessages.githubCommentId })
          .from(feedMessages)
          .where(eq(feedMessages.snippetId, feed.id))
          .all()
          .map((row) => row.id)
          .filter((value): value is number => typeof value === "number"),
      );
      const comments = await listComments(config, issue.number);
      const fresh = comments.filter((comment) => !comment.fromStacks && !seen.has(comment.id) && comment.body.trim());
      if (!fresh.length) continue;
      // Leave the comments unrecorded if the agent is mid-run, so the next sync
      // (when it's free) ingests and acts on them rather than dropping them.
      if (isFeedRunning(feed.id)) continue;

      const now = new Date().toISOString();
      for (const comment of fresh) {
        database.insert(feedMessages).values({
          id: `msg-${crypto.randomUUID()}`,
          snippetId: feed.id,
          role: "user",
          kind: "text",
          content: comment.body.trim(),
          githubCommentId: comment.id,
          createdAt: now,
        }).run();
        counts.commentsIngested += 1;
      }

      // Kick off one reply turn covering the new comments.
      const reply = fresh.map((comment) => comment.body.trim()).join("\n\n");
      if (feed.sessionId) {
        const prompt = buildFollowUpPrompt({ reply, appliedSummaries: [], rejectedSummaries: [], attachments: [] });
        void runFeedAgent({ snippetId: feed.id, sessionId: feed.sessionId, prompt, resume: true }).catch(() => {});
      } else {
        const history = database
          .select()
          .from(feedMessages)
          .where(eq(feedMessages.snippetId, feed.id))
          .orderBy(asc(feedMessages.createdAt))
          .all()
          .filter((message) => MIRRORED_KINDS.has(message.kind))
          .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.content}`)
          .join("\n\n");
        const prompt = buildForkPrompt({ reply, transcript: history, attachments: [] });
        void runFeedAgent({ snippetId: feed.id, sessionId: crypto.randomUUID(), prompt, resume: false }).catch(() => {});
      }
      // The working dir must exist for any attachments the agent stages.
      feedWorkingDir(feed.id);
      counts.repliesQueued += 1;
    }

    return Response.json({ ok: true, counts });
  } catch (error) {
    const message = error instanceof GitHubError || error instanceof Error ? error.message : "GitHub sync failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
