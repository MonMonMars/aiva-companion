// 给 expo export 出来的 dist/index.html 注入"启动兜底"
// ---------------------------------------------------------------------------
// ⚠️ 红线：expo export 每次都会重写 dist/index.html，把这里注入的东西冲掉，
//    所以**每次 export 之后都必须重跑本脚本**。
//
// 这一版解决的是一个真实的误报：主包 5.7MB，手机上下载常常超过 8 秒，
// 旧兜底写死 8 秒没画东西就报"页面未正常加载"，把"还在下载"说成了"坏了"，
// 用户只看到一句吓人的报错。
//
// 现在分三个阶段：
//   ① 下载中   —— 立刻画出品牌启动页 + 已等待秒数，不再是一片空白
//   ② 启动中   —— 主脚本 load 事件到了，说明下载完了，换文案继续等
//   ③ 真出错   —— 脚本报错 / 下载超时 / 启动超时，才报详细信息
// 兜底层挂在 body 上（不是 #root 里），所以不会污染"React 有没有画出来"的判断；
// 一旦 #root 有子节点就立刻把自己摘掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 这里曾经写死过 Windows 绝对路径，本地能跑、上 CI（Linux）直接崩。
//    所有路径一律从脚本自身位置推导，保证在任何机器上都能跑。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIST = process.argv[2] || 'dist';
const f = path.join(ROOT, DIST, 'index.html');
let html = fs.readFileSync(f, 'utf8');

// 先剥掉上一轮注入的（可能是坏的）兜底脚本
html = html.replace(/<script>[\s\S]*?__aivaBoot[\s\S]*?<\/script>/, '');
html = html.replace(/<style id="aiva-fixcss">[\s\S]*?<\/style>/, '');

// ---------------------------------------------------------------------------
// 手机浏览器的两个"抢手势"行为，必须在 HTML 这一层挡掉（JS 里补不回来）：
//   1) 双指捏合 = 页面缩放。舞台要拿它做相机推拉，结果被浏览器吃掉。
//      iOS Safari 从 10 起**故意忽略** user-scalable=no，所以只能拦 gesture* 事件。
//      （maximum-scale=1 在 Android Chrome 上有效，iOS 上无效但无害，一并写上。）
//   2) 橡皮筋回弹 / 双击放大。overscroll-behavior + touch-action 一起治。
// ---------------------------------------------------------------------------
const FIXCSS = `<style id="aiva-fixcss">
  html, body { overscroll-behavior: none; -webkit-text-size-adjust: 100%; }
</style>`;

const VIEWPORT_OLD = /<meta name="viewport" content="[^"]*"[^>]*>/i;
const VIEWPORT_NEW =
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, '
  + 'user-scalable=no, shrink-to-fit=no" />';
if (VIEWPORT_OLD.test(html)) html = html.replace(VIEWPORT_OLD, VIEWPORT_NEW);
else html = html.replace('</head>', '  ' + VIEWPORT_NEW + '\n</head>');

const T = {
  errTitle: '应用未能启动（请把这段发给我）：',
  dlFail: '下载主脚本超时',
  bootFail: '主脚本已下载完成，但一直没画出任何内容',
  assetFail: '资源加载失败',
  scriptErr: '应用启动出错',
  asyncErr: '未处理的异步错误',
};

// 下载阶段最多等 45 秒（手机弱网 1.2MB 的 gzip 包也可能要这么久），
// 脚本到位后再给 25 秒做解析/执行/首次渲染。
const DL_TIMEOUT = 45000;
const BOOT_TIMEOUT = 25000;
const QUIET = 300; // 300ms 内就起来了就别闪一下启动页

