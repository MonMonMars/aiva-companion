# 粵語 AI 助手 — 项目最终总结文档

**App Name:** 粵語 AI 助手 (Cantonese AI Assistant)
**Type:** Web app — hands-free Cantonese voice & chat companion
**Date:** 2026-09

---

## 1. What the app does

A web-based AI companion that talks and chats with you in fluent Cantonese (粵語/廣東話). It greets you automatically, listens hands-free, replies out loud in a natural Cantonese voice, and shows live captions — modeled after ChatGPT's voice conversation experience.

---

## 2. Final feature list

### Voice conversation
- **Auto-greeting** — the moment you enter a chat, the AI speaks a Cantonese greeting ("哈囉！我係你嘅粵語傾計伙伴～") then starts listening.
- **Hands-free continuous mode** — once started, the loop runs automatically: listen → transcribe → AI replies → speak aloud → listen again.
- **Tap ball to start / end** — the emotion orb toggles voice mode on and off.
- **Barge-in (interruption)** — start talking while the AI speaks and it immediately cuts its audio and listens.
- **Streaming TTS** — begins speaking the first sentence as soon as it's generated, rather than waiting for the full reply.
- **Backchannel fillers** — if the AI takes >800ms to think, it says a quick "嗯… / 等陣啊…" so there's no dead air.
- **Live captions** — your transcribed words stream in as you speak; the AI's words stream out in sync with the audio.
- **Voice picker** — switch between Cantonese voices (see §4); selection is remembered.

### Speech input (listening)
- **Auto-calibrated VAD** — measures ambient noise for ~1 second, then sets the speech threshold relative to that background noise (no hardcoded volume level).
- **Noise rejection** — requires sustained speech (~280ms) so breaths, taps, and background noise don't falsely trigger.
- **Short end-of-turn gap** — ~350ms silence before it sends, so it responds quickly after you stop talking.
- **Volume-reactive orb** — the ball pulses with your voice level so you can see the mic is receiving sound.

### The emotion ball (orb)
- Color-coded states:
  - 🟠 **Orange** — AI is speaking (sound out)
  - 🟢 **Green** — listening / you are speaking (sound in)
  - 🟣 **Purple** — thinking / transcribing / loading
- ChatGPT-style effects: layered glow, expanding ripple rings, floating light particles.
- Loading state shown while the voice model initializes.

### Chat & UI
- **ChatGPT-style interface** — left sidebar with conversation list, centered chat column, pill-shaped input box, welcome screen with suggestion cards.
- **Multilingual auto-detection** — automatically detects Cantonese / Mandarin / English / Japanese / Korean and replies in the same language.
- **Navigation buttons** — back, home, and end-call.
- **Chat history** — conversations saved locally (scoped storage), persist across refreshes; new/delete conversations.
- Default language is Cantonese (authentic colloquial: 嘅、咁、喺、唔、㗎、啦、咩 …).

---

## 3. Architecture (what we learned from ChatGPT)

The app uses a **cascaded** voice pipeline:

```
You speak
  → VAD detects end of turn (auto-calibrated, ~350ms silence)
  → Speech-to-text (streaming)
  → LLM generates reply (token by token, Cantonese colloquial)
  → Text-to-speech (sentence by sentence, starts early)
  → Audio plays; you can interrupt anytime
```

Key principles applied from studying ChatGPT's voice system:
- **Stream at every layer** — partial transcripts, token-by-token generation, chunked TTS — to cut latency.
- **Barge-in is the core** — interruption is a first-class state transition.
- **Don't over-interrupt** — short silence threshold but with a minimum-speech guard.
- **Backchannels** while thinking, instead of dead air.

> Note: true **full-duplex** (listen and speak simultaneously, like GPT-Live) requires a dedicated speech-to-speech model with no public API available to this build; the cascaded pipeline above is the practical equivalent.

---

## 4. Cantonese voices available

> ⚠️ **Verification note (2026-09-24):** this table was audited against the real sources.
> One widely-circulated claim — that **Piper TTS has a Cantonese (`yue`) model** — is **false**:
> the official `rhasspy/piper-voices` repo has **no `yue` folder** (`https://huggingface.co/rhasspy/piper-voices/tree/main/yue` returns 404).
> Do not rely on Piper for Cantonese. The real **no-key** options — all three now wired into this app — are:
> **Edge TTS `zh-HK-*`** (free neural, needs internet, Web build) →
> **system voice via `expo-speech`** (free, offline, native iOS/Android) →
> **eSpeak NG `zhy`** (truly offline, robotic, Web build).
> ⚠️ The eSpeak-ng selector for Cantonese is **`zhy`**, **not** `yue` — see the offline table below.

