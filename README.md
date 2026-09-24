# AIVA — AI 伴侣 App（3D 形象 + 好感度养成 + 多人格）

一个能装进 iPhone 和安卓手机的原生 App。三个 AI 人格（女友 / 男友 / 秘书），
可触摸的 3D 卡通形象，加上一套会随时间衰减的好感度养成系统。

形象是**真的会动**的：模型带 25 根标准骨骼（摸头会歪头、被戳会抬手），
脸上有 24 个 ARKit 表情 —— 说话时嘴在对口型（不是循环播动画，
是按文本排出来的），语气带情绪时眉眼也跟着变。

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

路径：**主界面 ⚙️ → 说话与联网 → 说话 · 联网设置**。

> ✅ **不填任何 Key 也能出声。** 每个平台都有默认的免 Key 引擎：
>
> | 平台 | 默认服务商 | 实际发声的是谁 |
> |---|---|---|
> | **网页版（Web）** | `edge` | 浏览器自带的微软神经粤语嗓音（`zh-HK-HiuGaaiNeural` 等） |
> | **iPhone / Android** | `native` | 手机自带的系统嗓音（`expo-speech` → iOS `AVSpeechSynthesizer` / Android `TextToSpeech`），**完全离线** |
>
> 已经填了 Key 的旧存档不会被改动 —— 迁移只在「选了云端服务却没填对应 Key」时才自动切过去。

#### 免 Key 引擎（不联网也能说话）

| 服务商 | 适用情况 | 备注 |
|---|---|---|
| **系统嗓音（手机内置）** | iPhone / Android 默认 | 走 `expo-speech`（Expo SDK 57 自带，**Expo Go 里直接可用**，不用自建开发客户端 / EAS 构建）。粤语想更地道：iPhone 到「设置 → 辅助功能 → 朗读内容 → 声音」下载「中文（粤语）」嗓音；没下载也会出声，只是用默认嗓音念。情绪只能靠音高 / 语速微调（`src/voice/nativeEmotion.js`），比云端平淡 |
| **Edge 神经语音（浏览器）** | 网页版默认 | 用浏览器自带的微软 `zh-HK` 神经嗓音，在 Edge / Windows 上就是真正的粤语神经音；其它浏览器会退而求其次用设备已有的粤语声音 |
| **eSpeak（离线·机械音）** | 前两者都不可用时的兜底 | 浏览器内跑 eSpeak NG WASM（放在 `public/espeakng/`，**必须同源托管**，Web Worker 不能跨域加载）。粤语嗓音码是 **`zhy`**（不是 `yue`，写成 `yue` 会静默回落成默认嗓音）。机械音，但保证一定有声音 |

#### 云端服务商（需要 Key，音质最好）

三家都接了，随时可切。

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

## 四、3D 模型这一层是怎么工作的

**三个角色都已经配好真实的 `.glb` 模型了**，就在 `assets/models/`，每个角色一个 `.glb` 加一张 `.jpg` 贴图。

启动时的顺序是这样的：

1. 先把**程序化角色**（用几何体拼出来的那个小人）画上去 —— 它能立刻显示，不用等任何 IO。
2. 同时异步读 `assets/models/<角色id>.glb`，解析成功后**热替换**掉程序化角色。
3. 再把 `<角色id>.jpg` 解码成 `DataTexture`，贴到模型表面。

任何一步失败，都只停在「降级形态」，不会崩：

| 失败点 | 表现 |
|---|---|
| glb 读不出来 / 解析失败 | 保留程序化角色 |
| jpg 解不了 | 模型以赛璐璐纯色显示 |
| 压根没配资源 | 从一开始就用程序化角色 |

也就是说，最差的结果是「没那么好看」，不会出现白屏或闪退。

### 为什么模型和贴图要分开放

React Native 没有 DOM，three 自带的贴图加载器在原生端会直接崩。所以：

- `.glb` 里**只留几何体**（这部分一定能加载）
- 贴图单独存成 `jpg`，由 App 自己用 `jpeg-js` 解码后交给 three

