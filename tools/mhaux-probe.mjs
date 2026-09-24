// mhaux-probe.mjs —— 数一数辅助几何（眼球/牙齿/舌头/睫毛）里到底有多少源顶点的
// target 位移是非零的。这些组不在 body 里，是否该跟着 morph 动，得先看数据说话。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Simon Lai/AppData/Local/Temp/mh-src/makehuman/data';
const txt = fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8');
let g = null;
const groups = {};
const pos = [];
for (const raw of txt.split('\n')) {
  const l = raw.trim();
  if (!l || l[0] === '#') continue;
  if ((l[0] === 'o' || l[0] === 'g') && l[1] === ' ') { g = l.slice(2).trim(); continue; }
  if (l[0] === 'v' && l[1] === ' ') { const a = l.slice(2).trim().split(/\s+/); pos.push(+a[0], +a[1], +a[2]); }
  else if (l[0] === 'f' && l[1] === ' ' && g) {
    (groups[g] = groups[g] || new Set());
    for (const tk of l.slice(2).trim().split(/\s+/)) groups[g].add(+tk.split('/')[0] - 1);
  }
}

const AUX = ['helper-l-eye', 'helper-r-eye', 'helper-upper-teeth', 'helper-lower-teeth',
  'helper-tongue', 'helper-l-eyelashes-1', 'helper-l-eyelashes-2',
  'helper-r-eyelashes-1', 'helper-r-eyelashes-2', 'helper-hair'];

// 取几个涵盖全身各处的 target
const TARGETS = [
  ['head-oval', 'head/head-oval'],
  ['eye-size', 'eyes/eye-size-incr'],
  ['eye-height', 'eyes/eye-height-decr'],
  ['mouth-dimples', 'mouth/mouth-dimples-in'],
  ['chin-height', 'chin/chin-height-incr'],
  ['universal-female', 'macrodetails/universal-female-young-maxmuscle-averageweight'],
  ['height', 'macrodetails/height/female-young-averagemuscle-averageweight-increase-height'],
];

console.log('组别'.padEnd(24) + '顶点数   各 target 中的非零位移顶点数');
for (const gname of AUX) {
  const set = groups[gname];
  if (!set) { console.log(`  ${gname.padEnd(22)} —— 不存在`); continue; }
  const cells = [];
  for (const [tn, rel] of TARGETS) {
    const fp = path.join(SRC, 'targets', rel + '.target');
    if (!fs.existsSync(fp)) { cells.push(tn + '=?'); continue; }
    const m = new Map();
    for (const raw of fs.readFileSync(fp, 'utf8').split('\n')) {
      const l = raw.trim();
      if (!l || l[0] === '#') continue;
      const a = l.split(/\s+/);
      m.set(+a[0], [+a[1], +a[2], +a[3]]);
    }
    let hit = 0, sum = 0;
    for (const vi of set) {
      const d = m.get(vi);
      if (!d) continue;
      const mag = Math.hypot(d[0], d[1], d[2]);
      if (mag > 1e-6) { hit++; sum += mag; }
    }
    cells.push(`${tn}=${hit}`);
  }
  console.log(`  ${gname.padEnd(22)} ${String(set.size).padStart(5)}   ${cells.join('  ')}`);
}

// 眼球 mhclo 里的顶点映射（mhclo 里 proxies 段会写清用哪些源顶点定位）
console.log('\n--- eyes/high-poly/high-poly.mhclo 头部 ---');
const mhclo = fs.readFileSync(path.join(SRC, 'eyes/high-poly/high-poly.mhclo'), 'utf8').split('\n');
console.log(mhclo.slice(0, 24).join('\n'));
console.log('  ... 总行数 ' + mhclo.length);
const vlines = mhclo.filter((l) => /^-?\d/.test(l.trim()));
console.log('  数字行 ' + vlines.length + '，示例：' + vlines.slice(0, 3).join(' | '));
