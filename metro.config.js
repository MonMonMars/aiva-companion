// Metro 配置：让 .glb 模型文件能被当资源打包
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 确保 glb / gltf 被当作静态资源（.glb 内部是二进制，不需要 babel 处理）
for (const ext of ['glb', 'gltf', 'bin']) {
  if (!config.resolver.assetExts.includes(ext)) {
    config.resolver.assetExts.push(ext);
  }
}

module.exports = config;