const safety = `<script>
(function(){
  var ID='aiva-boot', started=Date.now(), painted=false, phase='download', loadAt=0, tick=null;
  var DL_TIMEOUT=${DL_TIMEOUT}, BOOT_TIMEOUT=${BOOT_TIMEOUT};
  function root(){ return document.getElementById('root'); }
  function up(){ var r=root(); return !!(r && r.childElementCount>0); }

  function style(){
    if(document.getElementById('aiva-boot-css')) return;
    var s=document.createElement('style'); s.id='aiva-boot-css';
    s.textContent='@keyframes aiva-spin{to{transform:rotate(360deg)}}'
      +'@keyframes aiva-fade{from{opacity:0}to{opacity:1}}';
    (document.head||document.documentElement).appendChild(s);
  }

  function show(msg, hint){
    style();
    var w=document.getElementById(ID);
    if(!w){
      w=document.createElement('div'); w.id=ID;
      w.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;'
        +'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;'
        +'background:#14101A;color:#EDEAF2;text-align:center;padding:32px;box-sizing:border-box;'
        +'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;'
        +'animation:aiva-fade 200ms ease-out;';
      w.innerHTML=''
        +'<div style="font-size:32px;font-weight:800;letter-spacing:6px">◈ AIVA</div>'
        +'<div style="font-size:11px;letter-spacing:3px;opacity:.45">AI COMPANION</div>'
        +'<div style="width:36px;height:36px;margin-top:12px;border-radius:50%;'
        +'border:3px solid rgba(237,234,242,.16);border-top-color:#F2A0B8;'
        +'animation:aiva-spin 900ms linear infinite"></div>'
        +'<div id="aiva-boot-msg" style="font-size:13px;opacity:.8;min-height:20px"></div>'
        +'<div id="aiva-boot-hint" style="font-size:11px;opacity:.38;line-height:1.8;max-width:300px"></div>';
      document.body.appendChild(w);
    }
    var m=document.getElementById('aiva-boot-msg'), h=document.getElementById('aiva-boot-hint');
    if(m) m.textContent=msg||'';
    if(h) h.textContent=hint||'';
  }

  function hide(){
    var w=document.getElementById(ID);
    if(w&&w.parentNode) w.parentNode.removeChild(w);
    if(tick){ clearInterval(tick); tick=null; }
  }

  function fail(title,msg){
    if(painted) return;
    painted=true; hide();
    var r=root(); if(!r) return;
    r.innerHTML='';
    var pre=document.createElement('pre');
    pre.style.cssText='color:#FFB4B4;background:#1b1320;padding:24px;margin:0;min-height:100%;'
      +'font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;';
    pre.textContent=title+'\\n\\n'+msg;
    r.appendChild(pre);
    window.__safetyPainted=true;
  }

  window.addEventListener('error', function(e){
    if(painted) return;
    if(e&&e.error){ fail(${JSON.stringify(T.scriptErr)}, (e.error.stack||e.error.message||String(e.error))); }
    else if(e&&e.target&&e.target.src&&e.target.src.indexOf('/_expo/static/js/web/')>=0){
      fail(${JSON.stringify(T.assetFail)}, '主脚本加载失败：'+e.target.src+'\\n可能网络被拦截，或文件没部署上去。');
    }
  }, true);

  window.addEventListener('unhandledrejection', function(e){
    if(painted) return;
    var r=e&&e.reason;
    fail(${JSON.stringify(T.asyncErr)}, (r&&(r.stack||r.message))||String(r));
  });

  // 主脚本下载完 → 进入"启动中"，不再按下载超时算
  function onLoaded(){ if(phase!=='download') return; phase='boot'; loadAt=Date.now(); }
  if(document.readyState==='complete') onLoaded();
  else window.addEventListener('load', onLoaded);

  setTimeout(function(){
    if(painted||up()) return;
    tick=setInterval(function(){
      if(painted){ hide(); return; }
      if(up()){ hide(); return; }
      var s=((Date.now()-started)/1000).toFixed(0);
      if(phase==='download'){
        show('正在下载… 已等 '+s+' 秒', '首次打开需要下载几 MB，之后会被缓存住');
        if(Date.now()-started>DL_TIMEOUT){
          fail(${JSON.stringify(T.dlFail)}, '等了 '+DL_TIMEOUT/1000+' 秒主脚本还没下载完。\\n\\n'
            +'常见原因：\\n1) 网络太慢或不稳定\\n2) 代理 / VPN / 公司网络拦了这个 JS 文件\\n3) 部署的文件缺失\\n\\n'
            +'建议换个网络（或先关掉代理）再刷新。\\n\\n'+location.href);
        }
      } else {
        show('正在启动… 已等 '+s+' 秒', '');
        if(Date.now()-loadAt>BOOT_TIMEOUT){
          fail(${JSON.stringify(T.bootFail)}, '主脚本已下载完成，但 '+BOOT_TIMEOUT/1000+' 秒内没画出任何内容。\\n\\n'
            +'常见原因：\\n1) 该浏览器 / 内嵌浏览器未开启 WebGL\\n2) 浏览器版本过旧，不支持这个页面\\n\\n'
            +'请把上面这段发给我。');
        }
      }
    }, 400);
  }, ${QUIET});

  // ---- 拦掉浏览器自己那套双指缩放 ------------------------------------
  // iOS Safari 10+ 明确忽略 user-scalable=no，页面上捏合一定会被当成"放大网页"；
  // 舞台上的 touch-action:none 只在**手指落在舞台里**时管用，
  // 落在顶栏 / 输入条上时还是会整页放大（而且 iOS 不会自动缩回去）。
  // gesturestart / gesturechange / gestureend 是 Safari 私有的缩放事件，
  // 拦掉它们是目前唯一可靠的全页方案。
  ['gesturestart','gesturechange','gestureend'].forEach(function(t){
    document.addEventListener(t, function(e){ e.preventDefault(); }, { passive:false });
  });

  window.__aivaBoot=true;
})();
</script>`;

html = html.replace('<div id="root"></div>', '<div id="root"></div>\n  ' + safety);
html = html.replace('</head>', FIXCSS + '\n  </head>');
fs.writeFileSync(f, html);
console.log('rewrote ' + DIST + '/index.html, contains safety:', html.includes('__aivaBoot'));

// 校验内联脚本语法（注入失败比不注入更糟：页面会直接白屏）
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (m) {
  try { new Function(m[1]); console.log('inline script parses OK'); }
  catch (e) { console.log('INLINE SCRIPT SYNTAX ERROR:', e.message); process.exit(1); }
}

// ---- 把服务器和 package.json 一起放进 dist，好让部署环境能跑起来 ----------
// 部署默认是 python3 -m http.server，**不压缩**，5.7MB 原样发出去会让手机卡在白屏。
// 自带一个零依赖的 node 服务器，按 Accept-Encoding 发预压好的 .br / .gz。
fs.copyFileSync(path.join(ROOT, 'tools', 'dist-server.mjs'), path.join(ROOT, DIST, 'server.js'));
fs.writeFileSync(
  path.join(ROOT, DIST, 'package.json'),
  JSON.stringify(
    {
      name: 'aiva-companion',
      private: true,
      version: '1.0.0',
      // server.js 用的是 ESM（import），不声明的话 node 会先按 CJS 解析再回退，
      // 每次启动都打一条 MODULE_TYPELESS_PACKAGE_JSON 警告
      type: 'module',
      main: 'server.js',
      scripts: { start: 'node server.js' },
      dependencies: {},
    },
    null,
    2
  ) + '\n'
);
console.log('copied server.js + package.json into ' + DIST + '/');
