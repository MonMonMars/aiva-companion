/**
 * 入口：注册 extensionless 解析器。
 *
 * 用法：node --import ./tools/ext-resolve.mjs tools/xxx.mjs
 * 说明见 ./ext-resolve-hooks.mjs —— 真正的逻辑在那里（hooks 必须独立成文件，
 * Node 在单独线程里跑它们，不能自己注册自己）。
 */
import { register } from 'node:module';
register('./ext-resolve-hooks.mjs', import.meta.url);
