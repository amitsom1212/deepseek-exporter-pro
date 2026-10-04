import os, re, json, collections

OUT = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(OUT, "dl")

def load(n):
    with open(os.path.join(DL, n), "r", encoding="utf-8", errors="replace") as f:
        return f.read()

css = load("main.3208e09460.css")
main = load("main.7c490b0c22.js")
vend = load("default-vendors.73c732e189.js")

print("### SIZES", len(css), len(main), len(vend))

report = {}

# ---------- 1. ds-* design system tokens in CSS ----------
ds = collections.Counter(re.findall(r'\.(ds-[a-zA-Z0-9_-]+)', css))
report["ds_tokens_css"] = ds.most_common()
# also in JS (template literals / className)
dsjs = collections.Counter(re.findall(r'\b(ds-[a-z][a-z0-9-]{2,40})\b', main))
report["ds_tokens_js"] = dsjs.most_common(120)

# ---------- 2. hashed class names from the third-party exporter ----------
HASHES = ["_5cadb25","_76cd190","_25c7358","bf38813a","ec4f5d61","_77cefa5",
          "_24fad49","_519be07","_27fc06b","_5d271a3","_608a995","abbe3c45"]
report["hashed"] = {h: {"css": css.count(h), "main": main.count(h), "vend": vend.count(h)}
                    for h in HASHES}

# ---------- 3. legacy ds class names ----------
LEGACY = ["ds-message","ds-markdown","ds-think-content","ds-scroll-area",
          "ds-skeleton","ds-icon-button"]
report["legacy"] = {k: {"css": css.count(k), "main": main.count(k), "vend": vend.count(k)}
                    for k in LEGACY}

# ---------- 4. math ----------
for k in ["katex","KaTeX","annotation","application/x-tex","mathml","MathML","math-inline",
          "math-block","ds-math","tex2chtml","renderToString"]:
    report.setdefault("math", {})[k] = {"css": css.count(k), "main": main.count(k), "vend": vend.count(k)}

# ---------- 5. images ----------
for k in ["webp","image/webp","blob:","data:image","createObjectURL","cdn.deepseek.com",
          "files.deepseek.com","upload"]:
    report.setdefault("img", {})[k] = {"main": main.count(k), "vend": vend.count(k)}

# ---------- 6. api / storage ----------
for k in ["history_messages","chat/history","/api/v0/chat","api/v0","Authorization",
          "Bearer","localStorage","userToken","chat_session_id","chatSessionId",
          "conversation_id","message_id","parent_message_id","sse","stream"]:
    report.setdefault("api", {})[k] = {"main": main.count(k), "vend": vend.count(k)}

with open(os.path.join(OUT, "grep1.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print(json.dumps(report, ensure_ascii=False, indent=2))
