// 自动绑定工具（离线构建步骤）
// ---------------------------------------------------------------------------
// 为什么要有这个：
//   现成的 VTuber 模型很多是"静态网格" —— 没有骨骼、没有 blendshape，本质是座雕像。
//   要做嘴型同步和身体动作，必须先给它装骨架、算蒙皮权重、生成表情。
//
// 这个脚本一次性把 .glb 变成可在运行时驱动的资源：
//   xxx.rigged.glb      —— 每个 mesh 变成 SkinnedMesh，共用一副标准骨架；
//                          材质 / UV / 贴图**原样保留**，所以外观不会有损失
//   xxx.morph.json      —— 稀疏存的 blendshape 数据（只存脸部顶点）
//
// 为什么不把 blendshape 直接塞进 GLB：
//   glTF 的 morph target 必须和基础网格顶点数完全一致，且只能用 float32。
//   13k 顶点 × 52 个表情 = 8MB/角色，手机上完全不可接受。
//   改成"只记录脸部顶点 + 只记录真正用得上的表情"之后，单角色约 140~200KB。
//
// 用法：node tools/autorig.mjs assets/models/girlfriend.glb
//
// 产出之后要做的两件事：
//   1. 在 src/lib/companionModel.js 的 PERSONA_MODELS 里把 require 指向 .rigged.glb
//   2. 跑一次 npm test —— pipeline.test.mjs 会断言"骨架真的驱动了顶点"
//
// 踩过的坑（改测量逻辑之前务必先看这段，每一个都会让骨架整根歪掉）：
//   a) 头顶呆毛会骗走 topY   -> 用 p99.5 高度当有效头顶
//   b) Q 版两腿并拢，"中线无顶点"的裆部检测会一路走到脚踝
//      （实测报出裆部 0.02m）-> 先判断中线空隙是否真的存在，不存在就按腰线估
//   c) 手臂和双马尾在同一个 x 区间，用 |x| 判外扩会把肩线判到头顶
//      （实测报出肩 1.59m 而身高才 1.67m）-> 改用"两侧顶点群的 z 厚度随高度变化"
//   d) "是不是手臂"必须在按高度分区**之前**判 —— 手臂挂在身侧是向下垂的，
//      其高度比"胸"更低。按高度分区会让手臂顶点全落进躯干分支，
//      结果 Arm/ForeArm/Hand 三根骨一个顶点都拿不到

import fs from 'fs';
import path from 'path';

// GLTFExporter 内部用 FileReader 读 Blob，Node 里缺这个对象
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend && this.onloadend(); });
  }
};

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const TARGET_HEIGHT = 1.68; // 米，标准成人身高，作为统一缩放基准

// ---------------------------------------------------------------------------
// 1. 读入并把所有 mesh 拉到统一世界坐标
// ---------------------------------------------------------------------------

async function loadScene(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

/**
 * 收集所有 mesh，把它们的世界变换烘进几何体本身，然后把变换清零。
 * 烘完之后全部在同一个坐标系里，才能共用一副骨架（bind matrix = 单位阵）。
 * 注意：材质、UV、贴图全都留在原 mesh 上，不做任何合并。
 */
function collectMeshes(scene) {
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.isSkinnedMesh) return; // 已经是蒙皮的就别碰
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    out.push({ name: o.name || 'mesh', geo, material: o.material, orig: o });
  });
  return out;
}

/** 把所有几何体按顶点数归一化缩放：统一身高、水平居中、脚踩地面 */
function normalizeScale(meshes) {
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      box.expandByPoint(tmp.fromBufferAttribute(pos, i));
    }
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (!isFinite(size.y) || size.y <= 0) throw new Error('模型没有有效高度');

  const s = TARGET_HEIGHT / size.y;
  const p = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      // x/z 居中，y 让最低点落在 0
      pos.setXYZ(i, (p.x - center.x) * s, (p.y - box.min.y) * s, (p.z - center.z) * s);
    }
    pos.needsUpdate = true;
    m.geo.computeBoundingBox();
  }
  return { scale: s, size };
}

// ---------------------------------------------------------------------------
// 2. 用剪影反向测量身体各部位的真实高度
// ---------------------------------------------------------------------------
// 不用教科书比例硬套：模型有大长腿、有 Q 版、有鞋跟，套标准比例必歪。
// 这里直接从几何统计里量出几个锚点，其余再按比例插值。

/**
 * 量身体。返回的是一套**锚点高度**，不是最终骨骼坐标 —— 骨骼再按锚点插值。
 *
 * 踩过的坑（两个，都会让骨架整根歪掉）：
 *
 * 1) 头顶上那根呆毛。这批 VTuber 模型头顶常有一根极细的呆毛/发带，
 *    只有个位数顶点却顶在最高处。直接拿全局 maxY 当头顶，会让量出来的
 *    "身高"凭空多出一截，全身比例被拉长。所以先算 p99.5 高度当"有效头顶"，
 *    再往上找到真正还属于头部的那个高度。
 *
 * 2) Q 版模型两条腿是并在一起的。找裆部的经典办法是"从下往上找第一个
 *    中线附近没顶点的高度"，这在写实模型上很准；但 Q 版短腿并拢，
 *    中线**全程都有顶点**，于是循环一路走到最底下，把裆部判在脚踝上 ——
 *    整个骨盆、脊柱、腿骨全部跟着塌到地面。
 *    所以先检测"中线空隙"是否真的存在；不存在就退到按身高比例估算，
 *    并用剪影宽度分布的斜率来定位腰线（收窄最快的地方）。
 */
