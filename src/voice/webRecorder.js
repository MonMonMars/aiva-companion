// 浏览器端「真麦克风」录音（Web 版专用）
// ---------------------------------------------------------------------------
// 为什么必须自己录：
//   iOS Safari **从来没实现过** webkitSpeechRecognition（WebKit Bug #170773 长期
//   标记 Not planned），window.SpeechRecognition 和 webkitSpeechRecognition 在
//   iPhone 上恒为 undefined。旧代码正是拿它当唯一入口 —— 于是 iPhone 上点麦克风
//   永远走「此浏览器不支持语音输入」，系统麦克风权限弹窗一次都不会弹，
//   用户看到的就是"只能打字"。
//   唯一能打通的路：getUserMedia 拿音频流 → MediaRecorder 录成文件 → 送云端识别。
//
// 三条平台细节，每条都会让人白 debug 半天：
//   1. mimeType 不能写死 webm。iOS Safari 只认 audio/mp4（AAC），
//      Chrome/Firefox 认 audio/webm;codecs=opus。必须先 isTypeSupported 问一遍。
//   2. getUserMedia 只在**安全上下文**里存在（HTTPS 或 127.0.0.1）。
//      测试站要是 HTTP，navigator.mediaDevices 整个是 undefined，不是被拒绝。
//   3. iOS 上 AudioContext 刚建出来是 suspended，必须在用户手势里 resume()，
//      否则电平表永远读 0，静音自动停会立刻误触发。

const CANDIDATE_MIMES = [
  'audio/mp4',                 // iOS Safari / macOS Safari
  'audio/webm;codecs=opus',    // Chrome / Edge / Firefox
  'audio/webm',
  'audio/ogg;codecs=opus',
  '',                          // 交给浏览器自己挑
];

/** 这个环境能不能录音；不能的话给出人话原因 */
export function micSupport() {
  if (typeof navigator === 'undefined') return { ok: false, reason: 'no-navigator' };
  if (!window.isSecureContext) {
    return { ok: false, reason: 'insecure', hint: '麦克风只在 HTTPS 下可用，当前页面不是安全上下文。' };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: false, reason: 'no-api', hint: '这个浏览器没有 getUserMedia，换 Safari / Chrome 再试。' };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, reason: 'no-recorder', hint: '这个浏览器没有 MediaRecorder，无法录音。' };
  }
  return { ok: true };
}

function pickMime() {
  for (const m of CANDIDATE_MIMES) {
    if (!m) return { mime: '', ext: 'mp4' };
    try {
      if (MediaRecorder.isTypeSupported(m)) {
        return { mime: m, ext: m.indexOf('webm') >= 0 ? 'webm' : m.indexOf('ogg') >= 0 ? 'ogg' : 'm4a' };
      }
    } catch (_) {}
  }
  return { mime: '', ext: 'm4a' };
}

/** 把 DOMException 的 name 翻成一句用户看得懂、且知道下一步怎么办的话 */
export function micErrorText(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return '麦克风被拦住了。iPhone 请到【设置 → Safari → 麦克风】把本站打开；'
      + '或点地址栏左边的「大小字」图标 → 网站设置 → 麦克风 → 允许。';
  }
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
    return '没找到麦克风。检查一下有没有别的 App 正占着它。';
  }
  if (n === 'NotReadableError' || n === 'TrackStartError') {
    return '麦克风被别的程序占用了，关掉录音类 App 再试。';
  }
  if (n === 'OverconstrainedError') {
    return '麦克风不满足录音参数，请刷新页面重试。';
  }
  return `打不开麦克风：${e?.message || n || '未知错误'}`;
}

