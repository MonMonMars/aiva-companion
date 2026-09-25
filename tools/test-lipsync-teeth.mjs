// test-lipsync-teeth.mjs —— 验「口型」那两条断言自己有没有牙齿
// ===========================================================================
// 要挡的事：pipeline.test.mjs 里这两条断言被人**放宽**。
//   A) 「speak 之后口型通道真的在驱动嘴」  —— 防止又变回"对全部权重取 max"，
//      那样待机姿势的笑脸就能把它喂过（实测：表情贡献 0.399，口型其实一动没动）。
//   B) 「stopSpeaking 后口型通道归零」      —— 防止又变回"量 jawOpen / mouthSmile"，
//      那样待机姿势随机换到一个笑脸时就飘红（实测 40 次红 5 次）。
//
// 破坏场景（两处都是真出过的事故，不是随便挑的）：
//   破坏 1：去掉 `clock.t = t` —— 口型起点恒为 0，句子当场被判定"说完了"，
//           嘴从头到尾不动。**这正是线上真实的 bug**，修它之前没人发现，
//           因为旧断言被表情混过去了。
//   破坏 2：把 stopSpeaking 里的 `lips?.stop()` 注掉 —— 打断不停，嘴继续动。
//   期望：两次 pipeline.test.mjs 都必须**失败**，且失败在对应那条断言上。
//
// 为什么要常驻（和第 19 / 20 步同一个理由）：断言被放宽时，"所有测试照旧全绿"
// 是最容易出现的假象。写在文件注释里的「改完记得重跑」不会提醒任何人。
//
// ⚠️ 它会**临时改 src/three/companion.js** 再改回来。三条安全措施：
//    1) 动手前先把原件写到 .bak；
//    2) 每轮开头先看有没有遗留的 .bak —— 上一轮要是被杀，先把破坏还原掉，
//       绝不让改坏的源码留在盘上（改坏的源码比这一步红麻烦得多）；
//    3) 每轮都是 try/finally 还原。
//
// 用法：node tools/test-lipsync-teeth.mjs [项目根]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.argv[2] || '.');
const FILE = path.join(ROOT, 'src', 'three', 'companion.js');
const BAK = FILE + '.bak';

const orig = fs.readFileSync(FILE, 'utf8');
// ⚠️ 别把目标路径写进辅助函数里（第一版就栽在这）：
//    `const write = (s) => fs.writeFileSync(FILE, s)` 看着省事，
//    可 `write(BAK, orig)` 会**静默丢掉第二个参数**，把备份路径当内容写进源码
//    —— 源码瞬间变成一行路径字符串，子进程报 SyntaxError，
//    而这一步拿到的是"退出码非 0"，差点被误判成"断言咬住了"。
//    写入辅助函数必须显式带路径参数。
const write = (p, s) => fs.writeFileSync(p, s);

// 兜底还原：上一轮要是中途被杀（Ctrl+C / 超时），.bak 会留在盘上
if (fs.existsSync(BAK)) {
  console.log('  ⚠️ 发现上次遗留的备份，先还原（说明上一轮没走完就退出了）');
  write(FILE, fs.readFileSync(BAK, 'utf8'));
  fs.unlinkSync(BAK);
}

function runPipeline() {
  const r = spawnSync(process.execPath, ['tools/pipeline.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  return { code: r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const results = [];
function break_(label, from, to, mustFailOn) {
  const patched = orig.replace(from, to);
  if (patched === orig) {
    results.push([false, `${label}：没找到要破坏的那行（源码改过了？）`]);
    return;
  }
  try {
    write(BAK, orig);
    write(FILE, patched);
    const r = runPipeline();
    const hit = r.out.includes(mustFailOn);
    if (!hit) {
      // 破坏没生效、或者源码被改到跑不起来 —— 都得说清楚，
      // 否则这一步会拿"退出码非 0"冒充"断言咬住了"。
      console.log('    [没咬住] 完整输出：\n' + r.out.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    }
    results.push([r.code !== 0 && hit,
      `${label}：退出码 ${r.code}，且失败在「${mustFailOn}」上`]);
  } finally {
    // ★ 无论发生什么都要还原
    write(FILE, orig);
    if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  }
}

console.log('  破坏 1：去掉 clock.t = t（口型起点恒为 0，嘴不会动）');
break_('破坏 1', '    clock.t = t;\n', '', '口型通道真的在驱动嘴');

console.log('  破坏 2：stopSpeaking 不真的停（打断不停）');
break_('破坏 2', '    lips?.stop();', '    /* 故意破坏：不真的停 */', 'stopSpeaking 后口型通道归零');

const bad = results.filter(([ok]) => !ok);
if (bad.length) {
  console.log(`\n[lip-teeth] FAIL — ${bad.map(([, n]) => n).join('；')}`);
  console.log('  也就是说：破坏已经造出来了，断言却没咬住 —— 它已经失去拦截能力。');
  process.exit(1);
}
console.log(`\n[lip-teeth] PASS — ${results.map(([, n]) => n).join('；')}`);
console.log(`  源码已还原：${fs.readFileSync(FILE, 'utf8') === orig ? '与原始一致 ✓' : '★ 不一致！请检查'}`);
