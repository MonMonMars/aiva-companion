// 一次性核对脚本：18 个角色的「音色 / 离线台词 / 默认背景 / 签名姿势 / 示例对话」
// 是否齐全。
//
// ⚠️ 为什么用纯文本解析而不是 import：theme.js 会拉 react-native，
//    而 node_modules/react-native/index.js 里有 Flow 语法
//    （`import typeof * as ...`），Node 直接 SyntaxError。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const theme = read('src/theme.js');
const llm = read('src/llm.js');
const poses = read('src/anim/idlePoses.js');

// ---- 角色 id ----
// ⚠️ 别写成 `(?:girlfriend|realistic-)[a-z-]+` —— 那样 `girlfriend` 后面还要
//    再吃掉至少一个字符才匹配，三个可爱档会被悄悄漏掉（我第一版就踩了）。
const personaIds = [...theme.matchAll(/id: '(girlfriend|boyfriend|secretary|realistic-[a-z]+|ff-[a-z]+|vt-[a-z]+)'/g)]
  .map((m) => m[1]);

// ---- SPEECH 键 ----
const speechBlock = theme.slice(theme.indexOf('export const SPEECH'), theme.indexOf('export const personasByTier'));
const speechKeys = new Set([...speechBlock.matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s*\{/gm)].map((m) => m[1]));

// ---- SCRIPTS 键 ----
const scriptsBlock = llm.slice(llm.indexOf('const SCRIPTS = {'), llm.indexOf('const SCRIPTS_YUE'));
const scriptKeys = new Set([...scriptsBlock.matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s*\{/gm)].map((m) => m[1]));

// ---- 姿势 id ----
const poseIds = new Set([...poses.matchAll(/id: '([a-z0-9-]+)'/g)].map((m) => m[1]));

// ---- 每个角色块的字段 ----
// 取 PERSONAS 数组区间
const pStart = theme.indexOf('export const PERSONAS = [');
const pEnd = theme.indexOf('export const getPersona');
const personaBlock = theme.slice(pStart, pEnd);
// ⚠️ 别用 `split(/\n  \{\n/)` 去切：角色之间有注释块，切出来的块和 id 对不上，
//    结果一半角色被算成"没配"，而实际上配了 —— 核对脚本自己撒谎最要命。
//    改成：先定位 `id: 'xxx'`，再切到下一个角色（或数组末尾）为止。
const byId = new Map();
for (const id of personaIds) {
  const at = personaBlock.indexOf(`id: '${id}'`);
  if (at < 0) continue;
  const next = personaBlock.indexOf('\n  {\n', at);
  byId.set(id, personaBlock.slice(at, next < 0 ? personaBlock.length : next));
}

const FIELDS = ['bgId', 'idlePose', 'sample'];
const rows = [];
let bad = 0;
for (const id of personaIds) {
  const c = byId.get(id) || '';
  const row = { id };
  row.speech = speechKeys.has(id);
  row.script = scriptKeys.has(id);
  for (const f of FIELDS) {
    const m = c.match(new RegExp(`\\n    ${f}:`));
    row[f] = m ? (c.match(new RegExp(`\\n    ${f}:\\s*(.+)`))?.[1] ?? '?').slice(0, 34) : null;
  }
  if (row.idlePose) {
    const pid = row.idlePose.match(/'([a-z0-9-]+)'/)?.[1];
    row.poseOk = pid ? poseIds.has(pid) : false;
    row.poseId = pid || '?';
  } else {
    row.poseOk = false;
    row.poseId = '—';
  }
  if (!row.speech || !row.script || !row.poseOk || !row.bgId || !row.sample) bad += 1;
  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('角色'.padEnd(20), '音色', '台词', '背景', '姿势', '示例');
for (const r of rows) {
  const flag = (v) => (v ? ' ✓ ' : ' ✗ ');
  console.log(
    pad(r.id, 20),
    flag(r.speech),
    flag(r.script),
    flag(r.bgId),
    (r.poseOk ? ' ✓ ' : ' ✗ ') + pad(r.poseId, 16),
    flag(r.sample),
    r.bgId ? '' : '',
  );
}
console.log(`\n合计 ${rows.length} 个角色，有缺口的 ${bad} 个。`);
console.log(`SPEECH ${speechKeys.size} 条 / SCRIPTS ${scriptKeys.size} 条 / POSES ${poseIds.size} 个`);
