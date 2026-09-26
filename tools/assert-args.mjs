// 断言函数的**参数守卫** —— 防止「参数顺序写反，造出一条永远绿的断言」。
// ---------------------------------------------------------------------------
// 起因（2026-09-26）：
//   tools/test-with-timeout.mjs 里的 ok() 签名是 `ok(label, cond, detail)`，
//   跟别处 `ck(cond, label, extra)` 的写法**相反**。我按别处的习惯写成
//   `ok(cond, label)` —— 于是条件位拿到的是那一句标签（非空字符串 = 永真），
//   布尔值被当成标签打了出去，输出里出现一行 **「✓ false」**。
//   一条永远绿的断言，而且它连自己是假的都写在脸上。
//
// 「下次记得核对签名」不算防线 —— 这次是恰好看见了那行输出才发现。
// 所以让断言函数自己卡死参数类型：传反了**当场抛错**（测试进程失败、
// 报错点名），而不是悄悄变成一条空转的断言。
//
// 用法：在每个断言函数体的第一行调用它们（where 传函数名，报错才好找）：
//   const ck = (cond, label, extra = '') => {
//     needBool(cond, 'ck()'); needLabel(label, 'ck()');
//     ...
//   };
//
// ⚠️ 别嫌啰嗦：这两个函数存在的唯一理由就是「宁可炸，不要绿」。
//   有 tools/lint-assert-guards.mjs（第 30 步）盯着每个断言函数有没有调用它们。

export function needBool(cond, where = '断言') {
  if (typeof cond !== 'boolean') {
    throw new Error(
      `${where} 收不到布尔值：实际是 ${JSON.stringify(cond)}`
      + ` —— 最常见的原因是**参数顺序写反了**（这个文件的和其它文件的写法可能相反）。`
      + `写反的后果不是报错，是一条永远绿的断言：条件位拿到非空字符串 = 永真。`
    );
  }
}

export function needLabel(label, where = '断言') {
  if (typeof label !== 'string' || !label) {
    throw new Error(
      `${where} 收不到非空字符串标签：实际是 ${JSON.stringify(label)}`
      + ` —— 大概率是**参数顺序写反了**（布尔值被当成标签打了出来）。`
    );
  }
}
