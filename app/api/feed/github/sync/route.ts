import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedSnippets } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { readGithubLastSyncedAt, writeGithubLastSyncedAt } from "@/app/lib/local-settings";
import {
  createIssue,
  editComment,
  getCommentBody,
  listComments,
  listOpenIssues,
  patchIssueTitle,
  postComment,
  uploadAttachment,
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
// Cap the size Stacks will push to the repo per attachment (base64 via the
// Contents API); larger files stay local-only rather than bloating the repo.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function mirrorLabel(role: string): string {
  return role === "user" ? "**You:**" : "**Agent:**";
}

interface StoredAttachment { relativePath: string; label: string }

/**
 * Upload a turn's attachments into the repo and return a Markdown link list to
 * append to the mirrored comment, so a phone can download them. Files are staged
 * at feed/<id>/attachments/<name> locally and mirrored to the same repo path.
 */
async function mirrorAttachments(
  config: GitHubConfig,
  snippetId: string,
  attachmentsJson: string | null,
  counts: { attachmentsUploaded: number },
): Promise<string> {
  if (!attachmentsJson) return "";
  let parsed: StoredAttachment[];
  try {
    parsed = JSON.parse(attachmentsJson) as StoredAttachment[];
  } catch {
    return "";
  }
  const links: string[] = [];
  for (const attachment of parsed) {
    const name = basename(attachment.relativePath);
    const localPath = join(feedWorkingDir(snippetId), "attachments", name);
    if (!existsSync(localPath)) continue;
    const bytes = readFileSync(localPath);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      links.push(`- ${attachment.label} (too large to upload; kept local)`);
      continue;
    }
    const url = await uploadAttachment(config, `feed/${snippetId}/attachments/${name}`, bytes);
    links.push(`- [${attachment.label}](${url})`);
    counts.attachmentsUploaded += 1;
  }
  return links.length ? `Attachments:\n${links.join("\n")}` : "";
}

