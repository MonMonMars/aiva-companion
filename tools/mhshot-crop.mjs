// mhshot-crop.mjs —— 从截图里裁一块并放大，专门用来看细节
// 背景：直接把 1360x760 的全图交给看图工具时，它会把图缩到很小的尺寸显示，
//       视觉上容易误判（例如把单张头像看成平铺）。裁小 + 放大后看得准。
//
// 用法：node tools/mhshot-crop.mjs <in.png> <out.png> [x0 y0 x1 y1] [zoom]
import fs from 'node:fs';
import { decodePNG, encodePNG } from './pngutil.mjs';

const [inp, outp] = process.argv.slice(2);
const nums = process.argv.slice(4).filter((a) => /^-?\d+(\.\d+)?$/.test(a)).map(Number);
const zoom = Number(process.argv[process.argv.length - 1]) || 2;

const src = decodePNG(fs.readFileSync(inp));
console.log(`源图 ${src.w}x${src.h} ch=${src.ch}`);

let [x0, y0, x1, y1] = nums.length >= 4 ? nums.slice(0, 4) : [0, 0, src.w, src.h];
x0 = Math.max(0, Math.min(src.w - 1, Math.round(x0)));
x1 = Math.max(x0 + 1, Math.min(src.w, Math.round(x1)));
y0 = Math.max(0, Math.min(src.h - 1, Math.round(y0)));
y1 = Math.max(y0 + 1, Math.min(src.h, Math.round(y1)));

const cw = x1 - x0, chh = y1 - y0;
const ow = Math.round(cw * zoom), oh = Math.round(chh * zoom);
console.log(`裁剪 x${x0}-${x1} y${y0}-${y1} (${cw}x${chh}) → 放大 ${zoom}× → ${ow}x${oh}`);

const out = Buffer.alloc(ow * oh * 3);
for (let j = 0; j < oh; j++) {
  for (let i = 0; i < ow; i++) {
    const sx = Math.min(src.w - 1, x0 + Math.floor(i / zoom));
    const sy = Math.min(src.h - 1, y0 + Math.floor(j / zoom));
    const so = (sy * src.w + sx) * src.ch;
    const d = (j * ow + i) * 3;
    out[d] = src.data[so];
    out[d + 1] = src.data[so + 1];
    out[d + 2] = src.data[so + 2];
  }
}
fs.writeFileSync(outp, encodePNG(ow, oh, out));
console.log(`写出 ${outp} (${(fs.statSync(outp).size / 1024).toFixed(0)}KB)`);
