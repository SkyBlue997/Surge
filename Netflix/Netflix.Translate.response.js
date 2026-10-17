// Netflix 双语字幕 · 上下文感知翻译 (Surge http-response script)
// 作用: 拦截 *.oca.nflxvideo.net 返回的字幕文件 (TTML/DFXP/IMSC 或 WebVTT), 逐条翻译后与原文合并为双语字幕。
// 翻译器: OpenAI (Chat Completions, 兼容任意 OpenAI 格式接口) / Anthropic (Messages API) / DeepL。
// 上下文: 字幕按批次翻译, 每批都会附带前后若干行原文作为上下文 (LLM 用于理解剧情/人称/语气;
//         DeepL 走官方 context 参数, 不计费), 同时可通过 Hint 参数提供剧名、人名译法等背景信息。
// 缓存: 同一份字幕 + 同一翻译配置的结果存入 $persistentStore, 拖动进度条/重新加载时不重复计费。

const SCRIPT_NAME = "DualSubs Netflix";
const CACHE_KEY = "DualSubs.Netflix.LLM.Cache";

// ---------------------------------------------------------------- 参数
const ARG_KEYS = [
  "Vendor", "Source", "Target", "Position", "ShowOnly",
  "OpenAIKey", "OpenAIModel", "OpenAIBaseURL", "OpenAIEffort",
  "AnthropicKey", "AnthropicModel", "AnthropicBaseURL", "AnthropicEffort",
  "DeepLKey", "DeepLBaseURL",
  "ContextLines", "BatchSize", "Concurrency", "Hint", "CacheSize", "LogLevel",
];
const DEFAULTS = {
  Vendor: "OpenAI", Source: "AUTO", Target: "ZH-HANS", Position: "Forward", ShowOnly: "false",
  OpenAIKey: "", OpenAIModel: "gpt-5-mini", OpenAIBaseURL: "https://api.openai.com/v1", OpenAIEffort: "minimal",
  AnthropicKey: "", AnthropicModel: "claude-opus-5-5", AnthropicBaseURL: "https://api.anthropic.com", AnthropicEffort: "low",
  DeepLKey: "", DeepLBaseURL: "",
  ContextLines: "8", BatchSize: "40", Concurrency: "4", Hint: "", CacheSize: "3", LogLevel: "WARN",
};

// 按已知键名切分, 允许值里出现 & 或 = (例如 Hint 里的说明文字)
function parseArgument(raw) {
  const out = Object.assign({}, DEFAULTS);
  if (typeof raw !== "string" || !raw) return out;
  const re = new RegExp(`(?:^|&)(${ARG_KEYS.join("|")})=`, "g");
  const hits = [];
  let m;
  while ((m = re.exec(raw))) hits.push({ key: m[1], start: m.index, valueStart: re.lastIndex });
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : raw.length;
    let v = raw.slice(h.valueStart, end).trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    // 模块未替换的占位符 ({{{Key}}}) 视为未传入, 保留默认值; 显式留空则为空 (如关闭 OpenAIEffort)
    if (!/^\{\{\{.*\}\}\}$/.test(v)) out[h.key] = v;
  });
  return out;
}

const ARGS = parseArgument(typeof $argument !== "undefined" ? $argument : "");
const LOG_LEVELS = { OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, ALL: 5 };
const LOG_LEVEL = LOG_LEVELS[String(ARGS.LogLevel).toUpperCase()] ?? 2;
const log = {
  error: (...a) => LOG_LEVEL >= 1 && console.log(`❌ ${a.join(" ")}`),
  warn: (...a) => LOG_LEVEL >= 2 && console.log(`⚠️ ${a.join(" ")}`),
  info: (...a) => LOG_LEVEL >= 3 && console.log(`ℹ️ ${a.join(" ")}`),
  debug: (...a) => LOG_LEVEL >= 4 && console.log(`🅱️ ${a.join(" ")}`),
};
const toInt = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};
const CONFIG = {
  vendor: String(ARGS.Vendor).trim() || "OpenAI",
  source: String(ARGS.Source).trim().toUpperCase() || "AUTO",
  target: String(ARGS.Target).trim().toUpperCase() || "ZH-HANS",
  position: /^reverse$/i.test(ARGS.Position) ? "Reverse" : "Forward",
  showOnly: /^(true|1|yes)$/i.test(String(ARGS.ShowOnly)),
  contextLines: toInt(ARGS.ContextLines, 8, 0, 50),
  batchSize: toInt(ARGS.BatchSize, 40, 1, 200),
  concurrency: toInt(ARGS.Concurrency, 4, 1, 16),
  cacheSize: toInt(ARGS.CacheSize, 3, 0, 20),
  hint: String(ARGS.Hint || "").trim(),
};

