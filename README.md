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

### 2.1 语音合成服务商（TTS）怎么选

路径：**主界面 ⚙️ → 说话与联网 → 说话 · 联网设置**。三家都接了，随时可切。

| 服务商 | 适用情况 | 备注 |
|---|---|---|
| **OpenAI** | 综合最自然，推荐日常聊天 | `gpt-4o-mini-tts` 支持用自然语言描述语气；延迟低；粤语可用 `alloy`/`nova` 等音色近似发音 |
| **Azure** | 中文 / 粤语效果最好 | 有专门的**粤语音色** `zh-HK-WanLungNeural`（男，成熟自然）、`HiuGaaiNeural`（女，温柔亲切）、`HiuMaanNeural`（女，活泼年轻）；**注意**：粤语音色不支持 `<mstts:express-as>` 情绪样式，代码里已自动跳过 |
| **ElevenLabs** | 英语场景最好听 | 通过 `stability / style / similarity_boost` 三个参数调情绪强度 |

OpenAI 的音色列表：`alloy / ash / ballad / coral / echo / fable / nova / onyx / sage / shimmer`。

### 2.2 语音识别（STT）与方言

| 服务商 | 备注 |
|---|---|
| OpenAI Whisper | 通用，多语言识别稳 |
| Groq Whisper-large-v3 | 目前最快的选项，适合实时对话 |
| Azure | 粤语识别最准（指定 `zh-HK` 区域） |

粤语检测是自写的打分逻辑（`src/voice/stt.js`）：统计句子里「冇、嘅、喺、咗、啲、乜、咁、佢、俾」这类粤语特有字的占比来判定，不依赖 LLM。

### 2.3 推荐的大模型

- **中文场景**：`DeepSeek` 或 `Moonshot / Kimi`（成本低、延迟低）
- **需要粤语创造力**：`Moonshot` 或 `qwen-plus`（粤语产出的口语感更自然，不容易写成书面语）
- **需要情绪**：建议用支持 function calling 的模型，否则联网 / 提醒等能力会退化（见 2.5）

> 💡 **粤语能力**：粤语效果主要看 LLM 的粤语产出能力，TTS 只是把字念出来。
> 想让角色粤语说得好，**选对大模型比选对音色更重要**。

### 2.4 说话语言

支持四种，可在设置里选：

| 选项 | 行为 |
|---|---|
| **auto**（推荐） | 自动识别你说的是粤语、普通话还是英语，然后用同一种语言回答 |
| 粤语 zh-HK | 角色固定用粤语口语回答 |
| 普通话 zh-CN | 角色固定用普通话回答 |
| 英语 en-US | 角色固定用英语回答 |

还有 **mix** 模式：中英夹杂自然地切换，适合香港 / 海外用户的日常说话习惯。

### 2.5 联网搜索、天气与换算

**联网搜索**（三家可选，`none` 表示关闭）：

| 服务商 | 备注 |
|---|---|
| Tavily | **推荐**，专为 AI Agent 设计，直接返回答案摘要和来源，而非一堆链接再让 LLM 自己读 |
| Brave | 有免费额度，即时性强 |
| Serper | Google 搜索结果，适合查本地生活信息 |

**天气**：走 **Open-Meteo**，完全免费、**不需要 Key**。问「明天需要带伞吗」会自动地理编码城市并给出预报。

**单位换算、运算、音频转写**：OpenAI 兼容接口的通用能力，凡是支持 function calling 的模型都能主动调用；模型不支持时会退化到关键词触发（`src/services/tools.js`）。

### 2.6 麦克风、打断与韵律

ChatGPT 式的交互已经打通：

- 🎙️ **麦克风**：按住麦克风说话（Whisper 转文字），或者直接打字。打字也一样会念出来，走的是同一套韵律系统。
- 🛑 **打断**：播放过程中监测麦克风音量，超过阈值 **-25dB 且持续 320ms** 就判定为你想插话，立刻停止播放并切回录音。
- 😂 **带笑声的语音**：LLM 输出的文字里会插入情绪标记（`[laughs]`、`[sighs]`、`[giggles]` 等），系统按标记把一句话拆成多段，每段用不同的情绪参数分别合成，再拼起来播放。所以会有真正的笑声、叹气、耳语。

可用的情绪标记：`[laughs] [giggles] [sighs] [excited] [comfort] [gentle] [sad] [shy] [whispers] [surprised] [curious] [serious] [sing] [teach] [proud] [sleepy]`

### 2.7 儿童模式（AD）

打开设置里的**儿童模式**后会启用一套独立的提示词：

1. 用看得见的比喻讲科学，不用抽象概念（讲"地球为什么转"，用「旋转木马」而不是「向心力」）
2. 句子更短，一次只说一件事
3. 孩子说错不否定，先肯定他在思考，再轻轻补正
4. 遇到科学话题自动切到 `[teach]` 那种耐心语气

### 2.8 每个角色的音色映射

