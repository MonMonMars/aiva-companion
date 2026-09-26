/**
 * 发版后核查：线上 bundle 里到底有没有你刚写的代码。
 *
 * 用法： node tools/verify-live.mjs [--url <网址>]
 *
 * 只做三件事：抓首页 -> 取 <script src> -> 在 bundle 正文里找标记串。
 * 之所以要单独一个脚本，是因为「push 成功」和「线上是新的」是两件事，
 * 而中间隔着 Actions、Pages 缓存、CDN。
 *
 * ⚠️ `--url` 是后来补的，补的是「同一个网址被写在两处、各写各的」：
 *    CI 的 deploy job 里有两个步骤都要打线上 —— 这一步原本**写死**网址，
 *    而下面「线上冒烟」那步用的是 `${{ steps.deployment.outputs.page_url }}`。
 *    仓库一改名，baseUrl 会跟着变、page_url 也会变，**唯独这个写死的不会变**：
 *    于是「核查线上产物」会一直去查旧站点，而且查得通 —— 静默的假绿。
 *    现在两边都用同一个来源（page_url），写死的只剩手工跑时的默认值。
 */
// ⚠️ minifier 会把中文转成 \uXXXX 转义，直接搜中文会全 ✗ —— 必须先转义再搜。
const DEFAULT_SITE = 'https://monmonmars.github.io/aiva-companion/';
const argUrl = (() => { const i = process.argv.indexOf('--url'); return i >= 0 ? process.argv[i + 1] : null; })();
// `--expect-bundle <文件名>`：本次构建产出的主 bundle 名字（带内容哈希）。
// 不传的话这一步只能验「线上有这些字符串」，**验不了「线上是这一版」** ——
// 那些标记串旧包里也全有，于是 CDN 发着旧包它照样报「全部命中」。
const argBundle = (() => {
  const i = process.argv.indexOf('--expect-bundle');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  // ★ 传了 flag 却没拿到值（CI 里多半是 build job 的 outputs 没接上、展开成空串）
  //   **必须报错**，不能退回下面那个「验不了版本」的分支 —— 那正是这次要堵的洞。
  if (!v) {
    console.log('✗ --expect-bundle 后面没有值 —— 多半是 build job 的 outputs 没传过来，这条检查不能就这么放过。');
    process.exit(1);
  }
  return v;
})();
// 补尾斜杠：`new URL(相对路径, SITE)` 的结果取决于 SITE 是目录还是文件
const SITE = (argUrl || DEFAULT_SITE).replace(/\/?$/, '/');

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
  // STT / TTS 那批对外请求（src/lib/netFetch.js）—— 这次是核心交互，
  // 卡住的是麦克风本身，所以更要确认它上线了。
  'net-timeout',
];

// 每次都把核查目标打出来 —— 否则「它到底查了哪个网址」只能去读代码才知道，
// 而写死的那个一旦过时，日志上看着还是一切正常（静默的假绿）。
console.log(`核查的是：${SITE}`);
if (argUrl && argUrl !== DEFAULT_SITE) {
  console.log(`⚠️ 传进来的网址和脚本里写死的默认值 ${DEFAULT_SITE} 不一样 —— 默认值过时了，顺手改掉（它只影响手工跑时的默认目标）`);
}

const res = await fetch(SITE, { headers: { 'User-Agent': 'node' } });
if (!res.ok) { console.log('index', res.status); process.exit(1); }
const html = await res.text();

const m = html.match(/src="([^"]*\.js[^"]*)"/);
if (!m) { console.log('no js bundle found in index.html'); process.exit(1); }
const jsUrl = new URL(m[1], SITE).href;
const jsRes = await fetch(jsUrl, { headers: { 'User-Agent': 'node' } });
const js = await jsRes.text();
console.log('bundle', jsUrl.split('/').pop(), jsRes.status, js.length + ' bytes');

// ★ 一条标记都没有时**不许报通过** —— 那不是"全部命中"，是"这回什么都没比对"
//   （第 71 / 75 条那一族：扫描式检查是"扫到什么对什么"）。
if (MARKS.length + ASCII_MARKS.length === 0) {
  console.log('✗ MARK 清单是空的 —— 这条检查等于没验，别当成通过。');
  process.exit(1);
}

let bad = 0;

// ★ 这一版 vs 线上那一版：名字（内容哈希）对不上就是还没刷到，重试循环才有意义
const gotBundle = jsUrl.split('/').pop();
if (argBundle) {
  const same = gotBundle === argBundle;
  if (!same) bad++;
  console.log(`${same ? 'OK  ' : 'MISS'}  这一版的主 bundle  ${gotBundle}${same ? '' : `  ← 线上还是旧的，等的是 ${argBundle}`}`);
} else {
  console.log(`⚠️ 没传 --expect-bundle：只能验「线上有这些字符串」，**验不了「线上是这一版」**（${gotBundle}）—— 手工跑可以，CI 里必须传。`);
}

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
