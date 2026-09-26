/**
 * 唱歌功能的验证：WAV 是不是合法、有没有真的声音。
 * 「有声占比」是关键指标 —— 如果接近 0% 说明振荡器写错了（静音文件），
 * 用户会点播放然后什么也听不到，而代码看起来毫无破绽。
 *
 * 用法： node tools/songs.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tools', '.tmp-songs.mjs');
fs.copyFileSync(path.join(root, 'src', 'services', 'songs.js'), tmp);
const { renderSong, matchSong, SONG_LIST } = await import('file://' + tmp.replace(/\\/g, '/'));

let fail = 0;
const ck = (c, l, x = '') => {
  console.log(`${c ? '  ✓' : '  ✗'} ${l}${x ? '  ' + x : ''}`);
  if (!c) fail++;
};

console.log(`曲库 ${SONG_LIST.length} 首：${SONG_LIST.join(' / ')}\n`);

// ★★ 0 条闸门：曲库空了的话下面那个循环**一次都不跑**，`fail` 一直保持 0，
//    脚本照样打印「全部通过」。实测过（2026-09-26）：把 SONG_LIST 改成 [] 之后，
//    这里打一行「曲库 0 首：」然后一路走到模糊匹配，最后**靠 matchSong 返回
//    undefined 抛 TypeError 才退出非 0** —— 而那跟"歌有没有声音"毫无关系。
//    也就是说：WAV 头 / 峰值 / 有声占比这三条实质判据被**整批跳过**了。
//    靠崩溃才红是 fragile 的：哪天有人给 matchSong 加个空表兜底（很常见的
//    "健壮性"改法），这里立刻变成静默全绿。所以显式卡死。
ck(SONG_LIST.length > 0, `曲库非空（${SONG_LIST.length} 首）`, '空曲库会让下面每一条 WAV 判据都被跳过；这条自己必须是失败而不是崩溃');

for (const name of SONG_LIST) {
  const song = matchSong(name);
  const uri = renderSong(song);
  const buf = Buffer.from(uri.split(',')[1], 'base64');

  const riff = buf.toString('ascii', 0, 4);
  const wave = buf.toString('ascii', 8, 12);
  const channels = buf.readUInt16LE(22);
  const sr = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);

  let peak = 0;
  let audible = 0;
  for (let i = 44; i < buf.length - 1; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
    if (v > 100) audible++;
  }
  const totalSamples = (buf.length - 44) / 2;
  const seconds = totalSamples / sr;
  const audiblePct = (audible / totalSamples) * 100;

  console.log(`--- ${song.title} ---`);
  ck(riff === 'RIFF' && wave === 'WAVE', 'WAV 头正确');
  ck(channels === 1 && bits === 16 && sr > 8000, '格式：单声道 16bit');
  ck(seconds > 3 && seconds < 60, `时长合理 ${seconds.toFixed(1)}s`);
  ck(peak > 8000 && peak <= 32767, `峰值正常 ${peak}（不静音、不削波）`);
  ck(audiblePct > 60, `有声占比 ${audiblePct.toFixed(0)}%（不是静音文件）`);
  console.log(`      ${(buf.length / 1024).toFixed(0)} KB\n`);
}

console.log('=== 模糊歌名匹配 ===');
const matchCases = [
  ['生日快乐', '生日快乐'],
  ['我想听小星星', '小星星'],
  ['twinkle twinkle', '小星星'],
  ['两只老虎啦', '两只老虎'],
  ['birthday song', '生日快乐'],
];
for (const [q, want] of matchCases) {
  const got = matchSong(q).title;
  ck(got === want, `「${q}」→ ${got}`, got === want ? '' : `应为 ${want}`);
}
// 不写 `.title` 直接链式取属性 —— 曲库为空时 matchSong 返回 undefined，
// 这里是**崩溃**而不是一条 ✗（崩溃也能让退出码非 0，但那是在掩盖上面那条闸门
// 已经失守的事实，而且堆栈里看不出到底哪条判据没跑到）。
const rnd = matchSong('随便来一首')?.title;
ck(!!rnd, `说不出歌名时随机给一首 → ${rnd ?? '(空)'}`, '曲库为空时这里也必须是一条失败，不是崩溃');

fs.unlinkSync(tmp);
console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✗`);
process.exit(fail === 0 ? 0 : 1);