顺带也解决了体积：生成的 glb 里那张贴图原本占 10MB+，抽出来压缩后，三个角色的模型加贴图合计约 1.8MB。

相关代码在 `src/lib/assetBytes.js`（把打包资源读成字节）和 `src/lib/companionModel.js`（挂载与降级）。

### 换成你自己的模型

1. 模型导出成 glTF / `.glb`，贴图拆出来另存 jpg（现成脚本：`python tools/split_texture.py girlfriend boyfriend secretary`）
2. 按角色 id 命名丢进 `assets/models/`，例如 `girlfriend.glb` / `girlfriend.jpg`
3. **给它绑骨架**：`node tools/autorig.mjs assets/models/girlfriend.glb`
   会产出 `girlfriend.rigged.glb`（蒙皮网格）和 `girlfriend.morph.json`（表情），见下一节
4. 在 `src/lib/companionModel.js` 的 `PERSONA_MODELS` 里登记 —— 那里是静态 `require`，Metro 在打包时解析，**引用了不存在的文件会直接构建失败**

挂载时会自动按包围盒缩放到 2.05 米高、水平居中且脚踩地面，材质也会统一换成 `MeshToonMaterial` 对齐画风
（有顶点色就用顶点色，没有就按角色主色染一层），通常不需要手动调。

---

## 四·五、自动绑骨：从「雕像」到「能动」

现成的 VTuber 模型大多是**静态网格**——没有骨骼、没有表情，本质是一尊雕像。
`tools/autorig.mjs` 一次性把它变成可在运行时驱动的资源：

```bash
node tools/autorig.mjs assets/models/girlfriend.glb
#   ✓ girlfriend.rigged.glb (856KB) + morph (147KB)
```

产出两样东西：

| 文件 | 内容 |
| --- | --- |
| `xxx.rigged.glb` | 每个 mesh 变成绑在**统一标准骨架**上的 `SkinnedMesh`，材质 / UV / 贴图原样保留 |
| `xxx.morph.json` | 稀疏存储的 BlendShape（只存脸部顶点），单角色约 150~215KB |

骨架用的是 **Mixamo 兼容命名**（`Hips` / `Spine` / `LeftArm` / `LeftForeArm` …共 25 根）。
选它的理由很实际：Mixamo 是全球最大的免费动作库，命名一致意味着从那儿下载的动画可以**零重定向**直接套上来。

### 运行时怎么接上

```
companionModel.js  require('xxx.rigged.glb')  →  companion.js attachModel()
                                                      ↓
                                              rigDriver.js createRigDriver()
                                                      ↓ 用 anim/rigStandard.js 的别名表认骨
                                              每帧 update() 转骨骼 rotation
```

`src/three/rigDriver.js` 把「模型骨架」和「程序化角色」抽象成**同一套接口**，
所以 `companion.js` 的 `update()` 不用区分两种情况：

```js
if (rig) rig.update({ t, headTilt, armRaise, lookX, lookY, bounce });
else     character.head.rotation.z = …   // 老路径，程序化角色
```

认不出骨架（覆盖率 < 50%）时会返回 `null`，动画自动退回程序化那套，**不会崩也不会扭成麻花**。

### 绑骨时踩过的三个坑

这三个都不是「差不多就行」的小问题，每一个都会让骨架整根歪掉：

**1. 头顶的呆毛会骗走「身高」**
这批模型头顶常有一根极细的呆毛，只有个位数顶点却顶在最高处。直接拿全局 `maxY` 当头顶，
量出来的身高凭空多一截，全身比例被拉长。现在先用 p99.5 高度当「有效头顶」。

**2. Q 版模型两条腿是并在一起的**
找裆部的经典办法是「从下往上找第一个中线附近没顶点的高度」，这在写实模型上很准。
但 Q 版短腿并拢，中线**全程都有顶点**，循环一路走到最底下，把裆部判在脚踝上
——实测报出「裆部 0.02m」，于是骨盆、脊柱、腿骨全部塌到地面。
现在先检测中线空隙是否真的存在，不存在就按腰线位置估算比例。

