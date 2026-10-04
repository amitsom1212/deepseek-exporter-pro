import os, re, json
OUT = os.path.dirname(os.path.abspath(__file__)); DL=os.path.join(OUT,"dl")
main = open(os.path.join(DL,"main.7c490b0c22.js"),encoding="utf-8",errors="replace").read()
out=[]
def hits(pat, before=300, after=900, limit=6):
    out.append(f"\n---- {pat!r} ----"); n=0
    for m in re.finditer(pat, main):
        s=max(0,m.start()-before); e=min(len(main),m.end()+after)
        out.append(f"  @{m.start()}: {main[s:e]}"); n+=1
        if n>=limit: break
    if n==0: out.append("  (none)")

hits(r'deepseeksvc\.com', 800, 900, 8)
hits(r'getFilesBaseDomain', 300, 400, 8)
hits(r'lX=', 200, 400, 6)
hits(r'l0=|l2=lX', 300, 500, 4)
print("\n".join(out))
