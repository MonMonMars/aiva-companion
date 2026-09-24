/**
 * 端到端验证「读 glb → 解析 → 挂载 → jpg 解码 → DataTexture」整条管线。
 *
 * 为什么需要它：ui 上的截图看不出模型挂没挂上（挂上了也可能只是个白模），
 * 而这里全用数值断言 —— 包围盒、材质、贴图尺寸都能被打出来。
 *
 * 用法： node tools/pipeline.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import jpeg from 'jpeg-js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'assets', 'models');

// companion.js 只 import 了 three（没有任何 RN / DOM 依赖），
// 所以直接复制成 .mjs 就能在 Node 里跑，不用 Metro 打包。
//
// ⚠️ 这里**按 import 图自动递归**复制，不要写死文件清单：
//    以前是手列的（companion / rigDriver / rigStandard / morphData / lipSync /
//    faceStandard），每加一个新模块就漏一个，然后报
//    "Cannot find module ... .tmp-rig/anim/xxx.mjs"，而且看不出到底少了谁。
const tmpDir = path.join(root, 'tools', '.tmp-rig');
const srcRoot = path.join(root, 'src');
const outPathFor = (srcAbs) =>
  path.join(tmpDir, path.relative(srcRoot, srcAbs).replace(/\.js$/, '.mjs'));

const seen = new Set();
function copyTree(entryAbs) {
  const queue = [entryAbs];
  while (queue.length) {
    const srcAbs = queue.shift();
    if (seen.has(srcAbs)) continue;
    seen.add(srcAbs);
    // 改后缀的同时把相对 import 也改成 .mjs
    const src = fs.readFileSync(srcAbs, 'utf8')
      .replace(/from '(\.[^']*)'/g, (m, rel) => (rel.endsWith('.mjs') ? m : `from '${rel}.mjs'`));
    const outP = outPathFor(srcAbs);
    fs.mkdirSync(path.dirname(outP), { recursive: true });
    fs.writeFileSync(outP, src);
    // 顺着相对 import 继续爬
    for (const m of src.matchAll(/from '(\.[^']*)'/g)) {
      const depAbs = path.resolve(path.dirname(srcAbs), m[1].replace(/\.mjs$/, '.js'));
      if (fs.existsSync(depAbs)) queue.push(depAbs);
    }
  }
}
copyTree(path.join(srcRoot, 'three', 'companion.js'));
const tmp = path.join(tmpDir, 'three', 'companion.mjs');
const { createCompanionScene } = await import('file://' + tmp.replace(/\\/g, '/'));
const { textToVisemes, sampleViseme, visemesDuration, EMOTION_FACE } =
  await import('file://' + path.join(tmpDir, 'anim', 'lipSync.mjs').replace(/\\/g, '/'));

const PERSONA = {
  avatar: { skin: '#FFE0CF', style: 'twin-tail', hair: '#F0A6CA', top: '#FFFFFF', bottom: '#3B3B5C', eyes: '#3A2A3A', blush: '#FF9FB2' },
  colors: { primary: '#FF7FB0', soft: '#FFD6E7' },
};

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function decodeToTexture(bytes) {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxMemoryUsageInMB: 96 });
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

for (const id of ['girlfriend', 'boyfriend', 'secretary']) {
  console.log(`\n=== ${id} ===`);
  // 用 .rigged.glb —— 运行时引用的就是它（见 src/lib/companionModel.js）
  const glb = fs.readFileSync(path.join(modelsDir, `${id}.rigged.glb`));
  const jpg = fs.readFileSync(path.join(modelsDir, `${id}.jpg`));

  const comp = createCompanionScene(PERSONA);

  // 1. 解析 glb
  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().parse(toArrayBuffer(glb), '', res, rej)
  );
  check(!!gltf.scene, 'GLB 解析成功');

  // 2. 挂载（缩放 + 落地 + 材质替换）
  const ok = comp.attachModel(gltf.scene);
  check(ok, 'attachModel 返回 true');
  check(comp.isUsingModel(), 'isUsingModel() === true');

  const box = new THREE.Box3().setFromObject(comp.root);
  const size = box.getSize(new THREE.Vector3());
  check(
    Math.abs(size.y - 2.05) < 0.02,
    `统一缩放到 targetHeight=2.05`,
    `实际 ${size.y.toFixed(3)}`
  );
  check(
    Math.abs(box.min.y) < 0.01,
    '双脚落在 y=0 平面（不会浮空也不会陷地）',
    `min.y=${box.min.y.toFixed(4)}`
  );
  check(size.x < 2.05 && size.z < 2.05, '水平尺寸没爆炸', `x=${size.x.toFixed(2)} z=${size.z.toFixed(2)}`);

  // 3. 材质：模型没有顶点色，必须靠贴图，所以要确认 texture 位是空的 + side 被继承
  let mesh = null;
  comp.root.traverse((o) => { if (o.isMesh && !mesh && o.geometry.attributes.position.count > 5000) mesh = o; });
  check(!!mesh, '找到主体 mesh');
  check(mesh?.material?.isMeshToonMaterial === true, '材质被替换成 MeshToonMaterial（赛璐璐）');
  check(mesh?.material?.side === THREE.DoubleSide, '继承 doubleSided，薄面不穿帮');
  check(!mesh?.material?.map, '挂载前确实没有贴图（所以贴图步骤不是可选的）');

  // 4. jpg → DataTexture → applyTexture
  const tex = decodeToTexture(jpg);
  check(tex.image.width === 1024 && tex.image.height === 1024, '贴图解码为 1024²', `${tex.image.width}x${tex.image.height}`);
  check(comp.applyTexture(tex), 'applyTexture 返回 true');
  check(mesh.material.map === tex, '材质的 map 指向这张贴图');
  check(mesh.material.color.getHex() === 0xffffff, 'color 被刷成白色（不然贴图会被染色）');

  // 5. 骨架 (rig)：这是"真模型能不能动"的核心
  check(comp.hasRig(), '识别出骨架，rig 已接管');
  const rig = comp.getRig();
  if (rig) {
    // 核心骨必须齐 —— 缺关键的就没法做人体动作
    check(
      rig.coverage.ratio >= 0.8,
      `核心骨覆盖 ${rig.coverage.have.length}/${rig.coverage.have.length + rig.coverage.missing.length}`,
      rig.coverage.missing.length ? '缺: ' + rig.coverage.missing.join(',') : ''
    );
    check(rig.has('Head') && rig.has('Neck'), '找到 Head / Neck');
    check(rig.has('LeftArm') && rig.has('RightArm'), '找到左右上臂');
    check(rig.has('LeftForeArm') && rig.has('RightForeArm'), '找到左右前臂');
    check(rig.has('LeftUpLeg') && rig.has('RightUpLeg'), '找到左右大腿');

    // 真的转一下，测出顶点位移 —— 光看"骨头存在"是不够的
    const sk = [];
    comp.root.traverse((o) => { if (o.isSkinnedMesh) sk.push(o); });
    check(sk.length > 0, '存在 SkinnedMesh');

    if (sk.length) {
      const m = sk[0];
      const geo = m.geometry;
      // 找出 Head 骨拥有的顶点
      const headIdx = rig.mapping.Head ? sk[0].skeleton.bones.indexOf(rig.mapping.Head) : -1;
      const sampleIdx = [];
      if (headIdx >= 0) {
        const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
        for (let i = 0; i < geo.attributes.position.count && sampleIdx.length < 20; i++) {
          for (let k = 0; k < 4; k++) {
            if (si.getComponent(i, k) === headIdx && sw.getComponent(i, k) > 0.5) { sampleIdx.push(i); break; }
          }
        }
      }
      check(sampleIdx.length > 0, 'Head 骨确实拥有一批顶点', `${sampleIdx.length} 个采样点`);

      if (sampleIdx.length) {
        const read = () => {
          // 两个 update 都不能少：
          //   skeleton.update() 刷 boneMatrices（applyBoneTransform 用的就是它）
          //   updateMatrixWorld() 刷骨骼的世界矩阵
          // 少了后者，boneMatrices 全是旧的，测出来位移永远是 0（踩过）。
          m.skeleton.update();
          comp.root.updateMatrixWorld(true);
          return sampleIdx.map((i) => {
            const v = new THREE.Vector3().fromBufferAttribute(geo.attributes.position, i);
            m.applyBoneTransform(i, v);
            return v.clone();
          });
        };
        const before = read();
        // 走真实的动画路径：先给个明显的视线目标 + 触发被摸，
        // 再推进若干帧让阻尼收敛。只推进时间不动输入的话，
        // 靠 sin(t) 驱动的幅度太小，测出来会接近 0（第一版测试就栽在这里）。
        comp.setLookTarget(1, 0.4);
        comp.react('pet');
        for (let i = 0; i < 90; i++) comp.update(1 + i * 0.016, 0.016);
        const after = read();
        let maxD = 0;
        for (let i = 0; i < before.length; i++) maxD = Math.max(maxD, before[i].distanceTo(after[i]));
        check(maxD > 0.01, '动画真的驱动了头部顶点（不是摆设）', `最大位移 ${maxD.toFixed(4)}m`);
      }
    }
  }

  // 6. 表情 / 口型：morph 数据灌进 geometry.morphAttributes
  const morphJson = JSON.parse(fs.readFileSync(path.join(modelsDir, `${id}.morph.json`), 'utf8'));
  check(
    Array.isArray(morphJson.shapes) && morphJson.shapes.length >= 20,
    `morph.json 含 ${morphJson.shapes?.length} 个 ARKit 形状`
  );

  const handle = comp.applyMorph(morphJson);
  check(!!handle, 'applyMorph 接上了 morph');
  check(comp.hasFace(), '口型驱动已就绪（hasFace）');

  if (handle) {
    // 稀疏表要真被摊平成"整网格等长"的 morph 属性 —— 这是 three.js 的硬要求
    const sk2 = [];
    comp.root.traverse((o) => { if (o.isMesh && o.geometry?.morphAttributes?.position?.length) sk2.push(o); });
    check(sk2.length > 0, '有网格拿到了 morphAttributes.position');

    if (sk2.length) {
      const mm = sk2[0];
      const g = mm.geometry;
      const posLen = g.attributes.position.count * 3;
      const attrs = g.morphAttributes.position;
      check(
        attrs.every((a) => a.array.length === posLen),
        '每个 morph 属性的长度 === 顶点总数（稀疏已摊平）',
        `${attrs.length} 个 × ${posLen}`
      );
      check(g.morphTargetsRelative === true, 'morphTargetsRelative=true（存的是位移量）');
      check(
        mm.morphTargetInfluences.length === attrs.length,
        'influences 数量与属性数量一致',
        `${mm.morphTargetInfluences.length}`
      );

      // 决定性断言：把 jawOpen 拉满，**顶点必须真的移动**
      // 这里不能用 localToWorld —— 它不应用 morph。要对 position 加上
      // morph 位移自己算（three 的 applyBoneTransform 也只管骨骼，不管 morph）。
      const jawIdx = mm.morphTargetDictionary?.jawOpen;
      check(jawIdx !== undefined, 'jawOpen 在 morphTargetDictionary 里');

      if (jawIdx !== undefined) {
        const readMorph = () => {
          const base = g.attributes.position.array;
          const d = attrs[jawIdx].array;
          const out = [];
          // 采样：只看有位移的顶点
          for (let i = 0; i < g.attributes.position.count && out.length < 20; i++) {
            const o = i * 3;
            if (d[o] || d[o + 1] || d[o + 2]) {
              out.push(new THREE.Vector3(base[o] + d[o], base[o + 1] + d[o + 1], base[o + 2] + d[o + 2]));
            }
          }
          return out;
        };
        const zone = readMorph();
        check(zone.length > 0, 'jawOpen 确实作用在一批顶点上', `${zone.length} 个采样点`);

        // 权重为 0 时顶点应在 base 位置，为 1 时应偏移
        const w0 = mm.morphTargetInfluences[jawIdx];
        check(w0 === 0, '初始权重为 0');
        comp.getFace().setEmotion(null);
        handle.setInfluence('jawOpen', 1);
        check(mm.morphTargetInfluences[jawIdx] === 1, 'setInfluence 生效');
        // 位移量直接量出来：全 1 权重下的位移 = delta 本身
        let maxD = 0;
        const base = g.attributes.position.array;
        const d = attrs[jawIdx].array;
        for (let i = 0; i < g.attributes.position.count; i++) {
          const o = i * 3;
          const len = Math.hypot(d[o], d[o + 1], d[o + 2]);
          if (len > maxD) maxD = len;
        }
        check(maxD > 0.005, 'jawOpen 满权重时顶点位移可观', `最大 ${(maxD * 1000).toFixed(1)}mm`);
        handle.setInfluence('jawOpen', 0);
      }
    }

    // 7. 口型链路：文本 → 帧 → 采样，全程纯函数，不依赖任何 API key
    const frames = textToVisemes('你好呀，今天过得怎么样？', { speed: 1 });
    check(frames.length > 5, '中文句子排出了口型帧', `${frames.length} 帧`);
    check(visemesDuration(frames) > 0.8, '口型时长合理', `${visemesDuration(frames).toFixed(2)}s`);
    check(
      frames.every((f) => f.at >= 0 && f.dur > 0),
      '每帧的时间/时长都合法'
    );

    const mid = sampleViseme(frames, visemesDuration(frames) * 0.5);
    check(Object.keys(mid).length > 0, '中途能采样到口型', Object.keys(mid).join(','));
    check(
      Object.values(mid).every((v) => v >= 0 && v <= 1),
      '口型权重都在 0~1（超过 1 嘴会炸开）'
    );

    const en = textToVisemes('Hello, how are you doing today?', { speed: 1 });
    check(en.length > 5, '英文句子也能排出口型帧', `${en.length} 帧`);

    // 快语速必须更短 —— 否则口型会和声音错位
    const slow = visemesDuration(textToVisemes('这是一句用来测语速的话', { speed: 1 }));
    const fast = visemesDuration(textToVisemes('这是一句用来测语速的话', { speed: 1.5 }));
    check(fast < slow, '语速 1.5 时口型时长变短（对得上 TTS speed）', `${slow.toFixed(2)}s → ${fast.toFixed(2)}s`);

    // 说话时嘴真的在动：speak → 推进时间 → morph 权重非 0
    // 注意：不能只看 traverse 到的第一个 mesh —— morph 挂在哪个网格由
    // meshIdx 决定，得从 handle.lookup 里拿真正被驱动的那个。
    const drivenMesh = handle.lookup.jawOpen?.mesh;
    check(!!drivenMesh, 'jawOpen 找到了它所在的网格');

    comp.speak('你好，我叫小满', { emotion: 'gentle' });
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      comp.update(10 + i * 0.016, 0.016);
      const inf = drivenMesh?.morphTargetInfluences || [];
      for (const v of inf) if (v > peak) peak = v;
    }
    check(peak > 0.05, 'speak 之后有 morph 权重被推动（嘴真的在动）', `峰值 ${peak.toFixed(3)}`);

    // 说话时必须张嘴：jawOpen 或 mouthClose 至少一个在表里
    const jawI = drivenMesh?.morphTargetDictionary?.jawOpen;
    const closedI = drivenMesh?.morphTargetDictionary?.mouthClose;
    check(jawI !== undefined || closedI !== undefined, '嘴部形状在驱动表里');

    // 说完/打断后必须闭嘴
    comp.stopSpeaking();
    for (let i = 0; i < 60; i++) comp.update(20 + i * 0.016, 0.016);
    const infAfter = drivenMesh?.morphTargetInfluences || [];
    const maxAfter = infAfter.length ? Math.max(...infAfter) : 0;
    check(maxAfter < 0.35, 'stopSpeaking 后嘴部权重回落到静止', `残量 ${maxAfter.toFixed(3)}`);

    // 情绪表要覆盖 TTS 的全部标签，否则某些情绪会没有表情
    check(Object.keys(EMOTION_FACE).length >= 15, `表情表覆盖 ${Object.keys(EMOTION_FACE).length} 种情绪`);
  }

  // 8. update/react 全流程不报错
  let threw = null;
  try {
    for (let i = 0; i < 30; i++) comp.update(i * 0.016, 0.016);
    comp.react('pet');
    for (let i = 0; i < 30; i++) comp.update(0.5 + i * 0.016, 0.016);
    comp.react('poke');
    comp.react('gift');
    comp.react('levelup');
    for (let i = 0; i < 30; i++) comp.update(2 + i * 0.016, 0.016);
  } catch (e) {
    threw = e;
  }
  check(!threw, '换成真模型后 update/react 不报错', threw ? threw.message : '');

  comp.dispose();

  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log(`  体积：rigged.glb ${kb(glb.length)} + jpg ${kb(jpg.length)} + morph ${kb(morphJson ? fs.statSync(path.join(modelsDir, `${id}.morph.json`)).size : 0)}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过 ✓' : `\n失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
