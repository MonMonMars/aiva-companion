#!/usr/bin/env node
/**
 * 生成可发布的预览站：preview-site/
 *
 *   index.html      落地页（角色一览 + 下载链接）
 *   compare.html    3D A/B 对比器（左右两视口，可下拉切换全部角色）
 *   characters.html 离线三视图对照表
 *   models/*.glb    11 个角色的模型本体
 *   models/*.morph.json  表情（morph）侧车文件
 *
 * 为什么要有这个生成器：角色数字（三角面数、文件体积）如果手写进 index.html，
 * 每次改模型就会过期 —— 而"低模"正是 Hikari 的卖点，数字错了等于白说。
 * 所以三角面数从 GLB 里现读，角色名单从 compare-page.mjs 的 ROSTER 现解析。
 *
 * ⚠️ 输出目录必须放在 assets/ 外面：Expo 的 assetBundlePatterns 默认收 assets 下所有文件，
 *    把这 25MB 的副本塞进去会把 App 包体撑大一倍。
 *    （顺带提醒：注释里别照抄 glob 通配符，星号紧跟斜杠那两个字符会把块注释提前闭合。）
 *
 * 用法：node tools/make-preview-site.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS = path.join(ROOT, 'assets/models2');
const PREVIEW = path.join(ROOT, 'assets/preview');
const SHEETS = path.join(PREVIEW, 'sheets');
const OUT = path.join(ROOT, 'preview-site');

// --- 角色名单：从 compare-page.mjs 里现解析，不复制一份 -----------------------
//    复制一份的话，加角色时改了那边忘了这边，落地页就会漏人。
const ROSTER = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/compare-page.mjs'), 'utf8');
  const i = src.indexOf('const ROSTER = [');
  if (i < 0) throw new Error('compare-page.mjs 里找不到 ROSTER');
  const j = src.indexOf('\n];', i);
  return new Function('return ' + src.slice(i + 'const ROSTER = '.length, j + 2))();
})();

// --- 几何数字：全部从 GLB 现量，一个都不手写 ----------------------------------
//
// ⚠️ 以前只现读了三角面数，身高/头身比仍信任 ROSTER 里手写的 h / heads，
//    结果 Bryce 写着 1.83m、实测 1.887m，Rion 写着 1.83m、实测 1.853m ——
//    落地页和体检工具报出两套数，谁看谁糊涂。
//    所以这里连身高一起现量，并且跟 ROSTER 对账，偏差超阈值就当场报警。
function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  let off = 12, json = null;
  while (off < buf.readUInt32LE(8)) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return json;
}

function triCount(file) {
  const json = readGlbJson(file);
  const prim = json.meshes[0].primitives[0];
  const acc = prim.indices != null ? json.accessors[prim.indices] : json.accessors[prim.attributes.POSITION];
  return Math.round(acc.count / 3);
}

/**
 * 量身高 / 头身比 / 三角面。
 * 身高取网格 POSITION 的 min/max Y（就是体检工具的口径）；
 * 头长 = Head → HeadTop_End 的**世界** Y 差（骨骼平移要沿父链累加，
 * 直接读 node.translation 会漏掉父级偏移）。
 */
function glbStats(file) {
  const json = readGlbJson(file);
  const prim = json.meshes[0].primitives[0];
  const accP = json.accessors[prim.attributes.POSITION];
  const height = accP.max[1] - accP.min[1];
  const accI = prim.indices != null ? json.accessors[prim.indices] : accP;
  const tris = Math.round(accI.count / 3);

  const byName = new Map(json.nodes.map((n, i) => [n.name, i]));
  const parentOf = new Map();
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));

  const memo = new Map();
  const worldY = (i) => {
    if (memo.has(i)) return memo.get(i);
    const n = json.nodes[i];
    let y = n.matrix ? n.matrix[13] : (n.translation ? n.translation[1] : 0);
    const p = parentOf.get(i);
    if (p != null) y += worldY(p);
    memo.set(i, y);
    return y;
  };

  let heads = null;
  const hi = byName.get('Head');
  const ti = byName.get('HeadTop_End');
  if (hi != null && ti != null) {
    const headLen = worldY(ti) - worldY(hi);
    if (headLen > 1e-4) heads = height / headLen;
  }
  return { height, tris, heads };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });

fs.copyFileSync(path.join(PREVIEW, 'compare.html'), path.join(OUT, 'compare.html'));
// ⚠️ characters.html **不再从 assets/preview 拷贝**：那边是手写的文件，
//    上次就是它停留在 6 个角色 + 过期数字（Elena 写 1.73m/7.61 头身，实测 1.710/8.05），
//    而 index.html 早就 11 个角色了 —— 两个页面互相打脸。
//    现在改成在这下面生成，跟 index.html 共用同一份 ROSTER + 同一批现量数字。