export class MicRecorder {
  /**
   * @param {object} [opts]
   * @param {(lv:number)=>void} [opts.onLevel]   0..1 的实时音量，用来画电平
   * @param {()=>void}          [opts.onAutoStop] 静音够久自动收尾（ChatGPT 那种说完就停）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.ctx = null;
    this.analyser = null;
    this.raf = 0;
    this.startedAt = 0;
    this.quietSince = 0;
    this.recording = false;
    // 静音判定：低于这个 RMS 算安静，连续 SILENCE_MS 就自动停。
    // 别调太灵敏 —— 空调声、地铁声都会让 RMS 抬起来，太灵敏反而停不下来。
    this.quietAt = 0.035;
    this.silenceMs = 1900;
    this.minMs = 1300;      // 开录后这段时间内不判静音，避免"还没开口就停了"
    this.maxMs = 60000;     // 硬上限，防止忘了点停止
  }

  /** 必须在用户手势里同步调用，否则 iOS 不认 */
  async start() {
    const sup = micSupport();
    if (!sup.ok) return { ok: false, error: sup.hint || '这个环境不能录音' };

    try {
      // 回声消除/降噪关掉：识别引擎比人耳更吃这些"美化"，留原始信号识别率更高
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
    } catch (e) {
      return { ok: false, error: micErrorText(e) };
    }

    const { mime, ext } = pickMime();
    this.ext = ext;
    this.chunks = [];
    try {
      this.rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    } catch (e) {
      this._cleanup();
      return { ok: false, error: `无法开始录音：${e?.message || e}` };
    }

    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onerror = () => { /* onstop 里统一收尾，这里不重复处理 */ };

    try {
      // timeslice 给个小值，这样即使页面被系统掐掉也能拿到一部分音频
      this.rec.start(250);
    } catch (e) {
      this._cleanup();
      return { ok: false, error: `录音启动失败：${e?.message || e}` };
    }

    this.startedAt = Date.now();
    this.quietSince = 0;
    this.recording = true;
    this._meter();
    return { ok: true };
  }

  /** 电平表 + 静音自动停。放一起是因为它们读同一份数据，开两路反而浪费。 */
  _meter() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      // iOS：必须在手势里 resume，否则 state 一直是 suspended，读出来全是 0
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this._buf = new Uint8Array(this.analyser.fftSize);
    } catch (_) {
      this.analyser = null;
      return;
    }

    const tick = () => {
      if (!this.recording) return;
      const a = this.analyser;
      if (!a) return;
      a.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const v = (this._buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._buf.length);
      // 开方压缩一下，视觉上更像"音量条"，不然小声时几乎不动
      this.opts.onLevel?.(Math.min(1, Math.sqrt(rms) * 1.6));

      const elapsed = Date.now() - this.startedAt;
      if (elapsed > this.minMs) {
        if (rms < this.quietAt) {
          if (!this.quietSince) this.quietSince = Date.now();
          else if (Date.now() - this.quietSince > this.silenceMs) {
            this.opts.onAutoStop?.();
            return;
          }
        } else {
          this.quietSince = 0;
        }
      }
      if (elapsed > this.maxMs) {
        this.opts.onAutoStop?.();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** 收尾：返回 Blob + 可直接 fetch 的 objectURL */
  async stop() {
    if (!this.recording) return { ok: false, error: '没有在录音' };
    this.recording = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;

    const ms = Date.now() - this.startedAt;
    const done = new Promise((res) => {
      if (!this.rec || this.rec.state === 'inactive') return res();
      this.rec.onstop = () => res();
      try { this.rec.stop(); } catch (_) { res(); }
    });
    // 给个硬超时：iOS 偶尔不触发 onstop，不能把用户卡在"我在听…"
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);

    const type = (this.chunks[0] && this.chunks[0].type) || (this.rec && this.rec.mimeType) || 'audio/mp4';
    const blob = new Blob(this.chunks, { type });
    this._cleanup();

    if (!blob.size) return { ok: false, error: '没录到声音，再说一次？' };
    return { ok: true, blob, ms, type, ext: this.ext || 'm4a', url: URL.createObjectURL(blob) };
  }

  cancel() {
    this.recording = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.rec && this.rec.state !== 'inactive') {
      try { this.rec.stop(); } catch (_) {}
    }
    this.chunks = [];
    this._cleanup();
  }

  _cleanup() {
    if (this.stream) {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this.stream = null;
    }
    if (this.ctx) {
      try { this.ctx.close(); } catch (_) {}
      this.ctx = null;
    }
    this.analyser = null;
    this.rec = null;
  }
}