function measureBody(meshes) {
  const BINS = 240;
  const minW = new Array(BINS).fill(Infinity);
  const maxW = new Array(BINS).fill(-Infinity);
  const maxAbsZ = new Array(BINS).fill(0);
  let topY = -Infinity, botY = Infinity;

  const p = new THREE.Vector3();
  const ys = [];
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      ys.push(p.y);
      if (p.y > topY) topY = p.y;
      if (p.y < botY) botY = p.y;
    }
  }

  const rawH = topY - botY || 1;

  // --- 有效头顶：先把呆毛排除掉 -------------------------------------------
  // p99.5 高度作为"实在的头顶"下限；再往下找第一个"局部明显变宽"的高度，
  // 那个位置才是真正的颅顶（呆毛之下、头发之上）。
  ys.sort((a, b) => a - b);
  const pct = (q) => ys[Math.min(ys.length - 1, Math.floor(ys.length * q))];
  const solidTop = pct(0.995);

  // 分桶时用 solidTop 作为上界，避免呆毛独占最高的几个桶
  const span = solidTop - botY || 1;
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      if (p.y > solidTop) continue;
      let b = Math.floor(((p.y - botY) / span) * (BINS - 1));
      b = Math.max(0, Math.min(BINS - 1, b));
      if (p.x < minW[b]) minW[b] = p.x;
      if (p.x > maxW[b]) maxW[b] = p.x;
      if (Math.abs(p.z) > maxAbsZ[b]) maxAbsZ[b] = Math.abs(p.z);
    }
  }

  const H = solidTop - botY;
  const widthAt = (b) => (maxW[b] > minW[b] ? maxW[b] - minW[b] : 0);
  const yOf = (b) => botY + (b / (BINS - 1)) * H;

  // --- 中线空隙检测：判断是不是"并腿 Q 版" --------------------------------
  // 逐带统计 |x| < legSplitEps 的顶点数。eps 用身高的 2%。
  const nearCount = new Array(BINS).fill(0);
  const countIn = new Array(BINS).fill(0);
  const legSplitEps = 0.02 * H;
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      if (y > solidTop) continue;
      const b = Math.max(0, Math.min(BINS - 1, Math.floor(((y - botY) / (H || 1)) * (BINS - 1))));
      countIn[b]++;
      if (Math.abs(x) < legSplitEps) nearCount[b]++;
    }
  }

  // 只在"下半身"范围里找空隙（裆部一定在 20%~65% 身高之间）
  const loB = Math.floor(BINS * 0.20);
  const hiB = Math.floor(BINS * 0.65);
  let gapY = null;
  for (let b = loB; b <= hiB; b++) {
    // 该带总顶点数太少说明是边缘噪声，不足以证明"腿分开了"
    if (countIn[b] >= 12 && nearCount[b] === 0) { gapY = yOf(b); break; }
  }

  // --- 腰线：宽度分布里"最细"的那一带（裆以上、肩以下） --------------------
  let waistB = null;
  let waistW = Infinity;
  for (let b = loB; b <= Math.floor(BINS * 0.62); b++) {
    const w = widthAt(b);
    if (countIn[b] >= 12 && w > 0 && w < waistW) { waistW = w; waistB = b; }
  }

  // --- 手臂：用"两侧薄片的厚度渐变 + 终止点"来定位 -------------------------
  // 只看 |x| 永远分不出手臂和双马尾（实测两者都是 0.30~0.70）。
  // 有用的信号是**两侧顶点群的 z 厚度如何随高度变化**：
  //   头发段：厚(0.19~0.29)，且越往下越厚/持平
  //   手臂段：薄，并且**一路变薄**，最后直接消失（手以下没有东西了）
  // 实测：96% 处 z=0.086，到 60% 降为 0.19…48% 处只剩 0.109，然后侧面顶点数归零。
  // 所以策略是：从下往上扫，找"侧面顶点群消失"的高度，那里就是手的位置；
  // 再往上找"厚度开始回升"的高度，那里是肩。
  const NBANDS = 48;
  const sideInfo = [];
  for (let b = 0; b < NBANDS; b++) {
    const y0 = botY + (b / NBANDS) * H, y1 = botY + ((b + 1) / NBANDS) * H;
    const lat = 0.20 * H;
    let n = 0, zmin = Infinity, zmax = -Infinity, xmax = 0;
    for (const m of meshes) {
      const pos = m.geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (y < y0 || y >= y1 || y > solidTop) continue;
        if (Math.abs(x) <= lat) continue;
        n++;
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
        const ax = Math.abs(x);
        if (ax > xmax) xmax = ax;
      }
    }
    sideInfo.push({ b, y0, y1, n, thick: n >= 3 ? zmax - zmin : null, xmax });
  }

  // 手掌高度：从下往上第一个"侧面顶点成规模"的带
  let handRow = null;
  for (const s of sideInfo) {
    if (s.n >= 20) { handRow = s; break; }
  }
  // 肩的高度：从手掌往上，找"厚度明显回升"的带（头发开始的地方）
  let armTopRow = null;
  if (handRow) {
    let thickestBelow = handRow.thick ?? 0;
    for (const s of sideInfo) {
      if (s.y0 <= handRow.y0) continue;
      if (s.thick == null) continue;
      if (s.thick > thickestBelow * 1.5 && s.thick > 0.16 * H) { armTopRow = s; break; }
      if (s.thick > thickestBelow) thickestBelow = s.thick;
    }
  }

  let armMinY, armMaxY, armMaxAbsX;
  if (handRow && armTopRow) {
    armMinY = handRow.y0;
    armMaxY = armTopRow.y0;
    armMaxAbsX = Math.max(...sideInfo
      .filter((s) => s.y0 >= armMinY - 1e-6 && s.y1 <= armMaxY + 1e-6)
      .map((s) => s.xmax), 0);
  } else {
    // 兜底：Q 版手臂常见落在 46%~60% 身高
    armMinY = botY + 0.46 * H;
    armMaxY = botY + 0.60 * H;
    armMaxAbsX = 0.33 * H;
  }
  if (!(armMaxAbsX > 0)) armMaxAbsX = 0.33 * H;
  if (!(armMaxY > armMinY)) { armMaxY = armMinY + 0.10 * H; }

  // --- 肩：上半身最宽处 ----------------------------------------------------
  // 两个陷阱叠在一起：
  //   a) 手臂下垂时"手"比肩还宽 —— 取最大宽度会把肩定在手上（实测 59% 处）
  //   b) 双马尾/大波浪比肩膀还宽 —— 用固定阈值 |x| > 0.25H 判"外扩"，
  //      头发会从头到脚一路算作外扩，肩线被判到头顶（实测 1.59m，身高才 1.67m）
  //
  // 不变的事实是：**肩是躯干的最上端，而且是头部之外的第一个宽结构**。
  // 所以正确的顺序是：先定头，再从"头底"往下找第一个变宽处。
  // 这里用一个不依赖绝对阈值的办法：
  //   逐带求"该带中位 |x|"，从头顶往下扫，找到中位 |x| 第一次显著抬升的位置。
  //   头部的中位 |x| 很小（颅骨窄），肩部的中位 |x| 会跳上来。
  //   头发只影响 max |x|，不影响"中位"太多（发丝顶点占比小）。
  const medAbs = new Array(BINS).fill(0);
  {
    const buckets = Array.from({ length: BINS }, () => []);
    for (const m of meshes) {
      const pos = m.geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > solidTop) continue;
        const b = Math.max(0, Math.min(BINS - 1, Math.floor(((y - botY) / (H || 1)) * (BINS - 1))));
        buckets[b].push(Math.abs(pos.getX(i)));
      }
    }
    for (let b = 0; b < BINS; b++) {
      const a = buckets[b];
      if (!a.length) { medAbs[b] = 0; continue; }
      a.sort((x, y2) => x - y2);
      medAbs[b] = a[Math.floor(a.length / 2)];
    }
  }

  let shoulderB = null;
  {
    // 先从顶部往下找"头底"：中位 |x| 稳定在一个小值的那一段就是头
    let b = BINS - 1;
    while (b > 0 && medAbs[b] <= 0) b--;
    const headMed = medAbs[b];
    const topB = b;
    // 继续往下，找中位 |x| 首次超过头部中位数 1.6 倍的位置
    let found = null;
    for (let k = topB; k >= Math.floor(BINS * 0.5); k--) {
      if (medAbs[k] <= 0) continue;
      if (medAbs[k] > headMed * 1.6) { found = k; break; }
    }
    shoulderB = found;
  }
  if (shoulderB == null) shoulderB = Math.round(BINS * 0.70);

  // 安全钳：肩线必须落在 55%~82% 身高之间。
  // 任何测量都可能被异常几何带跑，但"肩在这个区间"是解剖学上的硬约束。
  // 不钳的话，一个错的肩位会把脖子、头、脸全部推到模型外面去（踩过）。
  const shoulderFrac = shoulderB / (BINS - 1);
  if (!(shoulderFrac >= 0.55 && shoulderFrac <= 0.82)) {
    shoulderB = Math.round(BINS * (shoulderFrac < 0.55 ? 0.70 : 0.78));
  }

  // 肩宽 = 肩线以下 3 带内，躯干(|x|<0.25H)的最大宽度。
  // 这样量到的是脖子根/锁骨那一圈，不是手臂。
  let shoulderW = 0;
  for (let b = shoulderB; b >= Math.max(0, shoulderB - Math.round(BINS * 0.03)); b--) {
    const innerW = Math.min(maxW[b] === -Infinity ? 0 : maxW[b], 0.25 * H) * 2;
    if (innerW > shoulderW) shoulderW = innerW;
  }
  if (!(shoulderW > 0)) shoulderW = 0.24 * H;

  // --- 裆部：有真实空隙就用空隙；没有（并腿 Q 版）就按比例估 --------------
  // Q 版常见"头身比 2.5~4"，腿相对短，裆部大约在 0.36~0.44 身高处。
  // 用腰线位置做一点校正：腰越靠下，说明躯干越短、腿越短。
  let crotchY;
  let crotchSource;
  if (gapY != null) {
    crotchY = gapY;
    crotchSource = 'gap';
  } else {
    let ratio = 0.42;                     // 缺省：Q 版
    if (waistB != null) {
      const waistFrac = waistB / (BINS - 1);
      // 腰线在 0.5 附近偏下时把裆部也相应下移一点
      ratio = Math.max(0.32, Math.min(0.48, 0.42 + (waistFrac - 0.56) * 0.6));
    }
    crotchY = botY + ratio * H;
    crotchSource = 'ratio';
  }

  return {
    H, topY: solidTop, rawTopY: topY, botY,
    width: widthAt, yOf, V: (b) => yOf(b),
    crotchY, crotchSource,
    waistY: waistB != null ? yOf(waistB) : botY + 0.56 * H,
    shoulderY: yOf(shoulderB),
    shoulderWidth: shoulderW,
    armMinY,                  // 手臂（薄片）区间的最低高度
    armMaxY,                  // 手臂区间的最高高度
    armMaxAbsX,               // 手臂能达到的最大 |x|
    topAbs: maxAbsZ,
  };
}

