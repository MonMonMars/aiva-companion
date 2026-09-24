// 线上冒烟：确认主 app 和后台都在，且后台的 publicConfig 是真的注入过而不是占位符残留
const BASE = 'https://cloud-ai-companion.app.workbuddy.host';

async function get(p) {
  const r = await fetch(BASE + p, { redirect: 'follow' });
  const t = await r.text();
  return { status: r.status, len: t.length, body: t };
}

const idx = await get('/');
console.log('GET /              ->', idx.status, (idx.len / 1024).toFixed(1) + 'KB');
console.log('  含安全网标志:', /AIVA|safety|__aiva|bootGuard/i.test(idx.body) ? 'yes' : 'no');

const adm = await get('/admin.html');
console.log('GET /admin.html    ->', adm.status, (adm.len / 1024).toFixed(1) + 'KB');
console.log('  占位符残留:', adm.body.includes('__CLOUD_') ? '❌ 有残留' : '✅ 无');
console.log('  endpoint 已注入:', adm.body.includes('cloud-ai-companion.app.workbuddy.host') ? '✅' : '❌');
console.log('  SDK 用 CDN @dev:', adm.body.includes('@tencent-ai/workbuddy-cloud-sdk@dev') ? '✅' : '❌');
console.log('  createWorkBuddyCloud 两个参数都在:',
  /createWorkBuddyCloud\(\{[^}]*endpoint[^}]*publishableKey/s.test(adm.body) ? '✅' : '❌');
