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
npm run lint          # 导入完整性 + 样式引用 + 对外请求是否走 netFetch
npm test              # 22 步全套（含 lint 三条 + 最后一次真打包 + 四组牙齿测试）
npm run test:fast     # 同上但跳过打包，省几十秒；别把它变成常态
npm run export:web    # 打个 web 包到 dist/，用来在浏览器里看效果
npm run verify:bundle   # 单独跑打包验证（web + ios，产物不落盘）
npm run verify:lips http://127.0.0.1:8130/   # 浏览器里真的说一句，截图比对口型
```

⚠️ **`npm test` 的第 16 步不是凑数的，它跑的是真正的 Metro 打包。**
为什么必须放在本地套装里，见 6.11 —— 曾经出现过「本地 15 步全绿、推上去 CI 才炸」。

`lint-imports.mjs` 专门防两类**打包不报错 / 或者只有打包才报错**的问题：
从某个模块导入了它根本没导出的名字（真实踩过：从 `components/ui` 导入 `UI`，
但 `UI` 其实住在 `theme.js`，于是 `color: UI.text` 直接抛异常，整个设置页白屏）。

### 6.2 在 Node 里直接跑 `tools/` 下的脚本

`src/` 里的 import 全部**不带扩展名**（`'../theme'`）—— Metro / webpack 会做扩展名推断，
但 **Node 的原生 ESM 不会**，照着源码那样写直接就是：

```
ERR_MODULE_NOT_FOUND: Cannot find module '../src/three/rigDriver'
```

错误信息长得像「文件被删了」，极具误导性。`src/` 里有 110 处这种裸路径，逐个补太蠢，
所以仓库里准备了 loader，**不改源码**就能让 Node 认：

```bash
node --import ./tools/src-resolve.mjs tools/test-rig-semantics.mjs
# 等价简写：
node tools/register-src.mjs tools/test-rig-semantics.mjs
```

> 这是仓库里**唯一**的一份解析钩子。2026-09-25 之前存在两套做同一件事的 loader
> （`ext-resolve-hooks.mjs` 和 `src-resolve-loader.mjs`），各缺一半能力：
> 前者能读裸 JSON import，后者能在 Node 原生解析之后再兜底（不遮蔽包入口和条件导出）。
> 现在合并成 `src-resolve.mjs`(入口) + `src-resolve-hooks.mjs`(实现)，行为取两者**并集**。

自己写这类 loader 有两个坑，而且**都是静默失效、一句错都不报**：

- `--import ./x.mjs` 是把 x 当**入口模块**执行，**不会**自动注册成 hooks 模块。
  必须在 x 里显式 `register(import.meta.url)` 把自己注册进去，
  否则你的 `resolve()` 一次都不会被调用（写完以为没生效但又没报错，就是这个原因）。
- 解析要基于 `context.parentURL`（发起 import 的那个文件），不能用 loader 自己的
  `import.meta.url`；返回值还得是 `file://` URL（`pathToFileURL`），
  否则 Windows 上报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`。

### 6.3 截图探针：别把工具的错算到 App 头上

`tools/cdp-shot.mjs` 用 CDP 驱动 Chrome 截图。这里的 UI 是 React Native Web，
真正可点的 Pressable 在 DOM 上有唯一指纹：

```
tabindex="0"  且  getComputedStyle(el).cursor === 'pointer'
```

**必须按这个筛，绝不能按「包含某段文字 + 面积最小」去挑。** 真实踩过一次，代价很大：
角色卡 footer 的小字 `<div>开始相处</div>` 面积只有 **851**，底部 CTA 是 **16800** ——
按面积最小挑，探针每次都点中 footer，而 footer 的 `onPress` 只 `setPickId()` 不跳转，
画面纹丝不动。当时的结论被写成「**这是 App 的真 bug**」，其实 App 一行代码都没错，
是探针瞎了。所以现在每屏都加了**硬断言**（`inputs > 0`、`☰ 是否存在`、关键词是否出现）。

> **截图本身永远不会告诉你它拍错了地方，只有 DOM 断言会。**
> 下次遇到「自动化点了没反应」，先问「我点的到底是哪个元素」，再去怀疑产品。

本地预览 Pages 产物时，`dist/` 就是站点根，而 index.html 里的引用带 `/aiva-companion/` 前缀：

```bash
node tools/serve-dist.mjs 8130 ./dist /aiva-companion
```

第三个参数负责剥前缀。另外它对**带扩展名却找不到**的路径如实返回 404 而不是回落 index.html ——
否则浏览器会拿到 HTML 当 JS 解析，报一个跟真因毫不相干的 `SyntaxError: Unexpected token '<'`。

### 6.4 同一文件要改多处：一次只能发一个编辑调用

**在一条消息里对同一个文件发多个编辑调用，只有最后一个会留下。**

真实代价：给 18 个角色补 `bgId / idlePose / sample` 三个字段，分 6 批、每批 3 个调用，
结果**每批只有第 3 个活下来** —— 18 处改动落地了 6 处，而每一次调用都回报
「修改成功」。肉眼完全看不出来，是靠 `tools/check-persona-coverage.mjs` 数出来的。

原因很直白：同一批里的调用各自拿着**同一份旧内容**去算新内容，
后写的覆盖先写的，前面的改动直接蒸发。

规避办法（任选其一）：

- **串行**：一个文件一次只发一个编辑调用，改完再发下一个。
- **写脚本**：一次性改动超过 3 处时，写成 `.mjs` 用 Node 跑（改完记得自己核验一遍）。

> 顺带一条同类教训：核对脚本自己也会撒谎。第一版用 `split(/\n  {\n/)` 去切
> `PERSONAS` 数组，角色之间的注释块把块和 id 错位了，一半角色被报成「没配字段」，
> 而实际上配了。**验证工具写完，先拿它去验一个你已知的结论。**

### 6.5 截图只证明"它拍到了什么"，不证明"它该拍什么"

`tools/shot.mjs` 的截图发生在 `--click` **之前**，所以"点了卡片之后长什么样"
它根本拍不到 —— 我拿它连拍三张，张张都是点击前那一屏，却差点据此去改代码。
另外 `--click "文字"` 是按 `innerText` 找元素的，**首屏之外的元素点不到**
（`林间游侠` 在 y≈2200，滚都没滚到），而且它匹配到的最小元素未必是那个 Pressable。

现在判断"页面到底成没成"的顺序是：

1. **先断言，后看图**。`PROBE` 环境变量注入一段表达式，直接问 DOM：
   预览头里写的是谁、默认舞台叫什么、待机姿势叫什么。断言绿了再谈视觉。
2. **要拍"操作后"的画面，就别用 `--click`**。用 CDP 直连，在 `Runtime.evaluate`
   里 `click()` → `await` 等状态更新 → `Page.captureScreenshot`，顺序才和用户一致。
   （这一轮临时写过 `tools/_shot-after-click.mjs`，用完即删。）
3. **截图之间会比大小**。同一屏两次截图字节数完全一致（181011 == 181011），
   就说明画面没变 —— 比肉眼快，也比肉眼准。

> 同一条教训在别处已经栽过三次：「探针/工具的错 ≠ App 的 bug」。
> 查线上文件、找测试脚本、用截图下结论，三次都是工具的错被当成了代码的错。

### 6.6 在 RN 里用 View 拼圆形：别拿矩形凑

`src/components/AvatarPreview.js` 的立绘是一堆 `View` 拼的，脸部连着错了四版：

| 版本 | 写法 | 结果 |
| --- | --- | --- |
| ① | 前发 `50×34`，`radius: 24` | RN 把半径夹到 17，**不是半圆是圆角方块** → 一张"粉色方脸" |
| ② | 去掉刘海、高度改 39 | 还是矩形，问题照旧 |
| ③ | 前发与头同尺寸 `50×50/radius 25`，脸挖成 `48×48` | 开窗只比头小 2px，**整颗头刷成肤色**，粉发和双马尾全没了 |
| ④ | 前发 `50×30`（圆角 22），脸由头自己充当 | 正确 |

结论：**宽高不等时，`borderRadius` 超过较短边的一半会被夹住**，
想要半圆就得让两边相等；想让 A 完全盖住 B，A 的尺寸和圆角必须和 B 一致。
另外 `Part` 内部只给 `position: 'absolute'` 而不给 `absoluteFillObject` ——
后者会连 right/bottom 一起设成 0，再传 width/height 就是三者打架。

---

### 6.7 给 promise 加超时：三行代码能把整个 App 打成错误页

起因很普通：线上冷启动要在标题页干等 11 秒（App 本身 0.6 秒就起来了），
根因是 `App.js` 里 `await loadSettings()` 没有上限，而线上访问云服务被 CORS 拦掉、
SDK 内部重试把整次调用拖到约 8 秒。于是给 `loadSettings` 加了 2 秒上限。

第一版写完直接把**整页**打成了「⚠️ 应用出错了」，两个成因都不在改动处报错：

1. `cloud.database.from(...).select(...)` 返回的不是真 Promise，是 `PostgrestBuilder`
   —— 它**只实现了 `then`，没有 `catch` / `finally`**
   （见 `node_modules/@tencent-ai/workbuddy-cloud-sdk/lib/index.js:1375`）。
   对它调 `promise.catch(() => {})` 是**同步**抛 TypeError。
2. 而 `Promise.race` 写在 `.catch` 之后 —— 异常发生在建立 race **之前**，
   于是 `setTimeout` 已经排上、却没人 race 那个 guard。2 秒后 guard 变成
   unhandled rejection；`src/ErrorBoundary.js:31` 恰好监听了 `unhandledrejection`，
   于是整页被错误页接管。

现在的做法抽成了 `src/lib/withTimeout.js`，三条约束写死在文件头：

- **guard 自己先挂一个空 handler**（`guard.catch(() => {})`）——
  无论后面任何一步同步抛错，它都不会无人接；
- **`Promise.resolve(source)` 包一层再 race**，拿到标准接口，thenable 也能用；
- **原调用迟到的失败也要吞掉**，否则又是一个 unhandled rejection。

`tools/test-with-timeout.mjs` 把这两条钉住了，并带一节**自检**：
把当初那个错误写法原样跑一遍，确认它确实会被测试抓出来 ——
一条永远绿的测试等于没有测试。

顺着同一条线又修了两处（都是量出来才发现的）：

- **关掉 SDK 自带的重试。** 它默认 `retryEnabled = true`，网络/CORS 失败会退避
  重试 3~4 次 —— 实测**单次失败 0.3 秒就返回，整次调用却被拖到约 8 秒**。
  启动路径上的只读调用拿不到就用 DEFAULTS，重试既救不回结果又让用户白等，
  所以这里 `.retry(false)`，并在超时时 `abort()` 掉没人等的请求。
- **SDK 默认（非 `throwOnError`）下网络失败是 resolve 成 `{ data: null, error }`，
  不是 reject。** 所以「拿到 error」也必须记进 `degraded`，只在 `catch` 里置位是漏的。

> 顺带提醒：`ErrorBoundary` 会把**任何**未处理的 promise 拒绝放大成整页错误。
> 这是有意为之（宁可暴露也别静默），但意味着第三方异步噪音足以让 App 全页不可用。
> 改异步代码时，`unhandledrejection` 不再是"控制台里的一条红字"，而是**白屏**。

### 6.8 同一个坑的另一半：SDK 的云端请求**都没有**超时

查「云端不可用时账号页会怎样」时量出来的，和 6.7 是同一类问题但更隐蔽 ——
后果取决于网络是「快速失败」还是「挂起」（**这两个必须分开看，结论完全不同**）：

- **快速失败（线上现在的 CORS 情况）**：fetch 立刻 reject，被归一成
  `{ kind: 'network' }` 并 **resolve 成 `{ data: null, error }`**（不是 reject），
  UI 出「连不上服务器，检查一下网络」，`finally` 复位 busy。表现可接受，**不用改**。
- **挂起**（电梯里、欠费 4G、DNS 黑洞 —— 连不上但也没被拒）：`await` **永不落定**。
  而 UI 的出口全都写在 `finally` 里 —— `finally` 要靠 await 落定才会执行，于是：
  - `useAccount` 的 `loading: true` 要等到返回值才置 false
    → 账号页永远停在「正在读取账号…」；
  - `AccountView` 每个操作 `setBusy(true)` 之后 await
    → 按钮被 `ActivityIndicator` **永久替换**，而且用户**没有任何取消入口**。

改法：`src/lib/cloudClient.js` 里两层包装，内部都复用 6.7 那个 `withTimeout`。
超时归一成 `{ error: { kind: 'timeout' } }` —— 这样调用处原有的
`if (error) throw error` / `if (r.error) return fail(r.error)` 一行都不用改，
超时会自然落进「服务器没响应，等一会儿再试」那句人话里
（**别复用「检查一下网络」**：挂起不是用户网络设置的锅，别误导他去改设置）。

| 层 | 入口 | 覆盖 |
|---|---|---|
| auth | `authCall()` | `cloud.auth.*`（登录、注册、登出、改密码） |
| database | `dbCall()` | `cloud.database.*`（ensureProfile / pullState / pushState） |
| 对外的 API | `netFetch()` | STT / TTS 的所有网络请求（详见 6.9） |

`dbCall` 会把一个 `AbortSignal` 交给调用方，超时那一刻顺手把请求掐掉 ——
我们已经不等了，就别让它在后台继续占着连接（弱网正是要防的场景）。
`PostgrestBuilder.abortSignal()` 返回 `this`，可以直接挂在链式末尾。

`tools/test-auth-timeout.mjs` 锁住这两层的契约（含自检：不套兜底的挂起
promise 200ms 后仍未落定），并把 `db-timeout` 加进了 `verify-live.mjs` 的验收标记。

> ⚠️ **这里踩过一个「看着像证据」的坑**：当初数 SDK 源码，看见
> `lib/index.js` 里的 `timeout` / `AbortSignal` 都出现在 **database 和 storage 模块**（auth 一份都没有），
> 就顺手写下「database 有兜底，auth 没有」的结论，还据此把 database 调用留在裸奔状态。
> **这是错的。** 那些 `timeout` 是 supabase 留的**可选能力**，不是默认行为：
> ```js
> // lib/index.js:5038 —— SDK 建客户端时只传了 fetch，没传 timeout
> this.client = new PostgrestClient(url, { fetch: fetch2 });
> // lib/index.js:4756 —— 而构造函数里，不传就走 else 分支：裸 fetch
> if (timeout !== void 0 && timeout > 0) { ...用 AbortController 包一层 fetch... }
> else { this.fetch = originalFetch }          // ← 一点超时都没有
> ```
> **auth 和 database 两边都没有超时。** 判据是「不传 timeout 会走哪条分支」，
> 不是「文件里有没有 timeout 这个词」。

> 顺带：为了让这些模块能在 node 里被单测，`tools/src-resolve-hooks.mjs` 里有一个
> `load` 钩子，把裸 `import cfg from './xxx.json'` 当成 `export default {...}` 喂回去
> （配套的 resolve 故意不把 .json 当候选，否则 `./foo` 会被误解析成 `./foo.json`）。
> 有它之后，凡是间接 import 了 `cloudConfig.json` 的模块才第一次能进测试。
> 这条能力很容易在重构 loader 时漏掉：`cloudClient.js` 第 11 行就是裸 JSON import，
> 摘掉 load 钩子只有 `test-auth-timeout` 一条会红，其它测试全绿。

### 6.9 第三次遇到同一个坑：语音链路（这次在核心交互上）

修完 auth / database 之后没有停手，用一个统一判据把全项目扫了一遍：
**每个 UI 等待态的出口，是不是写在 `await` 之后或 `finally` 里**。
凡是这种写法，只要 await 永不落定，出口就永不执行 —— UI 永久卡住且没有取消入口。
结果在语音链路又抓到一批，而且比前两次严重：它卡的是麦克风本身。

```
webSession.js:346   setState('thinking')
        ↓
        await transcribe()          ← STT 里 8 个对外请求，一个超时都没有
        ↓ 第 355 / 359 行           onState({ state: 'idle' })  ← 出口在这之后
useVoice.js:244     isBusy = state === 'thinking' || state === 'speaking'
        ↓ 上面那步不返回
        永久 true → 麦克风按不动，也插不了话
```

统一走 `src/lib/netFetch.js`（30 秒上限）。这里有个**两层**的结构，少一层就等于没修：

1. `AbortController` —— 到点把没人等的请求掐掉，别让它在后台继续占着连接；
2. `withTimeout` 的 `Promise.race` —— **真正保证「一定会有个结果」**。

反直觉的地方在第 2 层：signal 只是"通知对方取消"，要对方的 fetch 实现真的搭理它才
会 reject。`src/lib/region.js` 里那句「RN 的 fetch 不认 AbortSignal 时也能靠
Promise.race 兜住」说的就是这件事 —— 只发 signal 的话，在某个装聋的平台上
await 照样永不落定。而**本地恰恰测不出这个差别**（node 和浏览器的 fetch 都认 signal），
所以专门补了一条 stub「完全不理 signal」的用例盯着它。

- `src/voice/stt.js` —— **8 处**对外请求（Whisper / Azure / SiliconFlow / ElevenLabs / Gemini 两处 / 模型列表两处）
- `src/voice/tts.js` —— **4 处**合成请求（OpenAI / Azure 及其降级重试 / ElevenLabs）

两个刻意保留的例外，改的时候别顺手把它们也套上：

1. **读本地录音的 `fetch(uri).blob()` 保持裸奔** —— STT 里 14 个 fetch 只有 8 个是网络请求，
   另外 6 个读的是本机文件。移动端读文件本来就可能慢，给它加上限只会把正常流程掐断。
2. **调用方自己带了 signal 时不覆盖** —— 一次性下载要更长的等待，别替它做主。

超时带 `code = 'net-timeout'`，不混进文案；`verify-live.mjs` 靠这个串在线上产物里验一次。
`tools/test-net-timeout.mjs` 锁住契约，三条自检是刻意留的：

- 「套装聋平台的请求会落定」和「**完全不理 signal** 的裸 fetch 永远不落定」——
  后一条负责证明前一条有区分力；
- 兜底要是被改回单层的（只发 signal、不再 race），「平台不理睬 AbortSignal」那组会立刻红。
  这条我是真试过的：临时把实现退化回单层再跑一遍，那组整组红 —— 没验证过的测试不算数。

另外测试里每个「可能永不返回」的调用都套了一层硬上限（`callCapped`）：
直接 `await` 一个永不 settle 的 promise 只会让进程挂住，CI 上要等 job 超时才知道失败了，
还可能看不出挂在哪一步。加个盖子，把「挂住」变成一条几秒内必然打出来的失败断言。

运行时提示：`netFetch` 间接 import 了 `./withTimeout`（bundler 风格的无扩展名写法），
所以这条测试要挂着解析器钩子跑：`node --import ./tools/src-resolve.mjs tools/test-net-timeout.mjs`。
（顺带纠正一个想当然：别因为它只 import 了带扩展名的 `netFetch.js` 就以为用不到钩子 ——
那条链路上还有无扩展名的 `./withTimeout`。不挂钩子跑出来是 ERR_MODULE_NOT_FOUND，实测。）

> **又一次证明了同一件事**：这个 bug 不会自己暴露。三次都是「代码看着没问题、样例跑得通」，
> 只在「连不上但也没被拒」这一种网络形态下发作。所以别靠读代码确认它有/没有超时，
> 去找**不传 timeout 时走哪条分支**，或者干脆写一条会挂起的测试。

### 6.10 又扫一遍：同一个形态的第 4、5、6 处，以及为什么不再靠「下次记得」

给 netFetch 补完 race 那层之后有个直接推论：**凡是「自己 new AbortController」的地方，
可能都犯了同一个错**。而上一轮扫描时，下面三处是被我**凭印象**划成「有保护」的 ——
读代码之前它们账面余额是 45 秒、20 秒、2.4 秒，全是假的：

| 位置 | 账面 | 实际 | 挂住时的后果 |
|---|---|---|---|
| `src/llm.js` | 45 秒 | 只发 signal，没有 race | 聊天请求悬着，转圈 / 打字机一直空转 |
| `src/services/web.js` | 20 秒 | 同上 | 搜索、天气悬着 |
| `src/lib/region.js` | 2.4 秒 | 同上，**而且注释谎称有 race** | 见下 |

三处统一改走 `netFetch`，超时上限各自的语义保留（LLM 45 秒、搜索 20 秒、
地区探测按源分别给）。

`region.js` 这处值得单说，它有两层误导：

1. 注释写着「RN 的 fetch 不认 AbortSignal 时也能靠 Promise.race 兜住」，
   可整个文件里**一个 race 都没有** —— 它自己的 `withTimeout(ms)` 只返回 `{signal, done}`。
   （讽刺的是我上一轮正好引用了这句注释，作为「不能只信 signal」的证据。）
2. `probe()` 的 `maxMs` 预算**没有强制执行**，它只在源之间做判断；单个源挂住就永远出不来。
   后果是 `pending` 再也不清空 —— **之后每一次 `detectCountry()` 都拿回同一个永不返回的 promise**。

**结构防线**：同一个 bug 换了六个地方出现，`tools/lint-net-calls.mjs` 从此禁止
src 下出现未包装的 `fetch(`（白名单只有三处本地读取：`netFetch.js` 本身、
`stt.js` 的 6 处读录音、`assetBytes.js` 的 1 处读包内资源），并且把白名单里的
**数量钉死** —— 多一处就红。它挂在 `npm run lint` 和 CI 上。
这条 lint 的牙齿是验过的：临时塞一个裸 fetch 进去、以及在 stt.js 加到第 7 处，
两次都如期变红。

### 6.11 本地 15 步全绿，CI 却炸了：测试全绿 ≠ 能打包

6.10 那一轮收尾时，本地 15 步全 PASS，提交推上去，**CI #25 build 失败**，
失败点落在「导出 Web 静态包」。元凶只有一行：

```js
// src/llm.js —— llm.js 在 src/ 根，netFetch.js 在 src/lib/
import { netFetch, NET_TIMEOUT_CODE } from './netFetch';   // ✗
import { netFetch, NET_TIMEOUT_CODE } from './lib/netFetch'; // ✓
```

Meta 报得很清楚（这也是后来写静态检查时参照的候选项清单）：

```
Error: Unable to resolve module ./netFetch from .../src/llm.js:
None of these files exist:
  * src\netFetch(.web.ts|.ts|.web.tsx|.tsx|.web.mjs|.mjs|.web.js|.js|.web.jsx|.jsx|.web.json|.json|.web.cjs|.cjs|...)
  * src\netFetch
```

**为什么本地一条都没挡住** —— 漏洞是三层叠加：

1. `node --check` **只解析语法，不解析 import 路径**。它不知道 `'./netFetch'` 指向什么。
2. `lint-imports` 当时的 `resolveImport()` 一旦解析不出目标就 `continue` 跳过，
   等于**把「路径不存在」当成「不关我的事」**。
3. 本地套装里**根本没有打包这一步**。15 步覆盖的是逻辑测试 + lint，
   没有一步真的把 Metro 跑起来 —— 于是本地绿的定义里，"能打包"从来不在其中。

三层分别补上：

| 补的东西 | 挡哪一层的漏洞 | 验证方式 |
|---|---|---|
| `lint-imports` 新增第 C 项：相对 import/require **必须在磁盘上落地**（含平台变体 `.web.js`、资源扩展名、目录 index），挂了还会提示「也许你找的是 ./lib/netFetch.js」 | 2 | 退化实验：改回 `'./netFetch'`，如期报错并给出正确路径 |
| 把根进入口 `index.js` / `App.js` 纳入扫描（walk 原本只从 `src/` 出发，入口这两层是盲区） | 2 | 退化实验：把 `App.js` 的 `'./src/theme'` 改成 `'./theme'`，如期变红 |
| `tools/verify-bundle.mjs` + `runtests.mjs` 的第 16 步 | 3 | 退化实验：错误路径下本地 Metro **852ms 就失败**（热缓存 6 秒通过） |

⚠️ 第 16 步的存在本身就是这节的结论：**别相信一套不含构建步骤的本地验证。**
测试全绿只说明被测的东西没问题，说明不了没被测的东西。附成本高（几十秒），
所以用 `--fast` 可跳过，但它是默认开的。

另外记一笔同类错误的 mental 归类：6.9 / 6.10 是「同一个逻辑 bug 换个地方再犯」，
6.11 是「同一处踩了之后，**修的是实例而不是导致它逃过检查的那道缺口**」。
后者的判据是：修完之后问一句 —— **下一次同样的事是怎么被挡住的？**
答不上来（或者只能答「下次我会注意」）就还没修完。

> 为什么这三处**没有**配运行时单测：保护逻辑本身住在 netFetch 里（那 18 条断言、
> 含「装聋平台」那条都盯着它），而 lint 保证这三处确实走了 netFetch。
> 分工明确 —— 一个测「机制对不对」，一个测「有没有接上」。

### 6.12 只验 web 的盲区：原生端从来没被打包过

6.11 的结论是「本地套装要包含构建」，但那个"构建"当时只有 web —— 因为 CI 的
build job 只做 `expo export --platform web`。**于是"原生端能不能打包"从来没有被
任何一步验证过**（哪怕那是这个 App 真正要装的形态）。

补上之后的第一条实测数据说明了这不是洁癖：

| 平台 | 模块数 | 说明 |
|---|---|---|
| web | 546 | 走 react-native-web |
| iOS | 830 | 走真 react-native |

**相差的 284 个模块，全是"只有打原生才会经过"的代码。**

牙齿测试也做得干净：把 `Avatar3D.native.js` 临时移走 ——

```
v [web] 546 modules（3304ms）        ← 只看 web 的话，一切正常
✗ [ios] 打包失败（1613ms）
    Unable to resolve module ../components/Avatar3D from ... src\screens\Home.js
```

即：**缺了原生实现时，web 打包照样全绿**。所以第 16 步现在是 `verify-bundle.mjs`
打 web + ios 两个平台，并同样挂在 CI 的 test job 上
（ios 代表原生这一族：Metro 里 android 与 ios 共用 `.native.js` 解析链，
单独再跑一个 android 只多 20 秒却几乎没有新增覆盖）。

⚠️ 顺着这条再往前一步的话：**"打包过了"仍然只保证模块能解析，不保证运行时行为。**
真机上的 GL 初始化、iOS 出声这类问题，这一步挡不住 —— 它们要的是另一套验证。

### 6.13 「能打包」不等于「能跑起来」

6.12 留下了一条边界：`verify-bundle.mjs` 只保证模块能解析。白屏、boot 时抛异常、
ErrorBoundary 把上千行的错吞成一句提示 —— 这些 Metro 打包全都发现不了。
所以补了第 17 步 `smoke-runtime.mjs`：把打包产物在一个 headless Chrome 里
**真的 boot 一遍**，断言五条全部可数的值（不靠截图）：

| 断言 | 怎么数 |
|---|---|
| React 挂载 | `#root` 的子节点数 > 0（0 = 白屏） |
| 无未捕获异常 | `Runtime.exceptionThrown` 的条数 |
| 无 console error | `Runtime.consoleAPICalled(type=error)` 的条数 |
| 能走到 Home | 走完「标题页 → 角色卡 → 底部 CTA」后 `__aivaDebug` 是否出现 |
| 模型挂上 | `hasRig()` 为真（轮询最多 25 秒，等 GLB 解析完再判） |

⚠️ **为什么要连 console 一起听** —— 牙齿测试里最能说明问题的一条：
在 `index.html` 里塞一句 `throw new Error(...)`，结果是

```
root 子节点数：1        ← 挂载正常
进入 Home：是          ← 主界面也进得去
未捕获异常：1          ← 只有这一条拦得住
```

**只看「能不能走到 Home」会放行这条。** 页面看起来完全没事，恰恰是这个检查存在的理由。
另一条牙齿测试（抽掉主 bundle）则证明确实区分得出白屏：`root 子节点数：0`。

#### 第五条「模型挂上」是怎么来的

顺着老规矩再问一层：`__aivaDebug` 挂上来只说明 `Avatar3D.web` **组件挂载了**，
说明不了 GLB 加载成功。于是做了个实验：**把产物里 29 个 `.glb` 全部改名藏起来**再跑一遍。

| | `.glb` 都在 | `.glb` 全部藏起 |
|---|---|---|
| root 子节点数 | 1 ✅ | 1 ✅ |
| 未捕获异常 | 0 ✅ | 0 ✅ |
| console error | 0 ✅ | **0 ✅** |
| 进入 Home | 是 ✅ | 是 ✅ |
| partCount / hasRig | 53 / true | **0 / false** |

**四条断言一条都没拦住。** 关键是 console error 也是 0 —— 网络 404 不走
`Runtime.consoleAPICalled`，只走 `Network.loadingFailed`，光听 console 听不见。
也就是说「资产整个没进产物」这类事故会一路绿着发布出去。

补上第五条之后，同一场景变成 `FAIL — 模型挂上 没过`。
⚠️ 它必须**轮询等**（最多 25 秒）而不是读一次就判：几 MB 的 GLB 在软渲染下
解析要时间，读早了拿到 0 就是个会随机变红的闸门 —— 那比没有更糟。
只认 `hasRig`、不认 `partCount`：部件数随版本变（现在 53），
拿它当闸门迟早误报；`partCount` 只打出来当旁证。

这个实验**已经常驻成第 20 步** `tools/test-smoke-runtime-teeth.mjs`（CI 的
`test` job 里也有一行同名步骤）。理由和第 19 步一样：断言被放宽时，
「所有测试照旧全绿」是最容易出现的假象 —— 写在注释里的「改完记得重跑牙齿测试」
不会主动提醒任何人。它只做**一次**破坏场景（约 25 秒，要等轮询耗尽），
对照组由第 17 步自己充当，不重复烧时间。

#### 顺带修掉一个「打印在骗人」的坑

原来那行读的是 `globalThis.__aivaDebug?.partCount` 而**没调用函数** ——
`partCount` 是个函数，`returnByValue` 把函数序列化成 `{}`，日志里就显示
`模型部件数 partCount={}`，看着像「模型没挂上」。真被它骗过一次：
对着 CI 日志怀疑 ubuntu runner 上 GLB 没加载，白查了两轮。
**诊断数字要是假的，比没有更费事** —— 现在改成在页面里先调用再返回。

#### 边界（已实测更新）

早先这里写着「只在本地跑、CI 上没加」，后来**实测推翻了**：ubuntu runner 自带
Chrome（`/usr/bin/google-chrome` → Google Chrome 153.0.8010.52），swiftshader
软渲染也能跑。但不确定能不能稳定跑的检查别直接放上去挡发布（SKILL 第 49 条），
所以先开了个 `continue-on-error` 的观察位（`smoke-probe` job），连绿三轮
（#33/#34/#35，`partCount 53 / hasRig true` 与本地一致）确认不飘之后，
才并进 `test` job。收进去之后它也才被 `lint-ci-refs` 的 A/B/C 三项覆盖 ——
在那之前本地清单和 CI 清单其实一直没对上（本地 19 步、CI 18 步）。
它证明「boot 成功、能进主界面、模型在」，证明不了交互全对
（那是 `cdp-*` 那批专项探针的事）。

### 6.14 第四层：本地全绿 ≠ CI 绿（CI #29，本地 17 步全 PASS 却红了）

前三轮补的都是「代码缺什么」，这一层不一样 —— 缺的是**验收本身的配置**没人对账。

合并两套 loader 删掉 `tools/ext-resolve.mjs` 之后：本地 17 步全 PASS、
`build` / `deploy` 也绿，**只有 `test` job 红**。原因在三行：

```yaml
# .github/workflows/deploy-pages.yml（当时忘了改）
run "auth-timeout" node --import ./tools/ext-resolve.mjs tools/test-auth-timeout.mjs
run "net-timeout"   node --import ./tools/ext-resolve.mjs tools/test-net-timeout.mjs
run "rig-semantics" node --import ./tools/ext-resolve.mjs tools/test-rig-semantics.mjs
```

**为什么当时一次都没被发现**，是两个缺口叠在一起：

| 缺口 | 说明 |
|---|---|
| grep 默认**跳过隐藏目录** | 「扫全仓库引用」从来没扫到过 `.github/`，而且**不报任何错** —— 少扫了一整类最关键的文件，看起来和扫干净了没区别 |
| **本地跑的和 CI 跑的是两份互不相干的清单** | 本地的是 `tools/runtests.mjs` 里的数组，CI 的是 workflow 里的一串 `run`，此前没有任何一步在对照它们 |

**补的检查**：`tools/lint-ci-refs.mjs`（`runtests` 第 18 步 + CI test job + `npm run lint`），
它显式打开 `.github/workflows/`（不依赖任何全局搜索的默认行为），做三件事：

- **A** workflow 里引用的每个仓库文件必须在磁盘上存在（还会顺手提示可疑的替代文件名）
- **B** CI 跑的每一步，本地套装里也必须有（反向允许：`smoke-runtime` 那种依赖本机的步骤只列出来）
- **C** 同名步骤的**命令行还要逐个 token 一致** —— C 是后来补的，理由在下面

**后来又补上的 C**：按那条老规矩 —— 每补完一道防线，就把「下一次同样的错会被什么挡住」
这句判据**对着新防线本身再问一遍** —— 问出来的是：A 和 B **都只比对名字，不比对命令**。
而 CI #29 的本质恰恰是**命令漂移**
—— 缺文件只是表象。逃过去的场景很容易造：把 CI 那行改成裸的
`node tools/test-auth-timeout.mjs`（漏掉 loader），文件名存在（A 过）、步骤名也在（B 过），
可 CI 会红。所以 C 把两边的命令行抽出来逐 token 比，多了谁、少了谁都报错并同时打印两边。
本地独有的 token 要逐个写进白名单并**写明理由**（目前只有 `--keep`：
第 16 步要把产物留给第 17 步烟雾测试，CI 上没有第 17 步）。

**牙齿测试**（6 个场景全部合预期）：

| 场景 | 期望 | 结果 |
|---|---|---|
| 基线：真实配置当然要过（里面已含「本地多带 `--keep`」这种合法差异） | exit=0 | ✅ |
| A 引用改成不存在的 `tools/check-persona-coverageX.mjs` | exit=1 | ✅ 报「引用了不存在的文件」 |
| B 步骤名改成 `auth-timeout-x` | exit=1 | ✅ 报「步骤在本地套装里没有 —— 本地绿 ≠ CI 绿」 |
| C1 ★ CI 漏掉 loader：`--import ./tools/src-resolve.mjs` 没了 | exit=1 | ✅ 报「两边命令不一致」并同时打印两边 |
| C2 CI 比本地多一个参数（`--strict`） | exit=1 | ✅ 同上 |
| C3 本地比 CI 多一个白名单外的参数（`--verbose`） | exit=1 | ✅ 同上 |

> 牙齿测试这次换了个做法：**不再改动真实文件**。上一轮出过 `git rm` 把整个 `tools/`
> 抹掉的事故，所以这次是把 `.github/` 和 `tools/runtests.mjs` 复制进沙盒目录、改动只落在副本上。
> 沙盒还得做「最小」：这个检查实际只 Read 两类文件（yml 和 runtests），
> 被引用的其它文件它只做 `existsSync`，所以放零字节占位文件就够 ——
> 整目录复制会连 `tools/` 下那两个 7.3MB 的 `.tmp html` 一起拷七遍，慢到被超时掐断。
> 收工时再核一次真实文件哈希，确认一个字节都没被碰过。
>
> 这一整套后来提质成了常驻的第 19 步 `tools/test-lint-ci-refs-teeth.mjs`
> （同样挂进 CI 的 test job 和 `npm run lint`）—— 理由和第 18 步是同一个：
> 「改完记得重跑牙齿测试」这句话写在注释里，**它不会提醒任何人**，
> 所以让它变成自动跑的一步：哪天有人为了消误报放宽了第 18 步的正则，这里立刻红。

> 这一步又一次印证了第 6.11 起那条规矩：**防线只有跑在 CI 上才算数**，
> 而且「本地绿」的定义里必须包含「CI 那份清单和我这份是同一份」——
> 不只是步骤名同一份，**命令行也得是同一条**。

### 6.15 扫描式检查的静默假绿：「扫到什么就对什么」

上面那几步盯的是**闸门本身有没有牙齿**，这一节盯的是另一类更安静的失效：
**收集环节坏掉时，检查会一声不吭地报通过**。

`lint-net-calls` / `lint-styles` / `lint-imports` / `check-persona-coverage`
都是「扫到什么就对什么」—— `bad` 计数为 0 就打印通过。于是：

| 收集环节坏在哪 | 旧行为（实测） |
| --- | --- |
| 扫不到任何文件 | `✅ 样式引用检查通过（扫描 0 个文件）` / `[lint-imports] PASS — 扫描 0 个文件，问题 0 处`，**退出 0** |
| 角色 id 多了个新前缀（如 `zz-foo`） | `合计 18 个角色，有缺口的 0 个`，**退出 0** —— 而这个角色从头到尾没被核对过 |

第二行是更值得记住的：**数字一点没变，因为漏掉的方式是"整条漏"**。
只加「扫到 0 个要报错」挡不住它。所以 `check-persona-coverage` 补的是
**交叉核对**：`PERSONAS` 块里出现的每个 `id` 都必须被那条正则收到，
没收到的直接报错（沙盒实测：复制 `realistic-noa` 改成 `zz-demo`，
旧版退出 0、新版退出 1）。

另外同一轮还修掉一处「打印了但没拦住」：脚本末尾那句自检
「✗ 脚本有问题，别信上面的结果」以前只是 `console.log`，退出码照旧是 0 ——
现在它失败会让这一步真的变红。

**补的检查**：`tools/test-lint-zero-scan-teeth.mjs`（`runtests` 第 22 步 +
CI test job 同名一步）。它要求：空目录上三条文件扫描类检查必须红、
沙盒里塞正则收不到的角色必须红、`PERSONAS` 块定位不到必须红，
同时**正常仓库必须还是绿的**（免得闸门写得过严）。

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
- `bgId`：她的**默认舞台**（`src/backgrounds.js` 里的 id）。只在用户还没自己挑过舞台
  （`bgId === 'auto'`）时，点确认选人时才会带上 —— 主动选过的舞台优先级更高。
- `idlePose`：**签名待机姿势**（`src/anim/idlePoses.js` 里的 id，必须是 `tag: 'idle'` 的）。
  她一出场先摆这个，之后在轮换里按 18% 的概率回到它。
- `sample`：示例对白数组，显示在选角页预览里。

另外**三处**必须同时补，缺一处这个角色就会"半残"，而且不报错：

| 位置 | 缺了会怎样 |
|---|---|
| `src/theme.js` 的 `SPEECH` | 音色掉到 `girlfriend`（软甜少女音），男角色也会用女声 |
| `src/llm.js` 的 `SCRIPTS` | 离线台词掉到 `SCRIPTS.girlfriend`，**男角色说出可爱女友的台词** |
| 上面三个字段 | 选角页预览缺项，`idlePose` 没有的话她就没有签名动作 |

改完跑一遍核对脚本，它会把这五项逐一列出来：

```bash
node tools/check-persona-coverage.mjs
```

已挂进 `npm test` 的第一步，`18 个角色全绿 + 自检通过` 才算过。

新增发型 `style` 时，还要去 `src/components/AvatarPreview.js` 补一档轮廓，
否则会掉到短发默认形状上，看着像"新角色和别人撞发型了"。
那个文件的头部坐标很脆（`50×30` 的前发 + 头本身当脸），改动前先读文件里的注释。

### 发版之后：确认线上真的是新的

`git push` 成功 ≠ 线上已经更新，中间还隔着 Actions、Pages 构建和 CDN 缓存：

```bash
node tools/verify-live.mjs
```

它抓首页 → 取 `<script src>` → 在 bundle 正文里找一串标记串，全命中才退出 0。

网址可以用 `--url` 指定，不给就用脚本里写死的那个默认值；每次运行都会先把
「核查的是 <网址>」打出来，不用去读代码才知道它查了哪里。

> ⚠️ **CI 里必须传 `page_url`，别让它吃默认值**：仓库一改名，baseUrl 会跟着变、
> `page_url` 也会变，**只有写死的那个不会变** —— 于是这一步会一直去查旧站点，
> 而且查得通，是静默的假绿。现在它和线上冒烟那步用**同一个来源**；
> 传进来的网址和默认值不一致时脚本会自己警告一句。

> ⚠️ 还有半个洞是后来补的：这道闸叫「新包是否真的上线」，可它原来的输入只有
> 「网址 + 一串**固定**标记串」—— 而那些串（`默认舞台`、`settings-timeout`……）
> **旧包里也全有**。所以它对任何含这些串的包都给同一个结论：CDN 还在发三个提交
> 之前的包，它照样打印「全部命中 ✓」。
> 现在 CI 里会额外传 `--expect-bundle <这一版主 bundle 的名字>`（Expo 给主 bundle
> 起的名字带**内容哈希**，内容一变哈希就变），拿线上抓到的那个文件名去对：
> 名字不一样就是还没刷到新包，上面的重试循环才有意义。
> 手工跑不传也行 —— 但那时它只能验「线上有这些字符串」，验不了「线上是这一版」。

**发布后的这一步已经在 CI 里自动跑了**，不用你手动执行（也不用为了跑验收一直开着电脑）：
`deploy-pages.yml` 现在是三个 job ——

| job | 干什么 | 失败后果 |
|---|---|---|
| `test` | 与 build **并行**跑全套测试（22 步） | **不挡发布**，只把这个 job 标红 |
| `build` | 打包，并把这一版主 bundle 的名字（内容哈希）作为 job 输出交给 deploy | 不发布 |
| `deploy` | ① 发布后跑 `verify-live.mjs`（最多重试 12 次 × 45 秒）② 线上冒烟：`smoke-runtime.mjs --url <网址>` 真 boot 一遍 | ① 报「线上可能还是旧包」，要人工看一眼 ② 网址起不来 → 整个 job 标红 |

光靠 `verify-live.mjs` 只回答了「新包有没有上线」，**没回答「网址真的开得起来吗」**
—— 三条检查是三层：`verify-bundle`（能打包）→ `smoke-runtime`（能跑起来）→
**线上冒烟**（线上能跑起来）。最后一层只有真开一遍浏览器才知道：baseUrl 的仓库名
子路径、资源路径、Pages 给的 MIME 类型（`.glb` 尤其）。它挂在「核查线上产物」**之后**，
因为那一步已经把 CDN 传播延迟消化掉了。想手工跑一次（比如怀疑线上坏了）：

```bash
node tools/smoke-runtime.mjs . --url https://monmonmars.github.io/aiva-companion/
```

> ⚠️ 这条验的是**已经部署上去的那份**，不是你本地刚改的代码。本地改动没推、
> 没部署完之前，它绿了**不代表你的改动没问题** —— 别拿它当本地改动的验收。

> ⚠️ **测试为什么不当闸门？** 试过放在 build 里当闸门，结果直接把发布冻住了：
> CI 上 `npm test` 有一步挂，但本机 11 步全过、干净 checkout 副本里也全过，
> 而**当时没拿到日志**，看不出到底是哪一步 —— 这条后来实测推翻了：整包日志
> `GET /actions/runs/{id}/logs` 用本机令牌就能下载，不需要 admin；
> `GET /actions/runs/{id}/jobs` 还能只列每个 step 的结论，连日志都不用下。
> 在查清之前让它挡发布 = 站点停止更新，这个代价比「少一道闸」大得多。
>
> 现在的做法是**逐步跑 + 写进 Job Summary**：哪一步挂了、它的输出末 40 行，
> 直接显示在 run 页面上，不用翻日志。查清之后再决定要不要收紧成闸门。

发布后那道闸之所以要重试，是因为部署完立刻抓**拿到的常常还是旧 bundle**
（实测抓到过哈希与上一版完全相同的包，于是 2 项 MISS，差点误判成改动没生效）。

> ⚠️ 改动 `deploy` job 时注意：它**不会**自动带仓库文件（checkout 只在 build 里做过），
> 在 deploy 里跑任何 `node tools/xxx.mjs` 之前都要自己补 `actions/checkout@v4`
> （要跑 node 还得补 `setup-node`），否则就是「找不到文件」。

> ⚠️ 找中文标记必须**先转成 `\uXXXX`** —— minifier 会把中文全部转义，直接搜中文会全 MISS，
> 让人误以为代码没发出去（这个坑踩过）。
> ⚠️ 也别把「静态文本 + `{变量}`」当成一条字符串去搜：JSX 编译时会把
> `默认舞台 · {label}` 切成两段，线上根本没有「默认舞台 · 」这个连续字面量。
> 搜**不带尾空格的最短片段**。

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
