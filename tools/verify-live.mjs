/**
 * 发版后核查：线上 bundle 里到底有没有你刚写的代码。
 *
 * 用法： node tools/verify-live.mjs
 *
 * 只做三件事：抓首页 -> 取 <script src> -> 在 bundle 正文里找标记串。
 * 之所以要单独一个脚本，是因为「push 成功」和「线上是新的」是两件事，
 * 而中间隔着 Actions、Pages 缓存、CDN。
 */
// ⚠️ minifier 会把中文转成 \uXXXX 转义，直接搜中文会全 ✗ —— 必须先转义再搜。
const SITE = 'https://monmonmars.github.io/aiva-companion/';

const esc = (s) => [...s].map((c) => {
  const code = c.codePointAt(0);
  return code > 0x7f ? '\\u' + code.toString(16).padStart(4, '0') : c;
}).join('');

// 每条：线上必须能找到的标记
//
// ⚠️ 别把「静态文本 + {变量}」写成一条来搜。
//    JSX 在编译时会把 <Text>默认舞台 · {x}</Text> 切成 "默认舞台 · " 和 x
//    两个子节点，minifier 之后通常是 "默认舞台 · " 这个字符串**单独存在**
//    但被包在参数里 —— 直接搜「默认舞台 · 」（带尾空格）会 MISS，
//    而实际上代码好好的。所以按**不含尾空格**的最小片段搜。
const MARKS = [
  ['她会这么说话', '示例对白标题'],
  ['默认舞台', '角色默认舞台'],
  ['待机', '签名待机姿势'],
  ['歪头打量', '新加的 head-tilt 姿势名'],
  ['书房暖光', '林秘书的默认舞台'],
  ['海边黄昏', 'Sora 的默认舞台'],
  ['樱花树下', '小柔的默认舞台'],
  ['双手交握', '林秘书的签名待机'],
  ['伸个懒腰', 'Sora 的签名待机'],
  ['服务器没响应', '超时的人话文案（cloudClient.js，auth 和 database 共用一句）'],
];
// ASCII 标识符不需要转义
const ASCII_MARKS = [
  'head-tilt', 'idlePose', 'bgId',
  // 启动路径上的关键改动也要盯：这两个串来自 src/lib/withTimeout.js，
  // 「push 成功」不代表线上跑的是新代码 —— 2026-09-24 就是靠这条才发现
  // 线上耗时没变、自己的归因错了（那 8 秒根本不在 loadSettings 里）。
  'settings-timeout',
  'Promise.race',
  // auth 路径的超时兜底（src/lib/cloudClient.js 的 authCall）。
  // 同一套道理：只有在线上产物里搜到，才算这次改动真的上线了。
  'auth-timeout',
  // database 路径的超时兜底（同文件的 dbCall）。别以为 database 自带超时 ——
  // SDK 建 PostgrestClient 时压根没传 timeout，走的是裸 fetch 那条分支。
  // 少了这个串说明登录成功后的同步/upload 还在裸奔。
  'db-timeout',
];

const res = await fetch(SITE, { headers: { 'User-Agent': 'node' } });
if (!res.ok) { console.log('index', res.status); process.exit(1); }
const html = await res.text();

const m = html.match(/src="([^"]*\.js[^"]*)"/);
if (!m) { console.log('no js bundle found in index.html'); process.exit(1); }
const jsUrl = new URL(m[1], SITE).href;
const jsRes = await fetch(jsUrl, { headers: { 'User-Agent': 'node' } });
const js = await jsRes.text();
console.log('bundle', jsUrl.split('/').pop(), jsRes.status, js.length + ' bytes');

let bad = 0;
for (const [plain, label] of MARKS) {
  const hit = js.includes(esc(plain));
  if (!hit) bad++;
  console.log(`${hit ? 'OK ' : 'MISS'}  ${label}  (${plain})`);
}
for (const a of ASCII_MARKS) {
  const hit = js.includes(a);
  if (!hit) bad++;
  console.log(`${hit ? 'OK ' : 'MISS'}  ${a}`);
}

// 顺带确认静态资源还在
for (const asset of ['espeakng/espeakng.worker.js', 'espeakng/espeakng.worker.data', 'espeakng/espeakng-simple.js']) {
  const r = await fetch(new URL(asset, SITE).href, { headers: { 'User-Agent': 'node' } });
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'OK ' : 'MISS'}  ${asset}  ${r.status}`);
}

console.log(bad === 0 ? '\n线上复查全部命中 ✓' : `\n${bad} 项未命中 ✗`);
process.exit(bad ? 1 : 0);