// 三视图 JPG 由 tools/shot-sheet.mjs 生成；没跑过就不硬塞一个死链进落地页。
const hasSheets = fs.existsSync(SHEETS) && fs.readdirSync(SHEETS).some((f) => f.endsWith('.jpg'));
if (hasSheets) {
  fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });
  for (const f of fs.readdirSync(SHEETS).filter((x) => x.endsWith('.jpg'))) {
    fs.copyFileSync(path.join(SHEETS, f), path.join(OUT, 'sheets', f));
  }
}

const drift = [];
const rows = ROSTER.map((r) => {
  const glb = path.join(MODELS, r.file + '.glb');
  const morph = path.join(MODELS, r.file + '.morph.json');
  const st = glbStats(glb);
  fs.copyFileSync(glb, path.join(OUT, 'models', r.file + '.glb'));
  fs.copyFileSync(morph, path.join(OUT, 'models', r.file + '.morph.json'));

  // 以现量的为准；跟 ROSTER 手写值差太多就记一笔，最后一起报出来。
  if (st.heads != null && Math.abs(r.heads - st.heads) > 0.05) {
    drift.push(`${r.name} 头身：ROSTER 写 ${r.heads}，GLB 实测 ${st.heads.toFixed(2)}`);
  }
  if (Math.abs(r.h - st.height) > 0.02) {
    drift.push(`${r.name} 身高：ROSTER 写 ${r.h}，GLB 实测 ${st.height.toFixed(3)}`);
  }

  return {
    ...r,
    tris: st.tris,
    h: st.height,
    heads: st.heads ?? r.heads,
    kb: Math.round(fs.statSync(glb).size / 1024),
    mb: +(fs.statSync(glb).size / 1048576).toFixed(2),
  };
});

const n = (x) => x.toLocaleString('en-US');
const tr = rows.map((r) => `      <tr class="${r.tier === 'FF' ? 'ff' : r.tier === 'VTuber' ? 'vt' : ''}">
        <td><b>${r.name}</b></td>
        <td><span class="tag ${r.tier === 'FF' ? 'ff' : r.tier === 'VTuber' ? 'vt' : ''}">${r.tier}</span></td>
        <td>${r.role}</td>
        <td class="num">${r.h.toFixed(2)}</td>
        <td class="num">${r.heads.toFixed(2)}</td>
        <td class="num">${n(r.tris)}</td>
        <td>${r.note}</td>
        <td class="dl"><a href="models/${r.file}.glb">glb ${r.mb}M</a>
            <a href="models/${r.file}.morph.json">morph</a>${hasSheets ? `
            <a href="sheets/${r.file}-sheet.jpg">三视图</a>` : ''}</td>
      </tr>`).join('\n');

const totalMb = +(rows.reduce((s, r) => s + r.mb, 0)).toFixed(1);