**3. 手臂和双马尾在同一个 x 区间**
想定位肩膀，用 `|x|` 判「外扩」是行不通的——双马尾和手臂都在 `0.30~0.70`，
头发甚至会一路算作外扩，把肩线判到头顶（实测报出「肩 1.59m，身高才 1.67m」）。
有用的信号是**两侧顶点群的 z 厚度如何随高度变化**：头发厚且越往下越厚，
手臂薄并且一路变薄、最后直接消失。实测手臂落在 `0.77~1.00m`（约 46%~60% 身高）。

> 还有一个必须记住的顺序问题：**「是不是手臂」要在按高度分区之前判**。
> 手臂挂在身侧是向下垂的，girlfriend 的手臂在 `0.77~1.00m` 而「胸」在 `1.24m`
> ——手臂绝大部分比胸更低。早先按高度分区时，手臂顶点全落进了「躯干」分支，
> 候选骨里根本没有 `Arm`/`ForeArm`/`Hand`，这三根骨头一个顶点都拿不到。

### 验收方式

光看「骨头存在」是不够的，`tools/pipeline.test.mjs` 会真的转骨骼、用 `applyBoneTransform`
算出顶点位移并断言：

```
✓ 核心骨覆盖 13/13
✓ Head 骨确实拥有一批顶点  20 个采样点
✓ 动画真的驱动了头部顶点（不是摆设）  最大位移 0.0775m
```

> 一个容易踩的测试陷阱：`applyBoneTransform` 依赖 `skeleton.update()` **和**
> `updateMatrixWorld()` 两者都刷过。少刷后者，`boneMatrices` 全是旧的，
> 测出来的位移永远是 0 —— 会误判成「动画没接上」。

---

## 四·六、表情与口型：让角色真的会说话

骨架解决了「身体能动」，但脸还是死的。这一层把 `xxx.morph.json` 接进运行时。

### 运行时怎么接上

```
companionModel.js  readAssetJSON('xxx.morph.json')
                          ↓
                   companion.js applyMorph()  →  anim/morphData.js
                          ↓ 稀疏 delta 摊平成整网格的 morphAttributes.position
                   每帧 lips.update(t, dt)  →  anim/lipSync.js
                          ↓ 文本 → 音素 → 口型 → 按时间推进
                   morphTargetInfluences[name] = 0~1
```

### 为什么不用音频分析做口型

看起来最直觉的做法是接 `AnalyserNode` 算频谱，但那条路有三个硬伤：

1. **原生端没有 WebAudio** —— Expo 的那一半平台直接废掉；
2. 三家 TTS 拿到的都是 mp3，要解码成 PCM 才能算频谱，多一层依赖和延迟；
3. **听不出差别，但省一大截电**。口型的目标是「看着在说话」，不是还原频谱。

所以改用「文本 → 音素 → 口型 → 按时间推进」：中文按拼音韵母分级，
英文按元音簇分组，都映射到 4~5 个 ARKit 嘴部形状。这条链路是**纯函数**，
不依赖任何 API key，`pipeline.test.mjs` 里可以直接断言。

口型刻意做得粗 —— 4~5 个形状就够。做细反而会因为和真实音频不同步而显得更假。

### 和 TTS 的对接点

关键在 `voice/session.js`：口型必须在**音频真正开始播放**的那一刻排期，
而不是「开始合成」：

```js
// 播放回调里
this.opts.onSpeakSegment?.(clip.text, clip.emotion);
```

合成一段要几百毫秒、一整段要几秒，按合成触发的话**嘴会先动完、然后才出声**。

打断（barge-in）和用户点停止时都会调 `onSpeakEnd` → `stopSpeaking()`。这里有个
必须一起做的事：**情绪也要放掉**，否则角色会带着被打断时的微笑永远挂在脸上
——因为 `emoDst` 还停在 0.4，指数趋近永远不会归零。

