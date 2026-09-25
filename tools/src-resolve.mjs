// 入口：注册 Node ESM 解析钩子（唯一的那个）。
// ---------------------------------------------------------------------------
// 用法：node --import ./tools/src-resolve.mjs tools/xxx.mjs
//       node tools/register-src.mjs tools/xxx.mjs      ← 等价，见 register-src.mjs
//
// ⚠️ 真正的逻辑在 ./src-resolve-hooks.mjs —— 钩子必须独立成文件，
//    Node 在单独线程里跑它们，钩子模块不能自己注册自己（自己注册会递归）。
//
// ⚠️ register() 这一行是「能不能生效」的关键：Node 22 的 `--import` 只是把这个
//    文件当入口模块执行一遍，不调 register() 的话 hook 一次都不会被调用，
//    而且**不报任何错** —— 症状看起来和「loader 写错了」一模一样。
import { register } from 'node:module';

register('./src-resolve-hooks.mjs', import.meta.url);