// ---------------------------------------------------------------------------
// 3. 建立标准骨架
// ---------------------------------------------------------------------------
// 命门：必须和 Mixamo 一致。Mixamo 是全球最大免费动作库，
// 命名一致 = 它那儿的动画能零重定向直接套上来。

function buildSkeletonLayout(mea) {
  const H = mea.H;
  const botY = mea.botY;
  const hipY = mea.crotchY;                       // 骨盆底（裆）
  const chestY = mea.shoulderY - 0.04 * H;        // 胸下端
  const shoulderHW = mea.shoulderWidth / 2 * 0.86; // 肩关节比外轮廓靠内

  // 头颈段：Q 版头很大，不能套写实比例。
  // 用"肩到头顶"这段高度，按实测比例分给 颈 / 头。
  const neckTop = mea.shoulderY + 0.055 * H;
  const headY = Math.min(neckTop + 0.035 * H, mea.topY - 0.10 * H);

  // 躯干：裆 -> 胸之间均分给 Hips/Spine/Spine1/Spine2。
  // 写实模型这段很长（约 0.35H），Q 版很短（约 0.20H），所以必须按实测插值。
  const torsoTop = chestY;
  const torsoLen = Math.max(0.08 * H, torsoTop - hipY);
  const tAt = (k) => hipY + torsoLen * k;

  const L = (x, y, z) => new THREE.Vector3(x, y, z);
  // 【约定】角色面朝 +Z，则它的左手在 +X（forward×up = Z×Y = -X 是右手）
  //
  // 手臂：肩 -> 手 分三段。手的高度/横向尽头全部来自实测的"薄片区间"，
  // 而不是"胸口往下 0.38H"这种估法 —— Q 版手臂短、写实手臂长，估出来必歪，
  // 而且骨段太短会让前臂/手拿不到顶点（实测前臂 0 顶点）。
  //
  // 实测数据（girlfriend）：手臂薄片区在 50%~58% 身高，|x| 到 0.70（=0.37H）。
  // 所以肩关节取该区间的**顶部**，手取**底部**。
  const armTopX = Math.max(shoulderHW, 0.10 * H);
  // ⚠️ 上臂骨必须落在**肩关节**上，而肩位 shoulderY 是可靠的（已按 55%~82% 身高钳过）。
  //    原来是 min(chestY + 0.02H, armMaxY)：armMaxY 来自"手臂薄片"检测，
  //    只有当手臂顶点横向超过 0.20H（侧面阈值 lat）时才采得到样本。
  //    手臂收得贴身体 —— 动漫角色尤其常见 —— 就一个样本都没有，
  //    直接退化成兜底 0.60H，把上臂骨压到腹部。
  //    实测：肩在 1.28m 的模型，上臂骨被放到 1.008m，前臂/手骨整条外飘，
  //    手骨最远跑到 0.496（实际手在 0.312），手上一个顶点都分不到。
  //    这里改成只用肩位推导，armMaxY 交给下面的 handEndX/handEndY 去用。
  const armTopY = chestY + 0.02 * H;
  const handEndX = Math.max(armTopX * 1.25, mea.armMaxAbsX || 0.30 * H);
  const handEndY = mea.armMinY != null
    ? mea.armMinY
    : armTopY - 0.10 * H;

  // 肘 / 腕 沿"肩 -> 手"均匀插值，并把 x 拉成一条略外张的线（手臂自然下垂略外张）
  const armDX = handEndX - armTopX;
  const armDY = handEndY - armTopY;
  const elbowX = armTopX + armDX * 0.50;
  const elbowY = armTopY + armDY * 0.42;
  const wristX = armTopX + armDX * 0.85;
  const wristY = armTopY + armDY * 0.80;

  const pos = {
    Hips: L(0, tAt(0.06), 0),
    Spine: L(0, tAt(0.36), 0),
    Spine1: L(0, tAt(0.66), 0),
    Spine2: L(0, torsoTop, 0),
    Neck: L(0, neckTop, 0),
    Head: L(0, headY, 0),
    HeadTop_End: L(0, mea.topY, 0),

    LeftShoulder: L(+shoulderHW * 0.55, chestY + 0.03 * H, 0),
    LeftArm: L(+armTopX, armTopY, 0),
    LeftForeArm: L(+elbowX, elbowY, 0),
    LeftHand: L(+wristX, wristY, 0),

    RightShoulder: L(-shoulderHW * 0.55, chestY + 0.03 * H, 0),
    RightArm: L(-armTopX, armTopY, 0),
    RightForeArm: L(-elbowX, elbowY, 0),
    RightHand: L(-wristX, wristY, 0),
    // 腿部下面会按实测裆位统一重算，这里先占位（避免 order 里缺键）
    LeftUpLeg: L(+0.055 * H, botY + 0.06 * H, 0),
    LeftLeg: L(+0.055 * H, botY + 0.04 * H, 0),
    LeftFoot: L(+0.055 * H, botY + 0.02 * H, 0),
    LeftToeBase: L(+0.055 * H, botY + 0.015 * H, 0),
    LeftToe_End: L(+0.055 * H, botY + 0.015 * H, 0.09 * H),

    RightUpLeg: L(-0.055 * H, botY + 0.06 * H, 0),
    RightLeg: L(-0.055 * H, botY + 0.04 * H, 0),
    RightFoot: L(-0.055 * H, botY + 0.02 * H, 0),
    RightToeBase: L(-0.055 * H, botY + 0.015 * H, 0),
    RightToe_End: L(-0.055 * H, botY + 0.015 * H, 0.09 * H),
  };

  // 腿部只要 3 段（UpLeg/Leg/Foot）；裆位偏低时不能把整条腿压成一条线，
  // 这里保证膝 / 踝沿"裆 -> 地面"均匀分布，各占 1/3。
  const legLen = Math.max(0.05 * H, hipY - botY);
  const legTop = Math.max(hipY + 0.02 * H, botY + 0.06 * H);
  const toeBaseY = botY + 0.015 * H;
  for (const side of ['Left', 'Right']) {
    const sx = side === 'Left' ? +1 : -1;
    pos[`${side}UpLeg`] = L(sx * 0.055 * H, legTop, 0);
    pos[`${side}Leg`] = L(sx * 0.055 * H, botY + legLen * 0.52, 0);
    pos[`${side}Foot`] = L(sx * 0.055 * H, botY + legLen * 0.07, 0);
    // ToeBase 在脚掌前端，Toe_End 再往前 —— 两者**必须分开**。
    // 早先写成同一个点，骨段长度为 0，这两根骨头一个顶点都拿不到（实测 0）。
    pos[`${side}ToeBase`] = L(sx * 0.055 * H, toeBaseY, 0.06 * H);
    pos[`${side}Toe_End`] = L(sx * 0.055 * H, toeBaseY, 0.14 * H);
  }

  // hierarchy: name -> parent
  const parent = {
    Hips: null,
    Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
    Neck: 'Spine2', Head: 'Neck', HeadTop_End: 'Head',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot', LeftToe_End: 'LeftToeBase',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot', RightToe_End: 'RightToeBase',
  };

  // 每根骨头的"骨段"（近端到远端），用于算蒙皮权重时的距离
  const seg = {
    Hips: ['Hips', 'Spine'],
    Spine: ['Spine', 'Spine1'],
    Spine1: ['Spine1', 'Spine2'],
    Spine2: ['Spine2', 'Neck'],
    Neck: ['Neck', 'Head'],
    Head: ['Head', 'HeadTop_End'],
    LeftShoulder: ['LeftShoulder', 'LeftArm'],
    LeftArm: ['LeftArm', 'LeftForeArm'],
    LeftForeArm: ['LeftForeArm', 'LeftHand'],
    LeftHand: ['LeftHand', null],
    RightShoulder: ['RightShoulder', 'RightArm'],
    RightArm: ['RightArm', 'RightForeArm'],
    RightForeArm: ['RightForeArm', 'RightHand'],
    RightHand: ['RightHand', null],
    LeftUpLeg: ['LeftUpLeg', 'LeftLeg'],
    LeftLeg: ['LeftLeg', 'LeftFoot'],
    LeftFoot: ['LeftFoot', 'LeftToeBase'],
    LeftToeBase: ['LeftToeBase', 'LeftToe_End'],
    LeftToe_End: ['LeftToeBase', 'LeftToe_End'],
    RightUpLeg: ['RightUpLeg', 'RightLeg'],
    RightLeg: ['RightLeg', 'RightFoot'],
    RightFoot: ['RightFoot', 'RightToeBase'],
    RightToeBase: ['RightToeBase', 'RightToe_End'],
    RightToe_End: ['RightToeBase', 'RightToe_End'],
  };

  return { pos, parent, seg, order: Object.keys(parent) };
}