### 这份数据格式有个必须显式记录的东西

`deltas` **不是**「每个 shape 都用满整张稀疏表」。左右分开的形状
（`mouthSmileLeft` / `eyeBlinkRight` …）在生成时对不属于自己那一侧的顶点是
`continue` 跳过的，所以它的三元组数 < 稀疏表长度（实测 299 vs 195 / 104）。

因此 v2 格式带上了 `shapeSlots`：

| 字段 | 含义 |
| --- | --- |
| `indices` | 所有会动的脸部顶点的 `[meshIdx, vertexIdx]` 池 |
| `shapeSlots[s]` | 第 k 个三元组对应 `indices` 里的第几个 |
| `deltas[s]` | 展平的位移量，长度 = `3 × shapeSlots[s].length` |

没有这张表就只能退化假设 1:1，结果是**左右表情错位**（嘴歪、眼斜）。

### 又一个必须关掉的剔除法

有表情之后包围盒会随表情变化，视锥剔除会把**正在说话的头**整个剔掉。
所以接上 morph 的网格要 `frustumCulled = false`。

### 验收方式

同样用数值断言，而不是「看起来像在动」：

```
✓ morph.json 含 24 个 ARKit 形状
✓ applyMorph 接上了 morph
✓ 每个 morph 属性的长度 === 顶点总数（稀疏已摊平）  24 个 × 31383
✓ jawOpen 满权重时顶点位移可观  最大 10.7mm
✓ 中文句子排出了口型帧  12 帧
✓ 语速 1.5 时口型时长变短（对得上 TTS speed）  2.43s → 1.62s
✓ speak 之后有 morph 权重被推动（嘴真的在动）  峰值 0.399
✓ stopSpeaking 后嘴部权重回落到静止  残量 0.008
```

再加一道**浏览器端**的视觉验证（`npm run verify:lips`）：
进角色页 → 截图 → 调 `speak()` → 说话中截图 → `stopSpeaking()` → 截图。
权重断言和像素都要过 —— 权重推对了但网格没变是完全可能的。

### 一个静默失效的打包陷阱

`xxx.morph.json` 一开始**根本没进 web 产物**。原因是 Metro 对 `.json` 的默认行为是
**当 JS 模块 inline 进 bundle**，于是：

- `require('xxx.morph.json')` 拿到的是**已解析的对象**，不是资源引用；
- 把它喂给 `Asset.fromModule()` 会抛
  `Module "[object Object]" is missing from the asset registry`；
- 而且 200KB × 3 会白白塞进主 bundle。

两处要一起改：

1. `metro.config.js` 把 `morph.json` 注册成资源扩展名（注意写全，
   **不能**把普通 `.json` 一起变资源，否则 `package.json` 这类配置就废了）；
2. `lib/assetBytes.js` 加了 `readAssetJSON()`：**两条路都兼容** ——
   传进来已经是对象就直接用，是资源引用就读字节再 `JSON.parse`。
   判据是「有没有 `uri` / `__packager_asset`」，**不按内容形状判断**，
   否则别的 JSON 会被误拒。

> 这类 bug 的特点：不报错、不崩、页面照常渲染，只是**表情永远不动**。
> 所以每次改完资源管线，都要真的导出一次看 `Assets (N)` 列表里有没有它。

> 关于 **VRM**（`.vrm`，本质是 glTF 扩展）：配 `three-vrm` 会自带骨骼和表情 BlendShape，适合做动漫角色。
> 只是它在 React Native 上的支持不如 Web 成熟，建议先在 web 上调通再迁到手机。

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

### Web —— 放到 GitHub Pages（免费公开链接，iPhone 直接开）

iOS 原生包要 macOS + Apple 开发者账号，Windows 上打不了。想在 iPhone 上先试，
最快的路子是把 **Web 版**挂到 GitHub Pages：免费、自带 HTTPS（麦克风权限必须要 HTTPS）、有公开网址。

仓库里已经带了工作流 `.github/workflows/deploy-pages.yml`。你要做的只有三步：

