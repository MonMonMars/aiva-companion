// 下载 MakeHuman 官方 CC0 素材包（files2 镜像优先，files 备援）
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OUT = process.argv[2] || 'C:/Users/Simon Lai/AppData/Local/Temp/mh-packs';
const packs = process.argv.slice(3);
if (!packs.length) {
  console.log('usage: node mh-getpack.mjs <outdir> <pack...>');
  console.log('e.g.   node mh-getpack.mjs <outdir> hair01 eyebrows01 eyelashes01');
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const BASES = [
  'https://files2.makehumancommunity.org/asset_packs',
  'https://files.makehumancommunity.org/asset_packs',
];

const UA = { 'User-Agent': 'aiva-mh/1.0' };

for (const pack of packs) {
  const dest = `${OUT}/${pack}_cc0.zip`;
  if (existsSync(dest) && statSync(dest).size > 10000) {
    console.log(`skip ${pack} (already ${(statSync(dest).size / 1048576).toFixed(2)} MB)`);
    continue;
  }
  let ok = false;
  for (const b of BASES) {
    const url = `${b}/${pack}/${pack}_cc0.zip`;
    try {
      const head = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow' });
      const len = Number(head.headers.get('content-length') || 0);
      console.log(`${pack}: ${head.status} ${(len / 1048576).toFixed(2)} MB  <- ${b}`);
      if (!head.ok) continue;
      const res = await fetch(url, { headers: UA, redirect: 'follow' });
      if (!res.ok || !res.body) continue;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      const got = statSync(dest).size;
      console.log(`  saved ${(got / 1048576).toFixed(2)} MB -> ${dest}`);
      ok = got > 10000;
      if (ok) break;
    } catch (e) {
      console.log(`  fail ${b}: ${e.message}`);
    }
  }
  if (!ok) console.log(`!! ${pack} FAILED`);
}
console.log('done');