// ---------------------------------------------------------------------------
// 4. 蒙皮权重
// ---------------------------------------------------------------------------
// 纯按距离反比算会出事：两腿互相渗透、抬手时整块身体跟着动。
// 所以先按身体分区限制候选骨头，再在候选里按距离衰减。

function buildAuthorities(mea) {
  // 分区边界全部来自实测锚点，不写死比例 —— Q 版和写实模型的比例差一倍以上，
  // 写死任何百分比都会让其中一个彻底分错区（腿被算进躯干，或手臂被算进脖子）。
  const neckY = mea.shoulderY + 0.06 * mea.H;
  return {
    hipY: mea.crotchY,
    waistY: mea.waistY,
    chestY: mea.shoulderY - 0.04 * mea.H,
    neckY,
    headLoY: neckY + 0.04 * mea.H,
    H: mea.H,
    // 手臂判定：横向超过肩半宽 1.05 倍、且落在实测手臂区间内
    armLat: (mea.shoulderWidth / 2) * 1.05,
    armLoY: (mea.armMinY != null ? mea.armMinY : mea.botY + 0.46 * mea.H) - 0.03 * mea.H,
    armHiY: (mea.armMaxY != null ? mea.armMaxY : mea.botY + 0.60 * mea.H) + 0.06 * mea.H,
  };
}

