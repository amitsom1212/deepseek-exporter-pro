import os, sys, re, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import fetch

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")
os.makedirs(DL, exist_ok=True)

ASSETS = [
    "https://chat.deepseek.com/chat/static/default-vendors.73c732e189.js",
    "https://chat.deepseek.com/chat/static/main.7c490b0c22.js",
    "https://chat.deepseek.com/chat/static/main.3208e09460.css",
    "https://chat.deepseek.com/chat/manifest.json",
]

results = []
for u in ASSETS:
    name = u.rsplit("/", 1)[-1]
    path = os.path.join(DL, name)
    info, raw = fetch(u, out=path)
    rec = {"url": u, "status": info["status"], "size": info["size"],
           "ctype": info.get("ctype"), "file": path}
    results.append(rec)
    print(json.dumps(rec, ensure_ascii=False))

with open(os.path.join(OUT, "assets.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
