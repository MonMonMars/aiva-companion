// 把 JS 源码里的注释涂成空格 —— 保留行号与列号，好让报错能指回原文。
// ---------------------------------------------------------------------------
// 为什么要单独抽出来（和 find-dist / find-chrome 是同一个理由）：
//   扫源码文本的检查，最先撞上的坑就是**分不清「代码」和「注释里写的字」**（SKILL 第 111 条）。
//   `lint-rm-sync.mjs` 里已经有一份「抹掉注释再扫」的做法，而本文件要给
//   第 42 步（lint-ci-paths）用 —— 两处各写一份，必有一份是漏的。
//
// 为什么是「涂成空格」而不是「删掉」：
//   删掉会让后面的行号整体前移，报错里那句「第几行」就指错地方了。
//   涂成空格后字符串长度与原文逐字相同，行号列号都对得上。
//
// 已知边界：
//   正则字面量里的 `/*` 会被误当成块注释开头（要认出正则字面量得真解析 JS）。
//   本仓库 47 个 CI 脚本里没有这种写法，且第 43 步的牙齿测试会拿内置样例
//   把「注释里的不算 / 代码里的算」两条都钉住 —— 真被误吞了会红在那里。
// ---------------------------------------------------------------------------

/**
 * @param {string} src 原始 JS 源码
 * @returns {string} 与 src 等长；注释部分换成空格（换行原样保留）
 */
export function blankComments(src) {
  const n = src.length;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = src[k] === '\n' ? '\n' : ' ';

  let i = 0;
  let state = 'code'; // code | sq | dq | tq
  let inTmpl = false; // 当前 code 态是否身处模板串的 `${...}` 里
  let depth = 0; // `${...}` 的花括号配平

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (state === 'code') {
      // 行注释：吞到换行（换行本身在 out 里已经预置好了）
      if (c === '/' && d === '/') {
        i += 2;
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      // 块注释：吞到 */
      if (c === '/' && d === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        out[i] = c;
        i++;
        state = c === "'" ? 'sq' : 'dq';
        continue;
      }
      if (c === '`') {
        out[i] = c;
        i++;
        state = 'tq';
        continue;
      }
      // 模板串里的 `${...}` 是代码，要配平花括号才知道什么时候回到模板串
      if (inTmpl) {
        if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) {
            out[i] = c;
            i++;
            state = 'tq';
            inTmpl = false;
            continue;
          }
        }
      }
      out[i] = c;
      i++;
      continue;
    }

    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      out[i] = c;
      if (c === '\\') {
        if (i + 1 < n) out[i + 1] = src[i + 1]; // 转义字符整体保留，别把 \" 看成收尾
        i += 2;
        continue;
      }
      if (c === q) state = 'code';
      i++;
      continue;
    }

    // ---- state === 'tq'（模板串）----
    out[i] = c;
    if (c === '\\') {
      if (i + 1 < n) out[i + 1] = src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      state = 'code';
      i++;
      continue;
    }
    if (c === '$' && d === '{') {
      out[i + 1] = '{';
      i += 2;
      state = 'code';
      inTmpl = true;
      depth = 1;
      continue;
    }
    i++;
  }

  return out.join('');
}
