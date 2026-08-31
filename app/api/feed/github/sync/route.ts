import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { asc, eq, isNotNull } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { storedProposalSummary } from "@/app/lib/schemas/proposals";
import { readGithubLastSyncedAt, readGithubLinkedRepo, writeGithubLastSyncedAt, writeGithubLinkedRepo } from "@/app/lib/local-settings";
import {
  createIssue,
  editComment,
  getCommentBody,
  listCommentsPaged,
  listIssues,
  patchIssueState,
  patchIssueTitle,
  postComment,
  uploadAttachment,
  createGitHubSyncPolicy,
  GitHubError,
  GitHubSyncDeferred,
  type GitHubConfig,
} from "@/app/lib/github-sync";
import { feedWorkingDir, isFeedRunning, runFeedAgent } from "@/app/lib/feed-agent";
import { markOutcomesReported, unreportedOutcomes } from "@/app/lib/feed-outcomes";
import { flushGithubOutbox } from "@/app/lib/feed-github-outbox";
import { parseJsonWith } from "@/app/lib/schemas/parse";
import { SnippetAttachmentListSchema } from "@/app/lib/schemas/attachments";
import { buildFollowUpPrompt, buildForkPrompt, buildSnippetPrompt } from "@/app/lib/feed-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One sync at a time. The route is a long chain of check-then-write GitHub +
// DB calls; two overlapping runs would each see a feed as unlinked or a comment
// as un-ingested and duplicate issues, feeds, agents, and messages. A single
// Node process serves every request, so a module-scope flag is a sufficient
// mutex (the unique index on feed_snippets.issue_number is the DB backstop).
let syncInProgress = false;

// Only prose turns are mirrored to GitHub — tool calls and raw proposal blocks
// are local implementation detail, not something to read on a phone.
const MIRRORED_KINDS = new Set(["text", "result"]);
// Cap the size Stacks will push to the repo per attachment (base64 via the
// Contents API); larger files stay local-only rather than bloating the repo.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function mirrorLabel(role: string): string {
  return role === "user" ? "**You:**" : "**Agent:**";
}

const STATUS_LABEL: Record<string, string> = {
  pending: "⏳ Awaiting approval",
  approved: "✅ Approved",
  applied: "✅ Applied",
  rejected: "🚫 Rejected",
  failed: "⚠️ Failed",
};

/** A GitHub comment body summarizing a proposed library change + its status. */
function proposalCommentBody(operation: string, status: string): string {
  const summary = storedProposalSummary(operation, "Proposed change");
  return `**Proposed library change** · ${STATUS_LABEL[status] ?? status}\n\n${summary}\n\n_Approve or reject in Stacks; this reflects the current status._`;
}

/**
 * Build the "Attachments:" Markdown block for a mirrored comment. Uploaded files
 * (and legacy staged paper copies) are uploaded into the repo so a phone can
 * download them. Library papers attached by reference are NOT uploaded — there
 * is no local copy — so they are mentioned by title (metadata), which is what
 * matters on a phone anyway.
 */
