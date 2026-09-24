/**
 * 后台预热：把「还没上场的角色」的模型字节先抓进缓存。
 *
 * 为什么值得做：切换角色要走 readAssetBytes → fetch/base64 解码 → GLTFLoader.parse，
 * 前两步是纯 IO，完全可以提前做掉。做完之后换人只剩解析那一步，
 * 手感从"点下去愣一下"变成"点了就换"。
 *
 * 为什么不连解析一起做：解析结果只有挂上场景才有意义，
 * 而场景里同时只站一个人 —— 提前解析 14 个模型 = 白烧 14 次 CPU + 一堆显存。
 *
 * 为什么要 after: 'model'：主角的模型是 priority 100 的任务，
 * 预热是 priority 1。不排依赖的话，万一主角那条还没登记，
 * 预热会先跑 14 个 fetch，把主角自己的加载挤到后面去 —— 正好反了。
 */

import { PERSONA_MODELS } from './companionModel';
import { warmAssetBytes, isAssetModule } from './assetBytes';
import { schedule } from './preload';

/**
 * 主角当前用的模型，避免重复预热它。
 * ⚠️ 必须和 companionModel.js 的 PRO_MODEL_PERSONA 保持一致 ——
 *    写错了不会报错，只是会白预热一份主角模型（表现是"切换稍微慢一点"，
 *    很难查）。这里现在是 'aiva-mh'（MakeHuman CC0 底模）。
 */
const PRO_MODEL_PERSONA = 'aiva-mh';

export function warmOtherModels(currentPersonaId) {
  const ids = Object.keys(PERSONA_MODELS);

  ids.forEach((id) => {
    // 主角自己那份马上就要 parse 了，不用预热
    if (id === currentPersonaId || id === PRO_MODEL_PERSONA) return;

    const entry = PERSONA_MODELS[id];
    if (!entry) return;

    schedule({
      id: 'warm:' + id,
      label: '预热 ' + id,
      priority: 1,
      after: 'model',
      run: async () => {
        // morph.json 在 Metro 里经常被 inline 成普通对象（见 assetBytes 的说明），
        // 那种根本不需要预热 —— isAssetModule 挡掉，避免每人都打一条"失败"日志。
        // parts 也要预热：MakeHuman 档的头发有 4MB（动漫高模那套），
        // 不预热的话换角色时会卡在"下载头发"上。
        const mods = [entry.model, entry.texture, entry.morph, ...(entry.parts || [])];
        const jobs = mods.filter(isAssetModule);
        for (const mod of jobs) await warmAssetBytes(mod);
      },
    });
  });
}
