// 夹具（第 37 步场景②）：**同一个 cmd**，但包在 process.platform 分支里。
// ---------------------------------------------------------------------------
// 这是 tools/step-runner.mjs 里 taskkill 那种**唯一正确的写法** —— 必须判绿。
// 少了这个对照组，一个「见 cmd 就红」的无脑检查也能通过全部场景，
// 然后它会把正确写法逼成绕过检查（这个仓库里「绕过」发生过不止一次）。

import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'echo', 'hi']);
} else {
  spawnSync('echo', ['hi']);
}
