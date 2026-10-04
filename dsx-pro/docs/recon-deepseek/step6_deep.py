import os, re, json

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()

main = load("main.7c490b0c22.js")
css  = load("main.3208e09460.css")
out = []

def sec(title):
    out.append(f"\n\n{'#'*100}\n## {title}\n{'#'*100}")

def hits(text, pat, before=200, after=420, limit=8, tag=""):
    out.append(f"\n---- {pat!r} [{tag}] ----")
    n = 0
    for m in re.finditer(pat, text):
        s = max(0, m.start()-before); e = min(len(text), m.end()+after)
        out.append(f"  @{m.start()}: {text[s:e]}")
        n += 1
        if n >= limit: break
    if n == 0: out.append("  (none)")

sec("A. MESSAGE-RELATED CLASS NAMES present in bundles")
cls = set(re.findall(r'["\'.]([a-z][a-z0-9-]*message[a-z0-9-]*)["\'.]', main, re.I))
cls |= set(re.findall(r'\b(ds-[a-z0-9-]*(?:message|chat|conversation|session|virtual|markdown|think|reason)[a-z0-9-]*)\b', main))
out.append(json.dumps(sorted(cls), ensure_ascii=False, indent=1))

sec("B. ds-* classes in CSS that relate to message/markdown/think")
cssds = sorted(set(re.findall(r'\.(ds-[a-zA-Z0-9_-]+)', css)))
rel = [c for c in cssds if re.search(r'message|markdown|think|reason|virtual|session|conversation|scroll|skeleton|cite|code|table|blockquote|img|image', c)]
out.append(json.dumps(rel, ensure_ascii=False, indent=1))

sec("C. assistant/user message main content")
hits(main, r'ds-assistant-message-main-content', 700, 700, 6)
hits(main, r'ds-user-message[a-z-]*', 300, 400, 8)
hits(main, r'data-virtual-list-item-key', 350, 550, 6)

sec("D. MATH / latex")
hits(main, r'latexRenderer', 300, 500, 6)
hits(main, r'renderToString\(', 700, 700, 4)
hits(main, r'latex-wasm|latexWasm|latex_wasm|\.wasm', 250, 400, 8)
hits(main, r'om=\["katex","wasm"\]', 1500, 1500, 2)

sec("E. IMAGE / upload")
hits(main, r'createObjectURL', 300, 400, 8)
hits(main, r'image/webp', 300, 400, 6)
hits(main, r'upload_file', 300, 500, 4)
hits(main, r'cdn\.deepseek\.com', 200, 300, 8)

sec("F. SIDEBAR / session list / URL")
hits(main, r'/a/chat/s/', 300, 400, 8)
hits(main, r'chat_session/fetch_page', 200, 700, 3)
hits(main, r'data-[\w-]*session[\w-]*', 200, 300, 8)
hits(main, r'history.push|navigate\(|useNavigate', 150, 250, 10)

sec("G. AUTHORIZATION / token / storage keys")
hits(main, r'getToken\(\)', 400, 500, 5)
hits(main, r'create\("userToken"', 300, 400, 3)
hits(main, r'__appKit_', 100, 300, 10)
hits(main, r'Authorization', 250, 300, 6)

sec("H. STREAMING / stop button")
hits(main, r'stopGenerating|stop_generating|onStop|StopGenerating', 250, 400, 8)
hits(main, r'/api/v0/chat/completion', 300, 600, 3)
hits(main, r'data-[\w-]*(?:stream|generating)[\w-]*', 200, 300, 8)

with open(os.path.join(OUT, "ctx2.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("WROTE ctx2.txt", sum(len(x) for x in out))
