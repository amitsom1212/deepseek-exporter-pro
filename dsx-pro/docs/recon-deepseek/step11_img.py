import os, re, json, collections
OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f: return f.read()
main = load("main.7c730b0c22.js") if False else load("main.7c490b0c22.js")
out=[]
def sec(t): out.append(f"\n\n{'#'*100}\n## {t}\n{'#'*100}")
def hits(text, pat, before=250, after=700, limit=6, tag=""):
    out.append(f"\n---- {pat!r} [{tag}] ----")
    n=0
    for m in re.finditer(pat, text):
        s=max(0,m.start()-before); e=min(len(text),m.end()+after)
        out.append(f"  @{m.start()}: {text[s:e]}")
        n+=1
        if n>=limit: break
    if n==0: out.append("  (none)")

sec("signedPath -> URL builder l8")
hits(main, r'signedPath', 350, 500, 8)
hits(main, r'function l8|l8=\(|l8=', 200, 800, 4)
hits(main, r'baseUrl|BASE_URL|API_BASE', 200, 300, 8)

sec("DeepThink / thinking labels")
hits(main, r'deactivatedThinkTooltip|thinkingSwitch|DeepThink', 150, 250, 4)
hits(main, r'thoughtFor|thinkingSeconds|reasoning', 200, 300, 8)

sec("ds-* inventory in main.js")
dsjs = collections.Counter(re.findall(r'\b(ds-[a-z][a-z0-9-]{2,45})\b', main))
out.append("distinct ds-* tokens: %d" % len(dsjs))
out.append(json.dumps([k for k,_ in dsjs.most_common()], ensure_ascii=False, indent=1))

with open(os.path.join(OUT,"ctx6.txt"),"w",encoding="utf-8") as f: f.write("\n".join(out))
print("WROTE", sum(len(x) for x in out))
