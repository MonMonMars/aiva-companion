// 3D 伴侣角色：几何构建 + 动画 + 粒子
// ---------------------------------------------------------------------------
// 纯 three.js，不碰任何 DOM API —— 所以 web（canvas）和 native（expo-gl）能共用同一份。
// 形象用几何体程序化搭建：不用下载模型文件，体积小、启动快、绝对不会因为资源加载失败而白屏。
// 想换成真正的 .glb / .vrm 模型，见 README 里的「替换真模型」一节。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { createRigDriver } from './rigDriver';
import { createGroundLock } from './groundLock';
import { createPoseScheduler } from '../anim/poseScheduler';
import { createMotionPlayer } from '../anim/motionPlayer';
import { applyMorphData, createBuiltinMorphHandle } from '../anim/morphData';
import { createLipSync } from '../anim/lipSync';
import { createMakeHumanFace } from '../anim/makehumanFace';
import { bindMakeHumanEyes, resizeMakeHumanEyes } from '../lib/makehumanEyes';

// three.js 官方示例里的心形轮廓
function heartShape() {
  const x = 0, y = 0;
  const s = new THREE.Shape();
  s.moveTo(x + 25, y + 25);
  s.bezierCurveTo(x + 25, y + 25, x + 20, y, x, y);
  s.bezierCurveTo(x - 30, y, x - 30, y + 35, x - 30, y + 35);
  s.bezierCurveTo(x - 30, y + 55, x - 10, y + 77, x + 25, y + 95);
  s.bezierCurveTo(x + 60, y + 77, x + 80, y + 55, x + 80, y + 35);
  s.bezierCurveTo(x + 80, y + 35, x + 80, y, x + 50, y);
  s.bezierCurveTo(x + 35, y, x + 25, y + 25, x + 25, y + 25);
  return s;
}

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.72, metalness: 0.02, ...opts });

function buildLegs(a) {
  const g = new THREE.Group();
  const geo = new THREE.CapsuleGeometry(0.115, 0.42, 4, 12);
  const m = mat(a.bottom, { roughness: 0.85 });
  const l = new THREE.Mesh(geo, m);
  l.position.set(-0.17, 0.34, 0);
  const r = new THREE.Mesh(geo, m);
  r.position.set(0.17, 0.34, 0);
  g.add(l, r);

  // 鞋子
  const shoe = new THREE.SphereGeometry(0.135, 14, 10);
  const sm = mat(a.shoes, { roughness: 0.6 });
  const s1 = new THREE.Mesh(shoe, sm);
  s1.position.set(-0.17, 0.08, 0.05);
  s1.scale.set(1, 0.62, 1.35);
  const s2 = new THREE.Mesh(shoe, sm);
  s2.position.set(0.17, 0.08, 0.05);
  s2.scale.set(1, 0.62, 1.35);
  g.add(s1, s2);
  return g;
}

function buildArms(a) {
  const geo = new THREE.CapsuleGeometry(0.1, 0.34, 4, 12);
  const m = mat(a.skin);
  const sleeve = new THREE.CapsuleGeometry(0.115, 0.16, 4, 12);
  const sm = mat(a.top);

  const makeSide = (side) => {
    // pivot 在肩膀上，抬起才会自然
    const pivot = new THREE.Group();
    pivot.position.set(0.4 * side, 1.12, 0);
    const arm = new THREE.Mesh(geo, m);
    arm.position.set(0.02 * side, -0.24, 0);
    pivot.add(arm);
    const sl = new THREE.Mesh(sleeve, sm);
    sl.position.set(0.02 * side, -0.03, 0);
    pivot.add(sl);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), m);
    hand.position.set(0.02 * side, -0.44, 0);
    pivot.add(hand);
    pivot.rotation.z = -0.16 * side;
    return { pivot, restZ: -0.16 * side };
  };

  const L = makeSide(-1);
  const R = makeSide(1);
  return { left: L, right: R };
}

function buildHair(a, style) {
  const g = new THREE.Group();
  const main = mat(a.hair, { roughness: 0.55 });
  const dark = mat(a.hairDark, { roughness: 0.55 });

  // 头盖 + 刘海：一个略大的球，下半球被"削掉"感通过缩放实现
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.545, 24, 20, 0, Math.PI * 2, 0, Math.PI * 0.62), main);
  cap.position.y = 0.06;
  cap.scale.set(1.03, 1.06, 1.05);
  g.add(cap);

  const bang = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.42), dark);
  bang.position.set(0, 0.02, 0.02);
  bang.scale.set(1.04, 1.0, 1.06);
  g.add(bang);

  if (style === 'twin-tail') {
    const tail = new THREE.CapsuleGeometry(0.16, 0.42, 6, 14);
    for (const side of [-1, 1]) {
      const t = new THREE.Mesh(tail, main);
      t.position.set(0.56 * side, -0.3, -0.06);
      t.rotation.z = 0.55 * side;
      g.add(t);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12), dark);
      tip.position.set(0.72 * side, -0.62, -0.08);
      g.add(tip);
    }
    // 蝴蝶结
    const bow = new THREE.SphereGeometry(0.13, 14, 12);
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(bow, mat('#FFF0F5', { roughness: 0.5 }));
      b.position.set(0.2 * side, 0.34, -0.34);
      b.scale.set(1, 0.7, 0.5);
      b.rotation.z = -0.4 * side;
      g.add(b);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), mat('#FFD6E6'));
    knot.position.set(0, 0.34, -0.36);
    g.add(knot);
  } else if (style === 'spike') {
    // 短刺发：几撮锥体
    const spike = new THREE.ConeGeometry(0.11, 0.3, 10);
    const spots = [
      [0, 0.62, -0.05, 0.0], [-0.3, 0.55, 0.05, -0.4], [0.3, 0.55, 0.05, 0.4],
      [-0.14, 0.6, 0.2, -0.15], [0.16, 0.6, 0.2, 0.15], [0, 0.58, -0.3, 0.0],
    ];
    spots.forEach(([x, y, z, rz]) => {
      const s = new THREE.Mesh(spike, main);
      s.position.set(x, y, z);
      s.rotation.set(-0.15, 0, rz);
      g.add(s);
    });
  } else {
    // glasses：直长发 + 后脑长发
    const longBack = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.6, 6, 16), main);
    longBack.position.set(0, -0.42, -0.16);
    longBack.scale.set(1, 1, 0.6);
    g.add(longBack);

    // 侧边直发
    for (const side of [-1, 1]) {
      const side2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.7, 6, 14), main);
      side2.position.set(0.48 * side, -0.34, 0.06);
      side2.rotation.z = 0.06 * side;
      g.add(side2);
    }
  }
  return g;
}

