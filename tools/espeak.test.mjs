/**
 * eSpeak 离线兜底引擎的回归测试。
 *
 * 这块最容易踩的坑（2026-09 真踩过）：
 *   eSpeak-ng 里粤语的「嗓音名」是 'zhy'，不是 BCP-47 的 'yue'。
 *   写错码（写成 yue）引擎拿不到粤语嗓音，会静默回落到默认英文嗓音，听感全错。
 * 本测试做两件事：
 *   1. 守住 VOICE_FOR 的映射（zh-hk/yue → zhy），防止这个 bug 复发；
 *   2. 确认 public/espeakng/ 下的 4 个 WASM 资源真的在、且不是空文件
 *      （少了任何一个，离线兜底就会失败并回落浏览器语音）。
 *
 * 纯文件系统 + 模块导入，不依赖浏览器/网络，本机就能跑：
 *    node tools/espeak.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// espeak.js 只在函数内部引用 window，模块顶层只定义常量/函数，node 里 import 安全
const espeakUrl = 'file://' + path.join(root, 'src', 'voice', 'espeak.js').replace(/\\/g, '/');
const { VOICE_FOR } = await import(espeakUrl);

let fail = 0;
const ck = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '\n      ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('=== eSpeak 粤语嗓音码（防 yue→zhy 回归）===');
ck(VOICE_FOR['zh-hk'] === 'zhy', 'zh-hk → zhy', `实际: ${VOICE_FOR['zh-hk']}`);
ck(VOICE_FOR['yue'] === 'zhy', 'yue → zhy', `实际: ${VOICE_FOR['yue']}`);
ck(VOICE_FOR['zh-cn'] === 'zh', 'zh-cn → zh（普通话）', `实际: ${VOICE_FOR['zh-cn']}`);
ck(VOICE_FOR['en-us'] === 'en', 'en-us → en', `实际: ${VOICE_FOR['en-us']}`);

console.log('\n=== public/espeakng/ 资源齐全且非空 ===');
const need = [
  ['espeakng-simple.js', 1000, 'SimpleTTS 包装器'],
  ['espeakng.min.js', 500, '原始 eSpeakNG loader（兜底）'],
  ['espeakng.worker.js', 100000, 'Worker 主逻辑 (~776KB)'],
  ['espeakng.worker.data', 1000000, '语言数据包 (~2.5MB，含 zhy 粤语)'],
];
for (const [f, min, note] of need) {
  const p = path.join(root, 'public', 'espeakng', f);
  if (!fs.existsSync(p)) {
    ck(false, `${f} 存在（${note}）`, '文件缺失');
  } else {
    const sz = fs.statSync(p).size;
    ck(sz >= min, `${f} 非空（${note}）`, `${sz}B，阈值 ${min}B`);
  }
}

console.log('\n=== worker.data 含粤语嗓音 zhy ===');
const dataPath = path.join(root, 'public', 'espeakng', 'espeakng.worker.data');
if (fs.existsSync(dataPath)) {
  const buf = fs.readFileSync(dataPath);
  const has = buf.includes(Buffer.from('zhy'));
  ck(has, '数据包含 zhy（粤语）', has ? '已确认' : '未找到 zhy，离线兜底会念错语言');
} else {
  ck(false, '数据包含 zhy（粤语）', 'worker.data 不存在');
}

console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✗`);
process.exit(fail === 0 ? 0 : 1);
