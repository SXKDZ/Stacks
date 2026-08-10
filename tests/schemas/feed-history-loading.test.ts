import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("long feeds hydrate once, render bounded work, and retain the full history chooser", async () => {
  const [route, feed, historyStyles] = await Promise.all([
    readFile(new URL("../../app/api/feed/snippets/[id]/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/feed-history.css", import.meta.url), "utf8"),
  ]);

  assert.match(route, /controller\.enqueue\(frame\("snapshot", \{/);
  assert.match(route, /messages:\s*messages\.map/);
  assert.doesNotMatch(route, /for \(const message of messages\)/);

  assert.match(feed, /source\.addEventListener\("snapshot"/);
  assert.match(feed, /setMessages\(snapshot\.messages\)/);
  assert.match(feed, /setProposals\(snapshot\.proposals\)/);
  assert.match(feed, /const FEED_HISTORY_WINDOW = 8/);
  assert.match(feed, /\[visibleInteractionStart, setVisibleInteractionStart\] = useState<number \| null>/);
  assert.match(feed, /interactions\.slice\(visibleStart, visibleStart \+ visibleInteractionCount\)/);
  assert.match(feed, /setVisibleInteractionStart\(centeredStart\)/);
  assert.match(feed, /!atBottom \|\| hiddenLaterInteractionCount/);
  assert.match(feed, /coalesceLegacyAgentErrors\(visibleMessages\)/);
  assert.match(feed, /Show \{Math\.min\(FEED_HISTORY_WINDOW, hiddenInteractionCount\)\} earlier interaction/);

  assert.match(feed, /const FeedToolCall = memo/);
  assert.match(feed, /const FeedToolGroup = memo/);
  assert.match(feed, /\{expanded \? \([\s\S]*renderToolContent\(operation\.result/s);
  assert.match(feed, /visible\.length \? visible\.map\(\(\{ interaction, number, response \}\)/);
  assert.doesNotMatch(feed, /const activeRecord = visible\.find/);
  assert.match(feed, /cappedHistoryPreview\(response, FEED_HISTORY_RESPONSE_PREVIEW_LENGTH\)/);
  assert.match(feed, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(feed, /const FEED_HISTORY_JUMP_DURATION_MS = 260/);
  assert.match(feed, /\(time - startTime\) \/ FEED_HISTORY_JUMP_DURATION_MS/);
  assert.match(feed, /historyScrollFrameRef\.current = requestAnimationFrame\(animate\)/);
  assert.match(feed, /pane\.addEventListener\("wheel", cancelAnimatedScroll/);
  assert.match(feed, /const paneTop = pane\.getBoundingClientRect\(\)\.top/);
  assert.match(feed, /Math\.max\(0, pane\.scrollTop \+ cardTop - paneTop\)/);
  assert.doesNotMatch(feed, /interactionCardRefs\.current\.get\(id\)\?\.scrollIntoView/);
  assert.doesNotMatch(historyStyles, /content-visibility:\s*auto/);
  assert.match(feed, /\{loading \? \(\s*<div className="feed-history-loading"/s);
});
