import os, re, json

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()
main = load("main.7c490b0c22.js")
css  = load("main.3208e09460.css")
out=[]
def sec(t): out.append(f"\n\n{'#'*100}\n## {t}\n{'#'*100}")
def hits(text, pat, before=250, after=600, limit=6, tag=""):
    out.append(f"\n---- {pat!r} [{tag}] ----")
    n=0
    for m in re.finditer(pat, text):
        s=max(0,m.start()-before); e=min(len(text),m.end()+after)
        out.append(f"  @{m.start()}: {text[s:e]}")
        n+=1
        if n>=limit: break
    if n==0: out.append("  (none)")

sec("1) Which CSS hash classes are the conversation-list rows?")
for h in ["_25c7358","_77cefa5","_519be07","_27fc06b","_5d271a3","_24fad49","ec4f5d61","bf38813a"]:
    out.append(f"\n===== .{h} CSS RULES =====")
    for m in re.finditer(r'\.'+re.escape(h)+r'[^{]*\{[^}]*\}', css):
        out.append("  "+m.group(0)[:600])
        if len(out)>0 and m.group(0): pass
    # limit
    cnt=0
    for m in re.finditer(r'\.'+re.escape(h)+r'[^{]*\{[^}]*\}', css):
        cnt+=1
        if cnt>6: break

sec("2) MessageRole enum")
hits(main, r'MessageRole', 300, 500, 6)
hits(main, r'ASSISTANT[:=]|USER[:=]|"assistant"|"user"', 200, 300, 8)

sec("3) COMPOSER")
hits(main, r'ds-textarea__textarea', 400, 500, 4)
hits(main, r'chatInputPlaceholderChat', 200, 300, 4)
hits(main, r'collapsedUserMessage|collapseUserMessage', 200, 300, 4)
hits(main, r'codeDownload|copyCode', 200, 300, 4)
hits(main, r'ds-markdown-code-copy-button', 400, 500, 6)

sec("4) SHARE api + public share page")
hits(main, r'/api/v0/share/content', 400, 700, 4)
hits(main, r'/api/v0/share/fork', 200, 400, 3)
hits(main, r'shareId', 250, 400, 8)

sec("5) history_messages response fields")
hits(main, r'history_messages', 100, 1600, 2)

sec("6) skeleton + loading")
hits(main, r'ds-skeleton', 300, 400, 6)

sec("7) virtual list DOM ids")
hits(main, r'nG="data-virtual-list-item-key"', 1500, 1500, 2)
hits(main, r'ds-virtual-list-items|ds-virtual-list-visible', 300, 400, 6)

with open(os.path.join(OUT,"ctx4.txt"),"w",encoding="utf-8") as f:
    f.write("\n".join(out))
print("WROTE", sum(len(x) for x in out))