function buildFace(a, style) {
  const g = new THREE.Group();
  const eyes = [];
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });

  for (const side of [-1, 1]) {
    const grp = new THREE.Group();
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.088, 16, 14), mat(a.eyes, { roughness: 0.25 }));
    pupil.scale.set(0.85, 1.15, 0.7);
    grp.add(pupil);
    const hi = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), white);
    hi.position.set(0.03, 0.045, 0.06);
    grp.add(hi);
    grp.position.set(0.19 * side, 0.03, 0.44);
    g.add(grp);
    eyes.push(grp);
  }

  // 腮红
  const blush = [];
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(
      new THREE.CircleGeometry(0.085, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(a.blush), transparent: true, opacity: 0.5, depthWrite: false })
    );
    b.position.set(0.31 * side, -0.11, 0.4);
    b.rotation.y = 0.45 * side;
    g.add(b);
    blush.push(b);
  }

  // 嘴：一小段圆环，看起来像笑
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(0.055, 0.016, 8, 18, Math.PI),
    mat('#B2566B', { roughness: 0.5 })
  );
  mouth.position.set(0, -0.2, 0.44);
  mouth.rotation.set(0, 0, Math.PI);
  g.add(mouth);

  if (style === 'glasses') {
    const rm = new THREE.MeshStandardMaterial({ color: 0x3d4657, roughness: 0.3, metalness: 0.5 });
    for (const side of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.022, 8, 22), rm);
      r.position.set(0.19 * side, 0.03, 0.45);
      g.add(r);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.022), rm);
    bridge.position.set(0, 0.03, 0.45);
    g.add(bridge);
  }

  return { group: g, eyes, mouth };
}

function buildBody(a, style) {
  const g = new THREE.Group();

  const legs = buildLegs(a);
  g.add(legs);

  // 躯干：矮一点、宽一点，头大身小才是 Q 版比例
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.16, 6, 18), mat(a.top));
  torso.position.y = 0.95;
  torso.scale.set(1, 1, 0.86);
  g.add(torso);

  if (style === 'twin-tail' || style === 'glasses') {
    // 裙：圆台，上窄下宽（用 CylinderGeometry 而不是翻转圆锥，边缘更自然）
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.5, 0.42, 24), mat(a.bottom));
    skirt.position.y = 0.6;
    skirt.scale.set(1, 1, 0.92);
    g.add(skirt);
  } else {
    const pants = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.26, 0.34, 20), mat(a.bottom));
    pants.position.y = 0.6;
    pants.scale.set(1, 1, 0.86);
    g.add(pants);
  }

  // 秘书：领结
  if (style === 'glasses') {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 8, 20), mat('#3A6EA5'));
    collar.position.set(0, 1.16, 0.2);
    collar.rotation.x = 1.1;
    g.add(collar);
  }

  return g;
}

/**
 * 造一个完整角色
 * @returns {{root: THREE.Group, head: THREE.Group, arms: object, face: object, dispose: Function}}
 */
export function buildCharacter(avatar) {
  const root = new THREE.Group();
  const style = avatar.style || 'twin-tail';

  const body = buildBody(avatar, style);
  root.add(body);

  const head = new THREE.Group();
  head.position.y = 1.5;
  root.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 24), mat(avatar.skin));
  skull.scale.set(1, 0.98, 0.94);
  head.add(skull);

  const face = buildFace(avatar, style);
  head.add(face.group);

  const hair = buildHair(avatar, style);
  head.add(hair);

  const arms = buildArms(avatar);
  root.add(arms.left.pivot, arms.right.pivot);

  // 脖子
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.14, 14), mat(avatar.skin));
  neck.position.y = 1.28;
  root.add(neck);

  const dispose = () => {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  };

  return { root, head, arms, face, body, dispose };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

