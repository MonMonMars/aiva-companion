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
const rnd = matchSong('随便来一首').title;
ck(!!rnd, `说不出歌名时随机给一首 → ${rnd}`);

fs.unlinkSync(tmp);
console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✗`);
process.exit(fail === 0 ? 0 : 1);
