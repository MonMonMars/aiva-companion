// 夹具（第 37 步场景⑥）：把 .bat 当子进程目标 —— ubuntu 上跑不起来。

import { spawnSync } from 'node:child_process';

spawnSync('run.bat', []);
