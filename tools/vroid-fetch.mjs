// 下载 VRoid CC0 sample 模型（官方 FAQ 明确 CC0：base + 除 A/B/C 外的 sample）
// 来源 https://opengameart.org/content/vroid-studio-cc0-models
// 授权原始声明 https://vroid.pixiv.help/hc/en-us/articles/4402614652569
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'C:/Users/Simon Lai/WorkBuddy/2026-09-18-15-55-01/llm-companion/_vendor/vroid';
fs.mkdirSync(OUT, { recursive: true });

const FILES = [
  'base_female.zip',
  'sendagaya_shino.zip',
  'sakurada_fumiriya.zip',
  'avatarsample_d.zip',
  'avatarsample_e.zip',
  'avatarsample_f.zip',
  'avatarsample_g.zip',
];

for (const f of FILES) {
  const dst = path.join(OUT, f);
  if (fs.existsSync(dst)) { console.log('已有 ' + f); continue; }
  const url = 'https://opengameart.org/sites/default/files/' + f.replace('.zip', (f.startsWith('avatarsample_d.zip') ? '_0' : '') + '.zip');
  process.stdout.write('下载 ' + f + ' ... ');
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.log('HTTP ' + res.status); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dst, buf);
    console.log((buf.length / 1048576).toFixed(2) + ' MB');
  } catch (e) { console.log('失败 ' + e.message); }
}
console.log('\n目标目录: ' + OUT);
for (const f of fs.readdirSync(OUT)) console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(2) + ' MB');
