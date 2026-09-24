// vrm-inspect.mjs —— VRM 体检：能不能用，看这四项就够了
//   ① 有多少 **表情** blendshape（VRM 的 BlendShapeMaster preset）——决定会不会眨眼/对口型
//   ② 骨骼是不是标准 humanoid —— 决定 idle 动作能不能直接接上
//   ③ 网格/贴图规模 —— 决定手机上跑不跑得动、打包多大
//   ④ 文件内嵌的授权信息 —— 决定能不能放进公开 Web 包
// 用法: node tools/vrm-inspect.mjs <file.vrm 或目录>
import fs from 'node:fs';
import path from 'node:path';

function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB/VRM');
  let off = 12, json = null, binLen = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    else if (type === 0x004e4942) binLen = len;
    off += 8 + len;
  }
  return { json, binLen };
}

const files = [];
const arg = process.argv[2];
if (!arg) { console.error('用法: node tools/vrm-inspect.mjs <file.vrm|目录>'); process.exit(1); }
if (fs.statSync(arg).isDirectory()) {
  (function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) w(p); else if (/\.(vrm|glb)$/i.test(e.name)) files.push(p);
    }
  })(arg);
} else files.push(arg);

for (const file of files) {
  console.log('\n════════════════════════════════════════════════════════');
  console.log(path.basename(file) + '   ' + (fs.statSync(file).size / 1048576).toFixed(2) + ' MB');
  const { json, binLen } = parseGlb(file);

  // ---- 规模 ----
  const totalVerts = json.meshes.reduce((s, m) => s + json.accessors[m.primitives[0].attributes.POSITION].count, 0);
  const texCount = (json.images || []).length;
  console.log(`网格 ${json.meshes.length} 个 / 顶点合计 ${totalVerts} / 材质 ${(json.materials || []).length} / 贴图 ${texCount} / BIN ${(binLen / 1048576).toFixed(1)}MB`);

  console.log('\n-- 网格明细 --');
  // ⚠️ 只看 mesh.extras.targetNames 会得出"morph 0"的假结论：
  //    targetNames 是 three.js 的**惯例**，VRM 未必写；真正的 morph 在 primitives[0].targets 里。
  //    表情能不能用看的是 targets 数量，以及 VRM blendShapeGroups 的 binds 指向哪个 index。
  for (const m of json.meshes) {
    const p = m.primitives[0];
    const tn = m.extras?.targetNames || [];
    const real = (p.targets || []).length;
    console.log(`  ${m.name.padEnd(22)} ${String(json.accessors[p.attributes.POSITION].count).padStart(6)} 点   targets ${String(real).padStart(2)}   targetNames ${tn.length ? '有' : '无'}`);
    if (tn.length) console.log(`      ${tn.join(' ')}`);
  }

  // ---- VRM 扩展 ----
  const vrm = json.extensions?.VRM;
  if (!vrm) { console.log('\n⚠️ 没有 VRM 扩展（可能已被转成纯 glTF，丢掉了表情定义）'); continue; }
  const meta = vrm.meta || {};
  console.log('\n-- VRM meta --');
  console.log(`  标题      ${meta.title || '-'}`);
  console.log(`  作者      ${meta.author || '-'}`);
  console.log(`  版本      ${vrm.specVersion || '0.x'}`);
  console.log(`  联系      ${meta.contactInformation || '-'}`);
  console.log(`  reference ${meta.reference || '-'}`);
  console.log(`  licenseUrl ${meta.licenseUrl || '-'}`);
  console.log(`  allowedUser ${meta.allowedUserName || '-'} / violent ${meta.violentUssageName || meta.violentUsageName || '-'} / sexual ${meta.sexualUssageName || meta.sexualUsageName || '-'}`);
  console.log(`  commercial ${meta.commercialUssageName || meta.commercialUsageName || '-'} / redistribute ${meta.redistributionProhibited === undefined ? '-' : meta.redistributionProhibited}`);
  console.log(`  modify(modification) ${meta.modificationProhibited === undefined ? '-' : meta.modificationProhibited}`);

  // ---- ★ 表情（最关键） ----
  const groups = vrm.blendShapeMaster?.blendShapeGroups || [];
  console.log(`\n-- 表情 group ${groups.length} 个 --`);
  const presets = [], customs = [];
  for (const g of groups) {
    const line = { preset: g.presetName, name: g.name, binds: (g.binds || []).length, kind: g.isBinary ? 'binary' : '0-1' };
    (g.presetName && g.presetName !== 'unknown' ? presets : customs).push(line);
  }
  console.log('  预设：' + (presets.length ? presets.map((p) => `${p.name}(${p.binds})`).join(' ') : '无'));
  console.log('  自定义：' + (customs.length ? customs.map((p) => `${p.name}(${p.binds})`).join(' ') : '无'));

  // binds 明细：运行时就是照这个表去写 morphTargetInfluences
  console.log('  -- 绑定明细（group → mesh[index] weight）--');
  for (const g of groups) {
    const b = (g.binds || []).map((x) => `${json.meshes[x.mesh]?.name ?? '?'}[${x.index}]${(x.weight / 100).toFixed(2)}`).join(' + ');
    console.log(`     ${String(g.name).padEnd(10)} (${g.presetName || 'custom'}) ${b || '（空）'}`);
  }

  // 眨眼/口型有没有
  const need = ['blink', 'blink_l', 'blink_r', 'a', 'i', 'u', 'e', 'o', 'joy', 'angry', 'sorrow', 'fun'];
  const have = new Set(groups.map((g) => g.presetName).filter((n) => n && n !== 'unknown'));
  const miss = need.filter((n) => !have.has(n));
  console.log('  关键通道缺失：' + (miss.length ? miss.join(' ') : '无 ✅'));

  // ---- 骨骼 ----
  const hb = vrm.humanoid?.humanBones || [];
  console.log(`\n-- humanoid 骨 ${hb.length} 根 --`);
  console.log('  ' + hb.map((b) => b.bone.replace(/\s/g, '')).join(' '));
  const req = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const haveB = new Set(hb.map((b) => b.bone));
  const missB = req.filter((n) => !haveB.has(n));
  console.log('  缺骨架：' + (missB.length ? missB.join(' ') : '无 ✅'));
}
