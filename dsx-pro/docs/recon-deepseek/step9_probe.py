import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import fetch

OUT = os.path.dirname(os.path.abspath(__file__))
SID = "48b4f6dc-40c5-4616-8eb4-af278c4fbb16"
TESTS = [
    f"https://chat.deepseek.com/api/v0/share/content?share_id={SID}",
    f"https://chat.deepseek.com/share/{SID}",
    f"https://chat.deepseek.com/a/chat/s/{SID}",
    "https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=1",
    "https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=1",
    "https://fe-static.deepseek.com/chat/static/main.7c490b0c22.js",
    "https://fe-static.deepseek.com/chat/static/main.3208e09460.css",
    "https://fe-static.deepseek.com/chat/static/default-vendors.73c732e189.js",
]
rows = []
for u in TESTS:
    info, raw = fetch(u)
    snippet = raw[:400].decode("utf-8", "replace").replace("\n", " ")
    rows.append({"url": u, "status": info["status"], "size": info["size"],
                 "ctype": info.get("ctype"), "final_url": info.get("url"),
                 "err": info.get("error"), "snippet": snippet})
    print(json.dumps(rows[-1], ensure_ascii=False)[:900])
    print("-"*70)
with open(os.path.join(OUT, "probe.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)
