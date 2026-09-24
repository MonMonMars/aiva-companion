import urllib.request, os

root = r"c:\Users\Simon Lai\WorkBuddy\2026-09-18-15-55-01\llm-companion"
out = os.path.join(root, "public", "espeakng")
os.makedirs(out, exist_ok=True)
log = os.path.join(root, "espeak_fetch.log")

base_urls = [
    "https://cdn.jsdelivr.net/gh/steveseguin/espeakng.js@master/js/",
    "https://raw.githubusercontent.com/steveseguin/espeakng.js/master/js/",
    "https://cdn.jsdelivr.net/gh/pettarin/espeakng.js-cdn@master/js/",
]
files = ["espeakng-simple.js", "espeakng.min.js", "espeakng.worker.js", "espeakng.worker.data"]

lines = ["start"]
for f in files:
    done = False
    for b in base_urls:
        url = b + f
        dest = os.path.join(out, f)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=180).read()
            with open(dest, "wb") as fh:
                fh.write(data)
            lines.append("OK   %s  <- %s  (%d bytes)" % (f, url, len(data)))
            done = True
            break
        except Exception as e:
            lines.append("FAIL %s  %s  %s" % (f, url, e))
    if not done:
        lines.append("ALLFAIL %s" % f)
lines.append("done")

with open(log, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
print("\n".join(lines))
