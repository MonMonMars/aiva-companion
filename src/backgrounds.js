// 舞台背景预设
// ---------------------------------------------------------------------------
// Grok 的 Companions 里"换舞台"是核心玩法之一（outfits / stages），
// 所以我们把背景做成可选项，而不是永远跟着角色配色走。
//
// 每个预设给 4 个渐变色标（从上到下）。最后一档刻意留浅色 ——
// 底部输入条和字幕压在上面，太深会看不清字。

export const BACKGROUNDS = [
  { id: 'auto', label: '跟随角色', emoji: '✨' },
  { id: 'sakura', label: '樱花树下', emoji: '🌸', colors: ['#F3A7C0', '#F58BAE', '#FFC9DC', '#FFF2F7'] },
  { id: 'night', label: '夜色霓虹', emoji: '🌃', colors: ['#241B45', '#3E2C6B', '#6B4E97', '#C8B6E2'] },
  { id: 'seaside', label: '海边黄昏', emoji: '🌅', colors: ['#F6A96B', '#F2C078', '#FFE1B8', '#FFF6E8'] },
  { id: 'study', label: '书房暖光', emoji: '📚', colors: ['#6E4B32', '#8C6448', '#C89B75', '#EFDCC4'] },
  { id: 'forest', label: '林间晨雾', emoji: '🌲', colors: ['#2F5D45', '#4E7F5C', '#9CC49B', '#E4F2E1'] },
  { id: 'space', label: '深空', emoji: '🌌', colors: ['#0B0F2A', '#1B2352', '#3F3C82', '#9E9BD1'] },
  { id: 'stage', label: '演唱舞台', emoji: '🎤', colors: ['#2A0F3D', '#5B1E6B', '#9C2F86', '#E8A6D8'] },
  { id: 'custom', label: '自定义图片', emoji: '🖼' },
];

/**
 * 算出当前真正要用的渐变色。
 * 'auto'（默认）沿用角色自己的配色；'custom' 走 bgImage，不参与渐变。
 */
export function resolveBackground(bgId, persona) {
  if (bgId && bgId !== 'auto' && bgId !== 'custom') {
    const hit = BACKGROUNDS.find((b) => b.id === bgId);
    if (hit && hit.colors) return hit.colors;
  }
  // persona.colors.gradient 是 3 档，补一档浅色在底部保证可读
  return [...(persona?.colors?.gradient || ['#FFB6C9', '#C9A7E8', '#A7C8F0']), '#FFFFFF'];
}

export const backgroundLabel = (bgId) =>
  (BACKGROUNDS.find((b) => b.id === bgId) || BACKGROUNDS[0]).label;
