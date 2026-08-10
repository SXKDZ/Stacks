import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("long feeds hydrate once, render a bounded tail, and defer hidden tool bodies", async () => {
  const [route, feed] = await Promise.all([
    readFile(new URL("../../app/api/feed/snippets/[id]/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
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
  assert.match(feed, /activeRecord \? \(\(\) =>/);
  assert.doesNotMatch(feed, /visible\.length \? visible\.map\(\(\{ interaction, number, response \}\)/);
  assert.match(feed, /\{loading \? \(\s*<div className="feed-history-loading"/s);
});