1. 建一个**公开**仓库推上去（私有仓库的 Pages 要付费账号）
2. 仓库 **Settings → Pages → Source 选「GitHub Actions」**
3. 之后每次 `git push` 都会自动重新打包发布，网址是
   `https://<用户名>.github.io/<仓库名>/`（仓库名如果就叫 `<用户名>.github.io`，网址就是根域名）

工作流里两个最容易踩空的地方已经处理好了：

- **baseUrl**：Pages 挂在 `/<仓库名>/` 子路径下，而 Expo 默认把资源写成绝对路径
  `/assets/...`。不改的话整站资源 404。工作流会在打包前按仓库名把
  `expo.experiments.baseUrl` 写进 `app.json`。
  > ⚠️ baseUrl 只管得了 Expo 自己打包的资源。**代码里手拼的 URL 它管不着** ——
  > 曾经 `src/voice/espeak.js` 写死 `/espeakng/`，在子路径下解析到站点根目录 404，
  > 结果离线 TTS 在 Pages 上整个失效（页面照常用，只是没声音，极难查）。
  > 所以 `tools/fixhtml.mjs` 会把 baseUrl 再注入一次，变成运行时常量
  > `window.__AIVA_BASE__`。**凡 JS 里自己拼路径去取资源，一律用它当前缀，别写死 `/`。**
- **打包红线顺序**：`expo export` 会清空 `dist`，所以必须依次补
  `tools/fixhtml.mjs`（启动兜底 + iOS 捏合缩放拦截）、`tools/buildadmin.mjs`（admin.html）、
  `tools/precompress.mjs`（预压缩）。少任何一步，手机上就是白屏或后台页空白。
  > `fixhtml.mjs` 是**幂等**的，重复跑不会叠加。它注入的两块东西都带唯一 id
  > （`aiva-base` / `aiva-boot-safety`），删除时也认 id ——
  > 千万别把清理正则写成「从第一个 `<script>` 匹配到含某关键字的 `</script>`」，
  > 那种写法一旦 head 里多了脚本，就会把 `<title>` 到 `<div id="root">` 全吞掉。

> ⚠️ 手工发布到其它平台时同理：部署类型要选 **Node**（跑 `node server.js`），别选纯静态 ——
> 静态服务器不压缩，6.6MB 主包裸发给手机基本就是长时间白屏。

---

## 六、项目结构