/**
 * Reconcile the local feeds with their GitHub issues in one manual pass:
 *   outbound — create an issue per feed, push local renames, mirror new local
 *              messages as comments;
 *   inbound  — adopt remote renames, ingest new/edited human comments, turn new
 *              issues into feeds. New comments trigger a reply turn; edits just
 *              update the local copy (no re-run).
 * Incremental: the inbound issue list is filtered by `since` the last successful
 * sync (sorted by updated_at), so each pass pulls only what changed; the first
 * sync does a full paginated sweep. Loop-safe: Stacks-authored comments carry a
 * marker and every mirrored/ingested message stores its comment id.
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
  const counts = { issuesCreated: 0, commentsPosted: 0, feedsCreated: 0, repliesQueued: 0, commentsIngested: 0, commentsUpdated: 0, titlesRenamed: 0, attachmentsUploaded: 0 };
  const since = readGithubLastSyncedAt();
  // Stamp the high-water mark from BEFORE the network calls, so anything that
  // changes mid-sync is re-examined next time rather than skipped.
  const startedAt = new Date().toISOString();

  try {
    // 1. OUTBOUND — ensure an issue per feed, push local renames, mirror
    //    unposted local messages. Runs over all feeds (not the incremental
    //    set), so a purely-local change is never missed.
    const feeds = database.select().from(feedSnippets).all();
    for (const feed of feeds) {
      let issueNumber = feed.issueNumber;
      if (!issueNumber) {
        issueNumber = await createIssue(config, { title: feed.title, body: feed.instruction || feed.title });
        database.update(feedSnippets).set({ issueNumber, issueTitleSynced: feed.title }).where(eq(feedSnippets.id, feed.id)).run();
        counts.issuesCreated += 1;
      } else if (feed.issueTitleSynced === null) {
        // A feed synced before rename tracking existed: adopt the current title
        // as the base (no push) so future renames on either side are detected.
        database.update(feedSnippets).set({ issueTitleSynced: feed.title }).where(eq(feedSnippets.id, feed.id)).run();
        feed.issueTitleSynced = feed.title;
      } else if (feed.title !== feed.issueTitleSynced) {
        // The feed was renamed locally since the last sync — push it (local wins).
        await patchIssueTitle(config, issueNumber, feed.title);
        database.update(feedSnippets).set({ issueTitleSynced: feed.title }).where(eq(feedSnippets.id, feed.id)).run();
        feed.issueTitleSynced = feed.title;
        counts.titlesRenamed += 1;
      }
      const messages = database
        .select()
        .from(feedMessages)
        .where(eq(feedMessages.snippetId, feed.id))
        .orderBy(asc(feedMessages.createdAt))
        .all();
      for (const message of messages) {
        if (!MIRRORED_KINDS.has(message.kind)) continue;
        // Backfill: a message mirrored before attachment upload existed has a
        // comment but no "Attachments:" section. Upload its files and edit the
        // comment to add the links, once.
        if (message.githubCommentId) {
          if (!message.attachments) continue;
          const existing = await getCommentBody(config, message.githubCommentId);
          if (existing === null || existing.includes("Attachments:")) continue;
          const links = await mirrorAttachments(config, feed.id, message.attachments, counts);
          if (!links) continue;
          await editComment(config, message.githubCommentId, `${existing.replace(/\s+$/, "")}\n\n${links}`);
          continue;
        }
        const content = message.content.trim();
        const attachmentLinks = await mirrorAttachments(config, feed.id, message.attachments, counts);
        if (!content && !attachmentLinks) continue;
        const body = [`${mirrorLabel(message.role)}\n\n${content}`, attachmentLinks].filter(Boolean).join("\n\n");
        const commentId = await postComment(config, issueNumber, body);
        database.update(feedMessages).set({ githubCommentId: commentId }).where(eq(feedMessages.id, message.id)).run();
        counts.commentsPosted += 1;
      }
    }

    // 2. INBOUND — reconcile changed issues into feeds, renames, and comments.
    const linked = new Map<number, typeof feeds[number]>();
    for (const feed of database.select().from(feedSnippets).all()) {
      if (feed.issueNumber) linked.set(feed.issueNumber, feed);
    }
    const { issues, truncated } = await listOpenIssues(config, since);
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
          issueTitleSynced: issue.title,
          createdAt: now,
          updatedAt: now,
        }).run();
        const prompt = buildSnippetPrompt({ instruction, freeText: "", attachments: [] });
        void runFeedAgent({ snippetId: id, sessionId, prompt, resume: false }).catch(() => {});
        counts.feedsCreated += 1;
        continue;
      }

      // Adopt a remote rename only when the feed wasn't also renamed locally
      // (local rename already pushed above, so the base now equals the local
      // title). If the title differs from the just-synced base, GitHub changed it.
      if (issue.title && issue.title !== feed.title && feed.issueTitleSynced === feed.title) {
        database.update(feedSnippets).set({ title: issue.title.slice(0, 120), issueTitleSynced: issue.title }).where(eq(feedSnippets.id, feed.id)).run();
        counts.titlesRenamed += 1;
      }

      // Reconcile comments: ingest new human comments and adopt edits to ones
      // already synced (by comparing the remote body to the stored content).
      const localByComment = new Map<number, { id: string; content: string; role: string }>();
      for (const message of database.select().from(feedMessages).where(eq(feedMessages.snippetId, feed.id)).all()) {
        if (typeof message.githubCommentId === "number") {
          localByComment.set(message.githubCommentId, { id: message.id, content: message.content, role: message.role });
        }
      }
      const comments = await listComments(config, issue.number);

      // Edits to already-synced HUMAN comments: keep the local copy in step.
      for (const comment of comments) {
        if (comment.fromStacks) continue;
        const local = localByComment.get(comment.id);
        const body = comment.body.trim();
        if (local && local.role === "user" && body && body !== local.content.trim()) {
          database.update(feedMessages).set({ content: body }).where(eq(feedMessages.id, local.id)).run();
          counts.commentsUpdated += 1;
        }
      }

      const fresh = comments.filter((comment) => !comment.fromStacks && !localByComment.has(comment.id) && comment.body.trim());
      if (!fresh.length) continue;
      // Leave new comments unrecorded if the agent is mid-run, so the next sync
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

    // Advance the high-water mark only when the full changed set was seen; if
    // the page cap truncated results, keep the old mark so the tail isn't lost.
    if (!truncated) {
      writeGithubLastSyncedAt(startedAt);
    }
    return Response.json({ ok: true, counts, truncated });
  } catch (error) {
    const message = error instanceof GitHubError || error instanceof Error ? error.message : "GitHub sync failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