// ---------------------------------------------------------------- 语言
const LANG_NAMES = {
  ZH: "Simplified Chinese", "ZH-HANS": "Simplified Chinese",
  "ZH-HANT": "Traditional Chinese (Taiwan)", "ZH-HK": "Traditional Chinese (Hong Kong)",
  EN: "English", ES: "Spanish", JA: "Japanese", KO: "Korean", DE: "German",
  FR: "French", TR: "Turkish", KM: "Khmer",
};
const langName = (code) => LANG_NAMES[code] || code;

function deeplTarget(code) {
  switch (code) {
    case "ZH": case "ZH-HANS": return "ZH-HANS";
    case "ZH-HANT": case "ZH-HK": return "ZH-HANT";
    case "EN": return "EN-US";
    default: return code;
  }
}
function deeplSource(code) {
  if (!code || code === "AUTO") return undefined;
  return code.split("-")[0];
}

// 按字幕实际文字判断语言: 返回 zh / ja / ko / km / latin, 无法判断时返回 undefined
function detectScript(texts) {
  const sample = texts.join("").slice(0, 20000);
  const count = (re) => (sample.match(re) || []).length;
  const letters = count(/\p{L}/gu);
  if (letters < 10) return undefined;
  const han = count(/[㐀-鿿豈-﫿]/g), kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯ᄀ-ᇿ]/g), khmer = count(/[ក-៿]/g);
  const latin = count(/[A-Za-zÀ-ɏ]/g);
  if (kana / letters > 0.1) return "ja";
  if (hangul / letters > 0.4) return "ko";
  if (khmer / letters > 0.4) return "km";
  if (han / letters > 0.4) return "zh";
  if (latin / letters > 0.8) return "latin";
  return undefined;
}

// 字幕已是目标语言时不翻译 (如在 Netflix 里直接选了中文字幕)。
// 以实际文字为准: Netflix 的 TTML 声明的 xml:lang 不一定是字幕真实语言, 只在文字无法区分 (同为拉丁字母) 时参考
function alreadyInTarget(texts, target, declaredLang) {
  const t = target.split("-")[0].toLowerCase();
  const detected = detectScript(texts);
  log.info(`字幕语言检测: 文字=${detected ?? "未知"}, 声明=${declaredLang ?? "无"}, 目标=${t}`);
  if (detected && detected !== "latin") return detected === t;
  const declared = declaredLang ? declaredLang.split("-")[0].toLowerCase() : undefined;
  if (detected === "latin") return ["zh", "ja", "ko", "km"].includes(t) ? false : declared === t;
  return declared === t;
}

// ---------------------------------------------------------------- 文本工具
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const escapeXML = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 去掉注音 (振假名): TTML 的 tts:ruby="text" 与 WebVTT 的 <rt>, 只保留正文送去翻译
const stripRuby = (s) => s
  .replace(/<((?:\w+:)?span)\b[^>]*\btts:ruby="text"[^>]*>[\s\S]*?<\/\1>/g, "")
  .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/g, "");
const cleanLines = (s) => s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");