function candidateBones(p, A) {
  const side = p.x >= 0 ? 'Left' : 'Right';
  const ax = Math.abs(p.x);

  // 【先判"是不是手臂"】—— 这一条必须在按高度分区之前。
  // 手臂是**挂在身侧、向下垂**的：girlfriend 实测手臂在 0.77~1.00m，
  // 而"胸"在 1.24m。也就是说手臂的绝大部分都比胸更低。
  // 早先按高度分区时，手臂顶点全落进了"躯干"分支，候选骨里根本没有
  // Arm/ForeArm/Hand，于是这三根骨头一个顶点都拿不到（实测 0）。
  //
  // 判据：横向超过肩半宽的一定是手臂（躯干不会那么宽），
  // 且在手臂实测区间内。
  if (ax > A.armLat && p.y > A.armLoY && p.y < A.armHiY) {
    return [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`, 'Spine2'];
  }

  if (p.y < A.hipY - 0.01) {
    // 腿脚
    return [`${side}UpLeg`, `${side}Leg`, `${side}Foot`, `${side}ToeBase`, 'Hips'];
  }
  if (p.y < A.waistY) {
    // 腰以下：骨盆 + 大腿根
    return ['Hips', 'Spine', `${side}UpLeg`, `${side}Leg`];
  }
  if (p.y < A.chestY + 0.02) {
    // 躯干：所有脊柱
    return ['Hips', 'Spine', 'Spine1', 'Spine2', `${side}UpLeg`];
  }
  if (p.y < A.neckY) {
    // 肩胸区域：肩胛 + 手臂根 + 上胸
    return [
      `${side}Shoulder`, `${side}Arm`,
      'Spine2', 'Spine1', 'Neck',
    ];
  }
  if (p.y < A.headLoY) {
    return ['Neck', 'Head', 'Spine2'];
  }
  return ['Head', 'Neck'];
}

function distToSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? new THREE.Vector3().subVectors(p, a).dot(ab) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return p.distanceTo(proj);
}

/**
 * 沿骨段方向的"参数化距离"：返回 [到骨段轴线的垂距, 沿骨段方向的归一化位置]
 * 蒙皮权重不能只看三维距离 —— 必须知道顶点落在骨段的哪一段上，
 * 否则锁骨（贴近躯干）会把整条手臂抢走。
 */
function segCoord(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  let t = len2 > 0 ? new THREE.Vector3().subVectors(p, a).dot(ab) / len2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  const proj = new THREE.Vector3().copy(a).addScaledVector(ab, tc);
  return { d: p.distanceTo(proj), t: tc, overrun: t < 0 ? -t : t > 1 ? t - 1 : 0 };
}

function computeSkinWeights(meshes, rig, A) {
  let warned = 0;
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    const n = pos.count;
    const idx = new Uint16Array(n * 4);
    const w = new Float32Array(n * 4);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i);
      const cands = candidateBones(p, A);
      const scored = [];
      for (const bname of cands) {
        const s = rig.seg[bname];
        if (!s) continue;
        const a = rig.pos[s[0]];
        // 末端骨（Hand / Toe_End）没有远端：用"从近端向外延伸一个身长比例"当虚拟远端
        const b = s[1] ? rig.pos[s[1]] : null;
        const seg = b ?? a.clone().add(new THREE.Vector3(0, -0.06 * A.H, 0));
        const { d, overrun } = segCoord(p, a, seg);
        // 超出骨段范围的部分要罚：这样"上臂以外的顶点"不会赖在上臂头上
        const eff = d + overrun * 0.25 * A.H;
        scored.push([bname, eff]);
      }
      if (!scored.length) { if (warned++ < 3) console.warn('无候选骨', p); continue; }
      scored.sort((a, b) => a[1] - b[1]);
      // 取最近的 4 根：这是 glTF 的硬上限（JOINTS_0/WEIGHTS_0 是 vec4）
      const top = scored.slice(0, 4);
      // 距离越小权重越大；指数 4 让"最近的那根"占主导，形变更干净
      let sum = 0;
      const ws = top.map(([, d]) => {
        const v = 1 / Math.pow(Math.max(d, 1e-4) + 0.015, 4);
        sum += v;
        return v;
      });
      // 归一化后剪掉极小权重，再重新归一化 —— 避免出现"和几乎为 0"的僵尸顶点
      const norm = ws.map((x) => x / sum);
      let kept = 0;
      for (let k = 0; k < 4; k++) if (norm[k] >= 0.02) kept += norm[k];
      if (kept <= 0) { kept = 1; }
      for (let k = 0; k < 4; k++) {
        const bname = top[k]?.[0];
        idx[i * 4 + k] = bname ? rig.order.indexOf(bname) : 0;
        w[i * 4 + k] = top[k] ? (norm[k] >= 0.02 ? norm[k] / kept : 0) : 0;
      }
    }
    m.geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    m.geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  }
}

// ---------------------------------------------------------------------------
// 5. 生成 blendshape（嘴型 + 表情）
// ---------------------------------------------------------------------------

// 只生成真正会被用到的：嘴型同步 + 情绪表达。其余 ARKit 通道运行时置 0。
const SHAPES = [
  'jawOpen', 'mouthClose', 'mouthPucker', 'mouthFunnel',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthLeft', 'mouthRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'browInnerUp', 'browDownLeft', 'browDownRight',
  'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
];

/** 面部关键点：从头部几何体反推，而不是死记模型内脏的坐标 */
function measureFace(meshes, rig, mea) {
  const H = mea.H;
  const neckY = rig.pos.Neck.y;
  const headTopY = mea.topY;

  // 头部顶点集合
  const headVerts = [];
  for (const m of meshes) {
    const pos = m.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) >= neckY - 0.005) headVerts.push([m, i, pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
  }
  if (!headVerts.length) return null;

  // 陷阱：双马尾/大波浪会把整个头部的 x 范围撑得极宽。
  // 实测某角色 headVerts 的 x 跨度 = 1.186m，而身高才 1.67m —— 显然量到的是头发不是脸。
  //
  // 而且"头发比头宽"这件事在不同角色上表现完全不同：
  //   - 大波浪长发：从颅顶往下宽度一路缓增
  //   - 双马尾：在发根处宽度**突变**（0.51 -> 0.99），然后整个下半段都维持在 1.3
  // 所以不能用"最宽处"当基准（会被头发带跑）。
  //
  // 正确做法：从颅顶往下逐带扫描，找**宽度相对上一带突然跳增**的那个位置。
  // 那个位置就是"发根线"——它以上是颅骨，以下是头发/耳朵。
  // 颅骨宽度就取发根线以上的中位宽度。
  const yLo = neckY - 0.005;
  const yHi = headTopY;
  const BANDS = 40;
  const bandW = [];
  const bandLo = [];
  for (let b = 0; b < BANDS; b++) {
    const a = yLo + ((yHi - yLo) * b) / BANDS;
    const c = yLo + ((yHi - yLo) * (b + 1)) / BANDS;
    let lo = Infinity, hi = -Infinity;
    for (const [, , x, y] of headVerts) {
      if (y < a || y >= c) continue;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    bandW.push(hi > lo ? hi - lo : 0);
    bandLo.push(lo);
  }

  // 从顶往下找第一个"宽度跳增"（本带 > 上一带 × 1.35 且绝对增量 > 0.10H）
  let hairLine = null;
  for (let b = BANDS - 1; b >= 1; b--) {
    if (bandW[b] <= 0 || bandW[b - 1] <= 0) continue;
    if (bandW[b - 1] > bandW[b] * 1.35 && bandW[b - 1] - bandW[b] > 0.10 * H) {
      hairLine = b;   // b 是"还是头"的那一带，b-1 开始是头发
      break;
    }
  }

  let headW = 0.22 * H;   // 兜底
  let skullBottomY = yLo + ((yHi - yLo) * (hairLine ?? BANDS * 0.55)) / BANDS;
  if (hairLine != null) {
    // 颅骨宽 = 发根线以上的中位宽度（跳过最顶上那两带，呆毛/发饰会偏窄）
    const top = Math.max(0, hairLine - 2);
    const ws = bandW.slice(top, hairLine + 1).filter((w) => w > 0).sort((a, b) => a - b);
    if (ws.length) headW = ws[Math.floor(ws.length / 2)];
  } else {
    // 找不到跳变（没有夸张头发）：取颈部以上、最靠下那 40% 的中位宽度
    const from = Math.floor(BANDS * 0.15);
    const to = Math.floor(BANDS * 0.75);
    const ws = bandW.slice(from, to).filter((w) => w > 0).sort((a, b) => a - b);
    if (ws.length) headW = ws[Math.floor(ws.length / 2)];
  }
  // 心里有个底线：脸不可能比身高的 8% 还窄
  headW = Math.max(headW, 0.08 * H);

  // 面朝方向：在脸部候选窗口里找最突出的 z
  // 窗口取"鼻子一带"，|x| 很窄，避免被脑后的头发误导
  let zMax = -Infinity;
  const wy = rig.pos.Head.y;
  for (const [, , x, y, z] of headVerts) {
    if (Math.abs(x) > headW * 0.18) continue;
    if (y < wy - 0.06 * H || y > wy + 0.06 * H) continue;
    if (z > zMax) zMax = z;
  }
  if (!isFinite(zMax)) { zMax = 0.06 * H; }
  const faceZ = zMax;

  // 下巴：颅骨底往下一点；同时不能低过脖子太多
  const chinY = Math.max(neckY - 0.03 * H, skullBottomY - 0.02 * H);
  const headH = Math.max(1e-4, headTopY - chinY);

  // 五官位置：动漫比例 —— 眼睛在头高 45% 处（写实是 50%，动漫更低更靠中）
  return {
    H, headW, headH, faceZ, chinY,
    eyeY: chinY + 0.46 * headH,
    browY: chinY + 0.62 * headH,
    noseY: chinY + 0.34 * headH,
    mouthY: chinY + 0.20 * headH,
    eyeX: headW * 0.20,
    browX: headW * 0.23,
    mouthW: headW * 0.15,
    eyeR: headW * 0.17,
    browR: headW * 0.21,
    mouthR: headW * 0.14,
  };
}

/** 平滑衰减：d 是到中心的距离，r 是影响半径 */
const fall = (d, r) => {
  if (r <= 0) return 0;
  const t = Math.max(0, 1 - d / r);
  return t * t * (3 - 2 * t); // smoothstep
};

/**
 * 为一个 mesh 生成全部 blendshape 的稀疏 delta。
 * @returns {null | { indices:number[], shapes: Record<string, number[]> }}
 *          indices 是有位移的顶点下标；每个 shape 的长度 = indices.length*3
 */
function buildFaceMorphs(meshes, F) {
  if (!F) return null;
  const indexMap = new Map();          // 全局唯一 key -> 稀疏下标
  const indices = [];
  const deltas = {};
  for (const s of SHAPES) deltas[s] = [];
  // 每个 shape 自己用到的那批顶点在 indices 里的下标。
  // 为什么必须显式记：
  //   左右分开的形状（mouthSmileLeft / eyeBlinkRight …）在 push 时会 `continue`
  //   掉不属于自己那侧的顶点，于是它的 deltas 长度和 indices 长度**不相等**
  //   （实测 299 对 195 / 104）。
  //   只靠 `deltas[s].length === indices.length * 3` 来判断"数据对不对"会误判 ——
  //   运行时必须有这张表才知道第 k 个三元组对应哪个顶点。
  const shapeIdx = {};
  for (const s of SHAPES) shapeIdx[s] = [];

  // 先把所有会动的顶点挑出来（脸部前侧）
  const hits = []; // [mi, vi, x, y, z]
  for (let mi = 0; mi < meshes.length; mi++) {
    const pos = meshes[mi].geo.attributes.position;
    for (let vi = 0; vi < pos.count; vi++) {
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
      if (y < F.chinY - 0.02 * F.H) continue;
      if (z < F.faceZ - 0.28 * F.headW) continue;   // 背面不要
      hits.push([mi, vi, x, y, z]);
      indexMap.set(mi * 1e7 + vi, hits.length - 1);
    }
  }
  if (!hits.length) return null;

  // push 时同步记一笔：这个 shape 当前这个三元组用的是哪一个稀疏顶点
  let curSlot = -1;
  const push = (s, v) => {
    deltas[s].push(v);
    // 每个三元组的第一个分量时登记一次（三个 push 共享同一个 slot）
    if (deltas[s].length % 3 === 1) shapeIdx[s].push(curSlot);
  };

  for (const [mi, vi, x, y, z] of hits) {
    indices.push(mi * 1e7 + vi);
    curSlot = indices.length - 1;

    const absX = Math.abs(x);
    const sx = x >= 0 ? 1 : -1;   // +X 是角色自己的左手

    // ---- 下颌张开：绕颌关节转下去 ----
    {
      // 旋转轴穿过两侧下颌关节，大约在耳朵下方、鼻高稍上
      const pivotY = F.mouthY + 0.035 * F.H;
      const pivotZ = F.faceZ - 0.055 * F.headW;
      const relY = y - pivotY, relZ = z - pivotZ;
      const jawMask = fall(Math.abs(x), F.mouthW * 2.2) *
        fall(Math.max(0, pivotY - y), 0.075 * F.H);
      const a = 0.30 * jawMask;      // 最大约 17 度
      push('jawOpen', 0);
      push('jawOpen', -relY * (1 - Math.cos(a)) - relZ * Math.sin(a) * 0.35);
      push('jawOpen', -relY * Math.sin(a) * 0.35 + relZ * (1 - Math.cos(a)) * 0.4);
    }

    // ---- 抿嘴 / 噘嘴 / 张圆 ----
    const mouthD = Math.hypot(x, y - F.mouthY);
    const mMask = fall(mouthD, F.mouthR * 1.9);
    {
      push('mouthClose', 0);
      push('mouthClose', -0.012 * F.H * mMask * (y > F.mouthY ? 1 : -1) * 0.6);
      push('mouthClose', -0.004 * F.H * mMask);
    }
    {
      // 噘嘴：向中心收 + 向前推
      const pullX = -x * 0.35 * mMask;
      const pullY = -(y - F.mouthY) * 0.35 * mMask;
      push('mouthPucker', pullX);
      push('mouthPucker', pullY);
      push('mouthPucker', 0.022 * F.H * mMask);
    }
    {
      // 圆嘴（funnel）：向外张 + 略向前
      const out = fall(mouthD, F.mouthR * 2.2);
      push('mouthFunnel', x * 0.22 * out);
      push('mouthFunnel', (y - F.mouthY) * 0.30 * out);
      push('mouthFunnel', 0.010 * F.H * out);
    }

    // ---- 嘴角：笑 / 哭 / 咧 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const cx = sign * F.mouthW, cy = F.mouthY;
      const cornerD = Math.hypot(x - cx, y - cy);
      const cMask = fall(cornerD, F.mouthR * 1.6);
      push(`mouthSmile${sideName}`, 0.010 * F.H * cMask * sign * 0.5);
      push(`mouthSmile${sideName}`, 0.016 * F.H * cMask);
      push(`mouthSmile${sideName}`, 0.002 * F.H * cMask);

      push(`mouthFrown${sideName}`, -0.004 * F.H * cMask * sign * 0.5);
      push(`mouthFrown${sideName}`, -0.014 * F.H * cMask);
      push(`mouthFrown${sideName}`, 0);

      // 整嘴左右移动
      const shiftMask = fall(cornerD, F.mouthR * 2.4);
      push(`mouth${sideName}`, sign * 0.016 * F.H * shiftMask);
      push(`mouth${sideName}`, 0);
      push(`mouth${sideName}`, 0);
    }

    // ---- 眼睛：睁 / 闭 / 眯 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const ex = sign * F.eyeX, ey = F.eyeY;
      const eyeD = Math.hypot(x - ex, y - ey);
      if (eyeD > F.eyeR * 2.2) {
        push(`eyeBlink${sideName}`, 0); push(`eyeBlink${sideName}`, 0); push(`eyeBlink${sideName}`, 0);
        push(`eyeWide${sideName}`, 0); push(`eyeWide${sideName}`, 0); push(`eyeWide${sideName}`, 0);
        push(`eyeSquint${sideName}`, 0); push(`eyeSquint${sideName}`, 0); push(`eyeSquint${sideName}`, 0);
        continue;
      }
      const lid = fall(eyeD, F.eyeR * 1.5);
      // 闭眼：上眼睑下压
      const above = y > ey ? 1 : 0.25;
      push(`eyeBlink${sideName}`, 0);
      push(`eyeBlink${sideName}`, -0.026 * F.H * lid * above);
      push(`eyeBlink${sideName}`, -0.004 * F.H * lid);

      // 睁大：上下一起撑开
      const dir = y > ey ? 1 : -1;
      push(`eyeWide${sideName}`, 0);
      push(`eyeWide${sideName}`, dir * 0.014 * F.H * lid);
      push(`eyeWide${sideName}`, 0.002 * F.H * lid);

      // 眯眼：下眼睑抬起
      const below = y < ey ? 1 : 0.3;
      push(`eyeSquint${sideName}`, 0);
      push(`eyeSquint${sideName}`, 0.012 * F.H * lid * below);
      push(`eyeSquint${sideName}`, 0);
    }

    // ---- 眉毛 ----
    for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
      if (sx !== sign) continue;
      const bx = sign * F.browX, by = F.browY;
      const browD = Math.hypot(x - bx, y - by);
      const bMask = fall(browD, F.browR * 1.7);

      push(`browOuterUp${sideName}`, sign * 0.004 * F.H * bMask);
      push(`browOuterUp${sideName}`, 0.013 * F.H * bMask);
      push(`browOuterUp${sideName}`, 0);

      push(`browDown${sideName}`, sign * 0.006 * F.H * bMask);
      push(`browDown${sideName}`, -0.013 * F.H * bMask);
      push(`browDown${sideName}`, 0.002 * F.H * bMask);
    }
    {
      // 眉心抬起（惊讶 / 委屈）：靠近中线，两侧都动
      const innerD = Math.hypot(absX - F.headW * 0.08, y - F.browY);
      const iMask = fall(innerD, F.browR * 1.5);
      push('browInnerUp', 0);
      push('browInnerUp', 0.014 * F.H * iMask);
      push('browInnerUp', 0.002 * F.H * iMask);
    }

    // ---- 脸颊 ----
    {
      const cheekSpokeX = F.headW * 0.30, cheekY = (F.eyeY + F.mouthY) / 2;
      for (const [sideName, sign] of [['Left', 1], ['Right', -1]]) {
        if (sx !== sign) continue;
        const cd = Math.hypot(absX - cheekSpokeX, y - cheekY);
        const cMask = fall(cd, F.headW * 0.22);
        push(`cheekSquint${sideName}`, sign * 0.004 * F.H * cMask);
        push(`cheekSquint${sideName}`, 0.008 * F.H * cMask);
        push(`cheekSquint${sideName}`, 0.002 * F.H * cMask);
      }
      const puffD = Math.hypot(absX - cheekSpokeX * 0.9, y - cheekY - 0.01 * F.H);
      const pMask = fall(puffD, F.headW * 0.24);
      push('cheekPuff', sx * 0.018 * F.H * pMask);
      push('cheekPuff', 0);
      push('cheekPuff', 0.014 * F.H * pMask);
    }
  }

  return { indices, shapes: deltas, shapeIdx };
}

// ---------------------------------------------------------------------------
// 6. 导出
// ---------------------------------------------------------------------------

function buildSkinnedScene(meshes, rig) {
  const scene = new THREE.Scene();

  // 先建骨架树：local position = 自己的世界坐标 - 父节点的世界坐标
  const boneObjs = {};
  for (const name of rig.order) {
    const b = new THREE.Bone();
    b.name = name;
    boneObjs[name] = b;
  }
  for (const name of rig.order) {
    const parentName = rig.parent[name];
    if (parentName) {
      boneObjs[parentName].add(boneObjs[name]);
      boneObjs[name].position.subVectors(rig.pos[name], rig.pos[parentName]);
    } else {
      scene.add(boneObjs[name]);
      boneObjs[name].position.copy(rig.pos[name]);
    }
  }
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(rig.order.map((n) => boneObjs[n]));

  for (const m of meshes) {
    const sk = new THREE.SkinnedMesh(m.geo, m.material);
    sk.name = m.name;
    // frustumCulled 关掉：有 morph 之后包围盒会变，可能被误剔除
    sk.frustumCulled = false;
    scene.add(sk);
    sk.add(boneObjs.Hips);
    sk.bind(skeleton);
  }
  return { scene, skeleton, boneObjs };
}

async function exportGLB(scene, file) {
  const out = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true, animations: [] })
  );
  fs.writeFileSync(file, Buffer.from(out));
  return out.byteLength;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('用法: node tools/autorig.mjs <model.glb>'); process.exit(1); }
  const base = file.replace(/\.glb$/i, '');
  const rigFile = `${base}.rigged.glb`;
  const morphFile = `${base}.morph.json`;

  console.log(`\n▶ ${path.basename(file)}`);

  const scene = await loadScene(file);
  const meshes = collectMeshes(scene);
  if (!meshes.length) throw new Error('没找到任何 mesh');
  const totalVerts = meshes.reduce((a, m) => a + m.geo.attributes.position.count, 0);
  console.log(`  mesh ${meshes.length} 个 / ${totalVerts} 顶点`);

  normalizeScale(meshes);
  const mea = measureBody(meshes);
  console.log(`  身高 ${mea.H.toFixed(2)}m | 裆部 ${mea.crotchY.toFixed(2)} (${mea.crotchSource}) | 肩 ${mea.shoulderY.toFixed(2)} 宽 ${mea.shoulderWidth.toFixed(2)}`);
  console.log(`  腰 ${mea.waistY.toFixed(2)} | 手臂薄片区 ${mea.armMinY == null ? '未检出' : mea.armMinY.toFixed(2) + '~' + mea.armMaxY.toFixed(2)} | 臂展 |x|max ${mea.armMaxAbsX.toFixed(3)}`);

  const rig = buildSkeletonLayout(mea);
  const A = buildAuthorities(mea);
  computeSkinWeights(meshes, rig, A);

  const F = measureFace(meshes, rig, mea);
  if (F) {
    console.log(`  脸宽 ${F.headW.toFixed(3)} | 眼 (±${F.eyeX.toFixed(3)}, ${F.eyeY.toFixed(2)}) | 嘴 ${F.mouthY.toFixed(2)} | 面朝 z=${F.faceZ.toFixed(3)}`);
  } else {
    console.log('  ⚠ 没测出头部（模型可能没头或比例异常），跳过表情');
  }

  const built = buildSkinnedScene(meshes, rig);
  const gb = await exportGLB(built.scene, rigFile);

  let mb = 0;
  if (F) {
    const sparse = buildFaceMorphs(meshes, F);
    if (sparse) {
      // 稀疏下标还原成 (meshIndex, vertexIndex)
      const meshCount = meshes.length;
      const packed = {
        version: 2,
        meshCount,
        shapes: SHAPES,
        indices: sparse.indices.map((k) => [Math.floor(k / 1e7), k % 1e7]),
        // shapeSlots[s][k] = 第 k 个三元组对应的 indices 下标。
        // v1 里没有这张表，只能假设"每个 shape 都用满 indices"——
        // 左右分开的形状会因此错位（嘴歪、眼斜），所以必须带上。
        shapeSlots: sparse.shapeIdx,
        deltas: sparse.shapes,
      };
      const json = JSON.stringify(packed);
      fs.writeFileSync(morphFile, json);
      mb = json.length;
      const moved = sparse.indices.length;
      console.log(`  表情: ${SHAPES.length} 个，共同覆盖 ${moved} 个脸部顶点`);
    }
  }

  console.log(`  ✓ ${path.basename(rigFile)} (${(gb / 1024).toFixed(0)}KB) + morph (${(mb / 1024).toFixed(0)}KB)`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); });
