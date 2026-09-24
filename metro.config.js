// Metro 配置：让模型类和表情数据文件能被当**静态资源**打包
//
// 两条容易踩的：
//
// 1) .glb / .gltf / .bin
//    Metro 默认不认识，不加进 assetExts 会直接构建失败。
//
// 2) .morph.json 必须走"资源"而不是"模块"
//    Metro 对 `.json` 的默认行为是**当 JS 模块 inline 进 bundle**。
//    那有两个问题：
//      a) 200KB × 3 的表情数据会塞进 2.3MB 的主 bundle，首屏白白变大；
//      b) `Asset.fromModule()` 拿不到 uri —— 它期待的是"文件资源"，
//         而 inline 进来的是个已解析的对象，两者对不上，加载必然失败。
//    所以这里把 `.morph.json` 显式注册成资源扩展名。
//    注意扩展名要写全（`morph.json` 而不是 `json`），不能把普通 .json
//    一起变成资源，否则 package.json / app.json 这类配置就废了。
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const extraAssets = ['glb', 'gltf', 'bin', 'morph.json'];

for (const ext of extraAssets) {
  if (!config.resolver.assetExts.includes(ext)) {
    config.resolver.assetExts.push(ext);
  }
}

module.exports = config;