function hash(str) {
  // 两路 FNV-1a 拼接, 足够区分不同字幕文件
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function combine(original, translation, lineBreak) {
  if (!translation) return original;
  if (CONFIG.showOnly) return translation;
  return CONFIG.position === "Reverse"
    ? `${translation}${lineBreak}${original}`
    : `${original}${lineBreak}${translation}`;
}

// ---------------------------------------------------------------- 字幕格式
// TTML / DFXP / IMSC: 只改写 <p> 的内容, 其余结构 (样式/区域/时间轴) 原样保留
const TTML = {
  test: (body) => /<tt[\s>:]/.test(body) && /<\/(?:\w+:)?p>/.test(body),
  lang: (body) => (body.match(/<(?:\w+:)?tt\b[^>]*\bxml:lang="([^"]+)"/) || [])[1],
  parse(body) {
    const re = /(<((?:\w+:)?p)\b[^>]*>)([\s\S]*?)(<\/\2>)/g;
    const cues = [];
    let m;
    while ((m = re.exec(body))) {
      const inner = m[3];
      const text = cleanLines(decodeEntities(stripRuby(inner).replace(/<(?:\w+:)?br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")));
      cues.push({ start: m.index + m[1].length, end: m.index + m[1].length + inner.length, inner, text });
    }
    return cues;
  },
  build(body, cues, translations) {
    let out = "", last = 0;
    cues.forEach((cue, i) => {
      const t = translations[i];
      out += body.slice(last, cue.start);
      if (t) {
        const tx = t.split("\n").map(escapeXML).join("<br/>");
        out += combine(cue.inner, tx, "<br/>");
      } else {
        out += cue.inner;
      }
      last = cue.end;
    });
    return out + body.slice(last);
  },
};

// WebVTT: 以空行分块, 含 "-->" 的块为字幕块, 时间轴之后的行为字幕文本
const VTT = {
  test: (body) => /^﻿?WEBVTT/.test(body),
  lang: () => undefined,
  parse(body) {
    const nl = body.includes("\r\n") ? "\r\n" : "\n";
    const blocks = body.split(/\r?\n\r?\n/);
    const cues = [];
    blocks.forEach((block, bi) => {
      const lines = block.split(/\r?\n/);
      const ti = lines.findIndex((l) => l.includes("-->"));
      if (ti < 0) return;
      // 文件末尾的换行会在最后一块留下空行, 单独保留, 否则译文会被空行隔断而不显示
      const body = lines.slice(ti + 1);
      const tail = [];
      while (body.length && body[body.length - 1].trim() === "") tail.unshift(body.pop());
      const raw = body.join("\n");
      const text = cleanLines(decodeEntities(stripRuby(raw).replace(/<[^>]+>/g, "")));
      cues.push({ bi, head: lines.slice(0, ti + 1), raw, tail, text });
    });
    return Object.assign(cues, { blocks, nl });
  },
  build(body, cues, translations) {
    const { blocks, nl } = cues;
    cues.forEach((cue, i) => {
      const t = translations[i];
      if (!t) return;
      const textLines = combine(cue.raw, t, "\n").split("\n");
      blocks[cue.bi] = cue.head.concat(textLines, cue.tail).join(nl);
    });
    return blocks.join(nl + nl);
  },
};

// ---------------------------------------------------------------- HTTP
function post(url, headers, body, timeout = 60) {
  return new Promise((resolve, reject) => {
    $httpClient.post({ url, headers, body: JSON.stringify(body), timeout }, (err, resp, data) => {
      if (err) return reject(new Error(String(err)));
      const status = resp?.status ?? resp?.statusCode;
      if (status < 200 || status >= 300) {
        return reject(Object.assign(new Error(`HTTP ${status}: ${String(data).slice(0, 300)}`), { status }));
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`响应不是 JSON: ${String(data).slice(0, 200)}`));
      }
    });
  });
}

// ---------------------------------------------------------------- LLM 提示词
function systemPrompt() {
  const src = CONFIG.source === "AUTO" ? "the source language (auto-detect)" : langName(CONFIG.source);
  let p = `You are a professional subtitle translator for films and TV series. Translate subtitle lines from ${src} into ${langName(CONFIG.target)}.

Rules:
- "context_before" and "context_after" are neighbouring subtitle lines. Use them, together with the other lines in the batch, to understand the plot, who is speaking to whom, tone, pronouns, gender, and jokes. Do not translate the context lines themselves.
- A sentence is often split across consecutive subtitle lines. Translate each id so it reads naturally in sequence, keep the original split points, and never move content from one id to another.
- Keep names, places, terms, and forms of address consistent.
- Write concise, natural, colloquial subtitles, the way a professional subtitler would. Add no notes or explanations.
- Translate sound descriptions and speaker labels (e.g. [door slams], (JOHN:)) and keep their bracket style.
- Keep "\\n" line breaks and leading "-" dialogue dashes where the source has them.
- Return exactly one translation for every id in "lines".

Respond with JSON only, in this shape: {"translations":[{"id":0,"text":"..."}]}`;
  if (CONFIG.hint) p += `\n\nBackground from the viewer (title, names, preferred terms): ${CONFIG.hint}`;
  return p;
}

function userPayload(batch) {
  return JSON.stringify({
    context_before: batch.before,
    lines: batch.items.map((it) => ({ id: it.id, text: it.text })),
    context_after: batch.after,
  });
}

function parseLLMOutput(text, batch) {
  let s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`模型输出无法解析: ${s.slice(0, 200)}`);
  const obj = JSON.parse(s.slice(a, b + 1));
  const list = Array.isArray(obj) ? obj : obj.translations;
  if (!Array.isArray(list)) throw new Error("模型输出缺少 translations 数组");
  const map = {};
  list.forEach((t, i) => {
    if (typeof t === "string") {
      // 兼容直接返回字符串数组
      if (batch.items[i]) map[batch.items[i].id] = t;
    } else if (t && t.id !== undefined) {
      map[Number(t.id)] = String(t.text ?? "");
    }
  });
  return map;
}

// ---------------------------------------------------------------- 翻译器
const Translators = {
  async OpenAI(batch) {
    const key = ARGS.OpenAIKey;
    if (!key) throw Object.assign(new Error("未填写 OpenAIKey"), { fatal: true });
    const base = String(ARGS.OpenAIBaseURL || DEFAULTS.OpenAIBaseURL).replace(/\/+$/, "");
    const body = {
      model: ARGS.OpenAIModel || DEFAULTS.OpenAIModel,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPayload(batch) },
      ],
    };
    // 推理模型 (gpt-5 / o 系列) 用 reasoning_effort 控制延迟; 非推理模型或第三方接口请把 OpenAIEffort 留空
    if (ARGS.OpenAIEffort) body.reasoning_effort = ARGS.OpenAIEffort;
    if (/^https:\/\/api\.openai\.com\//.test(base)) body.response_format = { type: "json_object" };
    const res = await post(`${base}/chat/completions`, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    }, body, 90);
    const text = res?.choices?.[0]?.message?.content;
    return parseLLMOutput(text, batch);
  },

  async Anthropic(batch) {
    const key = ARGS.AnthropicKey;
    if (!key) throw Object.assign(new Error("未填写 AnthropicKey"), { fatal: true });
    const base = String(ARGS.AnthropicBaseURL || DEFAULTS.AnthropicBaseURL).replace(/\/+$/, "").replace(/\/v1$/, "");
    const model = ARGS.AnthropicModel || DEFAULTS.AnthropicModel;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
    const outputConfig = {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            translations: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "integer" }, text: { type: "string" } },
                required: ["id", "text"],
                additionalProperties: false,
              },
            },
          },
          required: ["translations"],
          additionalProperties: false,
        },
      },
    };
    if (ARGS.AnthropicEffort) outputConfig.effort = ARGS.AnthropicEffort;
    const body = {
      model,
      max_tokens: 16000,
      system: systemPrompt(),
      messages: [{ role: "user", content: userPayload(batch) }],
      output_config: outputConfig,
    };
    // 官方接口上, 被安全分类器拒绝的请求由服务端自动换模型重试
    if (/^https:\/\/api\.anthropic\.com$/.test(base) && /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/.test(model)) {
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      body.fallbacks = "default";
    }
    const res = await post(`${base}/v1/messages`, headers, body, 90);
    if (res?.stop_reason === "refusal") throw new Error(`模型拒绝翻译: ${res?.stop_details?.category ?? "unknown"}`);
    const content = Array.isArray(res?.content) ? res.content : [];
    // 发生过服务端 fallback 时, 只取最后一个 fallback 标记之后的文本
    let startAt = 0;
    content.forEach((c, i) => { if (c?.type === "fallback") startAt = i + 1; });
    const text = content.slice(startAt).filter((c) => c?.type === "text").map((c) => c.text).join("");
    if (res?.stop_reason === "max_tokens") log.warn("Anthropic 输出达到 max_tokens, 请调小 BatchSize");
    return parseLLMOutput(text, batch);
  },

  async DeepL(batch) {
    const key = ARGS.DeepLKey;
    if (!key) throw Object.assign(new Error("未填写 DeepLKey"), { fatal: true });
    const base = String(ARGS.DeepLBaseURL || (/:fx$/.test(key) ? "https://api-free.deepl.com" : "https://api.deepl.com"))
      .replace(/\/+$/, "").replace(/\/v2$/, "");
    const body = {
      text: batch.items.map((it) => it.text),
      target_lang: deeplTarget(CONFIG.target),
      preserve_formatting: true,
      // DeepL 的 context 不会被翻译、也不计费; 放入本批及前后的原文, 让每一行都能参考上下文
      context: [...batch.before, ...batch.items.map((it) => it.text), ...batch.after].join("\n"),
    };
    const src = deeplSource(CONFIG.source);
    if (src) body.source_lang = src;
    const res = await post(`${base}/v2/translate`, {
      "Content-Type": "application/json",
      Authorization: `DeepL-Auth-Key ${key}`,
    }, body, 60);
    const map = {};
    (res?.translations || []).forEach((t, i) => {
      if (batch.items[i]) map[batch.items[i].id] = t.text;
    });
    return map;
  },
};

