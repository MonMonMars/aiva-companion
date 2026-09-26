// 每一步的执行器：**带硬上限**。
// ---------------------------------------------------------------------------
// 为什么单独抽成一个文件：
//   它的行为需要被牙齿测试直接 import 来验证（造一个挂住的脚本，看它会不会被掐掉）。
//   塞在 runtests.mjs 里的话，要验它就得把 26 步全跑一遍 —— 那测的是套装，不是它。
//
// 存在的理由：**「挂住」不等于「通过」，也不等于「没跑完就算了」**。
//   2026-09-26 实测：全套跑到第 19 步挂住，日志停在「PASS lint-ci-refs」之后再无输出，
//   一挂就是 4 小时 17 分，最后是我手工停的。进程 CPU 时间几乎为 0，也没有任何子进程
//   —— 它卡在 Node 自己的 `fs.rmSync(recursive)` 上（沙盒删得只剩一个 yml 就不动了）。
//   根因没锁定（换个新进程删同一个残留只要 64ms；造同样形状的目录删也只要 138ms），
//   但这不重要：**能确定的是「一步挂住时，整套就永远没有结论」**。
//   没有这一步，CI 上等价于烧掉 6 小时的 job 超时，而且红得毫无信息量。
//
// 两条硬要求：
//   1. 超时算**失败**，并且要能一眼看出是超时（status 为 null、timedOut 为 true），
//      不能伪装成 exit 0，也不能被当成"没跑完就算了"。
//   2. 超时要**杀干净进程树**，不是只杀直接子进程。否则会留下孙进程占着文件句柄 ——
//      上面那次挂住里，最可疑的就是被残留句柄卡住的目录删除。
//      Windows 上 `child.kill()` 只杀一个，必须 `taskkill /PID <pid> /T /F`。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

// 10 分钟。刻意给得宽 —— 这一步防的是「挂死」，不是「慢」；
// 定太紧会把正常的慢步骤（真 Metro 打包、真浏览器 boot）也掐了，那就变成误报。
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// 杀进程树。Windows 用 taskkill /T（带子孙），其它平台用进程组（detached 时 -pid）。
function killTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return r.status === 0;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // 进程组（要求 detached）
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 跑一步，最多等 timeoutMs 毫秒。
 * @returns {Promise<{status:number|null, timedOut:boolean, stdout:string, stderr:string, ms:number, pid:number}>}
 *   status 为 null 且 timedOut 为 true → 被掐掉了；status 为 0 才算过。
 */
export function runStep(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // 非 Windows 上 detached 才能拿到自己的进程组，kill(-pid) 才收得干净
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ status: null, timedOut: false, error: String(e), stdout: '', stderr: '', ms: 0, pid: null });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ms: Date.now() - t0, pid: child.pid, ...res });
    };

    const timer = setTimeout(() => {
      const killed = killTree(child.pid);
      finish({ status: null, timedOut: true, timeoutMs, killed });
    }, timeoutMs);

    child.on('error', (e) => finish({ status: null, timedOut: false, error: String(e) }));
    // 用 'close' 而不是 'exit'：close 表示 stdio 都已经关了，输出才算收全 ——
    // 超时时最需要的就是「它挂之前打印到哪了」。
    child.on('close', (code, signal) => finish({ status: code, signal, timedOut: false }));
  });
}

// 删一个目录树，但**不许卡住**。
// ---------------------------------------------------------------------------
// 为什么要单独有它：`fs.rmSync(dir, {recursive:true})` 在这台机器上会**卡住不返回**
// （2026-09-26 那次就是它挂了 4 小时 17 分；沙盒删得只剩一个 yml 就不动了）。
// 直接把这句放在牙齿脚本的收尾里，后果是**八道题全过了、却因为清理卡住而整条变红** ——
// 那是假失败，比挂住更难查。所以：
//   ① 丢给子进程去做，父进程不亲自等；
//   ② 给它硬上限，超时连进程树一起杀；
//   ③ 删不掉就如实说，不挡结论（留个临时目录在磁盘上，远好过一个假红）。
// 注意：删不掉时**必须说出来** —— 静默留下垃圾，下一次跑就会拿到上次的残留。
export async function rmTreeBounded(abs, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const script = `require('fs').rmSync(${JSON.stringify(abs)}, { recursive: true, force: true })`;
  const r = await runStep(['-e', script], { cwd: opts.cwd || process.cwd(), timeoutMs });
  let gone = false;
  try {
    gone = !fs.existsSync(abs);
  } catch {
    gone = true; // existsSync 自己都抛错，多半是路径没了
  }
  return { gone, timedOut: !!r.timedOut, ms: r.ms };
}

// 判断某个 pid 还活着吗（给牙齿测试用：掐完之后得确认它真的没了）。
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // 不发信号，只探活；进程不在会抛 ESRCH
    return true;
  } catch {
    return false;
  }
}
