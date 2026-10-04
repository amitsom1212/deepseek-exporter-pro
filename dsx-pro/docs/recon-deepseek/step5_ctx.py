import os, re, json

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()

main = load("main.7c490b0c22.js")
vend = load("default-vendors.73c732e189.js")
css  = load("main.3208e09460.css")

out = []
def ctx(text, pat, before=160, after=260, limit=12, tag=""):
    out.append(f"\n{'='*90}\n#### PATTERN {pat!r}  [{tag}]\n{'='*90}")
    n = 0
    for m in re.finditer(pat, text):
        s = max(0, m.start()-before); e = min(len(text), m.end()+after)
        out.append(f"--- hit {n} @ {m.start()} ---\n{text[s:e]}")
        n += 1
        if n >= limit: break
    if n == 0:
        out.append("(no hits)")

ctx(main, r'ds-message', tag="main")
ctx(main, r'history_messages', tag="main")
ctx(main, r'chat/history', tag="main")
ctx(main, r'/api/v0/chat', limit=8, tag="main")
ctx(main, r'userToken', tag="main")
ctx(main, r'Bearer', tag="main")
ctx(main, r'\.katex|katex', limit=8, tag="main")
ctx(vend, r'annotation', limit=6, tag="vendors")
ctx(vend, r'MathML', limit=6, tag="vendors")
ctx(main, r'ds-think-content', tag="main")
ctx(main, r'ds-scroll-area', limit=6, tag="main")

with open(os.path.join(OUT, "ctx1.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("\n".join(out)[:200])
print("WROTE ctx1.txt", len("\n".join(out)))