// ---------------------------------------------------------------- 批处理
function makeBatches(texts, size) {
  // DeepL 单次最多 50 条
  if (CONFIG.vendor === "DeepL") size = Math.min(size, 50);
  const items = [];
  texts.forEach((text, id) => { if (text) items.push({ id, text }); });
  const n = CONFIG.contextLines;
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    batches.push({
      items: slice,
      before: items.slice(Math.max(0, i - n), i).map((it) => it.text),
      after: items.slice(i + size, i + size + n).map((it) => it.text),
    });
  }
  return batches;
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function translateBatch(translator, batch) {
  let map = {};
  try {
    map = await translator(batch);
  } catch (e) {
    if (e.fatal || (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
    log.warn(`批次翻译失败, 重试一次: ${e.message}`);
    await new Promise((r) => setTimeout(r, 1000));
    map = await translator(batch);
  }
  // 模型漏掉的行单独补一次 (仍附带同一批的上下文)
  const missing = batch.items.filter((it) => !map[it.id]);
  if (missing.length && missing.length < batch.items.length && CONFIG.vendor !== "DeepL") {
    log.info(`补翻 ${missing.length} 行`);
    try {
      Object.assign(map, await translator({ ...batch, items: missing }));
    } catch (e) {
      log.warn(`补翻失败: ${e.message}`);
    }
  }
  return map;
}

async function translateAll(texts) {
  const translator = Translators[CONFIG.vendor];
  if (!translator) throw Object.assign(new Error(`不支持的 Vendor: ${CONFIG.vendor}`), { fatal: true });
  const batches = makeBatches(texts, CONFIG.batchSize);
  log.info(`共 ${texts.length} 条字幕, ${batches.length} 批, 并发 ${CONFIG.concurrency}`);
  const maps = await runPool(batches.map((b) => () => translateBatch(translator, b)), CONFIG.concurrency);
  const merged = Object.assign({}, ...maps);
  return texts.map((_, i) => (merged[i] ? cleanLines(merged[i]) : ""));
}

// ---------------------------------------------------------------- 缓存
function cacheSignature(texts) {
  const model = { OpenAI: ARGS.OpenAIModel, Anthropic: ARGS.AnthropicModel, DeepL: "deepl" }[CONFIG.vendor];
  return hash([CONFIG.vendor, model, CONFIG.source, CONFIG.target, CONFIG.hint, texts.join("\u0001")].join("\u0002"));
}
function readCache() {
  try {
    return JSON.parse($persistentStore.read(CACHE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function cacheGet(sig) {
  if (!CONFIG.cacheSize) return null;
  const hit = readCache().find((e) => e.k === sig);
  return hit ? hit.t : null;
}
function cachePut(sig, translations) {
  if (!CONFIG.cacheSize) return;
  const list = readCache().filter((e) => e.k !== sig);
  list.unshift({ k: sig, t: translations });
  $persistentStore.write(JSON.stringify(list.slice(0, CONFIG.cacheSize)), CACHE_KEY);
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const body = typeof $response.body === "string" ? $response.body : "";
  const format = TTML.test(body) ? TTML : VTT.test(body) ? VTT : null;
  if (!format) {
    const h = $response.headers || {};
    const ct = h["Content-Type"] ?? h["content-type"] ?? "";
    log.debug(`非字幕响应, 跳过: Content-Type=${ct}, 长度=${body.length}, 开头=${JSON.stringify(body.slice(0, 60))}`);
    return {};
  }
  const cues = format.parse(body);
  log.info(`字幕格式: ${format === TTML ? "TTML" : "WebVTT"}, ${cues.length} 条`);
  const texts = cues.map((c) => c.text);
  if (!texts.some(Boolean)) return {};
  if (alreadyInTarget(texts, CONFIG.target, format.lang(body))) {
    log.info("字幕已是目标语言, 跳过翻译");
    return {};
  }

  const sig = cacheSignature(texts);
  let translations = cacheGet(sig);
  if (translations && translations.length === texts.length) {
    log.info("命中缓存");
  } else {
    const t0 = Date.now();
    translations = await translateAll(texts);
    const done = translations.filter(Boolean).length;
    log.info(`翻译完成 ${done}/${texts.filter(Boolean).length}, 用时 ${Date.now() - t0}ms`);
    if (done) cachePut(sig, translations);
  }
  return { body: format.build(body, cues, translations) };
}

main()
  .then((result) => $done(result))
  .catch((e) => {
    log.error(e?.message ?? e);
    $notification.post(`🍿️ ${SCRIPT_NAME}`, `${CONFIG.vendor} 翻译失败, 已显示原字幕`, String(e?.message ?? e).slice(0, 200));
    $done({});
  });
