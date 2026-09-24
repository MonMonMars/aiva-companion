// 选一张本地图片 —— 唯一入口
// ---------------------------------------------------------------------------
// RN 没有跨平台的文件选择器，而我们的部署形态是网页，所以这里直接用
// 一个隐藏的 <input type="file">，全 App 共用一个（别每个页面都往 body 里塞一个）。
//
// 回调拿到的是 data URL（base64），可以直接塞进 <Image source={{uri}}>，
// 也能存档 —— 存 data URL 会让存档变大，所以只用于「自定义背景」这一处，
// 而且控制在一张图以内。

import { Platform } from 'react-native';

let input = null;

function ensureInput() {
  if (input || Platform.OS !== 'web') return input;
  input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  return input;
}

/**
 * 打开选图框。
 * @param {(file:{name:string,uri:string}) => void} onPicked
 * @returns {boolean} 这个平台支不支持（非 web 返回 false，调用方给个提示）
 */
export function pickImage(onPicked) {
  if (Platform.OS !== 'web') return false;
  const el = ensureInput();
  if (!el) return false;
  el.value = '';
  el.onchange = () => {
    const f = el.files && el.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => onPicked({ name: f.name, uri: String(reader.result || '') });
    reader.readAsDataURL(f);
  };
  el.click();
  return true;
}
