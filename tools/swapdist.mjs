// 把 expo export 出来的 dist2 换成正式 dist
// ---------------------------------------------------------------------------
// 为什么要绕这一步：直接 `expo export --platform web`（默认输出到 dist）
// 实测会卡住不退出（10 分钟零输出，被 SIGTERM 掉，dist 根本没被重写）。
// 换 `--output-dir dist2` 同样的代码 1.2 秒就导完了，所以改成"导到 dist2 → 换过来"。
// 用法: node tools/swapdist.mjs [新产物目录]  默认是 dist2

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/';
const NEWNAME = process.argv[2] || 'dist2';
const OLD = path.join(ROOT, 'dist');
const NEW = path.join(ROOT, NEWNAME);
// 旧产物按批次留档：统一叫 dist-old 会互相覆盖，回滚时找不到上一版
const BAK = path.join(ROOT, NEWNAME + '-deployed');

if (!fs.existsSync(path.join(NEW, 'index.html'))) {
  console.error('dist2/index.html 不存在 —— 先跑 expo export --platform web --output-dir dist2');
  process.exit(1);
}

// 旧的先挪到 dist-old（不直接删，导出物是可再生的但留一手更省心），再换名
if (fs.existsSync(BAK)) fs.rmSync(BAK, { recursive: true, force: true });
if (fs.existsSync(OLD)) fs.renameSync(OLD, BAK);
fs.renameSync(NEW, OLD);

// ⚠️ 别把目录名写死在日志里：换成 dist-gemini / dist-world 时这句会照旧打印
//    "dist ← dist2 … dist-old"，看着像没生效，排查时白白绕一圈。
console.log(`dist ← ${NEWNAME} 完成；旧产物留在 ${NEWNAME}-deployed`);
const s = fs.statSync(path.join(OLD, 'index.html'));
console.log('  index.html', s.size, 'bytes');
