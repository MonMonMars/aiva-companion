"""校验原生端系统嗓音 TTS 接入是否没写坏。

两件事分开做，因为工具的能力不一样：
  1) node --check 只能吃纯 ESM，遇到 JSX 会误报 —— 所以只用于非 JSX 文件。
     （VoiceSettings.js 含 JSX，交给下面的 linter。）
  2) 项目自带的 lint-imports / lint-styles 是全项目扫描，能顺带查出
     「引用了不存在的文件」这类 Metro 打包不报错、运行时才炸的问题。

结果写进日志文件（本机 PowerShell 抓 stdout 会丢，必须落盘）。
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Users\Simon Lai\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
LOG = os.path.join(ROOT, "native_tts_verify.log")

# 不含 JSX 的文件才走 node --check
# 不含 JSX 的文件才走 node --check。
# VoiceSettings.js 含 JSX，node --check 一定会误报，交给下面的 linter。
SYNTAX_TARGETS = [
    "src/voice/nativeSpeech.js",
    "src/voice/session.js",
    "src/config/providers.js",
    "src/theme.js",
    "src/store.js",
]

out = []


def run(args, cwd=ROOT):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or ""), (r.stderr or "")


def syntax_check():
    out.append("=== 1) ESM 语法校验 (node --check) ===")
    tmpdir = os.path.join(ROOT, ".native_tts_tmp")
    if os.path.isdir(tmpdir):
        shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir, exist_ok=True)
    fail = 0
    for rel in SYNTAX_TARGETS:
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            out.append(f"  [缺失] {rel}")
            fail += 1
            continue
        dst = os.path.join(tmpdir, os.path.basename(rel).replace(".js", ".mjs"))
        shutil.copyfile(src, dst)
        rc, _, err = run([NODE, "--check", dst])
        if rc == 0:
            out.append(f"  OK   {rel}")
        else:
            fail += 1
            head = (err or "").strip().splitlines()[:4]
            out.append(f"  FAIL {rel}")
            for ln in head:
                out.append(f"       {ln}")
    shutil.rmtree(tmpdir, ignore_errors=True)
    out.append(f"  -> 通过 {len(SYNTAX_TARGETS) - fail}/{len(SYNTAX_TARGETS)}")
    return fail


def linters():
    out.append("")
    out.append("=== 2) 项目自带 linter ===")
    total = 0
    for script in ["tools/lint-imports.mjs", "tools/lint-styles.mjs"]:
        p = os.path.join(ROOT, script)
        if not os.path.isfile(p):
            out.append(f"  [跳过] 找不到 {script}")
            continue
        rc, so, se = run([NODE, script, "."])
        total += rc
        blob = (so + "\n" + se).strip()
        out.append(f"  {script} -> rc={rc}")
        if blob:
            # 只保留最后若干行，避免日志爆炸
            lines = blob.splitlines()
            keep = lines[-15:]
            for ln in keep:
                out.append(f"     {ln}")
            if len(lines) > 15:
                out.append(f"     …(共 {len(lines)} 行，仅显示末尾 15 行)")
        else:
            out.append("     (无输出 = 无问题)")
    return total


f1 = syntax_check()
f2 = linters()

out.append("")
out.append("=" * 46)
out.append(f"总计：语法失败 {f1} 个，linter 返回码合计 {f2}")
if f1 == 0 and f2 == 0:
    out.append("结论：全部通过 ✓")
else:
    out.append("结论：有问题 ✗ 见上方明细")

with open(LOG, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out))

print("\n".join(out))
sys.exit(0 if (f1 == 0 and f2 == 0) else 1)