```
llm-companion/
├── App.js                     导航与启动
├── app.json                   App 配置（名字 / 图标 / 包名）
├── index.js                   入口
├── metro.config.js            把 .glb / .morph.json 注册成静态资源（见第四·六节）
├── assets/
│   ├── models/                角色真人模型（.rigged.glb + .jpg + .morph.json），见第四节
│   ├── preview/               截图
│   └── *.png                  图标 / 启动图
├── src/
│   ├── theme.js               人格设定、配色、3D 形象参数、等级与礼物表
│   ├── store.js               养成状态 + AsyncStorage 持久化 + 时间衰减
│   ├── llm.js                 大模型调用 + 离线兜底引擎 + 记忆抽取
│   ├── useStore.js            React 侧的 store 订阅
│   ├── chatEngine.js          带 function calling 的对话层（联网 / 提醒 / 记忆）
│   ├── useVoice.js            把录音→识别→大模型→语音→播放串起来的 Hook
│   ├── voice/
│   │   ├── tts.js             情绪语音合成（云端三家 + 情绪标记解析）
│   │   ├── nativeSpeech.js    系统嗓音 TTS（expo-speech，iPhone/Android 免 Key 离线）
│   │   ├── nativeEmotion.js   系统嗓音的情绪 → 音高/语速换算（纯函数，可单测）
│   │   ├── espeak.js          eSpeak NG WASM 封装（Web 离线兜底，粤语嗓音码 zhy）
│   │   ├── webSpeak.js        Web 端「试听」播放通道
│   │   ├── session.js         原生端会话：录音 / 打断检测 / 音频队列 / 系统嗓音朗读
│   │   ├── webSession.js      Web 端会话：按 provider 分发 Edge / eSpeak
│   │   └── stt.js             语音识别（Whisper / Groq / Azure）+ 粤语检测
│   ├── services/
│   │   ├── tools.js           给大模型用的工具箱 + 不支持工具时的降级
│   │   ├── web.js             联网搜索（Tavily / Brave / Serper）+ 天气
│   │   ├── reminders.js       iPhone 本地通知提醒
│   │   └── songs.js           程序化合成的儿歌（无版权风险）
│   ├── config/
│   │   └── providers.js       语音 / 识别 / 搜索服务商的清单
│   ├── three/
│   │   ├── companion.js       3D 舞台：几何构建 + 动画 + 粒子 + glb 挂载（平台无关）
│   │   └── rigDriver.js       真模型的骨骼驱动（认骨 / 转骨，与程序化角色同接口）
│   ├── lib/
│   │   ├── assetBytes.js      把打包资源读成 Uint8Array / JSON（原生 / Web 两条路）
│   │   └── companionModel.js  角色 → 模型资源的登记，以及挂载与降级
│   ├── anim/
│   │   ├── rigStandard.js     各家骨骼命名 → 统一标准的映射
│   │   ├── faceStandard.js    ARKit 52 BlendShape 标准与别名表
│   │   ├── morphData.js       把 morph.json 灌进 geometry.morphAttributes
│   │   └── lipSync.js         文本 → 音素 → 口型，以及情绪 → 表情
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
│   ├── tts.test.mjs           情绪分段 + 去标签的回归测试
│   ├── songs.test.mjs         儿歌音频是否真的有声
│   ├── pipeline.test.mjs      glb → 解析 → 挂载 → 贴图 → 骨架 → 表情口型的端到端数值断言
│   ├── verify-lips.mjs        在真浏览器里说一句，前后截图比对口型（需先起 dist 服务）
│   ├── lint-styles.mjs        静态检查：找出引用了但没定义的样式
│   ├── lint-imports.mjs       静态检查：找出导入不存在的导出（这类错会让整页白屏）
│   ├── build-character.mjs    程序化生成人形角色（含 Mixamo 骨架 + ARKit BlendShape）
│   ├── autorig.mjs            给静态网格自动绑骨骼 + 生成 BlendShape
│   ├── inspect-model.mjs      打印 glb 的骨骼 / 网格清单
│   ├── silhouette.mjs         把模型投影成 ASCII 轮廓，肉眼确认姿态比例
│   ├── validate_model.mjs     校验拆分后的 glb 可解析，输出面数与材质
│   ├── split_texture.py       把 glb 拆成「无贴图模型 + 压缩 jpg」
│   ├── fetch_3d.py            轮询并下载 3D 生成任务的 .glb
│   ├── shot.mjs               用本机 Chrome 给 dist/ 页面截图
│   └── mkzip.mjs              把项目打成 zip（零依赖，替代不可用的 zip 命令）
└── 迁移说明.md                换电脑 / 迁移说明
```

> `src/anim/rigStandard.js` 被 `src/three/rigDriver.js` 引用，用来把模型自带的骨骼名
> 映射到统一标准（见第四·五节）；`src/anim/faceStandard.js`（ARKit 52 个 BlendShape）
> 和 `src/anim/morphData.js`、`src/anim/lipSync.js` 一起在第四·六节的表情/口型链路里工作。

### 6.1 开发时的检查命令

```bash
npm run lint     # 导入完整性 + 样式引用检查
npm test         # 情绪分段 / 儿歌音频 / 3D 挂载·骨架·表情·口型
npm run export:web   # 打个 web 包到 dist/，用来在浏览器里看效果
npm run verify:lips http://127.0.0.1:8130/   # 浏览器里真的说一句，截图比对口型
```

`lint-imports.mjs` 专门防一类**打包不报错、运行时整页白屏**的问题：
从某个模块导入了它根本没导出的名字（真实踩过：从 `components/ui` 导入 `UI`，
但 `UI` 其实住在 `theme.js`，于是 `color: UI.text` 直接抛异常，整个设置页白屏）。

