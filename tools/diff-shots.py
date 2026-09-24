#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
比较同一画面相隔数秒的两帧，用差异率证明"3D 角色真的在动"。

为什么不用"非背景像素占比"：App 的背景是人格主题色渐变，
角色和背景的色差很小，那个指标会被渐变本身污染（实测 97%，毫无意义）。
而角色待机时一直在呼吸、摆臂、眨眼，两帧之间必然有像素变化；
空画布（或降级成静态程序化小人）差异率会低一个量级。

用法：python tools/diff-shots.py <a.png> <b.png>
"""
import sys
import os

try:
    from PIL import Image, ImageChops
except ImportError:
    print("need Pillow")
    sys.exit(2)

a_path, b_path = sys.argv[1], sys.argv[2]
for p in (a_path, b_path):
    if not os.path.exists(p):
        print("missing: %s" % p)
        sys.exit(1)

a = Image.open(a_path).convert("RGB")
b = Image.open(b_path).convert("RGB")
if a.size != b.size:
    print("size mismatch %s vs %s" % (a.size, b.size))
    sys.exit(1)

W, H = a.size
pa, pb = a.load(), b.load()

changed = 0
total = 0
strong = 0
minx, maxx, miny, maxy = W, -1, H, -1

step = 2
for y in range(0, H, step):
    for x in range(0, W, step):
        ca, cb = pa[x, y], pb[x, y]
        d = abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
        total += 1
        if d > 12:
            changed += 1
            if d > 60:
                strong += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

pct = 100.0 * changed / max(1, total)
pct_strong = 100.0 * strong / max(1, total)

print("")
print("=== %s vs %s (%dx%d) ===" % (os.path.basename(a_path), os.path.basename(b_path), W, H))
print("  有变化的像素：%.2f%%   明显变化(>60)：%.2f%%" % (pct, pct_strong))
if changed:
    print("  变化区域：x %d..%d  y %d..%d（宽 %.0f%%，高 %.0f%%）"
          % (minx, maxx, miny, maxy,
             100.0 * (maxx - minx) / W, 100.0 * (maxy - miny) / H))

print("")
if pct >= 0.5:
    print("  [OK] 有 %.2f%% 的像素在动 —— 3D 角色活着（呼吸/摆臂/眨眼）" % pct)
    ok = True
else:
    print("  [FAIL] 只有 %.2f%% 的像素变化 —— 画面基本是静止的，"
          "角色可能没渲染出来" % pct)
    ok = False

# 变化是"局部"才对：整屏都在变说明是 UI 动画/渐变在滚，不是角色
if changed and (maxx - minx) > 0 and (maxy - miny) > 0:
    area = (maxx - minx) * (maxy - miny)
    if area > 0.85 * W * H:
        print("  [WARN] 变化铺满整屏 —— 可能只是背景动画，不能作为角色证据")

print("")
sys.exit(0 if ok else 1)
