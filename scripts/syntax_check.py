import os, subprocess, tempfile, shutil

node = r"C:\Users\Simon Lai\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
base = r"c:\Users\Simon Lai\WorkBuddy\2026-09-18-15-55-01\llm-companion"
# 这些是非 JSX 的纯 JS 文件，node --check 能直接解析 import/export
files = [
    "src/voice/espeak.js",
    "src/voice/webSpeak.js",
    "src/voice/webSession.js",
    "src/config/providers.js",
    "src/theme.js",
    "src/store.js",
]
tmp = tempfile.mkdtemp()
out = []
for f in files:
    src = os.path.join(base, f)
    dst = os.path.join(tmp, f.replace("/", "_") + ".mjs")
    shutil.copy(src, dst)
    r = subprocess.run([node, "--check", dst], capture_output=True, text=True)
    status = "OK  " if r.returncode == 0 else "FAIL"
    out.append(status + f)
    if r.returncode != 0:
        out.append("    " + r.stderr.strip().replace("\n", "\n    "))
shutil.rmtree(tmp, ignore_errors=True)
log = "\n".join(out)
open(os.path.join(base, "syntax_check.log"), "w").write(log + "\n")
print(log)
