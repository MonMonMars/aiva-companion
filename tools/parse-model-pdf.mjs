// 解析「3D 模型清单」这类 HTML 转出的矢量 PDF
// ---------------------------------------------------------------------------
// 为什么不能直接用现成的 PDF 库：
//   这类 PDF 是浏览器直接打印出来的，文字没有语义标签，全部散在一堆
//   `x y Td (text) Tj` 操作里，且**没有 Tf 字体选择**（继承自外层 BT 块）。
//   常见的文本抽取库会按流顺序拼，得到的是乱序结果（标题夹在数字中间）。
//
// 做法：
//   1. FlateDecode 解压所有 stream
//   2. 每个 BT...ET 块内，跟踪 Td/TD/Tm 的当前坐标，把 (text) Tj 记成 (x, y, text)
//   3. 按 y 分行（阈值 2pt），行内按 x 排序，再按 y 从上到下输出
//
// 用法：node tools/parse-model-pdf.mjs <input.pdf> [out.txt]
//
// 注意：这只是"够用的解析器"，不是通用 PDF 阅读器。遇到用 TJ 数组做字距调整、
// 或者文字在 XObject 表单里的 PDF，需要另外加处理。

import fs from 'fs';
import zlib from 'zlib';

const [, , input, outArg] = process.argv;
if (!input) {
  console.error('用法: node tools/parse-model-pdf.mjs <input.pdf> [out.txt]');
  process.exit(1);
}

const buf = fs.readFileSync(input);

// --- 1. 取出所有 stream 并解压 -------------------------------------------------
// 这里不解析 xref / 对象图，直接正则扫 stream...endstream —— 对这类
// 结构规整的浏览器导出 PDF 足够用。
const rawStreams = [...buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
  .map((m) => Buffer.from(m[1], 'latin1'));

const texts = [];
for (const rs of rawStreams) {
  let data;
  try {
    data = zlib.inflateSync(rs);
  } catch {
    continue; // 未压缩或非 FlateDecode 的流跳过（可能是图片）
  }
  const s = data.toString('latin1');
  if (!s.includes('BT')) continue;
  texts.push(s);
}

if (!texts.length) {
  console.error('没有找到含文字的 stream —— 可能这是个扫描件（纯图片 PDF）');
  process.exit(2);
}

// --- 2. 逐个 BT 块抽 (x, y, text) ---------------------------------------------
const items = [];

for (const s of texts) {
  for (const blk of s.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = blk[1];
    let cur = null;

    // 一个 token 一个 token 地扫：坐标算子 或 文本算子
    const re = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(?:Td|TD)|(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Tm|\((?:[^()\\]|\\.)*\)\s*Tj|\n/g;

    for (const m of body.matchAll(re)) {
      if (m[1] !== undefined) {
        // Td / TD：相对位移
        cur = cur ? [cur[0] + parseFloat(m[1]), cur[1] + parseFloat(m[2])] : [parseFloat(m[1]), parseFloat(m[2])];
      } else if (m[3] !== undefined) {
        // Tm：绝对矩阵，取 e/f 作为 x/y
        cur = [parseFloat(m[7]), parseFloat(m[8])];
      } else if (m[0].trimEnd().endsWith('Tj')) {
        const raw = m[0].slice(m[0].indexOf('(') + 1, m[0].lastIndexOf(')'));
        const text = raw
          .replace(/\\([()\\])/g, '$1')      // 转义括号与反斜杠
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '');
        if (cur && text.trim()) items.push({ x: cur[0], y: cur[1], t: text });
      }
    }
  }
}

if (!items.length) {
  console.error('没抽到任何文本 —— PDF 可能把文字转成了路径（部分打印引擎会这样）');
  process.exit(3);
}

// --- 3. 按 y 分行，行内按 x 排序 ------------------------------------------------
items.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));

const lines = [];
let row = [];
let lastY = null;
for (const it of items) {
  if (lastY === null || Math.abs(it.y - lastY) > 2) {
    if (row.length) lines.push(row.join('  |  '));
    row = [];
    lastY = it.y;
  }
  row.push(it.t.trim());
}
if (row.length) lines.push(row.join('  |  '));

const out = lines.join('\n');
if (outArg) {
  fs.writeFileSync(outArg, out, 'utf8');
  console.error(`已写出 ${outArg}（${lines.length} 行，${items.length} 段文本）`);
} else {
  console.log(out);
}
