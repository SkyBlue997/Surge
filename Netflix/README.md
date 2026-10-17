# 🍿️ Netflix 双语字幕 (LLM)

在 [DualSubs/Netflix](https://github.com/DualSubs/Netflix) v0.6.0 的基础上改写的 Surge 模块。字幕翻译换成 **OpenAI / Anthropic / DeepL**，并按上下文翻译。

模块地址：

```
https://raw.githubusercontent.com/SkyBlue997/Surge/main/Netflix/DualSubs.Netflix.LLM.sgmodule
```

## 文件

| 文件 | 说明 |
|---|---|
| `DualSubs.Netflix.LLM.sgmodule` | 模块：脚本规则、MITM 和全部可调参数 |
| `Netflix.Translate.response.js` | 翻译脚本：解析 TTML/DFXP/IMSC 和 WebVTT，调用翻译接口，合成双语字幕 |

## 使用

1. 安装模块，开启 MITM 并信任证书。
2. 在模块参数里把 `Vendor` 设为 `OpenAI`、`Anthropic` 或 `DeepL`，并填写对应的 `*Key`。
3. 在 Netflix 里选择原文字幕（例如英语）。脚本会在原文旁加上 `Target` 语言的译文。

没填 Key 或请求失败时，会弹出通知并显示原字幕，不会影响播放。

如果在 Netflix 里直接选了目标语言的字幕（例如目标是简体中文，而你选了中文字幕），脚本会根据字幕的实际文字识别出来，不翻译、直接显示原字幕。识别以文字为准，字幕文件里声明的语言只在文字无法区分时（同为拉丁字母）作参考。

## 上下文翻译

- 字幕按 `BatchSize` 条分批，一批台词在同一次请求里一起翻译。
- 每批还会带上前后各 `ContextLines` 行原文作为上下文，模型只参考、不翻译。用来判断说话人、人称、语气，以及被拆到相邻几条字幕里的同一句话。
- OpenAI / Anthropic：提示词要求逐条对应、术语和称谓保持一致，并以 JSON 返回。Anthropic 使用 structured outputs 保证格式；模型漏掉的行会单独补翻一次。
- DeepL：使用官方 `context` 参数（不翻译、不计费），放入本批及前后台词。
- `Hint` 可以填剧名、人物译名、称谓偏好等背景，会加进 LLM 的提示词。
- 译文按字幕内容和翻译配置缓存在本地（`CacheSize` 集），重复加载时不会再次请求。

## 参数速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `Vendor` | `OpenAI` | `OpenAI` / `Anthropic` / `DeepL` |
| `Source` / `Target` | `AUTO` / `ZH-HANS` | 源语言 / 目标语言 |
| `Position` | `Forward` | 原文在上 (`Forward`) 或在下 (`Reverse`) |
| `ShowOnly` | `false` | 只显示译文 |
| `OpenAIKey` / `OpenAIModel` / `OpenAIBaseURL` / `OpenAIEffort` | – / `gpt-5-mini` / `https://api.openai.com/v1` / `minimal` | BaseURL 可以换成任意 OpenAI 兼容接口；非推理模型或第三方接口请把 Effort 留空 |
| `AnthropicKey` / `AnthropicModel` / `AnthropicBaseURL` / `AnthropicEffort` | – / `claude-opus-5-5` / `https://api.anthropic.com` / `low` | 想要更快更便宜，可以换成 `claude-sonnet-5-5` 或 `claude-haiku-5-5` |
| `DeepLKey` / `DeepLBaseURL` | – / 自动 | 以 `:fx` 结尾的 Key 自动走 Free 接口 |
| `ContextLines` | `8` | 每批附带的前后上下文行数 |
| `BatchSize` | `20` | 每批台词数（DeepL 最多 50） |
| `Concurrency` | `16` | 同时发出的请求数 |
| `Timeout` | `30` | 限时（秒），到时先返回已翻译的部分 |
| `Hint` | 空 | 补充背景，不要包含英文双引号 |
| `CacheSize` | `3` | 本地缓存集数，填 0 关闭 |
| `LogLevel` | `WARN` | `OFF` / `ERROR` / `WARN` / `INFO` / `DEBUG` / `ALL` |

## 注意

- 一集字幕通常有几百条，分成几十批同时翻译。播放器不会无限等待字幕：超过 `Timeout` 秒还没翻完时，先返回已翻译的部分（从开头往后），其余显示原文，并弹通知提示。已翻译的部分会缓存，再次选择这条字幕时只翻剩余部分。
- 如果经常超时，可以调大 `Concurrency`、换更快的模型（如 `claude-haiku-5-5`），或调小 `BatchSize`。API 额度较低、频繁遇到 429 时调小 `Concurrency`。
- 使用 Anthropic 官方接口和支持的模型时，脚本会开启服务端 `fallbacks: "default"`：请求被安全分类器拒绝时，由服务端自动换模型重试。