### Server-side / cloud voices (need an API key or account)
| Voice | ID | Gender | Type | Status | Source / reference |
|---|---|---|---|---|---|
| 粵語小溏 | `zh_female_yueyunv_mars_bigtts` | Female | Neural (big model) | **Default — confirmed working** (Volcengine / 火山引擎) | [火山引擎音色公告](https://www.volcengine.com/docs/6561/1350657) |
| 香港小美 | `zh-HK_female_hkxiaomei_mars_bigtts` | Female | Neural | Confirmed (Volcengine) | [火山引擎音色列表](https://docs.volcengine.com/docs/6561/1257544) |
| 小何 2.0 | `zh_female_xiaohe_uranus_bigtts` | Female | Emotional neural | Experimental (falls back if unsupported) | [火山引擎音色列表](https://docs.volcengine.com/docs/6561/1257544) |
| 云舟 2.0 | `zh_male_m191_uranus_bigtts` | Male | Emotional neural | Experimental (Volcengine) | [火山引擎音色列表](https://docs.volcengine.com/docs/6561/1257544) |
| 粵語新聞 | `zh_male_yueyuxiaowu_mars_bigtts` | Male | Neural news | Experimental (Volcengine) | [火山引擎音色列表](https://docs.volcengine.com/docs/6561/1257544) |
| 廣東女仔 | `BV424_streaming` | Female | Small model | Experimental (Volcengine) | [火山引擎小模型音色](https://www.volcengine.com/docs/6561/97465) |
| 港劇男神 | `BV026_streaming` | Male | Small model | Experimental (Volcengine) | [火山引擎小模型音色](https://www.volcengine.com/docs/6561/97465) |
| 曉佳 (HiuGaai) | `zh-HK-HiuGaaiNeural` | Female | Microsoft neural | **Free, no key** (Edge TTS / browser) | [Edge TTS voice list](https://github.com/wangwangit/edge-tts-webui/blob/main/voice.txt) |
| 曉曼 (HiuMaan) | `zh-HK-HiuMaanNeural` | Female | Microsoft neural | **Free, no key** (Edge TTS / browser) | [Edge TTS voice list](https://github.com/wangwangit/edge-tts-webui/blob/main/voice.txt) |
| 雲龍 (WanLung) | `zh-HK-WanLungNeural` | Male | Microsoft neural | **Free, no key** (Edge TTS / browser) | [Edge TTS voice list](https://github.com/wangwangit/edge-tts-webui/blob/main/voice.txt) |
| 佳 (Gaai) | `zh-HK-GaaiNeural` | Female | Microsoft neural | **Free, no key** (Edge TTS / browser) | [Edge TTS voice list](https://github.com/wangwangit/edge-tts-webui/blob/main/voice.txt) |

### Local / offline voices (no API key)
| Voice | ID | Gender | Type | Status | Download / reference |
|---|---|---|---|---|---|
| **eSpeak NG** (browser WASM) | `zhy` | Female | Robotic (formant synthesis) | **Truly offline fallback** — no key, no network | **Bundled same-origin** at `public/espeakng/` (≈3.3 MB total). Upstream source is `steveseguin/espeakng.js@master/js/` — note the assets live under a **`js/` subfolder on the `master` branch** (root-level and `@main` URLs both 404). Files served locally: `espeakng-simple.js`, `espeakng.min.js`, `espeakng.worker.js` (776 KB), `espeakng.worker.data` (2.5 MB).<br>⚠️ **Web Workers cannot be loaded cross-origin**, so these must be served from the same origin — never hotlink a CDN.<br>⚠️ Selector is **`zhy`** (`yue` is not an installed voice name in this build; passing it silently falls back to the default voice). Guarded by `tools/espeak.test.mjs`. Upstream: [JRMeyer/espeak-ng](https://github.com/JRMeyer/espeak-ng). |
| **系统嗓音 (System voice)** — via `expo-speech` | `native` | Device-dependent | OS neural TTS | **Offline, no key — the default on iPhone/Android.** Wraps **iOS `AVSpeechSynthesizer`** / **Android `TextToSpeech`**; both support `zh-HK`. For authentic Cantonese on iPhone, download the *Chinese (Cantonese)* voice under Settings ▸ Accessibility ▸ Spoken Content ▸ Voices — without it the device still speaks, just with its default voice. | Ships with Expo SDK 57 (`expo-speech@~57.0.3`) and is **included in Expo Go**, so no custom dev client or EAS build is needed. See `src/voice/nativeSpeech.js`. |
| ~~Piper Cantonese~~ | `yue` | — | — | ❌ **Does NOT exist** — `rhasspy/piper-voices` has no `yue` model (`yue` folder 404s). | — |

### Other cloud providers (reference only — all need keys)
- **Google Cloud TTS** — Cantonese `yue-HK` voices (`yue-HK-Standard-A/B/C/D`, plus WaveNet/Neural2): [voices docs](https://cloud.google.com/text-to-speech/docs/voices)
- **AWS Polly** — `Hiujin` (female, `yue-CN`, neural): [neural voices](https://docs.aws.amazon.com/polly/latest/dg/neural-voices.html)
- **Alibaba TTS** — `taozi` (Peach), Cantonese female: [features](https://help.aliyun.com/en/isi/product-overview/features)

**Fallback chain (no-API-key reality):**
For running Cantonese with **no API key**, the practical chain is:
**Edge TTS `zh-HK-*`** (free neural, needs internet) → **system voice via `expo-speech`** (free, offline) → **eSpeak NG `zhy`** (truly offline, robotic).
All neural *cloud* voices above (Volcengine / Google / AWS / Alibaba) require an API key or account and will not work keyless.

> **App-status note (updated 2026-09-24):** **a keyless user now gets Cantonese speech on every platform.**
> OpenAI / Azure / ElevenLabs are still offered in `src/config/providers.js` for higher voice quality,
> but they are *optional* — the app no longer needs any key to speak.
> Defaults are key-free and platform-aware (`src/store.js`):
> - **Web** → `edge` (browser's own Microsoft neural `zh-HK-*` voices), with eSpeak NG WASM at `/espeakng/` as the offline fallback.
> - **iOS / Android** → `native` (the phone's built-in `zh-HK` voice via `expo-speech`, fully offline).
>
> Existing installs are migrated exactly once (`ttsMigratedToNative` / `ttsMigratedToFree`), and **only** if they
> were parked on a cloud provider with no matching key — anyone who deliberately filled in a key is left untouched.
>
> ⚠️ **STT (speech *input*) still needs a key**: browsers and phones can record audio, but turning speech into
> text requires a cloud service. Speaking *out* (TTS) is completely key-free.

---

## 5. Known limitations

- **Cantonese speech recognition** — the platform STT doesn't natively support Cantonese; it uses Mandarin phonetics then the AI converts the result to Cantonese text. Accuracy varies with tone and speed (speaking clearly helps).
- **No true full-duplex** — turn-taking is VAD-gated; it's fast but not literally simultaneous.
- **Emotion control** — replies do carry emotion tags (`[laughs]`, `[excited]`, `[comfort]`, …) that are translated **per provider** (see `EMOTIONS` in `src/voice/tts.js`): natural-language instructions for OpenAI, SSML styles for Azure, stability/style for ElevenLabs. The **key-free engines are deliberately simpler**: Edge uses no style at all, and the native system voice can only be nudged via pitch/rate (`src/voice/nativeEmotion.js`) — so both read noticeably *flatter* than the cloud voices.
- **Voice quality tier** — quality now follows the platform default rather than server availability: Web uses the browser's Microsoft neural `zh-HK` voices, iOS/Android use the OS voice, and robotic eSpeak appears only when the device has nothing better. Cloud voices (OpenAI / Azure / ElevenLabs) remain the best-sounding but require keys.
- **Piper has no Cantonese** — contrary to some lists, Piper's official catalog contains no `yue` model; do not depend on it for Cantonese.

---

## 6. How to use

1. Open the app and allow microphone access.
2. The AI greets you automatically in Cantonese.
3. Talk naturally — the ball shows green while listening.
4. The AI replies out loud (orange ball) with synced captions.
5. Talk over it anytime to interrupt.
6. Tap the ball again (or "結束通話") to end voice mode.
7. Use the voice button (top-right) to switch Cantonese voices.
8. Use the sidebar to start/switch/delete conversations.
