#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
统计一张 App 截图里"有没有角色、是不是纯色剪影"。

为什么需要：我读不了图片（Read 工具对 PNG 一直返回 does not support images），
所以只能让脚本把像素算出来回答两个问题：
  1. 画面中间那块（角色应该在的地方）有多少像素和背景不一样 —— 有没有人
  2. 这些像素的颜色离散度 —— 贴图生效了吗，还是一坨纯色

用法：python tools/analyze-shot.py <截图.png> [--focus=0.30,0.15,0.40,0.70]
      --focus 是 x0,y0,w,h 的比例，默认取画面中上部（角色躯干+头所在区域）
"""
import sys
import os
from collections import Counter

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：pip install Pillow")
    sys.exit(2)

path = sys.argv[1]
focus = None
for a in sys.argv[2:]:
    if a.startswith("--focus="):
        focus = [float(x) for x in a.split("=")[1].split(",")]

if not os.path.exists(path):
    print("找不到文件：%s" % path)
    sys.exit(1)

im = Image.open(path).convert("RGB")
W, H = im.size
px = im.load()

# 焦点区：默认中间偏上那块（角色站姿下头到腰的位置）
if focus and len(focus) == 4:
    x0, y0, w, h = focus
else:
    x0, y0, w, h = 0.25, 0.12, 0.50, 0.66
fx0, fy0 = int(W * x0), int(H * y0)
fx1, fy1 = int(W * (x0 + w)), int(H * (y0 + h))

# 背景色取四角众数（App 是深色 UI，取角落最稳）
corners = [px[2, 2], px[W - 3, 2], px[2, H - 3], px[W - 3, H - 3]]
bg = Counter(corners).most_common(1)[0][0]


def diff(c, b):
    return abs(c[0] - b[0]) + abs(c[1] - b[1]) + abs(c[2] - b[2])


total = 0
unusual = 0
colors = Counter()
sat = 0
lum = 0
minx, maxx, miny, maxy = W, -1, H, -1

step = 2  # 隔点采样，够统计了
for y in range(fy0, fy1, step):
    for x in range(fx0, fx1, step):
        c = px[x, y]
        total += 1
        if diff(c, bg) > 30:
            unusual += 1
            colors[(c[0] >> 3, c[1] >> 3, c[2] >> 3)] += 1
            mx, mn = max(c), min(c)
            sat += mx - mn
            lum += 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

pct = 100.0 * unusual / max(1, total)
print("")
print("=== %s (%dx%d) ===" % (os.path.basename(path), W, H))
print("  背景色（四角众数）：RGB%s" % (bg,))
print("  焦点区：x %d..%d  y %d..%d" % (fx0, fx1, fy0, fy1))
print("  非背景像素占比：%.1f%%" % pct)
print("  不同颜色数：%d" % len(colors))
if unusual:
    print("  平均饱和度：%.1f   平均亮度：%.1f" % (sat / unusual, lum / unusual))
    print("  主体外框：x %d..%d  y %d..%d（占画面宽 %.0f%%，高 %.0f%%）"
          % (minx, maxx, miny, maxy,
             100.0 * (maxx - minx) / W, 100.0 * (maxy - miny) / H))

ok = True
print("")
if pct < 5:
    print("  [FAIL] 焦点区几乎全是背景色 —— 角色可能没画出来 / 相机没对准")
    ok = False
else:
    print("  [OK] 焦点区有 %.1f%% 的非背景像素 —— 画面里有东西" % pct)

if len(colors) < 60:
    print("  [FAIL] 颜色只有 %d 种 —— 像纯色剪影，贴图可能没生效" % len(colors))
    ok = False
else:
    print("  [OK] 颜色 %d 种 —— 有细节，不是纯色剪影" % len(colors))

print("")
sys.exit(0 if ok else 1)
