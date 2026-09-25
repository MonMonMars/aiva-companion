// 核对脚本：18 个角色的「音色 / 离线台词 / 默认背景 / 签名姿势 / 示例对白 / 六组互动台词」
// 是否齐全且合法。改完 theme.js 或 llm.js 之后跑一遍。
//
// ⚠️ 为什么用纯文本解析而不是 import：theme.js 会拉 react-native，
//    而 node_modules/react-native/index.js 里有 Flow 语法
//    （`import typeof * as ...`），Node 直接 SyntaxError。
//
// ⚠️ 核对脚本自己也会撒谎：第一版用 split(/\n  {\n/) 切 PERSONAS，
//    角色之间的注释块把块和 id 错位了，一半角色被误报成"没配字段"。
//    所以这个脚本最后会**自检一遍**：拿一个已知齐全的角色去验它自己。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const theme = read('src/theme.js');
const llm = read('src/llm.js');
const poses = read('src/anim/idlePoses.js');
const bgs = read('src/backgrounds.js');

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

// ---- 姿势 id（签名姿势必须是 tag:'idle' 的，否则她站着的时候根本看不到）----
const poseIds = new Set([...poses.matchAll(/id: '([a-z0-9-]+)'/g)].map((m) => m[1]));
const idlePoseIds = new Set(
  [...poses.matchAll(/id: '([a-z0-9-]+)',\s*\n\s*name: '[^']*',\s*\n\s*tag: 'idle'/g)].map((m) => m[1])
);

// ---- 背景 id ----
const bgIds = new Set([...bgs.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]));

// ---- 每个角色块 ----
const pStart = theme.indexOf('export const PERSONAS = [');
const pEnd = theme.indexOf('export const getPersona');
const personaBlock = theme.slice(pStart, pEnd);

// ★ 收集环节自己失效时，必须响 —— 不然下面照样打印"有缺口的 0 个"然后退出 0。
//   （SKILL 第 71 条：扫描式检查是"扫到什么对什么"，扫到 0 条时静默全绿。）
if (pStart < 0 || pEnd < 0) {
  console.log('✗ 在 src/theme.js 里定位不到 PERSONAS 块 —— 这个脚本没验到任何东西，别信它的结论。');
  process.exit(1);
}
if (personaIds.length === 0) {
  console.log('✗ 一个角色 id 都没扫到 —— 多半是上面那条正则跟不上新的 id 前缀了（' +
    'girlfriend / boyfriend / secretary / realistic-* / ff-* / vt-*）。');
  process.exit(1);
}

// ★ 交叉核对：PERSONAS 块里出现的每个 id 都必须被上面那条正则收到。
//   只靠"数量对不对"抓不到真正的失效方式 —— 加一个新前缀（比如 zz-foo）时，
//   那条正则会**整条漏掉**这个角色，于是它永远不会被核对，而数量看着也没变。
//   （大小写在这里是帮上忙的：bgId / poseId 里的 "Id" 是大写 I，不会被误收。）
const blockIds = [...personaBlock.matchAll(/\bid: '([a-z0-9-]+)'/g)].map((m) => m[1]);
const missed = [...new Set(blockIds)].filter((id) => !personaIds.includes(id));
if (missed.length) {
  console.log(`✗ PERSONAS 里有 ${missed.length} 个角色**根本没被核对到**：${missed.join('、')}`);
  console.log('    上面那条 id 正则漏了它们 —— 补进 tools/check-persona-coverage.mjs 的正则里。');
  process.exit(1);
}
// ⚠️ 别用 `split(/\n  \{\n/)` 去切（见文件头）。定位 `id: 'xxx'` 再切到下一个角色。
const byId = new Map();
for (const id of personaIds) {
  const at = personaBlock.indexOf(`id: '${id}'`);
  if (at < 0) continue;
  const next = personaBlock.indexOf('\n  {\n', at);
  byId.set(id, personaBlock.slice(at, next < 0 ? personaBlock.length : next));
}

// voice 六个槽位：戳一下 / 摸头 / 送礼 / 升级 / 低心情 / 待机
const VOICE_SLOTS = ['pet', 'poke', 'gift', 'levelUp', 'lowMood', 'idle'];

