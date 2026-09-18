/**
 * 情绪分段 + 去标签的回归测试。
 *
 * 这块是整个「说话有情绪」的地基：分段分错了，后面合成得再好也是错的。
 * 而且它纯字符串处理、不依赖网络和设备，所以能在本机就测干净。
 *
 * 用法： node tools/tts.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tools', '.tmp-tts.mjs');
fs.copyFileSync(path.join(root, 'src', 'voice', 'tts.js'), tmp);
const { splitByEmotion, stripEmotionTags, EMOTIONS } = await import('file://' + tmp.replace(/\\/g, '/'));

let fail = 0;
const ck = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '\n      ' + extra : ''}`);
  if (!cond) fail++;
};
const norm = (segs) => segs.map((s) => `${s.text}|${s.emotion ?? '-'}`);

console.log(`情绪表 ${EMOTIONS.length} 种：${EMOTIONS.map((e) => e.tag).join(', ')}\n`);
console.log('=== 分段规则：标签管它后面的文字 ===');

const cases = [
  {
    in: '哈哈哈 [laughs] 你这个问题问得好！[excited] 答案是：因为地球是圆的。',
    want: ['哈哈哈|-', '你这个问题问得好！|laughs', '答案是：因为地球是圆的。|excited'],
  },
  { in: '[laughs] 哈哈哈，你这个问题问得好！', want: ['哈哈哈，你这个问题问得好！|laughs'] },
  { in: '[gentle]（轻轻拍拍你）别怕，我在呢。', want: ['（轻轻拍拍你）别怕，我在呢。|gentle'] },
  { in: '这句话没有标签，应该整段保留。', want: ['这句话没有标签，应该整段保留。|-'] },
  { in: '[sighs] 好吧。', want: ['好吧。|sighs'] },
  { in: '[laughs][giggles] 连续两个标签。', want: ['连续两个标签。|giggles'] },
  { in: '前面[giggles]中间[sing]后面', want: ['前面|-', '中间|giggles', '后面|sing'] },
  { in: '', want: [] },
];

for (const c of cases) {
  const got = norm(splitByEmotion(c.in));
  ck(
    JSON.stringify(got) === JSON.stringify(c.want),
    `分段 ${JSON.stringify(c.in).slice(0, 44)}`,
    JSON.stringify(got) === JSON.stringify(c.want) ? '' : `得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(c.want)}`
  );
}

console.log('\n=== 未知标签必须被吃掉，不能念出来 ===');
ck(
  JSON.stringify(norm(splitByEmotion('你好 [xyz123] 呀'))) === JSON.stringify(['你好|-', '呀|-']),
  '[xyz123] 被丢弃且不清空情绪',
  JSON.stringify(norm(splitByEmotion('你好 [xyz123] 呀')))
);
ck(
  splitByEmotion('你好 [xyz123] 呀').every((s) => !/\[|\]/.test(s.text)),
  '输出里绝对不能再有中括号'
);
ck(
  JSON.stringify(norm(splitByEmotion('[excited] 好耶！[bogus] 继续说。'))) ===
    JSON.stringify(['好耶！|excited', '继续说。|excited']),
  '未知标签不影响已生效的情绪'
);

console.log('\n=== 全角中括号兜底 ===');
ck(
  JSON.stringify(norm(splitByEmotion('［gentle］轻轻地说'))) === JSON.stringify(['轻轻地说|gentle']),
  '全角［gentle］等价于 [gentle]',
  JSON.stringify(norm(splitByEmotion('［gentle］轻轻地说')))
);

console.log('\n=== 去标签（给用户看的文本）===');
ck(stripEmotionTags('哈 [laughs] 你好 [excited] 呀') === '哈 你好 呀', '去掉标记并压紧空格');
ck(stripEmotionTags('全角［giggles］也能清') === '全角也能清', '支持全角');

console.log('\n=== 教学 / 唱歌 两个关键场景 ===');
ck(splitByEmotion('[teach] 因为太阳光照到地球不同的地方。')[0]?.emotion === 'teach', '讲解模式生效');
ck(splitByEmotion('[sing] 一闪一闪亮晶晶')[0]?.emotion === 'sing', '唱歌模式生效');
ck(splitByEmotion('[comfort] 别难过，我陪你。')[0]?.emotion === 'comfort', '安慰模式生效');

console.log('\n=== 粤语/英语也能带上情绪 ===');
ck(splitByEmotion('[excited] 我哋一齐去玩啦！')[0]?.emotion === 'excited', '粤语台词带情绪');
ck(splitByEmotion('[teach] Our planet orbits the Sun.')[0]?.emotion === 'teach', '英语台词带情绪');

console.log('\n=== 三家的情绪配置都齐了 ===');
for (const e of EMOTIONS) {
  const ok = e.openai && e.azure?.style && e.eleven?.style != null;
  ck(ok, `[${e.tag}] 三家都有对应配置`, ok ? '' : JSON.stringify(e));
}

fs.unlinkSync(tmp);
console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✗`);
process.exit(fail === 0 ? 0 : 1);