const gallery = hasSheets ? `
<h2>三视图（正 / 侧 / 背）</h2>
<div class="gal">
${rows.map((r) => `  <figure><img src="sheets/${r.file}-sheet.jpg" loading="lazy" alt="${r.name} 三视图">
    <figcaption><b>${r.name}</b> · ${r.role} · ${r.tier} 档</figcaption></figure>`).join('\n')}
</div>` : '';

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>角色设计一览 — 3D 伴侣角色库</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 26px 56px; background:#faf8f5; color:#33282f;
         font:14px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { margin:0 0 6px; font-size:22px; letter-spacing:.02em; }
  .sub { color:#8a7f77; margin-bottom:26px; }
  .cards { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:30px; }
  .card { flex:1 1 260px; padding:18px 20px; background:#fff; border:1px solid #e8e2da;
          border-radius:12px; text-decoration:none; color:inherit; }
  .card:hover { border-color:#c9bfb4; }
  .card b { display:block; font-size:15px; margin-bottom:4px; }
  .card span { color:#8a7f77; font-size:13px; }
  table { width:100%; border-collapse:collapse; background:#fff;
          border:1px solid #e8e2da; border-radius:12px; overflow:hidden; }
  th, td { padding:9px 12px; text-align:left; border-bottom:1px solid #f0ece6; }
  th { background:#f5f1eb; font-weight:600; font-size:13px; color:#6b6058; }
  tr:last-child td { border-bottom:none; }
  tr.ff { background:#fbf7fb; } tr.vt { background:#f4fbfb; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .tag { display:inline-block; padding:1px 8px; border-radius:9px; font-size:12px;
         background:#efeae3; color:#6b6058; }
  .tag.ff { background:#efe6f5; color:#7a4fa3; }
  .tag.vt { background:#e2f2f2; color:#1f7f86; }
  .dl a { display:inline-block; margin-right:8px; font-size:12px; color:#2f6f9f;
          text-decoration:none; border-bottom:1px solid #cfe0ec; }
  .dl a:hover { border-bottom-color:#2f6f9f; }
  .foot { margin-top:26px; color:#8a7f77; font-size:13px; }
  h2 { margin:34px 0 12px; font-size:16px; }
  .gal figure { margin:0 0 22px; }
  .gal img { width:100%; border:1px solid #e8e2da; border-radius:10px; display:block; }
  .gal figcaption { margin-top:6px; font-size:13px; color:#8a7f77; }
</style>
</head>
<body>
<h1>角色设计一览</h1>
<div class="sub">${rows.length} 个原创 3D 角色 · 三档风格 · 全部程序化生成，无外部素材</div>

<div class="cards">
  <a class="card" href="compare.html"><b>3D A/B 对比器</b>
    <span>左右双视口，实时切换任意两个角色，可拖旋转 / 滚轮缩放 / 切全身·半身·大头</span></a>
  <a class="card" href="characters.html"><b>三视图对照表</b>
    <span>正 / 侧 / 背 三个角度的离线渲染，看轮廓和发型的剪影（${rows.length} 个角色全在）</span></a>
</div>

<table>
  <thead><tr>
    <th>角色</th><th>档位</th><th>定位</th><th class="num">身高 m</th>
    <th class="num">头身</th><th class="num">三角面</th><th>特征</th><th>下载</th>
  </tr></thead>
  <tbody>
${tr}
  </tbody>
</table>

${gallery}
<div class="foot">
  模型合计 ${totalMb} MB（含 morph 侧车文件）·
  骨骼 23 根（Mixamo 命名，可直接重定向）· 表情 24 个 ARKit 混合形状 ·
  GLB 顶点色按部位分区，可直接当材质 ID 用。
</div>
</body>
</html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);

/* ------------------------------------------------------------------ *
 * characters.html —— 三视图对照表（本文件生成，不再手工维护）
 * ------------------------------------------------------------------ */

/** 全部 mesh 的三角面之和。VRM 那种 16 个 mesh 的模型要用它，meshes[0] 只是其中一块。 */
function totalTris(file) {
  const json = readGlbJson(file);
  let n = 0;
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      const a = p.indices != null ? json.accessors[p.indices] : json.accessors[p.attributes.POSITION];
      n += a.count / 3;
    }
  }
  return Math.round(n);
}

const KIZUNA = path.join(MODELS, 'kizuna-kamatte.glb');
const kizuna = fs.existsSync(KIZUNA)
  ? { tris: totalTris(KIZUNA), mb: +(fs.statSync(KIZUNA).size / 1048576).toFixed(2) }
  : null;

const cards = rows.map((r) => `  <div class="card">
    <h2>${r.name} · ${r.role}</h2>
    <div class="meta"><span class="tag ${r.tier === 'FF' ? 'ff' : r.tier === 'VTuber' ? 'vt' : ''}">${r.tier}</span>
      ${r.h.toFixed(2)}m · ${r.heads.toFixed(2)} 头身 · ${n(r.tris)} 面 · ${r.mb}M</div>
    <a href="sheets/${r.file}-sheet.jpg"><img src="sheets/${r.file}-sheet.jpg" loading="lazy"
      alt="${r.name} 三视图：正面 / 侧面 / 背面"></a>
    <div class="feat">${r.note}</div>
  </div>`).join('\n\n');

const dataRows = rows.map((r) => `  <tr class="${r.tier === 'FF' ? 'ff' : r.tier === 'VTuber' ? 'vt' : ''}">
    <td><b>${r.name}</b></td><td>${r.tier}</td><td>${r.role}</td>
    <td class="num">${r.h.toFixed(3)}</td><td class="num">${r.heads.toFixed(2)}</td>
    <td class="num">${n(r.tris)}</td><td class="num">${r.mb}</td><td>${r.note}</td></tr>`).join('\n');

const charsHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>三视图对照表 — 3D 伴侣角色库</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:30px 26px 60px; background:#faf8f5; color:#33282f;
         font:14px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:.02em; }
  .sub { font-size:13px; color:#8a7f77; margin-bottom:26px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:18px; }
  .card { background:#fff; border:1px solid #e8e2da; border-radius:14px; padding:14px; }
  .card h2 { font-size:15px; margin:0 0 6px; }
  .card .meta { font-size:12px; color:#8a7f77; margin-bottom:10px; }
  .card img { width:100%; display:block; border:1px solid #ece7e0; border-radius:10px;
              background:#f2efe9; }
  .card .feat { font-size:12px; color:#6b6058; margin-top:9px; }
  .tag { display:inline-block; padding:1px 8px; border-radius:9px; font-size:12px;
         background:#efeae3; color:#6b6058; margin-right:6px; }
  .tag.ff { background:#efe6f5; color:#7a4fa3; }
  .tag.vt { background:#e2f2f2; color:#1f7f86; }
  table { width:100%; border-collapse:collapse; background:#fff; margin-top:32px;
          border:1px solid #e8e2da; border-radius:12px; overflow:hidden; font-size:13px; }
  th, td { padding:8px 12px; text-align:left; border-bottom:1px solid #f0ece6; }
  th { background:#f5f1eb; font-weight:600; font-size:12px; color:#6b6058; }
  tr:last-child td { border-bottom:none; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  h2.sec { margin:38px 0 12px; font-size:16px; }
  .note { background:#fff8f2; border:1px solid #f0dfcd; border-radius:12px;
          padding:14px 18px; font-size:13px; color:#6b5847; }
  .note b { color:#33282f; }
  .foot { margin-top:24px; color:#8a7f77; font-size:13px; }
  a.back { color:#2f6f9f; text-decoration:none; }
</style>
</head>
<body>

<h1>三视图对照表</h1>
<div class="sub">
  ${rows.length} 个原创角色，每个一张「正 / 侧 / 背」三视图 JPG（由 <code>tools/shot-sheet.mjs</code> 离线渲染）。<br>
  身高与头身比由 <code>tools/make-preview-site.mjs</code> 从 GLB <b>现量</b>，不是手写的 —— 加角色或改模型后重跑本工具即可同步。<br>
  <a class="back" href="index.html">← 返回角色一览</a>
</div>

<div class="grid">
${cards}
</div>

<h2 class="sec">体检数据</h2>
<table>
  <thead><tr>
    <th>角色</th><th>档位</th><th>定位</th><th class="num">身高 m</th>
    <th class="num">头身比</th><th class="num">三角面</th><th class="num">GLB MB</th><th>特征</th>
  </tr></thead>
  <tbody>
${dataRows}
  </tbody>
</table>

${kizuna ? `
<h2 class="sec">App 内当前在用的模型（不提供下载）</h2>
<div class="note">
  <b>Kizuna AI 官方免费 VRM 1.0</b> · ${kizuna.tris.toLocaleString('en-US')} 三角面 · ${kizuna.mb} MB ·
  52 个 ARKit 混合形状 · VRM 人形骨 13/13 全映射。<br><br>
  自造模型观感未达标期间，App 里暂时用它顶上。它<b>不在这张三视图表里</b>，因为
  三视图渲染器只读 meshes[0]，而它有 16 个 mesh（身体 / 头发 / 衣服各一块）——
  渲出来只会是身体的一部分。<br><br>
  <b>许可限制（VRM 1.0，必须遵守）</b>：<code>allowRedistribution: false</code>（禁止再分发）、
  <code>commercialUsage: personalNonProfit</code>（个人非商用）、
  <code>avatarPermission: onlyAuthor</code>。<br>
  所以页面上<b>不放模型、不放渲染图</b>，也不进任何公开分享链接 / CDN / 应用商店包体。
  个人本地自用没问题。
</div>` : ''}

<div class="foot">
  <b>指标含义</b><br>
  · <b>身高</b> = 网格 POSITION 的 maxY − minY，与 <code>tools/inspect-character.mjs</code> 同一口径<br>
  · <b>头身比</b> = 身高 ÷ 头长，头长取 Head→HeadTop_End 的<b>世界</b> Y 差（骨骼平移沿父链累加）<br>
  · <b>合格带</b>：写实成人档 6.8~8.6；Hikari 是 VTuber 动漫档，刻意 6.86，单列 6.0~7.2<br>
  · <b>三角面</b> = meshes[0] 的主 primitive（自造模型只有一个 mesh）
</div>
</body>
</html>`;

fs.writeFileSync(path.join(OUT, 'characters.html'), charsHtml);

const sz = (p) => +(fs.statSync(p).size / 1048576).toFixed(2);
console.log('✓ preview-site/ 已生成');

// ROSTER 里的 h / heads 是手写的，只是**展示用的初值**；真正进页面的是现量值。
// 两边差太多说明有人改了模型却没改名单 —— 报出来，别让它悄悄漂。
if (drift.length) {
  console.log('\n⚠️ ROSTER 手写值与 GLB 实测不一致（页面已用实测值，但名单该更新了）：');
  for (const d of drift) console.log('    ' + d);
  console.log('    → 改 tools/compare-page.mjs 的 ROSTER');
}
console.log('    index.html      ' + sz(path.join(OUT, 'index.html')) + ' MB');
console.log('    compare.html    ' + sz(path.join(OUT, 'compare.html')) + ' MB');
console.log('    characters.html ' + sz(path.join(OUT, 'characters.html')) + ' MB');
console.log('    models/         ' + totalMb + ' MB（' + rows.length + ' 个角色）');
