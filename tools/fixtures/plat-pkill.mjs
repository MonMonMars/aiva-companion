// 夹具（第 37 步场景⑦）：Unix 专属命令 pkill，没有守卫。
// ---------------------------------------------------------------------------
// 反方向也要管：这台开发机是 Windows，pkill 在本地同样不存在。

import { spawnSync } from 'node:child_process';

spawnSync('pkill', ['-f', 'x']);
