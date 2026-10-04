import sys, ssl, urllib.request, urllib.error, gzip, zlib, os, json

ctx = ssl.create_default_context()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

def fetch(url, out=None, want_headers=False):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    })
    try:
        with urllib.request.urlopen(req, timeout=45, context=ctx) as r:
            raw = r.read()
            enc = r.headers.get("Content-Encoding", "")
            if "gzip" in enc:
                try: raw = gzip.decompress(raw)
                except Exception: pass
            elif "deflate" in enc:
                try: raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                except Exception: pass
            info = {
                "status": r.status,
                "url": r.geturl(),
                "ctype": r.headers.get("Content-Type"),
                "clen": r.headers.get("Content-Length"),
                "size": len(raw),
                "headers": dict(r.headers),
            }
            if out:
                with open(out, "wb") as f: f.write(raw)
            return info, raw
    except urllib.error.HTTPError as e:
        body = b""
        try: body = e.read()
        except Exception: pass
        return {"status": e.code, "error": str(e), "size": len(body),
                "headers": dict(e.headers or {})}, body
    except Exception as e:
        return {"status": 0, "error": f"{type(e).__name__}: {e}", "size": 0, "headers": {}}, b""

if __name__ == "__main__":
    for url in sys.argv[1:]:
        out = None
        info, raw = fetch(url)
        print(json.dumps(info, ensure_ascii=False)[:1200])
        print("-" * 70)
