// 步骤登记处：**每一步都必须回答"它的牙齿在哪"**。
// ---------------------------------------------------------------------------
// 为什么要有：
//   这个仓库里已经有九组「别人的牙齿」了（第 19~27 步），但**是谁提醒它们该配牙齿的？
//   是我。** 每次都是我在补完一条闸之后自己想起来"那谁来盯这条闸" ——
//   这就是「下次记得」，而「下次记得」不算防线（SKILL 第 78 条反复在说的那件事）。
//   本文件把那个提醒变成硬约束：加一步而不登记它的牙齿（或写明为什么不需要），
//   **整套测试直接拒绝开跑**。加第 30 步的那个人会立刻撞上它，不需要谁记得。
//
// 三个字段**三选一**：
//   teeth:     '<脚本>'              —— 这一步的牙齿脚本；会自动要求清单里有 <name>-teeth 这一步
//   guardedBy: '<已有牙齿步骤名>'    —— 已经有别人的牙齿在盯它（可给多个）
//   why:       '<写给人看的理由>'    —— 它为什么不需要牙齿；不许敷衍，太短或占位都要红
//
// 为什么不是"自动扫代码判断谁有牙齿"：
//   试过，判不准。九条牙齿里有四条的名字跟被保护的步骤对不上
//   （lipsync-teeth 盯的是 pipeline；zero-scan-teeth 盯的是四条 lint；
//    persona-coverage-teeth 盯的是 check-persona-coverage）。
//   "看到某个文件里提到了另一个文件名"根本推不出"这条在保护那条"。
//   所以改成**显式登记**：谁保护谁由登记的人写清楚，机器只负责核对没漏。
//
// ⚠️ verifyRegistry 是**纯函数**（不碰文件之外的状态、不读 STEPS 全局变量），
//    因为它的牙齿测试要拿合成的清单来验「漏登记会被抓到」这些场景。

import fs from 'node:fs';
import path from 'node:path';

// 敷衍理由：这一栏要是能随手写「不需要」了事，这道闸就白设了。
const PLACEHOLDER = /^(不需要|不用|无需|暂不需要|待补|待定|TODO|todo|TBD|同上|见上)[\s。.、,]*$/;
// 「未验证」标记：写了这三个字，说明这只是我的判断、没有证据 —— 单独列出来，
// 它不红（不然没人肯老实写），但**必须被看见**。
const UNVERIFIED = /未验证|没验过|待验证|没有证据/;

/**
 * @param {Array<[string, string[]]>} steps
 * @param {Map<string, object>} decl
 * @param {string} root 仓库根（用来核对 teeth 指向的脚本真的存在）
 */
export function verifyRegistry(steps, decl, root) {
  const names = steps.map((s) => s[0]);
  const problems = [];
  const unverified = [];
  const covered = [];

  // ⚠️ 「扫到 0 条就静默全绿」这个坑在这个仓库里已经出现过四次
  //    （lint-ci-refs 的 A 项、B/C 项、zero-scan、以及角色核对的 0 条闸门）。
  //    这里同样躲不掉：清单是空的，下面的循环一次都不进，返回「0 问题」——
  //    于是一次把步骤列表改坏的操作会得到「登记齐全」的绿。必须先卡死。
  if (names.length === 0) {
    problems.push('清单里一步都没有 —— 多半是哪次改动把步骤列表弄坏了；「0 步」不许判成「登记齐全」');
  }
  // 重名同理：跑的时候「第 N 步」对不上 CI，登记也会被后来的覆盖掉，而且不报错。
  for (const dup of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
    problems.push(`${dup}：名单里出现了 ${names.filter((n) => n === dup).length} 次 —— 重名会让「第 N 步」对不上 CI，登记也会互相覆盖`);
  }

  for (const [name] of steps) {
    const d = decl.get(name);
    if (!d) {
      problems.push(`${name}：没有登记 —— 加这一步的人必须写明它的牙齿在哪，或者为什么不需要（不写就跑不起来）`);
      continue;
    }
    const hasTeeth = typeof d.teeth === 'string' && d.teeth.trim() !== '';
    const guards = d.guardedBy ? [].concat(d.guardedBy).filter(Boolean) : [];
    const hasGuard = guards.length > 0;
    const hasWhy = typeof d.why === 'string' && d.why.trim() !== '';
    const n = [hasTeeth, hasGuard, hasWhy].filter(Boolean).length;

    if (n === 0) {
      problems.push(`${name}：登记了，但 teeth / guardedBy / why 一个都没填 —— 三选一`);
      continue;
    }
    if (n > 1) problems.push(`${name}：teeth / guardedBy / why 只能填一个，这里填了 ${n} 个`);

    if (hasTeeth) {
      // 指向的脚本得真的在 —— 否则跟没配一样，而且更骗人（看着配了）
      const abs = path.join(root, d.teeth);
      if (!fs.existsSync(abs)) problems.push(`${name}：teeth 指向的脚本不存在：${d.teeth}`);
      // 牙齿自己也得在清单里 —— 否则它就是个没人跑的文件
      if (!names.includes(`${name}-teeth`)) {
        problems.push(`${name}：填了 teeth，但清单里没有 <${name}-teeth> 这一步 —— 牙齿不跑等于没有`);
      } else {
        covered.push(name);
      }
    }

    if (hasGuard) {
      for (const g of guards) {
        if (!names.includes(g)) problems.push(`${name}：guardedBy 指向的步骤「${g}」不在清单里`);
      }
      if (guards.every((g) => names.includes(g))) covered.push(name);
    }

    if (hasWhy) {
      const w = d.why.trim();
      if (w.length < 10) problems.push(`${name}：why 只有 ${w.length} 个字 —— 说清理由，这一栏是给以后的自己看的`);
      if (PLACEHOLDER.test(w)) problems.push(`${name}：why 是敷衍的占位（"${w}"）—— 这一栏不许糊弄`);
      if (UNVERIFIED.test(w)) unverified.push(name);
    }
  }

  // 反方向：登记了却不在清单里（多半是改名之后留下的孤儿登记）
  for (const name of decl.keys()) {
    if (!names.includes(name)) problems.push(`${name}：登记了却不在清单里 —— 步骤改名了？登记要跟着改`);
  }

  return { problems, unverified, covered, total: names.length };
}

// 给 runtests 用的小工具：登记 + 顺便把「谁靠什么覆盖」记下来。
export function makeRegistry() {
  const steps = [];
  const decl = new Map();
  return {
    steps,
    decl,
    push(name, args, opts = {}) {
      steps.push([name, args]);
      decl.set(name, opts);
    },
    verify(root) {
      return verifyRegistry(steps, decl, root);
    },
  };
}
