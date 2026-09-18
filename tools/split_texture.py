"""把生成的 glb 拆成「无贴图模型 + 独立压缩贴图」。

为什么：
1. 生成出来的 glb 里那张贴图占了 10MB+，三个角色就是 38MB 的 App 体积，太夸张。
2. React Native 没有 DOM，three 自带的贴图加载器在原生端会直接崩。
   → 模型里不放贴图（几何体一定能加载），贴图单独存 jpg，由 App 自己解码成 DataTexture。

产出：
    assets/models/<name>.glb       —— 纯几何 + 无贴图材质
    assets/models/<name>.jpg       —— 缩放后的 baseColor 贴图

用法：
    python tools/split_texture.py girlfriend boyfriend secretary
"""
import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

MODELS = Path(__file__).resolve().parent.parent / "assets" / "models"
TEX_SIZE = 1024      # 贴图边长上限
JPEG_QUALITY = 88


def read_glb(path: Path):
    data = path.read_bytes()
    magic, ver, total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, f"{path} 不是合法的 glb"
    off, blob, js = 12, None, None
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        payload = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:      # JSON
            js = json.loads(payload)
        elif ctype == 0x004E4942:    # BIN
            blob = payload
        off += 8 + clen
    return js, blob


def write_glb(path: Path, js: dict, blob: bytes):
    js_bytes = json.dumps(js, separators=(",", ":")).encode("utf-8")
    js_bytes += b" " * ((4 - len(js_bytes) % 4) % 4)        # JSON 必须 4 字节对齐
    if len(blob) % 4:
        blob += b"\x00" * (4 - len(blob) % 4)
    total = 12 + 8 + len(js_bytes) + (8 + len(blob) if blob else 0)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js_bytes), 0x4E4F534A) + js_bytes
    if blob:
        out += struct.pack("<II", len(blob), 0x004E4942) + blob
    path.write_bytes(bytes(out))


def process(name: str):
    src = MODELS / f"{name}.glb"
    js, blob = read_glb(src)

    images = js.get("images") or []
    if not images:
        print(f"[{name}] 没有内嵌贴图，跳过")
        return None

    # --- 1. 抽出贴图层并压缩成 jpg ---
    view_idx = images[0]["bufferView"]
    view = js["bufferViews"][view_idx]
    img_bytes = blob[view["byteOffset"]: view["byteOffset"] + view["byteLength"]]
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    img.thumbnail((TEX_SIZE, TEX_SIZE), Image.LANCZOS)
    # EXIF 方向修正（部分生成器会带旋转标记）
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    tex_path = MODELS / f"{name}.jpg"
    img.save(tex_path, "JPEG", quality=JPEG_QUALITY, optimize=True)

    # --- 2. 重建 BIN：丢掉贴图那一段，其余 bufferView 顺延重写偏移 ---
    keep = [i for i in range(len(js["bufferViews"])) if i != view_idx]
    new_blob = bytearray()
    offset_map = {}
    for i in keep:
        v = js["bufferViews"][i]
        old = v.get("byteOffset", 0)
        chunk = blob[old: old + v["byteLength"]]
        pad = (4 - len(new_blob) % 4) % 4
        new_blob += b"\x00" * pad
        offset_map[i] = len(new_blob)
        new_blob += chunk
        v["byteOffset"] = offset_map[i]

    js["bufferViews"] = [js["bufferViews"][i] for i in keep]
    # bufferView 的索引变了，需要修正所有引用（accessors / images / mesh）
    remap = {old_i: new_i for new_i, old_i in enumerate(keep)}
    for acc in js.get("accessors", []):
        if "bufferView" in acc and acc["bufferView"] in remap:
            acc["bufferView"] = remap[acc["bufferView"]]
    js["buffer"] = [{"byteLength": len(new_blob)}] if js.get("buffer") else []

    # --- 3. 干掉贴图相关定义，材质留 baseColor ---
    mat = (js.get("materials") or [{}])[0]
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr.pop("baseColorTexture", None)
    pbr.setdefault("baseColorFactor", [1, 1, 1, 1])
    for key in ("images", "textures", "samplers"):
        js.pop(key, None)
    js.pop("extensionsUsed", None)

    write_glb(src, js, bytes(new_blob))

    before = 0
    after = src.stat().st_size + tex_path.stat().st_size
    return {
        "name": name,
        "model_kb": round(src.stat().st_size / 1024),
        "texture_kb": round(tex_path.stat().st_size / 1024),
        "total_kb": round(after / 1024),
        "texture_size": img.size,
    }


if __name__ == "__main__":
    for n in (sys.argv[1:] or ["girlfriend", "boyfriend", "secretary"]):
        try:
            print(json.dumps(process(n), ensure_ascii=False))
        except Exception as e:
            print(f"[{n}] 失败: {e!r}")
            sys.exit(1)
