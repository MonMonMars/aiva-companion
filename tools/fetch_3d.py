"""轮询 3D 生成任务，完成后自动下载 .glb 到 assets/models/

用法（token 走 stdin，不进命令行）：
    echo -n "<token>" | python fetch_3d.py <job_id> <输出文件名.glb>
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

SCRIPT = ("C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/"
          "workbuddy-builtin/skills/buddy-multimodal-generation/scripts/buddy-cloud.py")
MODELS = Path(__file__).resolve().parent.parent / "assets" / "models"
MAX_WAIT = 900
INTERVAL = 20


def status(token: str, job_id: str) -> dict:
    out = subprocess.run(
        [sys.executable, SCRIPT, "status", job_id, "--type", "3d", "--token-stdin"],
        input=token, capture_output=True, text=True, timeout=120,
    )
    txt = out.stdout.strip()
    # 脚本可能先输出日志行，取最后一个 JSON 对象
    if not txt.startswith("{"):
        txt = txt[txt.rindex("\n{") + 1:] if "\n{" in txt else txt[txt.index("{"):]
    return json.loads(txt)


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        f.write(r.read())


def main():
    token = sys.stdin.read().strip()
    job_id = sys.argv[1]
    name = sys.argv[2]
    MODELS.mkdir(parents=True, exist_ok=True)
    dest = MODELS / name

    waited = 0
    while waited < MAX_WAIT:
        info = status(token, job_id)
        st = info.get("status") or info.get("raw_result", {}).get("Status")
        files = info.get("raw_result", {}).get("ResultFile3Ds") or []
        print(f"[{waited:>4}s] status={st} files={len(files)}", flush=True)

        if st in ("DONE", "success", "SUCCESS") and files:
            candidates = [f for f in files if str(f.get("Type", "")).lower() == "glb"] or files
            entry = candidates[0]
            url = entry.get("Url") or entry.get("url")
            print(f"downloading -> {dest}", flush=True)
            download(url, dest)
            size = dest.stat().st_size
            out = {"job_id": job_id, "glb": str(dest), "bytes": size,
                   "preview": entry.get("PreviewImageUrl") or entry.get("preview_image_url")}
            print(json.dumps(out, ensure_ascii=False), flush=True)
            return
        if st in ("FAIL", "failed", "FAILED"):
            print(json.dumps({"error": "generation_failed", "raw": info}, ensure_ascii=False), flush=True)
            sys.exit(1)
        time.sleep(INTERVAL)
        waited += INTERVAL
    print(json.dumps({"error": "timeout"}, ensure_ascii=False), flush=True)
    sys.exit(2)


if __name__ == "__main__":
    main()
