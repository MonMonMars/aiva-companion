// 在任何可能出问题的模块之前先装上全局错误兜底层。
// 这样即便是"脚本还没跑起来就崩"（比如某个原生模块在浏览器里 eval 抛错），
// 用户看到的也不是白屏，而是一句可读的启动失败信息。
// 必须被最早 import（在 App.js 顶部第一行），才能盖住后面那些高风险 import。
(function () {
  if (typeof window === 'undefined') return;
  function show(msg) {
    try {
      const root = document.getElementById('root');
      if (!root) return;
      // React 已经接管（有真实内容）就不覆盖，避免误伤正常界面
      if (root.childElementCount > 0 && !window.__fatalShown) return;
      window.__fatalShown = true;
      root.innerHTML = '';
      const box = document.createElement('pre');
      box.style.cssText =
        'color:#FFB4B4;background:#1b1320;padding:24px;margin:0;' +
        'font:12px/1.6 monospace;white-space:pre-wrap;word-break:break-word;';
      box.textContent = '应用启动失败（请把这段发给我）：\n\n' + msg;
      root.appendChild(box);
    } catch (_) {}
  }
  window.addEventListener('error', (e) => {
    show((e && (e.error && (e.error.stack || e.error.message))) || e.message || String(e));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    show((r && (r.stack || r.message)) || String(r));
  });
})();
