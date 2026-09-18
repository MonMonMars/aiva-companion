// 3D 伴侣角色：几何构建 + 动画 + 粒子
// ---------------------------------------------------------------------------
// 纯 three.js，不碰任何 DOM API —— 所以 web（canvas）和 native（expo-gl）能共用同一份。
// 形象用几何体程序化搭建：不用下载模型文件，体积小、启动快、绝对不会因为资源加载失败而白屏。
// 想换成真正的 .glb / .vrm 模型，见 README 里的「替换真模型」一节。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
  camera.position.set(0, 1.18, 4.3);
  camera.lookAt(0, 1.02, 0);

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
    // 阻尼 / 回弹
    bounce *= Math.pow(0.0025, dt);        // ~0.86/帧 @60fps
    headTiltTarget *= Math.pow(0.02, dt);
    armRaiseTarget *= Math.pow(0.05, dt);
    shake *= Math.pow(0.0008, dt);

    headTilt += (headTiltTarget - headTilt) * Math.min(1, dt * 9);
    armRaise += (armRaiseTarget - armRaise) * Math.min(1, dt * 8);
    look.x += (look.tx - look.x) * Math.min(1, dt * 4);
    look.y += (look.ty - look.y) * Math.min(1, dt * 4);

    const root = stage;      // 待动画容器（可能是程序化角色，也可能是真模型）
    const head = character.head;

    // 呼吸 + 摇晃 + 弹跳
    const breathe = Math.sin(t * 1.7) * 0.022;
    root.position.y = breathe + bounce;
    root.rotation.y = Math.sin(t * 0.45) * 0.13 + look.x * 0.35;
    root.rotation.z = shake * Math.sin(t * 40) * 0.6;

    // 被弹起来时挤压拉长（squash & stretch），这是"手感好"的关键
    const squish = Math.max(0, bounce);
    root.scale.set(1 + squish * 0.09, 1 - squish * 0.12, 1 + squish * 0.09);

    // 头部
    head.rotation.z = Math.sin(t * 0.6) * 0.03 + headTilt + look.x * 0.22;
    head.rotation.x = -look.y * 0.2 + Math.sin(t * 0.9) * 0.015;
    head.rotation.y = look.x * 0.3;

    // 手臂：待机轻摆，被摸时抬起来（像猫被挠下巴）
    const swing = Math.sin(t * 1.3) * 0.06;
    character.arms.left.pivot.rotation.z = character.arms.left.restZ + swing - armRaise;
    character.arms.right.pivot.rotation.z = character.arms.right.restZ - swing + armRaise;
    character.arms.left.pivot.rotation.x = -armRaise * 0.35;
    character.arms.right.pivot.rotation.x = -armRaise * 0.35;

    // 眨眼
    nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkPhase = 0.16;
      nextBlink = 2.2 + Math.random() * 3.5;
    }
    if (blinkPhase > 0) {
      blinkPhase -= dt;
      const p = Math.max(0, Math.min(1, blinkPhase / 0.16));
      const s = 0.08 + 0.92 * Math.abs(Math.cos(p * Math.PI));
      character.face.eyes.forEach((e) => e.scale.y = s);
    } else {
      character.face.eyes.forEach((e) => e.scale.y = 1);
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

  /**
   * 把加载好的 glb 塞进舞台，替掉程序化角色。
   * 统一缩放到目标高度、水平居中、双脚落地，并套上统一的赛璐璐材质。
   */
  function attachModel(object3D, { targetHeight = 2.05 } = {}) {
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
    return true;
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
      const gltf = typeof source === 'string'
        ? await new Promise((resolve, reject) => loader.load(source, resolve, undefined, reject))
        : await new Promise((resolve, reject) => loader.parse(source, '', resolve, reject));
      return attachModel(gltf.scene);
    } catch (e) {
      console.warn('[companion] glb 加载失败，继续用程序化角色：', e?.message || e);
      return false;
    }
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
    isUsingModel: () => usingModel,
    root: stage,
  };
}
