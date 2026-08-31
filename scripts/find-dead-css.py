"""Cross-file, cascade-correct duplicate removal.

The earlier attempts failed because they reasoned per-file. The cascade is global:
a block in library-details.css can be overridden by one in management-workflows.css
(imported later), so "this earlier block sets nothing new" must be judged against
ALL files in import order, and against equal-specificity rules only.

A block is removable only if, for every property it declares, some LATER block
with the SAME selector text declares that property too (so the earlier value never
wins anywhere).
"""
import re, sys, collections, pathlib

# The cascade order is whatever app/globals.css imports, so read it from there
# rather than keeping a third copy: this list had already lost feed-history.css, so
# that file's dead blocks were never checked.
ORDER = re.findall(r'@import\s+["\']\./styles/([^"\']+)\.css["\']', pathlib.Path("app/globals.css").read_text())
if not ORDER:
    # An empty list would scan nothing and still print "0", which passes the test
    # that guards this script vacuously.
    sys.exit('find-dead-css: no @import "./styles/*.css" lines found in app/globals.css')
BLOCK = re.compile(r'(?P<sel>[^{}@/]+?)\s*\{(?P<body>[^{}]*)\}', re.S)

def decls(body):
    out = {}
    for part in body.split(";"):
        if ":" not in part: continue
        n, _, v = part.partition(":")
        n, v = n.strip(), v.strip()
        if n and v: out[n] = v
    return out

def top_blocks(text):
    out = []
    for m in BLOCK.finditer(text):
        sel = re.sub(r'/\*.*?\*/', '', m.group("sel"), flags=re.S).strip()
        if not sel or sel.startswith("@"): continue
        d = 0
        for t in re.finditer(r'\{|\}', text[:m.start("body")]):
            d += 1 if t.group(0) == "{" else -1
        if d - 1 != 0: continue   # skip anything nested in @media/@supports
        out.append((sel, m.group("body"), m.start(), m.end()))
    return out

# Global ordered list of (file, selector, decls, span).
files = {name: pathlib.Path(f"app/styles/{name}.css").read_text() for name in ORDER}
sequence = []
for name in ORDER:
    for sel, body, s, e in top_blocks(files[name]):
        sequence.append({"file": name, "sel": sel, "decls": decls(body), "s": s, "e": e})

# For each block, is every property it sets also set by a LATER block with the
# identical selector text? If so it can never win and is safe to delete.
removable = collections.defaultdict(list)
for i, block in enumerate(sequence):
    if not block["decls"]:
        continue
    later = {}
    for other in sequence[i + 1:]:
        if other["sel"] == block["sel"]:
            later.update(other["decls"])
    if all(prop in later for prop in block["decls"]):
        removable[block["file"]].append(block)

total = sum(len(v) for v in removable.values())
print(f"blocks fully superseded by a later same-selector block: {total}")
for name, blocks in removable.items():
    print(f"  {name}: {len(blocks)}")
    for b in blocks:
        print(f"      {b['sel'][:60]}  ({len(b['decls'])} props)")

if "--apply" in sys.argv:
    for name, blocks in removable.items():
        text = files[name]
        for b in sorted(blocks, key=lambda x: -x["s"]):
            end = b["e"]
            while end < len(text) and text[end] == "\n": end += 1
            start = b["s"]
            prefix = text[:start].rstrip()
            if prefix.endswith("*/"):
                open_at = prefix.rfind("/*")
                if open_at != -1 and "\n\n" not in text[open_at:start]:
                    start = open_at
            text = text[:start] + text[end:]
        pathlib.Path(f"app/styles/{name}.css").write_text(text)
    print("applied")
