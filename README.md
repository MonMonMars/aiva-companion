# AIVA — AI 伴侣 App（3D 形象 + 好感度养成 + 多人格）

一个能装进 iPhone 和安卓手机的原生 App。三个 AI 人格（女友 / 男友 / 秘书），
可触摸的 3D 卡通形象，加上一套会随时间衰减的好感度养成系统。

技术栈：**Expo (React Native) SDK 57 + three.js**，一套代码同时产出 iOS / Android / Web。

---

## 一、先跑起来看

最快的方式是在浏览器里看效果：

```bash
cd llm-companion
npx expo start --web
```

想装到手机上：

```bash
npx expo start
```
手机装 **[Expo Go](https://expo.dev/go)**（iOS App Store / 安卓应用市场），
和电脑连同一个 Wi-Fi，用 iPhone 相机 / 安卓 Expo Go 扫终端里的二维码即可。

---

## 二、接真实大模型（重要）

**开箱即用的时候是「离线人格」** —— 内置了规则化台词引擎，能聊、有性格，但不会真的思考。

要接真模型：**主界面右上角 ⚙️ → 大模型接口**，选供应商、填 Key、点「测试连接」。
所有供应商都走 OpenAI 兼容格式，已内置预设：

| 供应商 | Base URL | 默认模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 自定义 | 自己填 | 自己填 |

> ⚠️ **Key 的安全**：Key 存在手机本地的 AsyncStorage，**不会**上传任何服务器，也不在代码里。
> 但它同时也是明文存在设备上的 —— 如果这是公司的 Key，建议只用自己的额度，别用生产 Key。

---

## 三、玩起来大致是这样

**主界面**
- 舞台上半部分 = 摸头，下半部分 = 戳一下。
- 摸头**滑动**比单点收益更高（会累积强度）。
- 被摸会掉精力，精力会随时间自动恢复 —— 所以别一次性狂摸。

**养成**
- 💞 **亲密**：每 120 点升 1 级，共 20 级，称号从「陌生」到「世界中心」。
- 🌤 **心情**：离线期间每小时掉 1.4，超过 6 小时没回来她会说难过的话。
- ⚡️ **精力**：每小时回复 7，摸她会消耗。
- 🪙 **金币**：抚摸 +1、每轮对话 +2、每日签到 +25，用来买礼物。

**聊天**
- 好感等级会被拼进 system prompt —— **关系越深她说话越亲近**，这是这个 App 和普通输入法聊天最大的区别。
- 你透露的个人信息（"我喜欢喝美式"这种）会被抽出来存进「她的记忆」，之后一直记得。

---

## 四、替换成真的 3D 模型（可选）

现在这个形象是用**几何体程序化搭出来的**：
好处是零外部资源、启动快、绝对不会因为模型文件加载失败而白屏；坏处是精度有限。

想换成 `.glb` 动画模型：

1. 把模型放进 `assets/`，在 `app.json` 里配好 asset。
2. 改 `src/three/companion.js` 的 `buildCharacter()`：
   用 `GLTFLoader` 载入模型替换返回值里的 `root`，保留 `head` / `arms` 这两个 group 的引用
   （动画系统靠它们做头部倾斜和抬手），其余逻辑不用动。
3. 想要动漫角色推荐用 **VRM 格式**（`.vrm`，本质是 glTF 扩展），配 `three-vrm` 会自带骨骼和表情 BlendShape。

注意：`.vrm` / 骨骼动画在 React Native 上的支持不如 Web 成熟，先在 web 上调通再迁到手机。

---

## 五、打包成真正的安装包

### Android —— 这台 Windows 就能出包

```bash
# 方式 A：Expo 云构建（不需要装 Android Studio）
npm install -g eas-cli
eas login
eas build --platform android --profile preview

# 方式 B：本地构建（需要装 Android Studio + JDK）
eas build --platform android --local
```
产出 `.apk` / `.aab`，直接发手机装。

### iOS —— 必须 macOS + Xcode，或云构建

**Windows 上没法打 iOS 包，这是苹果的限制，不是配置问题。** 两条路：

1. **Expo 云构建**（推荐，不用买 Mac）
   ```bash
   eas build --platform ios
   ```
   需要一个 Apple Developer 账号（¥688/年）。免费账号也能装到自己的手机上，但证书 7 天失效。

2. **借一台 Mac**，本地跑 `eas build --platform ios --local`。

> 要上架 App Store 的话，这类"AI 伴侣"产品要注意审核规则：
> 说明清楚 AI 身份、内容分级、用户数据处理方式，否则容易被拒。

---

## 六、项目结构

```
llm-companion/
├── App.js                     导航与启动
├── app.json                   App 配置（名字 / 图标 / 包名）
├── index.js                   入口
├── assets/                    图标与启动图
└── src/
    ├── theme.js               人格设定、配色、3D 形象参数、等级与礼物表
    ├── store.js               养成状态 + AsyncStorage 持久化 + 时间衰减
    ├── llm.js                 大模型调用 + 离线兜底引擎 + 记忆抽取
    ├── useStore.js            React 侧的 store 订阅
    ├── three/
    │   └── companion.js       3D 角色几何构建 + 动画 + 粒子（平台无关）
    ├── components/
    │   ├── Avatar3D.web.js    web 渲染（canvas + three）
    │   ├── Avatar3D.native.js 原生渲染（expo-gl + three）
    │   └── ui.js              玻璃卡 / 进度条 / 按钮 / 底部弹层
    └── screens/
        ├── PersonaSelect.js   选人格
        ├── Home.js            主界面：3D 舞台 + 养成面板
        ├── Chat.js            聊天
        └── Settings.js        模型配置与数据管理
```

---

## 七、几个已经做进去的取舍

1. **没有用真流式输出**。React Native 的 `fetch` 对流支持不稳定，容易在非主流机型上卡死。
   改成了「整段请求 + 前端打字机」，`await requestCompletion` 拿全文，
   由 Chat 页按帧推进显示 —— 用户看到的完全一样，但不会挂。想换成真流式，
   改 `src/llm.js` 的 `requestCompletion`，同时把 UI 的打字机去掉。

2. **触摸判定用分区，不用射线检测**。射线检测依赖各平台触摸事件的细节，
   分区方案在 iOS / Android / Web 上表现一致，也好调（`HOME HEAD_ZONE` 一个常量）。

3. **3D 用几何体拼，不下载模型文件**。见第四节。

4. **没引状态管理库**。一个 `useSyncExternalStore` 就够了，少一个依赖少一处版本冲突。

5. **WebGL2 降级**：three r16x 之后只支持 WebGL2。老设备如果初始化失败，
   主界面会自动降级成一个 emoji 卡面，而不是白屏闪退。

---

## 八、加第四个人格

编辑 `src/theme.js` 的 `PERSONAS` 数组，加一个对象就行：

- `id / name / role / emoji / tagline / greet`
- `colors`：UI 配色
- `avatar`：`skin / hair / top / bottom / eyes / blush / style`
  `style` 目前支持 `'twin-tail'`（双马尾）· `'spike'`（短刺发）· `'glasses'`（直长发+眼镜）
- `voice`：`pet / poke / gift / levelUp / lowMood / idle` 六组台词
- `system`：给大模型的角色设定

顺便补一份 `src/llm.js` 里 `SCRIPTS` 的兜底台词（key 用新的 persona id）。
