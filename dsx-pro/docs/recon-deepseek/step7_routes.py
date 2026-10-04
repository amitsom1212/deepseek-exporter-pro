import os, re, json, collections

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()
main = load("main.7c490b0c22.js")
out = []
def sec(t): out.append(f"\n\n{'#'*100}\n## {t}\n{'#'*100}")
def hits(text, pat, before=200, after=500, limit=8, tag=""):
    out.append(f"\n---- {pat!r} [{tag}] ----")
    n=0
    for m in re.finditer(pat, text):
        s=max(0,m.start()-before); e=min(len(text),m.end()+after)
        out.append(f"  @{m.start()}: {text[s:e]}")
        n+=1
        if n>=limit: break
    if n==0: out.append("  (none)")

sec("ALL /api/ ROUTES in bundle")
routes = sorted(set(re.findall(r'["\'](/api/[A-Za-z0-9_/\-\.]+)["\']', main)))
out.append(json.dumps(routes, ensure_ascii=False, indent=1))

sec("ROUTE PATHS (ROOT / chat url shape)")
hits(main, r'ROOT\s*[:=]', 250, 400, 6)
hits(main, r'/a/chat', 300, 500, 10)
hits(main, r'`/a/chat', 300, 500, 6)
hits(main, r'p2p|share_id|shareId', 250, 350, 8)
hits(main, r'window\.location\.pathname|location\.pathname', 200, 300, 6)

sec("SIDEBAR conversation list")
hits(main, r'chat_sessions\.map|chat_sessions', 250, 400, 6)
hits(main, r'SessionList|sessionList|ConversationList|chatList', 200, 350, 8)
hits(main, r'createSidebarHandle|sidebar', 200, 300, 8)
hits(main, r'key:\s*[a-zA-Z_$]*\.id|itemKey', 250, 350, 8)

sec("COMPOSER / input")
hits(main, r'ds-textarea', 300, 400, 6)
hits(main, r'textareaElRef', 250, 350, 5)
hits(main, r'contenteditable', 250, 350, 6)
hits(main, r'placeholder', 200, 300, 5)

sec("THINK CONTENT internals")
hits(main, r'ds-think-content', 1200, 1200, 3)
hits(main, r'thinkingContent|reasoning_content|reasoningContent', 300, 400, 8)

sec("KATEX / math DOM mount")
hits(main, r'katex-display', 700, 700, 4)
hits(main, r'ds-markdown-math', 400, 500, 8)
hits(main, r'"math"|mathBlock|mathInline|inlineMath', 250, 350, 8)

sec("MESSAGE ROLE / user vs assistant")
hits(main, r'MessageRole', 200, 300, 8)
hits(main, r'isUserMessage|fromUser|role==="user"|role===er', 250, 350, 8)

with open(os.path.join(OUT, "ctx3.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("WROTE", sum(len(x) for x in out))
