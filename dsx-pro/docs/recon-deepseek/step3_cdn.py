import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import fetch

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
os.makedirs(DL, exist_ok=True)

ASSETS = [
    "https://fe-static.deepseek.com/chat/static/default-vendors.73c732e189.js",
    "https://fe-static.deepseek.com/chat/static/main.7c490b0c22.js",
    "https://fe-static.deepseek.com/chat/static/main.3208e09460.css",
    "https://fe-static.deepseek.com/chat/manifest.json",
    "https://fe-static.deepseek.com/chat/favicon.svg",
]
for u in ASSETS:
    name = u.rsplit("/", 1)[-1]
    path = os.path.join(DL, name)
    info, raw = fetch(u, out=path)
    print(json.dumps({"url": u, "status": info["status"], "size": info["size"],
                      "ctype": info.get("ctype"), "err": info.get("error"),
                      "head": raw[:80].decode("utf-8", "replace")}, ensure_ascii=False))