export function createCompanionScene(persona) {
  const avatar = persona.avatar;
  const c = persona.colors;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  // 下面 applyCamera() 会立刻按 CAM_DEFAULT 重新摆位，这里只是初值
  camera.position.set(0, 1.18, 3.25);
  camera.lookAt(0, 1.02, 0);

  // --- 相机轨道 -----------------------------------------------------------
  // 原来相机是写死的（上面那两行），现在改成"球坐标 + 阻尼"：
  //   yaw   绕角色左右转（单指拖空白区）
  //   pitch 上下俯仰
  //   dist  远近（双指捏合）
  //   ty    注视点的高度（双指上下拖 = 画面上下平移）
  // 每个量都有"当前值"和"目标值"，当前值阻尼追目标值 —— 手指一松不会硬停，
  // 会顺着惯性滑一小段再稳住，手感差别很大。
  // dist 4.3 → 3.25：前台现在只剩一条输入条，画面全让给她，
  // 人物要从"站在风景里的小人"变成"占满屏幕的那个人"。
  // 3.25 是按 fov 38° 反推的：可视高度 ≈ 2·d·tan(19°) ≈ 2.24，
  // 人物高约 1.75 → 占屏高约 78%，头顶脚底都还留有余量。
  const CAM_DEFAULT = { yaw: 0, pitch: 0.0372, dist: 3.25, ty: 1.02 };
  const CAM_LIMIT = {
    pitch: [-0.32, 0.78],   // 别让镜头翻到地板下面或者头顶正上方
    dist: [1.9, 7.6],       // 下限也放宽：想贴近看就让人贴
    ty: [0.25, 1.95],
  };
  const cam = { ...CAM_DEFAULT };
  const camTo = { ...CAM_DEFAULT };
  const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));

  function applyCamera() {
    const cp = Math.cos(cam.pitch);
    camera.position.set(
      cam.dist * cp * Math.sin(cam.yaw),
      cam.ty + cam.dist * Math.sin(cam.pitch),
      cam.dist * cp * Math.cos(cam.yaw)
    );
    camera.lookAt(0, cam.ty, 0);
  }
  applyCamera();

  /** 单指拖空白区：绕着角色转。dx/dy 是像素位移。 */
  function orbitByPixels(dx, dy, viewH = 600) {
    // 一屏高度 ≈ 转 100°，横竖一致，不同屏幕尺寸手感也一致
    const k = (Math.PI * 0.55) / viewH;
    camTo.yaw -= dx * k;
    camTo.pitch = clamp(camTo.pitch + dy * k, CAM_LIMIT.pitch);
    return camTo;
  }

  /** 双指捏合。mult > 1 = 拉远，< 1 = 拉近（直接传 旧指距/新指距 就行） */
  function zoomBy(mult) {
    camTo.dist = clamp(camTo.dist * mult, CAM_LIMIT.dist);
    return camTo.dist;
  }

  /** 双指上下拖：平移画面。dy 是像素位移（屏幕坐标，向下为正）。 */
  function panByPixels(dy, viewH = 600) {
    // 往下拖 = 把画面往下推 = 去看更高的地方
    camTo.ty = clamp(camTo.ty + (dy / viewH) * 1.9, CAM_LIMIT.ty);
    return camTo.ty;
  }

  function resetCamera() {
    Object.assign(camTo, CAM_DEFAULT);
  }

  /** 相机是不是被用户动过（用来决定要不要显示"重置视角"按钮） */
  function cameraMoved() {
    return Math.abs(cam.yaw - CAM_DEFAULT.yaw) > 0.05
      || Math.abs(cam.pitch - CAM_DEFAULT.pitch) > 0.02
      || Math.abs(cam.dist - CAM_DEFAULT.dist) > 0.05
      || Math.abs(cam.ty - CAM_DEFAULT.ty) > 0.03;
  }

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6c8dd, 1.15));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2.2, 3.4, 2.6);
  scene.add(key);

  const rim = new THREE.DirectionalLight(new THREE.Color(c.primary), 1.1);
  rim.position.set(-2.4, 1.4, -2.0);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(0, -1, 3);
  scene.add(fill);

  // 脚下的圆盘，给角色一个"站住"的重心
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(c.soft),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.005;
  scene.add(disc);

  // stage 是「待动画容器」：里面放程序化角色，或换成真实 glb 模型，
  // 两种情况下的呼吸/摇晃/弹跳动画代码完全共用。
  const stage = new THREE.Group();
  scene.add(stage);

  const character = buildCharacter(avatar);
  stage.add(character.root);

  // --- 粒子池 ---------------------------------------------------------------
  const heartGeo = new THREE.ExtrudeGeometry(heartShape(), {
    depth: 0.06,
    bevelEnabled: true,
    bevelSize: 0.03,
    bevelThickness: 0.03,
    bevelSegments: 2,
    curveSegments: 8,
  });
  heartGeo.scale(0.013, 0.013, 0.013);
  heartGeo.center();

  const particles = [];
  const MAX_PARTICLES = 36;

  function spawnParticle(kind = 'heart') {
    if (particles.length >= MAX_PARTICLES) return;
    const colorHex = kind === 'heart' ? c.primary : '#FFE27A';
    const mesh = new THREE.Mesh(
      heartGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), transparent: true, opacity: 1 })
    );
    mesh.position.set((Math.random() - 0.5) * 0.7, 1.5 + Math.random() * 0.3, 0.35 + Math.random() * 0.2);
    const scale = 0.7 + Math.random() * 0.6;
    mesh.scale.setScalar(scale);
    scene.add(mesh);
    particles.push({
      mesh,
      vy: 0.75 + Math.random() * 0.5,
      vx: (Math.random() - 0.5) * 0.35,
      spin: (Math.random() - 0.5) * 2.2,
      life: 0,
      max: 1.5 + Math.random() * 0.5,
    });
  }

  // --- 状态 -----------------------------------------------------------------
  let bounce = 0;          // 弹跳
  let headTiltTarget = 0;  // 头部歪（被摸时的撒娇感）
  let headTilt = 0;
  let armRaiseTarget = 0;
  let armRaise = 0;
  let nextBlink = 1.5 + Math.random() * 2.5;
  let blinkPhase = 0;
  let look = { x: 0, y: 0, tx: 0, ty: 0 };
  let shake = 0;
  // 本帧「落地支撑」把根节点移动了多少（负数 = 往下）。调试 / 探针用
  let groundDrop = 0;
  const clock = { last: 0, t: 0 };

  function setLookTarget(x, y) {
    look.tx = Math.max(-1, Math.min(1, x));
    look.ty = Math.max(-1, Math.min(1, y));
  }

  /** 触发反应：pet / poke / levelup / gift */
  function react(kind) {
    if (kind === 'pet') {
      bounce = Math.min(0.34, bounce + 0.16);
      headTiltTarget = (Math.random() - 0.5) * 0.5;
      armRaiseTarget = 0.5 + Math.random() * 0.4;
      if (Math.random() < 0.55) spawnParticle('heart');
    } else if (kind === 'poke') {
      shake = 0.35;
      bounce = Math.min(0.2, bounce + 0.1);
      headTiltTarget = (Math.random() - 0.5) * 0.7;
    } else if (kind === 'gift') {
      bounce = 0.4;
      armRaiseTarget = 1.1;
      for (let i = 0; i < 3; i++) spawnParticle('heart');
    } else if (kind === 'levelup') {
      bounce = 0.5;
      for (let i = 0; i < 6; i++) spawnParticle('sparkle');
    }
  }

  /**
   * 每帧更新
   * @param {number} t 累计时间（秒）
   * @param {number} dt 帧间隔（秒）
   */
  function update(t, dt) {
    // ⚠️ clock.t 必须跟着走 —— speak() 拿它当口型的时间起点（startedAt = clock.t）。
    //    以前它只在上面声明、**从来没被写过**，恒为 0，于是 lips 里
    //      local = t - startedAt = t - 0 = 累计秒数
    //    开 App 两秒之后 local 就远大于句子时长，`local > dur + 0.15` 当场成立，
    //    口型被判定"已经说完了" —— 也就是**嘴从头到尾没跟着话动过**。
    //    看画面看不出来：sighs / laughs 这些**表情**通道还在动，嘴也会因为
    //    待机姿势的笑脸而开合，所以没人发现。
    //    （是 CI #37 的偶发失败一路追出来的：那条断言实测每 8 次红 1 次，
    //     查下去才发现它量到的"嘴"根本不是口型通道在动。）
    clock.t = t;

    // 阻尼 / 回弹
    bounce *= Math.pow(0.0025, dt);        // ~0.86/帧 @60fps
    headTiltTarget *= Math.pow(0.02, dt);
    armRaiseTarget *= Math.pow(0.05, dt);
    shake *= Math.pow(0.0008, dt);

    // 相机：当前值阻尼追目标值（手指松开后还会顺一小段，不会硬停）
    const camK = Math.min(1, dt * 9);
    cam.yaw += (camTo.yaw - cam.yaw) * camK;
    cam.pitch += (camTo.pitch - cam.pitch) * camK;
    cam.dist += (camTo.dist - cam.dist) * Math.min(1, dt * 7);
    cam.ty += (camTo.ty - cam.ty) * camK;
    applyCamera();

    headTilt += (headTiltTarget - headTilt) * Math.min(1, dt * 9);
    armRaise += (armRaiseTarget - armRaise) * Math.min(1, dt * 8);
    look.x += (look.tx - look.x) * Math.min(1, dt * 4);
    look.y += (look.ty - look.y) * Math.min(1, dt * 4);

    const root = stage;      // 待动画容器（可能是程序化角色，也可能是真模型）

    // --- 动作片段：先推一帧，好让下面算根高度时拿到的是**本帧**的根位移 ----
    //
    // 顺序有讲究：motionPlayer.update 既推进时间、也算出本帧的根位移，
    // 必须排在 root.position.y 赋值之前。放在 rig.update 前也行，
    // 但那样根高度会慢一帧 —— 跳舞时表现为脚比上半身晚一帧，肉眼能看出来。
    const playing = motionPlayer.active();
    if (playing) motionPlayer.update(dt);
    // 腿被驱动的片段（跳舞/功夫/跳/翻滚）由动画自己负责下半身：
    // 落地支撑要**让开**，否则它为了把脚钉在地上会把整个人往地里按
    // （实测 Jump_Start 的脚离地 42cm，那是真的在跳，不是飘）。
    const legsDriven = playing && motionPlayer.legsDriven();

    // 呼吸 + 摇晃 + 弹跳 —— 这一层永远作用在容器上，两种角色共用
    //
    // ⚠️ 呼吸幅度从 0.022 降到 0.006。原来 2.2cm 的"呼吸"实际是把**整个人
    //    连脚一起**上下抬，120 帧里脚踝在 0~2.2cm 之间来回 —— 人眼对这个尺度
    //    极其敏感，看到的就是"她浮在地面上"。真人呼吸抬的是胸腔（Spine1 的
    //    pitch 已经在做了），不是整个人。
    const breathe = Math.sin(t * 1.7) * 0.006;

    // 动作片段带来的根位移（米）。缓动过去而不是硬切：
    // 片段开始/结束时目标值会突变，硬切会看到她"掉"一下或"弹"一下。
    const rootYTarget = playing ? (motionPlayer.rootY() || 0) : 0;
    motionRootY += (rootYTarget - motionRootY) * Math.min(1, dt * 9);
    root.position.y = breathe + bounce + motionRootY;
    root.rotation.y = Math.sin(t * 0.45) * 0.13 + look.x * 0.35;
    root.rotation.z = shake * Math.sin(t * 40) * 0.6;

    // 被弹起来时挤压拉长（squash & stretch），这是"手感好"的关键
    const squish = Math.max(0, bounce);
    root.scale.set(1 + squish * 0.09, 1 - squish * 0.12, 1 + squish * 0.09);

    // 眨眼：两种情况下都要算，因为 nextBlink 的计时在这里推进
    let eyeScale = 1;
    nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkPhase = 0.16;
      nextBlink = 2.2 + Math.random() * 3.5;
    }
    if (blinkPhase > 0) {
      blinkPhase -= dt;
      const p = Math.max(0, Math.min(1, blinkPhase / 0.16));
      eyeScale = 0.08 + 0.92 * Math.abs(Math.cos(p * Math.PI));
    }

    if (rig) {
      // --- 真模型：动作交给骨骼驱动 -------------------------------------
      // 注意：容器上的 rotation.y 已经带了 look.x 的转向，所以这里只补"脖子以上"的
      // 余量，否则头会转两倍。
      //
      // 动作片段（跳舞 / 功夫）优先级最高：它在播的时候只更新 poseB 的内容，
      // 待机调度器要让开 —— 不然两边抢同一个 poseB，跳舞会被待机姿势打断。
      // ⚠️ motionPlayer.update(dt) 在上面算根高度之前已经跑过了，别再跑一次。
      rig.update({
        t,
        dt,
        headTilt,
        armRaise,
        lookX: look.x,
        lookY: look.y,
        blinkScale: eyeScale,
        bounce,
      });
      // 待机姿势调度：站着发呆 / 思考 / 加载 各用一套池子，被戳时抢占
      if (!playing) poseSched.update(t, dt);
    } else {
      // --- 程序化角色：转 group（老路径，保持原样）---------------------
      const head = character.head;
      head.rotation.z = Math.sin(t * 0.6) * 0.03 + headTilt + look.x * 0.22;
      head.rotation.x = -look.y * 0.2 + Math.sin(t * 0.9) * 0.015;
      head.rotation.y = look.x * 0.3;

      // 手臂：待机轻摆，被摸时抬起来（像猫被挠下巴）
      const swing = Math.sin(t * 1.3) * 0.06;
      character.arms.left.pivot.rotation.z = character.arms.left.restZ + swing - armRaise;
      character.arms.right.pivot.rotation.z = character.arms.right.restZ - swing + armRaise;
      character.arms.left.pivot.rotation.x = -armRaise * 0.35;
      character.arms.right.pivot.rotation.x = -armRaise * 0.35;

      character.face.eyes.forEach((e) => e.scale.y = eyeScale);
    }

    // --- 表情 + 口型 -----------------------------------------------------
    // 放在骨架之后的最后一步：它只写 morphAttributes，和骨骼旋转互不干扰。
    // 眨眼也走这个出口，避免眨眼和口型两处同时写 eyeBlink 打架。
    //
    // ⚠️ 这里原来写的是 `{ blinkScale: eyeScale }`，而 lipSync 那边解的是
    //    `const { blink: blinkScale } = s` —— **名字对不上**，于是 blink 永远是 1，
    //    眨眼对真模型**从来没有生效过**（只有程序化角色那条 e.scale.y 在动）。
    //    上面那句注释说的"走这个出口"其实一直是空话。
    if (lips) lips.update(t, dt, { blink: eyeScale });

    // MakeHuman 档：表情是**写在骨头上**的（jaw / orbicularis / risorius …），
    // 所以必须排在 rig.update 之后 —— 先让姿势定好头颈，再把表情叠上去。
    // 两边写的是不相交的骨头（makehumanFace 建表时就按名字剔除了 rig.mapping），
    // 顺序只是为了逻辑清晰，不是防冲突。
    if (faceRig) faceRig.update(dt);

    // --- 落地支撑：姿势摆完之后，把根节点钉到「脚正好踩在地上」的高度 ------
    // 顺序很讲究，三步缺一不可：
    //   ① 上面 rig.update / poseSched.update 先把所有骨头摆好
    //   ② 这里量脚骨实际到哪了，算出根节点该待在哪个 y（绝对值，不是增量）
    //   ③ **再跑一次 rig.update**，让骨头在修正后的根节点下重新合成
    // 漏掉 ③ 的话，这一帧渲染的是"新根节点 + 旧骨头世界矩阵"，
    // 视觉上每帧抖一下（脚在正确位置，上半身还是旧的）。
    // rig.update 是纯幂等的（每帧从 rest 世界朝向重算，不累积），重跑代价很小。
    //
    // ☝️ 腿被驱动的动作片段走**有上限**的补偿（见 MOTION_COMP_MAX）：
    //    只抹平"没贴稳"的那几厘米，真正的离地留给她自己跳。
    //    待机 / 说话 / 被戳这些腿锁死的片段没有上限，脚必须死死钉住 ——
    //    那才是"别飘"的场合。
    if (usingModel && groundLock.tracked()) {
      groundDrop = groundLock.update(root.position.y, legsDriven ? MOTION_COMP_MAX : null);
      root.position.y = groundDrop;
    } else {
      groundDrop = 0;
    }
    if (usingModel && groundLock.tracked() && rig) {
      // 但凡是"钉"过的（不管全额还是有上限），根节点都变了，
      // 所以要按新的根节点再合成一次，否则这一帧渲染的是"新根 + 旧骨头"。
      rig.update({
        t, dt, headTilt, armRaise,
        lookX: look.x, lookY: look.y,
        blinkScale: eyeScale, bounce,
      });
    }

    // 粒子
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.rotation.z += p.spin * dt;
      const k = p.life / p.max;
      p.mesh.material.opacity = Math.max(0, 1 - k * k);
      p.mesh.scale.setScalar(Math.max(0.01, p.base * (1 - k * 0.45)));
      if (p.life >= p.max) {
        scene.remove(p.mesh);
        p.mesh.material.dispose();
        particles.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 真实 glb 模型
  // -------------------------------------------------------------------------

  /** 程序化生成的 cel-shading 渐变贴图 —— 不用任何外部图片，所以原生端也能跑 */
  function makeToonGradient() {
    const steps = new Uint8Array([70, 130, 190, 255]); // 4 阶调，卡通渲染的关键
    const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
  const toonGradient = makeToonGradient();
  let usingModel = false;
  // 真模型的骨骼驱动句柄。有它的时候，头部/手臂动作由它负责；
  // 没有（模型没骨架 / 骨名认不出来）就继续用程序化角色的那套转 group 的动画。
  let rig = null;
  // 落地支撑：把「姿势把脚抬起来的高度」从根节点上减掉，脚就永远踩在地上。
  // 只认得了骨架时才有效，程序化角色直接返回 0。
  let groundLock = createGroundLock(null);
  /** 动作片段带来的根位移，缓动后的实际值（米） */
  let motionRootY = 0;
  /**
   * 腿被驱动的动作期间，落地支撑最多补多少米。
   *
   * 为什么不是全额补：那些片段本来就包含离地（跳跃 42cm、翻滚），
   * 全额补等于把"跳起来"翻译成"沉进地板"。
   * 为什么又不完全不补：源模型和我们的角色腿长不完全一样，同样的关节角
   * 到我们身上脚会有 1~2cm 的偏差 —— 这点偏差肉眼看得出来（就是"飘"），
   * 而它远小于真正的离地，所以用 12cm 这条线把两者分开：
   * 线以下当"没贴稳"抹平，线以上当"人家本来就在空中"。
   */
  const MOTION_COMP_MAX = 0.12;
  // 待机姿势调度器。没 rig 的时候是空转的空壳，调用方不用判断。
  // 换姿势时同步把表情也带上（姿势库里写了 face 的才有）——
  // 没写 face 的姿势传 null，表情会过渡回中立，不会一直挂着上一个姿势的笑脸。
  // signature 是这个角色的签名待机姿势（theme.js 的 persona.idlePose）。
  // 她一出场先摆这个，之后在轮换里按概率回来 —— 这样 18 个角色站着的时候
  // 才各自有辨识度，而不是所有人都在同一套随机循环里晃。
  let poseSched = createPoseScheduler(null, {
    signature: persona?.idlePose || null,
    onPose: (p) => setFaceEmotion(p?.face || null),
  });
  // 动作片段播放器（跳舞 / 功夫 / 挥手…）。库是**按需动态加载**的 ——
  // 289KB 的 JSON 不进首屏包，等聊天开始之后再后台拉（见 preloadMotion）。
  // 播片段期间它会接管 poseB，所以下面 update 里要把待机调度器让开。
  let motionPlayer = createMotionPlayer(null);
  // 表情/口型驱动。只在 morph 真接上了之后才有值 —— 没有它就不做表情，
  // 其余一切照常（骨架驱动不依赖它）。
  let lips = null;
  let morphHandle = null;
  // MakeHuman 档专用：眼球绑定句柄（contains measure Map，用于按滑块刷新尺寸）
  let eyeRig = null;
  // MakeHuman 档专用：骨架表情句柄（jaw / orbicularis / risorius …）
  let faceRig = null;
  // 模型的上下边界（attachModel 时量好）。只在**认不出骨架**时才拿它按
  // "头顶 22% 算头"兜底判头/身，有骨架一律走 headLineY()。
  let hitTop = 2.05;
  let hitBottom = 0;
  // 当前挂载的模型根节点。attachParts 需要它：部件要挂进这棵树里，
  // 才能继承 attachModel 算好的缩放/位移，也才能拿到基础骨骼去重新绑定。
  let modelRoot = null;
  // 已经挂上去的部件网格数（调试用）
  let partMeshCount = 0;

  /**
   * 把加载好的 glb 塞进舞台，替掉程序化角色。
   * 统一缩放到目标高度、水平居中、双脚落地，并套上统一的赛璐璐材质。
   */
  function attachModel(object3D, { targetHeight = 2.05, keepTexturedMaterial = true } = {}) {
    const box = new THREE.Box3().setFromObject(object3D);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (!isFinite(size.y) || size.y <= 0) return false;

    const scale = targetHeight / size.y;
    object3D.scale.setScalar(scale);
    object3D.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

    // 统一材质风格：有顶点色就用顶点色，没有就用角色主色调染一层
    object3D.traverse((o) => {
      if (!o.isMesh) return;
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      const hasVertexColor = !!o.geometry?.attributes?.color;

      // 蒙皮网格必须关掉视锥裁剪：包围球是按**绑定姿态**算的，骨骼一动
      // three.js 仍拿旧包围球做判断，结果就是"头一转整个人消失"。
      // 官方 VRM 有 18 个蒙皮网格，这个问题会非常明显。
      if (o.isSkinnedMesh) o.frustumCulled = false;

      // 自带贴图的模型（VRM / 外部 GLB）不能再套 Toon —— 换材质等于把
      // baseColorTexture 一起丢掉，只剩一个纯色剪影。这类模型保留原材质，
      // 它自己就是赛璐璐/卡通着色，风格上反而更统一。
      if (keepTexturedMaterial && src?.map) {
        // 半透明件（发饰、蕾丝这类）默认不写深度会互相穿插，开起来更稳
        if (src.transparent) src.depthWrite = true;
        return;
      }

      o.material = new THREE.MeshToonMaterial({
        color: hasVertexColor
          ? 0xffffff
          : new THREE.Color(src?.color ?? 0xffffff).lerp(new THREE.Color(c.soft), 0.35),
        gradientMap: toonGradient,
        vertexColors: hasVertexColor,
        // side 要继承：这批生成模型标了 doubleSided，改单面会在裙摆、发梢这类薄片上穿帮
        side: src?.side ?? THREE.FrontSide,
      });
    });

    stage.remove(character.root);
    stage.add(object3D);
    usingModel = true;
    modelRoot = object3D;
    partMeshCount = 0;
    // 换模型 = 换骨架，上一具的绑定/表情句柄全部作废。
    // 不清的话 resizeEyes / faceRig.update 会去写已经 dispose 掉的几何。
    eyeRig = null;
    faceRig = null;

    // 有骨架就接上驱动 —— 没骨架返回 null，动画自动退回"转容器"那套
    rig = createRigDriver(object3D);
    if (rig) {
      console.log(
        `[rig] 骨架已接管：${rig.coverage.have.length}/${rig.coverage.have.length + rig.coverage.missing.length} 核心骨` +
        (rig.unknown.length ? `，未识别 ${rig.unknown.length} 根` : '')
      );
    }
    // 换模型 = 换骨架，调度器要重新绑一次，否则还拿着上一具骨架的句柄
    poseSched.rebind(rig);
    motionPlayer.rebind(rig);
    // 落地支撑也要重绑：新骨架的脚骨在世界里的高度完全不同，
    // 用旧基准去减只会把新模型按到地底下。
    //
    // ⚠️ 必须传当前的 root.position.y 当基准线，而且**必须趁姿势还没播之前量**。
    //    此刻刚 attachModel 完，stage.position.y 还是上一次 update 的残值，
    //    而骨头全部处于 rest 姿态 —— 正是量基准的最好时机。
    groundLock.rebuild(rig, stage.position.y);
    motionRootY = 0;

    measureHitBounds();
    return true;
  }

  /**
   * 量「头 / 身子」分界线用的上下边界。
   *
   * ⚠️ 必须量**角色本身**（modelRoot），不能量整个 stage。
   *    舞台里还挂着背景板、地面、灯这些环境物件，它们往往比人高得多
   *    （实测夜景背景板顶到 y=2.63，而角色头顶只有 1.99）。
   *    拿 stage 的盒子去算 headLine = bottom + 78%*(top-bottom)，
   *    分界线会被顶到 2.06 —— **比头顶还高，于是一辈子判不出"摸到头"**，
   *    摸头互动直接失效。这个坑就是这么来的，别改回去。
   */
  function measureHitBounds() {
    const root = modelRoot || stage;
    const wb = new THREE.Box3().setFromObject(root);
    if (isFinite(wb.min.y) && wb.max.y > wb.min.y) {
      hitBottom = wb.min.y;
      hitTop = wb.max.y;
    } else {
      hitBottom = 0; hitTop = 2.05;      // 量不出来就退回程序化角色的默认值
    }

    // 头/身分界线**优先用骨头定位**，包围盒只当兜底。
    // 实测：Shino 的包围盒被顶到 2.63，而她头顶只有 2.06 —— 背景板、裙摆、
    // 发饰任何一种混进包围盒，78% 那条线就会飘到头顶之上，摸头永远判不出来。
    // Neck→Head 两根骨头的世界坐标永远长在脖子和头上，不受这些干扰。
  }

  const _vA = new THREE.Vector3();
  const _vB = new THREE.Vector3();

  /**
   * 「头 / 身子」分界线的世界高度。
   *
   * 优先用 **Neck → Head 两根骨头的当前世界坐标**，包围盒只当兜底：
   *   实测 Shino 的包围盒被顶到 2.63，而她头顶只有 2.06 —— 背景板、裙摆、
   *   发饰任何一种混进包围盒，"头顶 22% 算头"那条线就会飘到头顶之上，
   *   于是**摸头一辈子判不出来**。骨头坐标不受这些干扰。
   *
   * 每次现算而不是挂载时算一次：她一直在做待机动作（呼吸、点头、转头），
   * 骨头是动的，快照会慢慢跑偏。
   */
  function headLineY() {
    const m = rig && rig.mapping;
    const neck = m && m.Neck;
    const head = m && m.Head;
    if (neck && head) {
      const ny = _vA.setFromMatrixPosition(neck.matrixWorld).y;
      const hy = _vB.setFromMatrixPosition(head.matrixWorld).y;
      // 脖子往上一点就算头：再高会把下颌和脖子判成身子，再低会把肩膀算成头
      if (hy > ny) return ny + (hy - ny) * 0.5;
    }
    return hitBottom + (hitTop - hitBottom) * 0.78;
  }

  /**
   * 加载 glb。失败返回 false —— 调用方保持程序化角色，绝不会白屏。
   *
   * @param {string|ArrayBuffer} source
   *   字符串按 url 处理（web 可以用，原生端 file:// 走不通 fetch）；
   *   传 ArrayBuffer 则直接解析，两条平台路径都稳。
   */
  async function loadModel(source) {
    try {
      const loader = new GLTFLoader();
      // 在线专业模型（Ready Player Me / VRoid / 各类 GLB）常带 Draco 压缩，
      // 不开 DRACOLoader 会直接解析失败。解码器走 gstatic CDN（CORS 友好、稳定）。
      // 只对 Draco 模型触发网络，普通模型完全不碰，离线也不受影响。
      try {
        const draco = new DRACOLoader();
        draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
        loader.setDRACOLoader(draco);
      } catch (_) { /* 某些平台没有 DRACOLoader，跳过即可，不影响普通模型 */ }
      const gltf = typeof source === 'string'
        ? await new Promise((resolve, reject) => loader.load(source, resolve, undefined, reject))
        : await new Promise((resolve, reject) => loader.parse(source, '', resolve, reject));
      return attachModel(gltf.scene);
    } catch (e) {
      // ⚠️ 一定要打 stack：GLTFLoader 的报错经常只有一句
      // "Cannot read properties of undefined"，不打栈根本定位不到是哪个结构坏了
      console.warn('[companion] glb 加载失败，继续用程序化角色：', e?.message || e, '\n', e?.stack || '');
      return false;
    }
  }

  /**
   * 给一棵树做「路径 → 节点」索引。
   * 路径就是子节点序号拼起来的串（"0/3/5"），不依赖名字是否唯一。
   */
  function indexPath(root) {
    const map = new Map();
    (function walk(o, p) {
      map.set(p, o);
      o.children.forEach((c, i) => walk(c, p + '/' + i));
    })(root, '');
    return map;
  }

  /**
   * 把「部件」glb（头发 / 衣服）挂到已加载的基础模型（身体）上。
   *
   * 为什么能拼：拆分工具 (tools/glbsplit.mjs) 保留了**完整且完全相同**的
   * node 树和 skin 表，只是摘掉了不想要的 mesh。所以部件里每个 mesh 所在的
   * 节点路径，在基础模型里一定有唯一对应 —— 按路径重新挂回去即可，
   * 不需要猜名字，也不需要骨骼名字匹配。
   *
   * 拼回去之后要做一件事：**重新绑定骨骼**。部件自带一套 Bone 对象，
   * 和基础模型的 Bone 是两套实例，不重绑的话头发/衣服不会跟着身体动。
   * 做法是按骨骼名字换成基础模型的 Bone，boneInverses 原样保留。
   *
   * ⚠️ 部件应当**只包含可换的东西**（衣服 / 头发）。
   *    如果把「裸体」也当成一个部件挂上来，会盖在底座的身体上面 Z-fighting。
   *    所以现在的用法是：底座 = 裸体 + 脸，部件 = 衣服 + 头发。
   *
   * @param {ArrayBuffer[]} sources 每个部件的原始 glb 字节
   * @returns {Promise<number>} 成功挂上的网格数；失败只记 warn，不影响主体
   */
  async function attachParts(sources) {
    if (!usingModel || !modelRoot) {
      console.warn('[parts] 还没有基础模型，部件跳过');
      return 0;
    }
    const baseMap = indexPath(modelRoot);
    const baseBones = new Map();
    modelRoot.traverse((o) => { if (o.isBone) baseBones.set(o.name, o); });

    let n = 0;
    for (const src of sources) {
      try {
        const loader = new GLTFLoader();
        const gltf = await new Promise((resolve, reject) =>
          loader.parse(src, '', resolve, reject)
        );

        // 先把部件里所有网格连同它所在的节点路径收集出来，再统一搬家
        // （边遍历边改父子关系会漏节点）
        const found = [];
        (function walk(o, p) {
          if (o.isMesh || o.isSkinnedMesh) found.push({ obj: o, path: p });
          o.children.forEach((c, i) => walk(c, p + '/' + i));
        })(gltf.scene, '');

        for (const { obj, path } of found) {
          const host = baseMap.get(path) || modelRoot;
          if (obj.parent) obj.parent.remove(obj);

        if (obj.isSkinnedMesh && obj.skeleton) {
          const bones = obj.skeleton.bones.map((b) => baseBones.get(b.name) || b);
          obj.skeleton = new THREE.Skeleton(bones, obj.skeleton.boneInverses);
          obj.bind(obj.skeleton, obj.bindMatrix);
          // ⚠️ bindMatrix 用的是**部件自己的根节点**在它那份文件里的位置。
          //    比如 Shino 拆成 base/outfit/hair 三份时，每份文件里 Face / Body /
          //    Hair001 的 local transform 都是一样的（源文件一个字节没动），
          //    所以直接挂过去就对得上。
          //    但**换过朝向的文件不能混用**：-front 那份把 5 个顶层 root 一起
          //    左乘了 Ry(180°)，拿它当部件、拿未旋转的当底座，衣服会穿到背面去。
          //    parts 和 model 必须来自同一次拆分。
        }
          // 蒙皮网格一律关视锥裁剪（理由同 attachModel）
          obj.frustumCulled = false;
          // 打标：方便调试时把"头发+衣服"整层藏起来，只看底座
          // （Avatar3D.web.js 的 __aivaDebug.hideParts 会读这个标记）
          obj.userData.__aivaPart = true;
          host.add(obj);
          n++;
        }
      } catch (e) {
        console.warn('[parts] 部件 glb 解析失败，跳过：', e?.message || e);
      }
    }

    if (n) {
      partMeshCount += n;
      // 部件可能比身体高（头发）或宽（裙摆），边界要按新整体重算
      measureHitBounds();
      console.log(`[parts] 已挂载 ${n} 个部件网格（累计 ${partMeshCount}）`);
    }
    return n;
  }

  /**
   * 给已挂载的模型贴上一层贴图（由调用方解码好传进来）。
   * glTF 的 UV 原点在左上，DataTexture 默认 flipY=false，两者正好对上，所以不用翻转。
   */
  function applyTexture(texture) {
    if (!usingModel || !texture) return false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    stage.traverse((o) => {
      if (!o.isMesh) return;
      o.material.map = texture;
      o.material.color.set(0xffffff);
      o.material.needsUpdate = true;
    });
    return true;
  }

  /**
   * 把解析好的 morph.json 灌到模型上，并建立口型/表情驱动。
   * 必须在模型挂上来**之后**调用（attachModel 成功之后）。
   *
   * @param {object} data girlfriend.morph.json 解析结果
   * @returns {null | object} morph 句柄
   */
  /** 拿到句柄之后的公共收尾：建口型驱动 + 打日志 */
  function bindMorphHandle(handle, how) {
    if (!handle) return null;
    morphHandle = handle;
    lips = createLipSync(morphHandle, { fade: 0.05, emotionRate: 4 });
    console.log(
      `[morph] 表情已接管（${how}）：${morphHandle.count} 个形状 / ${morphHandle.meshes} 个网格` +
      (lips ? `（口型驱动就绪，${lips.supported()} 个标准动作）` : '')
    );
    return morphHandle;
  }

  /** 走我们生成的 .morph.json（程序化角色：可爱档 / 写实档 / FF 档） */
  function applyMorph(data) {
    if (!usingModel) return null;
    // 换角色时要先把旧的表情驱动扔掉，否则旧 morph 会被继续写（它指向已 disposal 的几何）
    lips = null;
    return bindMorphHandle(applyMorphData(stage, data), 'morph.json');
  }

  /**
   * 走模型自带的 blendshape（外部模型：VRM / 现成 GLB）。
   * 这类模型自己的表情通常更完整，也接不上我们的 morph.json（顶点对不上），
   * 所以直接复用它自带的。
   */
  function applyBuiltinMorph() {
    if (!usingModel) return null;
    lips = null;
    return bindMorphHandle(createBuiltinMorphHandle(stage), '内置 blendshape');
  }

  /**
   * 把眼球重绑到 eye.L / eye.R 骨头上（MakeHuman 档专用）。
   * 眼球是独立 glb、自带 skinIndex 全 0，不重绑的话头一动眼睛就飞走。
   * 必须在 attachParts 之后调 —— 那时眼球才刚被搬进身体这棵树。
   *
   * @returns {null | {bound:number, sides:object, measure:Map}}
   */
  function bindEyes() {
    if (!usingModel || !modelRoot) return null;
    // 眼球在哪：部件的根部是 modelRoot 的子节点，眼球网格带 __aivaPart 标记
    const r = bindMakeHumanEyes(modelRoot, modelRoot);
    if (!r.bound) return null;
    eyeRig = r;
    return r;
  }

  /**
   * 用骨架驱动面部（MakeHuman 档专用，代替 morph）。
   * 它与 rigDriver 会同时写骨架，所以必须把 rigDriver 已接管的骨让出去
   * —— makehumanFace 内部按名字白名单剔除，这里把 rig.mapping 传进去即可。
   */
  function applySkeletalFace() {
    if (!usingModel || !modelRoot) return null;
    lips = null;
    const h = createMakeHumanFace(modelRoot, { bindRig: rig });
    if (!h) return null;
    faceRig = h;
    // 走和 morph 一样的收尾：建口型驱动 + 打日志。
    // 这里必须用「按名字 set」的路径 —— lipSync 会按 ARKit 名逐个 setInfluence，
    // 而骨架表情正好也是按 ARKit 名分通道的，接口天然对齐。
    return bindMorphHandle(h, '骨架表情');
  }

  /**
   * 让角色"说"一句话 —— 只驱动口型，不出声。
   * 音频由 useVoice/tts 那条线负责，两者并行：这里落的是视觉。
   *
   * @param {string} text 要朗读的文本（可含 [laughs] 这类情绪标签）
   * @param {object} [o]
   * @param {string} [o.emotion] 情绪标签（tts.splitByEmotion 的产出）
   * @param {number} [o.speed=1] 与 TTS 的 speed 一致，口型时长才对得上
   * @param {number} [o.at] 起始时间；不传就用当前累计时间
   */
  function speak(text, o = {}) {
    if (!lips) return false;
    return lips.speak(text, { at: o.at ?? clock.t, ...o });
  }

  /** 打断口型（用户抢话、切屏、播放失败时都要调） */
  function stopSpeaking() {
    lips?.stop();
    return !!lips;
  }

  /** 情绪触发的面部表情（不依赖 TTS，纯视觉） */
  function setFaceEmotion(tag) {
    lips?.setEmotion(tag);
    return !!lips;
  }

  // -------------------------------------------------------------------------
  // 戳中判定：戳在角色身上还是戳在空白背景上
  // -------------------------------------------------------------------------
  // ⚠️ 已知限制：three.js r186 的 SkinnedMesh 没有覆写 raycast，命中的是
  //    **绑定姿态**（A-pose 站立）的轮廓。摆姿势时手臂动了对不上，
  //    但躯干和头的位置基本不跑，用来区分"戳头 / 戳身子 / 戳空"够用。
  //    真要做到逐帧精确，得自己拿蒙皮后的顶点算，代价太大，先不做。
  const ray = new THREE.Raycaster();
  const ndc = { x: 0, y: 0 };

  /**
   * @param {number} x NDC 横坐标（-1~1）
   * @param {number} y NDC 纵坐标（-1~1，向上为正）
   * @returns {null | {point:THREE.Vector3, distance:number, part:'head'|'body', object:THREE.Object3D}}
   */
  function hitTest(x, y) {
    ndc.x = x;
    ndc.y = y;
    camera.updateMatrixWorld();
    stage.updateMatrixWorld(true);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(stage, true);
    if (!hits.length) return null;
    const h = hits[0];
    const headLine = headLineY();
    return {
      point: h.point.clone(),
      distance: h.distance,
      part: h.point.y >= headLine ? 'head' : 'body',
      object: h.object,
    };
  }

  // -------------------------------------------------------------------------
  // 待机姿势
  // -------------------------------------------------------------------------

  /** 切换待机状态：idle 站着发呆 / think 在想事 / load 加载等待 */
  function setPoseState(tag) {
    poseSched.setState(tag);
  }

  /**
   * 抢占播一个反应姿势（被戳 / 被摸）
   * @param {string} id idlePoses.js 里的 id，如 'startle' / 'pet-lean'
   */
  function playPose(id) {
    return poseSched.react(id);
  }

  // --- 动作片段（跳舞 / 功夫 / 打拳 / 挥剑 …）------------------------------

  /**
   * 后台加载动作库。289KB 的 JSON，不进首屏包 ——
   * 页面跑起来之后（用户在打字 / 聊天的那几秒）再拉，拉完就能立刻播。
   * 重复调用不会重复加载。
   * @returns {Promise<boolean>} 加载好了吗
   */
  async function preloadMotion() {
    if (motionPlayer.ready()) return true;
    try {
      const mod = await import('../anim/motionClips.json');
      // ESM 的 JSON 模块：metro/webpack 下是 { default: {...} }，node 下也是
      const data = mod.default || mod;
      return motionPlayer.load(data);
    } catch (e) {
      console.warn('[motion] 动作库加载失败：', e?.message || e);
      return false;
    }
  }

  /**
   * 播一个动作。
   * @param {string} id 片段 id（'Dance_Loop' / 'Punch_Jab' …）或用途 tag
   *                    （'dance' / 'kungfu' / 'action' / 'sit'）
   * @returns {Promise<boolean>} 真的播起来了吗
   */
  async function playMotion(id) {
    if (!rig) return false;
    const ok = await preloadMotion();
    if (!ok) return false;
    // 先按具体 id 找，找不到再当用途 tag 随机挑一个
    if (motionPlayer.play(id)) return true;
    return motionPlayer.playTag(id);
  }

  /** 停掉正在播的动作，淡回待机 */
  function stopMotion() {
    motionPlayer.stop();
  }

  function resize(width, height) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    toonGradient.dispose();
    heartGeo.dispose();
    character.dispose();
    disc.geometry.dispose();
    disc.material.dispose();
    // 真模型也要释放：切换角色时如果不清，显存会一路涨上去
    stage.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach((m) => {
        if (!m) return;
        m.map?.dispose();
        m.dispose();
      });
    });
  }

  return {
    scene, camera, resize, update, react, setLookTarget, spawnParticle, dispose,
    loadModel, attachModel, applyTexture,
    attachParts,
    applyMorph, applyBuiltinMorph, speak, stopSpeaking, setFaceEmotion,
    // MakeHuman 档专用：眼球重绑 / 骨架表情 / 按滑块刷新眼球尺寸
    bindEyes, applySkeletalFace,
    resizeEyes: () => resizeMakeHumanEyes(eyeRig, modelRoot),
    hasEyes: () => !!eyeRig,
    getEyeRig: () => eyeRig,
    getFaceRig: () => faceRig,
    // 相机：单指拖空白区转、双指捏合缩放、双指上下拖平移
    orbitByPixels, zoomBy, panByPixels, resetCamera, cameraMoved,
    // 戳中判定 + 待机姿势
    hitTest,
    // 调试用：摸头判不出来的时候先看它 —— 分界线必须落在角色身上。
    // 顺带把「最高的几个网格是谁」列出来：分界线被顶高基本都是某个环境物件
    // （背景板 / 灯 / 地面）混进了包围盒，一看名字就知道是谁。
    hitBounds: () => {
      const r3 = (v) => +v.toFixed(3);
      const boneY = (b) => (b ? r3(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y) : null);
      const m = rig && rig.mapping;
      const live = headLineY();
      return {
        headLine: r3(live),
        source: (m && m.Neck && m.Head) ? 'bone' : 'box',
        bones: m ? { neck: boneY(m.Neck), head: boneY(m.Head) } : null,
        box: { top: r3(hitTop), bottom: r3(hitBottom), boxLine: r3(hitBottom + (hitTop - hitBottom) * 0.78) },
      };
    },
    setPoseState, playPose, isReacting: () => poseSched.isReacting(),
    currentPose: () => poseSched.current(),
    /** 换角色后更新签名姿势（不重建场景时用它） */
    setSignaturePose: (id) => poseSched.setSignature(id),
    signaturePose: () => poseSched.signature(),
    // 动作片段：跳舞 / 功夫 / 打拳 / 挥剑…
    preloadMotion, playMotion, stopMotion,
    motionReady: () => motionPlayer.ready(),
    currentMotion: () => motionPlayer.current(),
    // 落地支撑：footLift = 脚离地多少米（> 0.005 就是肉眼能看出的"飘"）
    groundInfo: () => ({
      footLift: groundLock.footLift(),
      residual: groundLock.residualLift(),
      drop: Number(groundDrop.toFixed(4)),
      rootY: Number(stage.position.y.toFixed(4)),
      baseY: groundLock.baseY(),
      ready: groundLock.ready(),
      tracked: groundLock.tracked(),
      bones: groundLock.bones(),
      rest: groundLock.rest(),
      // 动作片段带来的根位移（探针要断言它真的生效了）
      motionRootY: Number(motionRootY.toFixed(4)),
    }),
    motionLegsDriven: () => motionPlayer.legsDriven(),
    isUsingModel: () => usingModel,
    partCount: () => partMeshCount,
    hasRig: () => !!rig,
    getRig: () => rig,
    hasFace: () => !!lips,
    getFace: () => lips,
    root: stage,
  };
}