async function mirrorAttachments(
  config: GitHubConfig,
  snippetId: string,
  attachmentsJson: string | null,
  counts: { attachmentsUploaded: number },
): Promise<string> {
  if (!attachmentsJson) return "";
  // Validated against the shared attachment schema: a row written by an older
  // version (or a truncated write) yields no links instead of a crash mid-mirror.
  const parsed = parseJsonWith(SnippetAttachmentListSchema, attachmentsJson);
  if (!parsed.ok) return "";
  const links: string[] = [];
  for (const attachment of parsed.data) {
    // A referenced library paper: mention it, don't upload (no local copy).
    if (attachment.kind === "paper" || !attachment.relativePath) {
      links.push(`- ${attachment.label} (library paper)`);
      continue;
    }
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
 *   outbound — create an issue per feed, push local renames and collapse
 *              state, mirror new local messages as comments;
 *   inbound  — adopt remote renames and close/reopen (as collapse), ingest
 *              new/edited human comments, turn new open issues into feeds.
 *              New comments trigger a reply turn; edits just update the local
 *              copy (no re-run).
 * Incremental: the inbound issue list is filtered by `since` the last successful
 * sync (sorted by updated_at, stamped with a clock-skew margin), so new issues and
 * issue metadata only pull what changed. Comments on every already-linked issue
 * are always reconciled by their stable ids: this anti-entropy pass recovers a
 * comment even if GitHub's issue-level change gate or an older Stacks build let
 * the high-water mark advance past it. The mark only advances when nothing was
 * truncated or deferred, so unprocessed changes are re-pulled. Loop-safe:
 * Stacks-authored comments carry a marker and every mirrored/ingested message
 * stores its comment id. Repo-safe: issue/comment ids are scoped to the repo they
 * were created in (github.linkedRepo); switching repos unlinks everything first
 * so no stale id touches the new repo's issues.
 */
export async function POST(): Promise<Response> {
  const runtime = await resolveRuntimeValues();
  const repo = runtimeValue(runtime, "STACKS_GITHUB_REPO");
  const token = runtimeValue(runtime, "GITHUB_TOKEN");
  if (!repo || !token) {
    return Response.json({ error: "Set the GitHub repo and access token in Settings → Integrations first." }, { status: 400 });
  }
  // A large first sync can require hundreds of issue/comment mutations. Keep
  // each HTTP pass bounded; every completed mutation is checkpointed below, so
  // the client can immediately request the next pass without duplicating it.
  const syncPolicy = createGitHubSyncPolicy();
  const config: GitHubConfig = { repo, token, syncPolicy };

  // Refuse to start while another sync is running (see syncInProgress above).
  if (syncInProgress) {
    return Response.json({ error: "A GitHub sync is already running." }, { status: 409 });
  }
  syncInProgress = true;

  const database = await ensureDatabase();
  const counts = { issuesCreated: 0, commentsPosted: 0, feedsCreated: 0, repliesQueued: 0, commentsIngested: 0, commentsUpdated: 0, titlesRenamed: 0, attachmentsUploaded: 0, proposalsPosted: 0, proposalsUpdated: 0, issuesClosed: 0, issuesReopened: 0, feedsUnlinked: 0 };
  // Stamp the high-water mark from BEFORE the network calls, minus a skew
  // margin: GitHub filters `since` against ITS clock, so a local clock running
  // ahead would otherwise silently skip changes made right around the sync.
  const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // When any feed's inbound work is deferred (agent busy), the mark must not
  // advance past it, or the deferred comments fall behind `since` forever.
  let deferredInbound = false;

  try {
    // 0a. The issue/comment ids stored locally are only meaningful in the repo
    //     they were created in. If the configured repo changed, unlink every
    //     feed and message first — issue #N in the new repo is someone else's
    //     issue, and touching it would rename/close/comment on the wrong thing.
    //     Unlinked feeds then relink naturally: the outbound pass opens fresh
    //     issues in the new repo and re-mirrors their messages and proposals.
    const linkedRepo = readGithubLinkedRepo();
    if (linkedRepo !== repo) {
      if (linkedRepo) {
        counts.feedsUnlinked = database.select({ id: feedSnippets.id }).from(feedSnippets).where(isNotNull(feedSnippets.issueNumber)).all().length;
        database.update(feedSnippets).set({ issueNumber: null, issueTitleSynced: null, issueStateSynced: null }).run();
        database.update(feedMessages).set({ githubCommentId: null, attachmentsSynced: 0 }).run();
        database.update(feedProposals).set({ githubCommentId: null, githubStatusSynced: null }).run();
      }
      writeGithubLinkedRepo(repo);
    }
    // The incremental mark belongs to the linked repo's timeline; after a
    // switch, start from a full sweep of the new repo.
    const since = linkedRepo === repo ? readGithubLastSyncedAt() : undefined;

    // 0b. Drain pending GitHub actions (e.g. closing the issue of a deleted
    //     feed) BEFORE reading issues, so a just-deleted feed's issue is already
    //     closed and the inbound pass won't recreate it from an open issue.
    await flushGithubOutbox(config);

    // 1. OUTBOUND — ensure an issue per feed, push local renames, mirror
    //    unposted local messages. Runs over all feeds (not the incremental
    //    set), so a purely-local change is never missed.
    const feeds = database.select().from(feedSnippets).all();
    for (const feed of feeds) {
      // One feed whose issue was deleted on GitHub must not wedge the whole sync:
      // every outbound call below 404s, and that error used to escape to the route
      // and return 400, so no later feed was ever processed. Unlink the feed
      // instead, and the next pass opens a fresh issue for it.
      try {
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

        // Mirror the collapsed flag to the issue's open/closed state, but only when
        // it changed since the last sync (issueStateSynced is the 3-way base). A
        // freshly created issue is already open, so it baselines without an API call.
        const desiredState = feed.collapsed ? "closed" : "open";
        const stateBase = feed.issueStateSynced ?? "open";
        if (desiredState !== stateBase) {
          await patchIssueState(config, issueNumber, desiredState);
          counts[desiredState === "closed" ? "issuesClosed" : "issuesReopened"] += 1;
        }
        if (feed.issueStateSynced !== desiredState) {
          database.update(feedSnippets).set({ issueStateSynced: desiredState }).where(eq(feedSnippets.id, feed.id)).run();
          feed.issueStateSynced = desiredState;
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
          // comment to add the links, once — attachmentsSynced records completion
          // so the probe doesn't re-fetch every old comment on every sync.
          if (message.githubCommentId) {
            if (!message.attachments || message.attachmentsSynced) continue;
            const existing = await getCommentBody(config, message.githubCommentId);
            // Deleted upstream, already carrying links, or nothing uploadable:
            // in every case there is nothing left to do on later syncs.
            if (existing !== null && !existing.includes("Attachments:")) {
              const links = await mirrorAttachments(config, feed.id, message.attachments, counts);
              if (links) {
                await editComment(config, message.githubCommentId, `${existing.replace(/\s+$/, "")}\n\n${links}`);
              }
            }
            database.update(feedMessages).set({ attachmentsSynced: 1 }).where(eq(feedMessages.id, message.id)).run();
            continue;
          }
          const content = message.content.trim();
          const attachmentLinks = await mirrorAttachments(config, feed.id, message.attachments, counts);
          if (!content && !attachmentLinks) continue;
          const body = [`${mirrorLabel(message.role)}\n\n${content}`, attachmentLinks].filter(Boolean).join("\n\n");
          const commentId = await postComment(config, issueNumber, body);
          database.update(feedMessages).set({ githubCommentId: commentId, attachmentsSynced: 1 }).where(eq(feedMessages.id, message.id)).run();
          counts.commentsPosted += 1;
        }

        // Mirror proposed library changes + their status, so mobile sees what the
        // agent proposed and whether it was applied/rejected. One comment per
        // proposal, edited when the status changes.
        const proposals = database.select().from(feedProposals).where(eq(feedProposals.snippetId, feed.id)).all();
        for (const proposal of proposals) {
          const body = proposalCommentBody(proposal.operation, proposal.status);
          if (!proposal.githubCommentId) {
            const commentId = await postComment(config, issueNumber, body);
            database.update(feedProposals).set({ githubCommentId: commentId, githubStatusSynced: proposal.status }).where(eq(feedProposals.id, proposal.id)).run();
            counts.proposalsPosted += 1;
          } else if (proposal.githubStatusSynced !== proposal.status) {
            await editComment(config, proposal.githubCommentId, body);
            database.update(feedProposals).set({ githubStatusSynced: proposal.status }).where(eq(feedProposals.id, proposal.id)).run();
            counts.proposalsUpdated += 1;
          }
        }
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) {
          database.update(feedSnippets)
            .set({ issueNumber: null, issueTitleSynced: null, issueStateSynced: null })
            .where(eq(feedSnippets.id, feed.id))
            .run();
          counts.feedsUnlinked += 1;
          continue;
        }
        throw error;
      }
    }

    // 2. INBOUND — reconcile changed issues into feeds, renames, and comments.
    const linked = new Map<number, typeof feeds[number]>();
    for (const feed of database.select().from(feedSnippets).all()) {
      if (feed.issueNumber) linked.set(feed.issueNumber, feed);
    }
    const { issues, truncated } = await listIssues(config, since);

    /**
     * Reconcile one linked issue's complete comment history against the stable
     * GitHub comment ids stored locally. This deliberately does not depend on
     * the issue-level `since` gate: once a missed comment falls behind that
     * cursor, comparing ids is the only way a later manual sync can recover it.
     */
    const reconcileComments = async (issueNumber: number, feed: typeof feeds[number]): Promise<void> => {
      const localByComment = new Map<number, { id: string; content: string; role: string }>();
      for (const message of database.select().from(feedMessages).where(eq(feedMessages.snippetId, feed.id)).all()) {
        if (typeof message.githubCommentId === "number") {
          localByComment.set(message.githubCommentId, { id: message.id, content: message.content, role: message.role });
        }
      }
      const { comments, truncated: commentsTruncated } = await listCommentsPaged(config, issueNumber);
      if (commentsTruncated) {
        // Some of this thread was never read, so the mark must not move past it.
        deferredInbound = true;
      }

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
      if (!fresh.length) return;
      // Leave new comments unrecorded if the agent is mid-run, so the next sync
      // (when it's free) ingests and acts on them rather than dropping them.
      // Flag the deferral so the high-water mark stays put. The all-linked sweep
      // below also makes this recoverable even if the cursor has already moved.
      if (isFeedRunning(feed.id)) {
        deferredInbound = true;
        return;
      }

      const now = Date.now();
      // Offset each comment by 1ms so the batch keeps its GitHub order when the
      // transcript is read back sorted by createdAt.
      fresh.forEach((comment, index) => {
        database.insert(feedMessages).values({
          id: `msg-${crypto.randomUUID()}`,
          snippetId: feed.id,
          role: "user",
          kind: "text",
          content: comment.body.trim(),
          githubCommentId: comment.id,
          createdAt: new Date(now + index).toISOString(),
        }).run();
        counts.commentsIngested += 1;
      });

      // Kick off one reply turn covering the new comments.
      const reply = fresh.map((comment) => comment.body.trim()).join("\n\n");
      // A turn started from an inbox comment carries the same undelivered approval
      // decisions a reply from the app would, so a decision made here is not lost.
      const outcomes = await unreportedOutcomes(feed.id);
      await markOutcomesReported(outcomes.ids);
      if (feed.sessionId) {
        const prompt = buildFollowUpPrompt({ reply, outcomes, attachments: [] });
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
    };

    // A remotely deleted issue can disappear from the incremental issue list.
    // Treat a 404/410 during the all-linked sweep exactly like the outbound pass:
    // unlink it so the next sync opens a replacement instead of wedging all syncs.
    const reconcileLinkedComments = async (issueNumber: number, feed: typeof feeds[number]): Promise<void> => {
      try {
        await reconcileComments(issueNumber, feed);
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) {
          database.update(feedSnippets)
            .set({ issueNumber: null, issueTitleSynced: null, issueStateSynced: null })
            .where(eq(feedSnippets.id, feed.id))
            .run();
          linked.delete(issueNumber);
          counts.feedsUnlinked += 1;
          return;
        }
        throw error;
      }
    };

    // GitHub's updated-sort pagination can legitimately return the same issue
    // twice (it moves between pages as it is touched). Inserting it twice hit the
    // unique index on issue_number and aborted the whole sync with a 400.
    const handled = new Set<number>();
    for (const issue of issues) {
      if (issue.isPullRequest) continue;
      if (handled.has(issue.number)) continue;
      handled.add(issue.number);
      const feed = linked.get(issue.number);

      if (!feed) {
        // Only OPEN unlinked issues become feeds. A closed unlinked issue is
        // history — most importantly a deleted feed's issue (closed via the
        // outbox), which must not resurrect the feed it belonged to.
        if (issue.state !== "open") continue;
        // A whitespace-only title is truthy, so the "Untitled" fallback never fired
        // and the instruction collapsed to empty: the result was a junk feed that
        // immediately launched an agent with no instruction at all.
        if (!issue.title.trim() && !(issue.body ?? "").trim()) continue;
        // A brand-new issue (opened from a phone): start a feed for it.
        const id = `feed-${crypto.randomUUID()}`;
        const sessionId = crypto.randomUUID();
        const now = new Date().toISOString();
        // Combine title + body, but don't repeat the title when the body just
        // restates it (a phone issue often carries the same text in both, or the
        // title is a truncated prefix of the body), which showed the query twice.
        // Store and baseline the SAME string. Baselining the untruncated remote
        // title against a truncated local one made every later sync see a local
        // rename and push the truncation back to GitHub.
        const localTitle = issue.title.trim().slice(0, 120) || "Untitled";
        const issueTitle = issue.title.trim();
        const issueBody = (issue.body ?? "").trim();
        const bodyEchoesTitle = issueBody === issueTitle || issueBody.startsWith(issueTitle);
        const instruction = (bodyEchoesTitle ? issueBody || issueTitle : [issueTitle, issueBody].filter(Boolean).join("\n\n")).trim();
        database.insert(feedSnippets).values({
          id,
          title: localTitle,
          instruction,
          status: "queued",
          sessionId: "",
          issueNumber: issue.number,
          issueTitleSynced: localTitle,
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
        const adopted = issue.title.trim().slice(0, 120) || "Untitled";
        database.update(feedSnippets).set({ title: adopted, issueTitleSynced: adopted }).where(eq(feedSnippets.id, feed.id)).run();
        counts.titlesRenamed += 1;
      }

      // Adopt a remote close/reopen as the local collapsed state. The outbound
      // pass already pushed any LOCAL change and re-baselined issueStateSynced,
      // so a state that still differs from the base was changed on GitHub —
      // closing an issue from the phone shelves the feed here, reopening it
      // brings the feed back. (When both sides changed, outbound pushed first:
      // local wins, matching the rename policy.)
      if ((issue.state === "open" || issue.state === "closed") && issue.state !== (feed.issueStateSynced ?? "open")) {
        const collapsed = issue.state === "closed";
        database.update(feedSnippets).set({ collapsed, issueStateSynced: issue.state }).where(eq(feedSnippets.id, feed.id)).run();
        counts[collapsed ? "issuesClosed" : "issuesReopened"] += 1;
      }

      await reconcileLinkedComments(issue.number, feed);
    }

    // Anti-entropy pass: GitHub's issue-level `since` response is an optimization,
    // not proof that the linked threads are identical. Reconcile every linked
    // issue that the incremental set omitted so older missed comments recover by
    // their stable ids instead of remaining permanently behind the cursor.
    for (const [issueNumber, feed] of linked) {
      if (handled.has(issueNumber)) continue;
      await reconcileLinkedComments(issueNumber, feed);
    }

    // Advance the high-water mark only when the full changed set was seen AND
    // nothing was deferred: a truncated page cap or a busy feed both mean some
    // already-published changes are still unprocessed, and moving the mark past
    // them would hide them from every future incremental pull.
    if (!truncated && !deferredInbound) {
      writeGithubLastSyncedAt(startedAt);
    }
    return Response.json({ ok: true, counts, truncated, pending: false, mutations: syncPolicy.mutations });
  } catch (error) {
    if (error instanceof GitHubSyncDeferred) {
      return Response.json({
        ok: true,
        counts,
        pending: true,
        pauseReason: error.reason,
        retryAfterMs: error.retryAfterMs,
        mutations: syncPolicy.mutations,
      });
    }
    const message = error instanceof GitHubError || error instanceof Error ? error.message : "GitHub sync failed.";
    const details = error instanceof GitHubError ? error.details : "";
    const status = error instanceof GitHubError && error.status >= 400 && error.status <= 599
      ? error.status
      : error instanceof GitHubError ? 400 : 500;
    return Response.json({
      error: message,
      details: details || undefined,
      retryAfterMs: error instanceof GitHubError && error.retryAfterMs > 0 ? error.retryAfterMs : undefined,
    }, { status });
  } finally {
    syncInProgress = false;
  }
}
