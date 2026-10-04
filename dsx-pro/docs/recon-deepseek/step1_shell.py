import re, os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import fetch

OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(OUT, "dl"), exist_ok=True)

urls = [
    "https://chat.deepseek.com/",
    "https://chat.deepseek.com/a/chat/s/48b4f6dc-40c5-4616-8eb4-af278c4fbb16",
]
for u in urls:
    info, raw = fetch(u)
    print("===", u, info["status"], info["size"])
    html = raw.decode("utf-8", "replace")
    fn = os.path.join(OUT, "shell.html")
    with open(fn, "w", encoding="utf-8") as f:
        f.write(html)
    print(html)
    break

# extract asset refs
assets = set()
for m in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', html):
    assets.add(m.group(1))
for m in re.finditer(r'["\'](/[A-Za-z0-9_\-./]+\.(?:js|css|json|woff2?|png|svg))["\']', html):
    assets.add(m.group(1))
print("\n\n#### ASSETS ####")
for a in sorted(assets):
    print(a)