三个角色各自配了一套音色，定义在 `src/theme.js` 的 `SPEECH`：

| 角色 | 风格 | OpenAI | Azure 普通话 | Azure 粤语 | Azure 英语 | ElevenLabs |
|---|---|---|---|---|---|---|
| **小柔**（女朋友） | 软甜少女音 | `nova` 1.05× | `zh-CN-XiaoyiMultilingualNeural` | `zh-HK-HiuGaaiNeural` | `en-US-AvaMultilingualNeural` | `EXAVITQu4vr4xnSDxMaL` |
| **阿哲**（男朋友） | 低沉少年音 | `echo` 0.95× | `zh-CN-YunxiMultilingualNeural` | `zh-HK-WanLungNeural` | `en-US-AndrewMultilingualNeural` | `ErXwobaYiN019PkySvjV` |
| **林秘书**（秘书） | 清冷专业音 | `sage` 1.0× | `zh-CN-XiaoxiaoMultilingualNeural` | `zh-HK-HiuMaanNeural` | `en-US-JennyMultilingualNeural` | `21m00Tcm4TlvDq8ikWAM` |

> ⚠️ **粤语音色的坑**：Azure 的粤语音色（HiuGaai / WanLung / HiuMaan）**不支持** `<mstts:express-as>` 情绪样式，
> 硬塞会报错。代码里已经标记为 `allowStyle: false` 自动跳过，只用语速和语调表达情绪。
> 这是目前在 Azure 上做粤语情感语音的一个真实限制 —— 想要粤语 + 强情绪，建议 TTS 选 OpenAI。

> 想换就把 `src/theme.js` 的 `SPEECH[personaId]` 改成你喜欢的音色即可。Azure 完整音色列表见[官方文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)。

### 2.9 iPhone 提醒事项

**需要说清楚的限制**：Apple **没有提供**往系统「提醒事项」App 里写东西的 API —— 不是我们不想做，是 iOS 不给这个口子。

所以替代方案是**本地通知**：App 会申请通知权限（第一次打开语音功能时申请），然后像闹钟一样在指定时间推送提醒，效果和提醒事项基本一致。

角色会自动调用：说「十分钟后提醒我吃药」，她就设一个 10 分钟后的本地通知。

### 2.10 记忆

角色LLM 可以主动调用 `remember_fact` 工具记住关于你的事：名字、喜好、家人、重要日期。
记下来的内容会持久存在本机，并且在每次对话时作为 system prompt 的一部分注入（见 `src/llm.js` 的 `buildSystemPrompt`），所以她是真的"记得你"，而不是每轮重新认识。

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
├── src/
│   ├── theme.js               人格设定、配色、3D 形象参数、等级与礼物表
│   ├── store.js               养成状态 + AsyncStorage 持久化 + 时间衰减
│   ├── llm.js                 大模型调用 + 离线兜底引擎 + 记忆抽取
│   ├── useStore.js            React 侧的 store 订阅
│   ├── chatEngine.js          带 function calling 的对话层（联网 / 提醒 / 记忆）
│   ├── useVoice.js            把录音→识别→大模型→语音→播放串起来的 Hook
│   ├── voice/
│   │   ├── tts.js             情绪语音合成（三家服务商 + 情绪标记解析）
│   │   ├── stt.js             语音识别（Whisper / Groq / Azure）+ 粤语检测
│   │   └── session.js         录音 / 打断检测 / 音频播放队列
│   ├── services/
│   │   ├── tools.js           给大模型用的工具箱 + 不支持工具时的降级
│   │   ├── web.js             联网搜索（Tavily / Brave / Serper）+ 天气
│   │   ├── reminders.js       iPhone 本地通知提醒
│   │   └── songs.js           程序化合成的儿歌（无版权风险）
│   ├── config/
│   │   └── providers.js       语音 / 识别 / 搜索服务商的清单
│   ├── three/
│   │   └── companion.js       3D 角色几何构建 + 动画 + 粒子（平台无关）
│   ├── components/
│   │   ├── Avatar3D.web.js    web 渲染（canvas + three）
│   │   ├── Avatar3D.native.js 原生渲染（expo-gl + three）
│   │   ├── VoiceMic.js        ChatGPT 式麦克风按钮
│   │   └── ui.js              玻璃卡 / 进度条 / 按钮 / 底部弹层
│   └── screens/
│       ├── PersonaSelect.js   选人格
│       ├── Home.js            主界面：3D 舞台 + 养成面板 + 麦克风
│       ├── Chat.js            聊天
│       ├── Settings.js        模型配置与数据管理
│       └── VoiceSettings.js   语音 / 语言 / 联网 / 儿童模式
├── tools/
│   ├── tts.test.mjs           情绪切分回归测试
│   ├── songs.test.mjs         儿歌音频合成测试
│   └── lint-styles.mjs        静态检查：找出引用了但没定义的样式
└── 迁移说明.md                换电脑 / 迁移说明
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