---

## 七、几个已经做进去的取舍

1. **没有用真流式输出**。React Native 的 `fetch` 对流支持不稳定，容易在非主流机型上卡死。
   改成了「整段请求 + 前端打字机」，`await requestCompletion` 拿全文，
   由 Chat 页按帧推进显示 —— 用户看到的完全一样，但不会挂。想换成真流式，
   改 `src/llm.js` 的 `requestCompletion`，同时把 UI 的打字机去掉。

2. **触摸判定用分区，不用射线检测**。射线检测依赖各平台触摸事件的细节，
   分区方案在 iOS / Android / Web 上表现一致，也好调（`HOME HEAD_ZONE` 一个常量）。

3. **程序化角色和真模型并存，而不是二选一**。程序化版本不依赖任何外部文件、一定能画出来，
   所以它同时充当「首帧占位」和「加载失败时的兜底」；真模型异步到位后热替换上去。
   两边的动作都走同一套接口（`rigDriver.js` 对骨骼、老路径对 group），
   所以真模型也能「脑袋跟指尖转、被摸抬手」—— 详见第四·五节。

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

**3D 形象怎么处理：** 不配模型也能跑 —— `loadCompanionModel` 会返回 `no-asset`，界面上就是那个程序化角色。
但要注意 `src/lib/companionModel.js` 里的 `PERSONA_MODELS` 用的是静态 `require`，**登记了却不存在的文件会让 Metro 直接构建失败**。
所以要么连 `assets/models/<新id>.glb` 一起准备好（生成流程见第四节），要么干脆别在那张表里登记这一项。

---

## 九、版权与合规

上架前建议自己核对一遍。这个 App 用到的素材来源如下：

| 项目 | 来源 | 风险 |
|---|---|---|
| 全部代码 | 本项目原创 | 无 |
| App 界面元素（图标、插画） | 由 ImageGen 生成 | 建议保留生成记录 |
| `src/services/songs.js` 里的儿歌 | 公有领域旋律 + 代码合成 | 见下 |
| App 生成的语音 | 你选的 TTS 服务商实时合成 | 看服务商条款 |
| LLM 生成的回答 | 你选的模型实时产出 | 看服务商条款 |

**儿歌。** 四首旋律均属公有领域：

- `小星星` —— 传统童谣《一闪一闪亮晶晶》
- `两只老虎` —— 法国童谣《雅克兄弟》
- `伦敦大桥` —— 英国童谣 London Bridge
- `生日快乐` —— 其旋律已于 2016 年被美国法院判定进入公有领域

音频由代码合成，不含任何录音。若不放心，删掉 `MELODIES` 里对应的歌即可。

**语音。** App 不内置语音数据，全部由所选服务商实时生成。

**虚拟人外观。** 侵权风险通常来自两种情形：外观高度像某个真实自然人，或使用了他人享有著作权的美术。交给 App 自动生成的部分风险较低，但上架前建议自行确认。

---

## 十、机器人接入：还没做

先说清楚现状：

> **这个仓库里目前没有任何机器人相关代码。**

在此之前，本节曾把 `amoji.ts`、`companionBundle.ts`、`SenMQTransportFactory.ts` 等文件写成"已实现"。这些文件在本项目中从未存在过（已核对 git 历史与磁盘），属于误记，已删除。

原因是中间一度把设计意图当成了已完成的实现。这是我的问题。

**要做成还需要什么：**

1. 机器人厂商的 SDK 或上位机协议文档（控制接口、端口、数据格式）
2. BlendShape 排列顺序；若厂商自有标准，还需定出它与通用命名的对应关系
3. 情绪怎么表达：没有面部屏幕的机器人只能靠语音韵律、LED、身体自由度

拿到第 1 条后可以很快补上。表情参数的产生与硬件之间本来就是解耦的，差的只是最后一跳的格式适配。