function voiceSlots(chunk) {
  const at = chunk.indexOf('\n    voice: {');
  if (at < 0) return [];
  const end = chunk.indexOf('\n    },', at);
  const block = chunk.slice(at, end < 0 ? chunk.length : end);
  return VOICE_SLOTS.filter((s) => new RegExp(`\\n      ${s}:\\s*\\[`).test(block));
}

const rows = [];
let bad = 0;
for (const id of personaIds) {
  const c = byId.get(id) || '';
  const row = { id };
  row.speech = speechKeys.has(id);
  row.script = scriptKeys.has(id);
  row.tagline = /\n    tagline:/.test(c);
  row.greet = /\n    greet:/.test(c);
  row.system = /\n    system:/.test(c);

  row.bgId = c.match(/\n    bgId:\s*'([a-z]+)'/)?.[1] || null;
  row.bgOk = row.bgId ? bgIds.has(row.bgId) : false;

  row.poseId = c.match(/\n    idlePose:\s*'([a-z0-9-]+)'/)?.[1] || null;
  row.poseOk = row.poseId ? idlePoseIds.has(row.poseId) : false;

  row.sampleN = (c.match(/\n    sample:\s*\[([^\]]*)\]/)?.[1] || '')
    .split(/',\s*'/).filter((s) => s.trim().length > 2).length;

  const vs = voiceSlots(c);
  row.voice = vs.length;

  row.ok = row.speech && row.script && row.tagline && row.greet && row.system
    && row.bgOk && row.poseOk && row.sampleN > 0 && row.voice === VOICE_SLOTS.length;
  if (!row.ok) bad += 1;
  rows.push(row);
}

const flag = (v) => (v ? ' ✓ ' : ' ✗ ');
const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('角色', 20), '音色 台词 人设 背景', pad('姿势', 17), '示例 台词组',
);
for (const r of rows) {
  console.log(
    pad(r.id, 20),
    flag(r.speech), flag(r.script), flag(r.tagline && r.greet && r.system),
    (r.bgOk ? ' ✓ ' : ' ✗ ') + pad(r.bgId ?? '—', 10),
    (r.poseOk ? ' ✓ ' : ' ✗ ') + pad(r.poseId ?? '—', 15),
    pad(String(r.sampleN), 3),
    pad(`${r.voice}/6`, 5),
    r.ok ? '' : '  ← 有缺口',
  );
}

// ---- 签名姿势是否重复 ----
const seen = new Map();
for (const r of rows) if (r.poseId) seen.set(r.poseId, (seen.get(r.poseId) || 0) + 1);
const dupes = [...seen.entries()].filter(([, n]) => n > 1);

console.log(`\n合计 ${rows.length} 个角色，有缺口的 ${bad} 个。`);
console.log(`SPEECH ${speechKeys.size} / SCRIPTS ${scriptKeys.size} / 姿势 ${poseIds.size}（其中 idle ${idlePoseIds.size}）/ 背景 ${bgIds.size}`);
if (dupes.length) {
  console.log(`\n⚠️ 签名姿势重复：${dupes.map(([k, n]) => `${k}×${n}`).join('、')}`);
} else if (bad === 0) {
  console.log('✓ 18 个角色的签名姿势互不重复。');
}

// ---- 自检：拿一个已知齐全的角色反向验证脚本没算错 ----
// 如果这里也报 ✗，那说明是脚本错了，不是数据错了 —— 先修脚本。
const probe = rows.find((r) => r.id === 'realistic-noa');
const probeOk = !!(probe && probe.ok);
console.log(
  `\n自检（realistic-noa 应当全绿）：${probeOk ? '✓ 脚本正常' : '✗ 脚本有问题，别信上面的结果'}`
);

// ★ 自检失败必须**影响退出码**。以前它只是打印一句「别信上面的结果」，
//   退出码照旧是 0 —— CI 上这一步照样绿，那句警告没人看得见。
//   打印了 ≠ 拦住了（SKILL 第 69 条「打印了 ≠ 留下来了」的近亲，坏在同一个地方）。
//   同理，rows 为空时 bad 也是 0，所以下面还多一道 rows.length 的闸。
process.exit(bad === 0 && !dupes.length && probeOk && rows.length > 0 ? 0 : 1);
