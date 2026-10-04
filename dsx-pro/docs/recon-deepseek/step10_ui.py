import os, re, json, collections

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()
main = load("main.7c490b0c22.js")
css  = load("main.3208e09460.css")
out=[]
def sec(t): out.append(f"\n\n{'#'*100}\n## {t}\n{'#'*100}")
def hits(text, pat, before=300, after=800, limit=5, tag=""):
    out.append(f"\n---- {pat!r} [{tag}] ----")
    n=0
    for m in re.finditer(pat, text):
        s=max(0,m.start()-before); e=min(len(text),m.end()+after)
        out.append(f"  @{m.start()}: {text[s:e]}")
        n+=1
        if n>=limit: break
    if n==0: out.append("  (none)")

sec("ROLE -> component mapping (Cd=user, mM=assistant)")
hits(main, r'case er\.B\.MessageRole\.USER', 500, 900, 3)
hits(main, r'function Ca\(|Ca=|let Ca', 300, 900, 6)

sec("ds-message render site (container)")
hits(main, r'"ds-message"', 1800, 900, 2)

sec("USER message DOM")
hits(main, r'selectedMessages|collapseUserMessage|expandUserMessage', 400, 700, 5)

sec("SEND/STOP button")
hits(main, r'case"stop"', 400, 700, 4)
hits(main, r'a7\.uN|a7\.NH', 300, 400, 6)

sec("IMAGE in message")
hits(main, r'message_image', 300, 700, 4)
hits(main, r'localThumbnailUrl', 300, 500, 8)
hits(main, r'<img|jsx\)\("img"', 300, 500, 8)
hits(main, r'thumbnailUrl|imageUrl|image_url', 250, 350, 8)

sec("ds-* FULL inventory count")
dsjs = collections.Counter(re.findall(r'\b(ds-[a-z][a-z0-9-]{2,45})\b', main))
out.append("total distinct ds-* tokens in main.js: %d" % len(dsjs))
out.append(json.dumps([k for k,_ in dsjs.most_common()], ensure_ascii=False))

sec("CSS custom props / theme attrs")
out.append(json.dumps(sorted(set(re.findall(r'\[data-([a-z-]+)[\]=]', css))), ensure_ascii=False))

with open(os.path.join(OUT,"ctx5.txt"),"w",encoding="utf-8") as f:
    f.write("\n".join(out))
print("WROTE", sum(len(x) for x in out))
