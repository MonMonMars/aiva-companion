/**
 * 静态检查：src/ 下不许出现未经包装的网络请求。
 *
 * 为什么要有这条 lint（不是形式主义，是被同一个 bug 打了五遍）：
 *   2026-09-25 一天之内，同一个形态的缺陷在 auth、database、STT/TTS、
 *   llm.js、services/web.js、lib/region.js 六个地方被先后发现 ——
 *   全是「对外请求没有兜底」或「兜底只有 AbortSignal 一层」。
 *   靠"下次写的时候记得"是守不住的（前五次写的时候也没人想漏），
 *   所以改成**结构上就不可能遗漏**：新增任何裸 fetch 都在这条检查上红。
 *
 * 判据很简单：只有白名单里的文件允许出现 `fetch(`。白名单每个条目都写清了
 *   它那些裸调用在干什么 —— 全是**读本机 / 读包内资源**，不是网络请求。
 *   外面所有对外的 HTTP 调用必须走 src/lib/netFetch.js（signal + Promise.race 两层）。
 *
 * 用法：node tools/lint-net-calls.mjs [要扫的目录，默认 src]
 *
 * ⚠️ 只管**应用代码**（src/）。tools/ 下那批一次性脚本是开发过程产物，
 *    不少直接 fetch 本地预览服务器，把它们算进来只会让人学会忽略这条检查。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'src';

/**
 * 白名单：文件 → { 允许几处裸 fetch, 为什么 }
 * ⚠️ 数量是钉死的 —— 这里的每一处都被逐行确认过是本地读取。
 *   数字变了说明有人新增了裸调用，那就是这次改动该被问一句的地方。
 */
const ALLOW = {
  // 键统一按「相对 src/」写 —— 用户传 '.' 或传 'src' 都能对上
  'lib/netFetch.js': { n: Infinity, why: '它自己就是包装器' },
  'voice/stt.js': { n: 6, why: '读本地录音 Blob（移动端读文件可能慢，刻意不加超时）' },
  'lib/assetBytes.js': { n: 1, why: '读包内资源；原生端走 FileSystem，只有 web 用 fetch' },
};

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 数一下"真正的调用"，注释里提 fetch 的不算 */
function countFetchCalls(src) {
  // 先整块去掉 /* … */（含那种一行写完的 /** xxx */ ——
  // 只按"行首是 *"过滤会漏掉它，把 stt.js 里一句文档注释当成了一次调用），
  // 再去掉行尾 // 注释；但不能动 https:// 里的那两个斜杠。
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .filter((l) => /\bfetch\s*\(/.test(l)).length;
}

const files = walk(ROOT);

// ★ 扫到 0 个文件时**不许报通过** —— 那不是"没问题"，是"这条检查什么都没验"。
//   同款洞在 lint-ci-refs 里出现过（SKILL 第 71 条）：扫描式检查是"扫到什么对什么"，
//   一旦收集文件的环节失效（目录搬走、扩展名改成 .mjs —— `\.(js|jsx|ts|tsx)$`
//   并不匹配 .mjs），它就会一声不吭地绿过去，比没有这条检查更糟：
//   它让人以为"没人敢写裸 fetch"这件事有人守着。
if (files.length === 0) {
  console.log(`✗ 一个文件都没扫到（目录：${ROOT}）—— 这条检查等于没跑，别当成通过。`);
  console.log('    多半是源码目录搬走了，或者扩展名不在 (js|jsx|ts|tsx) 里。');
  process.exit(1);
}

let bad = 0;

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const key = rel.startsWith('src/') ? rel.slice(4) : rel;
  const n = countFetchCalls(fs.readFileSync(f, 'utf8'));
  const rule = ALLOW[key];

  if (!rule) {
    if (n > 0) {
      bad++;
      console.log(
        `✗ ${rel}\n    有 ${n} 处裸 fetch，但不在这个文件的白名单里。\n` +
          '    对外的网络请求请走 src/lib/netFetch.js（signal + Promise.race 两层）；\n' +
          '    如果是读本机文件且刻意不加超时，把它加进 tools/lint-net-calls.mjs 的 ALLOW 并写明理由。'
      );
    }
    continue;
  }

  if (n > rule.n) {
    bad++;
    console.log(
      `✗ ${rel}\n    白名单允许 ${rule.n === Infinity ? '任意' : rule.n} 处裸 fetch（${rule.why}），实际 ${n} 处。\n` +
        '    新的对外请求请走 src/lib/netFetch.js。'
    );
  }
}

console.log(bad ? `\n裸网络请求检查：${bad} 处需要处理（共扫 ${files.length} 个文件）` : `\n裸网络请求检查通过 ✓（共扫 ${files.length} 个文件）`);
process.exit(bad ? 1 : 0);
