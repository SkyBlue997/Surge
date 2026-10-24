/*
 * 哔哩哔哩视频 CDN 自定义 + 自动测速 (Surge)
 * 把视频分片请求 (/upgcxcode/) 改写到指定或测速选出的 CDN 主机
 *
 * 处理三种来源：
 *   1. 官方 UPOS 主机：upos-*.bilivideo.com、upos-*-mirrorakam.akamaized.net、cn-*.bilivideo.com
 *   2. App 通过 HTTPDNS 直连 IP，URL 主机是 IP，真实主机在 Host 头里
 *   3. PCDN / MCDN：*.mcdn.bilivideo.cn、*.szbdyd.com、IP:4480 等
 * 只替换主机，路径和签名参数原样保留（upsig 不包含主机名）
 *
 * 同一个文件按 argument 里的 Mode 在四种场景下运行：
 *   request  (默认) 改写分片请求；CDN.UPOS=AUTO 且没有可用测速结果时，用当前分片做一次竞速
 *   response 被改写的请求返回错误时，标记该节点失败，并 302 回原地址
 *   panel    面板：显示测速结果，点按刷新时完整测速
 *   event    网络切换后，用最近一次的视频链接在后台完整测速
 *   cron     定时检查：最近看过视频且结果过期时，在后台完整测速
 */

const KEY_SAMPLE = "BiliBili.CDN.Sample";
const KEY_RESULTS = "BiliBili.CDN.Results";
const KEY_LOCK = "BiliBili.CDN.Lock";
const PROBE_HEADER = "X-BiliCDN-Probe"; // 测速请求自身不再被改写
const FROM_HEADER = "X-BiliCDN-From"; // 记录改写前的主机，供失败回退
const SKIP_PARAM = "bilicdn=0"; // 回退后的请求不再改写

const DEFAULT_CANDIDATES = [
	"upos-sz-mirrorcosov.bilivideo.com",
	"upos-sz-mirroraliov.bilivideo.com",
	"upos-sz-mirrorhwov.bilivideo.com",
	"cn-hk-eq-01-01.bilivideo.com",
	"cn-hk-eq-01-09.bilivideo.com",
	"cn-hk-eq-01-12.bilivideo.com",
	"cn-hk-eq-01-14.bilivideo.com",
	"upos-sz-mirrorali.bilivideo.com",
	"upos-sz-mirrorcos.bilivideo.com",
	"upos-sz-mirrorhw.bilivideo.com",
];

const RACE_TIMEOUT = 3000; // 内联竞速最多拖慢当前分片的时间 (ms)
const PROBE_TIMEOUT = 6000; // 完整测速时单个节点的超时 (ms)
const FAIL_TTL = 5 * 60e3; // 竞速全部失败后，多久内不再重试
const WARMUP_SIZE = 16 * 1024; // 完整测速前先预热连接，减少握手对速度的影响
const LOCK_TTL = 15e3; // 测速锁，防止并发分片同时测速
const MAX_NETWORKS = 10;

function parseArgument(raw) {
	const out = {};
	if (typeof raw === "object" && raw !== null) return { ...raw };
	for (const pair of String(raw ?? "").split("&")) {
		const i = pair.indexOf("=");
		if (i < 0) continue;
		const value = decodeURIComponent(pair.slice(i + 1)).trim().replace(/^"|"$/g, "");
		if (value.startsWith("{{{")) continue;
		out[decodeURIComponent(pair.slice(0, i)).trim()] = value;
	}
	return out;
}

const Settings = parseArgument(typeof $argument === "undefined" ? "" : $argument);
const verbose = /^(INFO|DEBUG|ALL)$/i.test(Settings.LogLevel ?? "");
const info = msg => verbose && console.log(msg);

const isOff = value => !value || /^(off|none|false|0|-)$/i.test(value);
const isAuto = value => /^auto$/i.test(value ?? "");
const isIP = host => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
const UPOS_HOST = /^(?:upos-[\w-]+\.bilivideo\.com|upos-[\w-]+\.akamaized\.net|cn-[\w-]+\.bilivideo\.com)$/i;
const normalizeHost = h =>
	String(h ?? "")
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "");

const TEST_SIZE = Math.min(Math.max(parseInt(Settings["CDN.TestSize"], 10) || 512, 64), 4096) * 1024;
const TTL = Math.max(parseInt(Settings["CDN.TTL"], 10) || 60, 5) * 60e3;

function header(headers, name) {
	const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === name.toLowerCase());
	return key ? headers[key] : undefined;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function load(key, fallback) {
	try {
		return JSON.parse($persistentStore.read(key) ?? "null") ?? fallback;
	} catch {
		return fallback;
	}
}

function save(key, value) {
	$persistentStore.write(JSON.stringify(value), key);
}

// 测速结果按网络分别保存：家里 Wi-Fi、公司 Wi-Fi、蜂窝的最优节点往往不同
function networkKey() {
	const n = typeof $network === "object" && $network ? $network : {};
	if (n.wifi?.ssid) return `Wi-Fi ${n.wifi.ssid}`;
	const cell = n["cellular-data"];
	if (cell && (cell.carrier || cell.radio)) return `蜂窝 ${cell.carrier ?? ""}`.trim();
	return `网络 ${n.v4?.primaryInterface ?? "未知"}`;
}

function loadEntry(net = networkKey()) {
	return load(KEY_RESULTS, {})[net];
}

function saveEntry(entry, net = networkKey()) {
	const all = load(KEY_RESULTS, {});
	all[net] = entry;
	const keys = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
	for (const k of keys.slice(MAX_NETWORKS)) delete all[k];
	save(KEY_RESULTS, all);
}

function tryLock() {
	const now = Date.now();
	if (now - Number($persistentStore.read(KEY_LOCK) || 0) < LOCK_TTL) return false;
	$persistentStore.write(String(now), KEY_LOCK);
	return true;
}

const unlock = () => $persistentStore.write("0", KEY_LOCK);

// 最近一次的视频链接 (路径 + 签名参数)，供后台测速复用；deadline 过期后签名失效
function saveSample(sample) {
	const prev = load(KEY_SAMPLE, null);
	const now = Date.now();
	if (prev && now - prev.savedAt < 5 * 60e3 && prev.deadline - now > 30 * 60e3) return;
	save(KEY_SAMPLE, { ...sample, savedAt: now });
}

const sampleUsable = s => !!s && s.deadline - Date.now() > 60e3;

// ---------------------------------------------------------------------------
// 测速
// ---------------------------------------------------------------------------

function candidates(origin, failed = {}) {
	const custom = String(Settings["CDN.Candidates"] ?? "")
		.split(/[\s,|;]+/)
		.map(normalizeHost)
		.filter(Boolean);
	const list = custom.length ? custom : [...DEFAULT_CANDIDATES];
	// 原主机也参与比较；Akamai 的签名与其他节点不通用，不能作为目标
	if (origin && /\.bilivideo\.com$/.test(origin)) list.unshift(origin);
	const now = Date.now();
	return [...new Set(list)].filter(h => !/\.akamaized\.net$/.test(h) && !(now - (failed[h] ?? 0) < TTL));
}

function probe(host, sample, timeout, size = TEST_SIZE) {
	return new Promise(resolve => {
		const start = Date.now();
		const headers = { Range: `bytes=0-${size - 1}`, "User-Agent": sample.ua || "Bilibili Freedoooooom/MarkII", [PROBE_HEADER]: "1" };
		if (sample.referer) headers.Referer = sample.referer;
		const request = { url: `https://${host}${sample.path}${sample.query}`, headers, timeout: timeout / 1000, "binary-mode": true };
		$httpClient.get(request, (error, response, data) => {
			const ms = Date.now() - start;
			const status = response?.status ?? response?.statusCode ?? 0;
			const bytes = data?.byteLength ?? data?.length ?? 0;
			// 只认 206：忽略 Range 的节点会返回整个文件
			const ok = !error && status === 206 && bytes > 0;
			resolve({ host, ok, status, ms, speed: ok ? Math.round((bytes / Math.max(ms, 1)) * 1000) : 0, error: error ? String(error).slice(0, 60) : undefined });
		});
	});
}

// 所有候选同时下载同一段，最先下完的胜出；只等胜者，不等其余节点
function race(sample, hosts) {
	return new Promise(resolve => {
		let pending = hosts.length;
		let finished = false;
		const finish = result => {
			if (finished) return;
			finished = true;
			resolve(result);
		};
		if (!pending) return finish(null);
		setTimeout(() => finish(null), RACE_TIMEOUT);
		for (const host of hosts) {
			probe(host, sample, RACE_TIMEOUT).then(r => {
				if (r.ok) finish(r);
				else if (--pending === 0) finish(null);
			});
		}
	});
}

// 逐个下载，避免互相抢带宽：先用小请求建立连接并记录延迟，再测下载速度
async function measure(host, sample) {
	const warm = await probe(host, sample, PROBE_TIMEOUT, WARMUP_SIZE);
	if (!warm.ok) return warm;
	const result = await probe(host, sample, PROBE_TIMEOUT);
	return { ...result, latency: warm.ms };
}

async function fullTest(sample, hosts) {
	const list = [];
	for (const host of hosts) list.push(await measure(host, sample));
	list.sort((a, b) => b.speed - a.speed || a.ms - b.ms);
	return list;
}

// 失败节点按各自的时间戳过期，与测速结果本身的有效期无关
function recentFailed(entry) {
	const now = Date.now();
	return Object.fromEntries(Object.entries(entry?.failed ?? {}).filter(([, at]) => now - at < TTL));
}

async function runFullTest(sample) {
	const net = networkKey();
	const failed = recentFailed(loadEntry(net));
	const list = await fullTest(sample, candidates(sample.origin, failed));
	const best = list.find(r => r.ok)?.host ?? null;
	const entry = { best, at: Date.now(), mode: "full", list, failed };
	saveEntry(entry, net);
	info(`📶 ${net} 完整测速 → ${best ?? "全部失败"}`);
	return entry;
}

async function autoTarget(sample) {
	saveSample(sample);
	const net = networkKey();
	const entry = loadEntry(net);
	const now = Date.now();
	if (entry && now - entry.at < (entry.best ? TTL : FAIL_TTL)) return entry.best;
	// 过期但仍可用的结果先继续用，由 cron / 网络切换在后台刷新；太久没刷新才在这里竞速
	if (entry?.best && now - entry.at < 6 * TTL) return entry.best;
	if (!tryLock()) return entry?.best ?? null; // 其他分片正在测速，先沿用旧结果
	try {
		const failed = recentFailed(entry);
		const winner = await race(sample, candidates(sample.origin, failed));
		saveEntry({ best: winner?.host ?? null, at: Date.now(), mode: "quick", list: winner ? [winner] : [], failed }, net);
		info(`⚡️ ${net} 竞速 → ${winner ? `${winner.host} ${winner.ms}ms` : "全部失败，保持原地址"}`);
		return winner?.host ?? null;
	} finally {
		unlock();
	}
}

// ---------------------------------------------------------------------------
// request：改写分片请求
// ---------------------------------------------------------------------------

function parseUrl(url) {
	const m = /^(https?):\/\/(\[[^\]]+\]|[^\/:?#]+)(?::(\d+))?(\/[^?#]*)(\?[^#]*)?/i.exec(url);
	return m ? { host: m[2].toLowerCase(), path: m[4], query: m[5] ?? "" } : undefined;
}

async function onRequest(request) {
	if (header(request.headers, PROBE_HEADER)) return undefined;
	const url = parseUrl(request.url);
	if (!url || !url.path.startsWith("/upgcxcode/")) return undefined;
	if (url.query.includes(SKIP_PARAM)) return undefined;

	// HTTPDNS 直连时以 Host 头为准
	const hostHeader = String(header(request.headers, "host") ?? header(request.headers, ":authority") ?? "").split(":")[0];
	const origin = (isIP(url.host) && hostHeader ? hostHeader : url.host).toLowerCase();
	const deadline = Number(/[?&]deadline=(\d+)/.exec(url.query)?.[1]) * 1000 || Date.now() + 3600e3;
	const sample = { origin, path: url.path, query: url.query, deadline, ua: header(request.headers, "user-agent"), referer: header(request.headers, "referer") };
	const upos = Settings["CDN.UPOS"];
	const pcdn = Settings["CDN.PCDN"];
	const resolveUpos = async () => (isAuto(upos) ? await autoTarget(sample) : isOff(upos) ? null : upos);

	let target;
	if (UPOS_HOST.test(origin)) {
		target = await resolveUpos();
	} else {
		if (isOff(pcdn)) return undefined;
		if (/^upos$/i.test(pcdn)) {
			// 回源到官方 UPOS：优先用自定义 / 测速结果，其次用 PCDN 链接自带的源站
			const source = /[?&]xy_usource=([^&]+)/.exec(url.query)?.[1];
			target = (await resolveUpos()) ?? (source ? decodeURIComponent(source) : "upos-sz-mirrorcos.bilivideo.com");
		} else {
			target = pcdn;
		}
	}
	target = normalizeHost(target);
	if (!target || target === origin) return undefined;

	const headers = { ...request.headers };
	for (const key of Object.keys(headers)) {
		const lower = key.toLowerCase();
		if (lower === "host" || lower === ":authority") delete headers[key];
	}
	headers.Host = target.split(":")[0];
	if (UPOS_HOST.test(origin)) headers[FROM_HEADER] = origin;
	info(`🔀 ${origin} → ${target}`);
	return { url: `https://${target}${url.path}${url.query}`, headers };
}

// ---------------------------------------------------------------------------
// response：失败回退
// ---------------------------------------------------------------------------

function onResponse(request, response) {
	const from = header(request.headers, FROM_HEADER);
	const status = response?.status ?? 0;
	if (!from || status < 400 || status === 416) return undefined;
	const url = parseUrl(request.url);
	if (!url) return undefined;
	const net = networkKey();
	const entry = loadEntry(net) ?? { best: null, list: [] };
	entry.failed = { ...(entry.failed ?? {}), [url.host]: Date.now() };
	if (entry.best === url.host) {
		entry.best = null;
		entry.at = 0; // 下一个分片重新竞速，并排除失败节点
	}
	saveEntry(entry, net);
	console.log(`⚠️ CDN ${url.host} 返回 ${status}，回退到 ${from}`);
	const location = `https://${from}${url.path}${url.query}${url.query ? "&" : "?"}${SKIP_PARAM}`;
	return { status: 302, headers: { ...response.headers, Location: location } };
}

// ---------------------------------------------------------------------------
// panel / event
// ---------------------------------------------------------------------------

const shortHost = h => String(h).replace(/\.bilivideo\.com$/, "");

function formatSpeed(bps) {
	if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
	return `${Math.round(bps / 1024)} KB/s`;
}

function formatAge(ms) {
	const m = Math.round(ms / 60e3);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m} 分钟前`;
	return `${Math.round(m / 60)} 小时前`;
}

function renderPanel(entry, note) {
	const net = networkKey();
	const upos = Settings["CDN.UPOS"];
	const mode = isAuto(upos) ? "自动" : isOff(upos) ? "未启用" : `固定 ${shortHost(normalizeHost(upos))}`;
	const lines = [];
	if (entry?.list?.length) {
		const ok = entry.list.filter(r => r.ok);
		ok.slice(0, 4).forEach((r, i) => lines.push(`${i + 1}. ${shortHost(r.host)}  ${entry.mode === "full" ? `${formatSpeed(r.speed)} · ${r.latency ?? r.ms}ms` : `${r.ms}ms`}`));
		const bad = entry.list.filter(r => !r.ok).map(r => `${shortHost(r.host)}(${r.status || "超时"})`);
		if (bad.length) lines.push(`失败：${bad.join(" ")}`);
		lines.push(`${net} · ${entry.mode === "full" ? "完整测速" : "竞速"} · ${formatAge(Date.now() - entry.at)}`);
	} else {
		lines.push(`${net} · 暂无测速结果`);
	}
	if (note) lines.push(note);
	return {
		title: `B站 CDN · ${mode}${entry?.best ? ` · ${shortHost(entry.best)}` : ""}`,
		content: lines.join("\n"),
		icon: "speedometer",
		"icon-color": "#FB7299",
	};
}

async function onPanel() {
	const sample = load(KEY_SAMPLE, null);
	let entry = loadEntry();
	const tapped = typeof $trigger !== "undefined" && $trigger === "button";
	const stale = !entry || entry.mode !== "full" || Date.now() - entry.at > TTL;
	if (!tapped && !stale) return renderPanel(entry);
	if (!sampleUsable(sample)) return renderPanel(entry, "先播放任意视频，再点按刷新测速");
	if (!tryLock()) return renderPanel(entry, "正在测速，稍后刷新");
	try {
		entry = await runFullTest(sample);
	} finally {
		unlock();
	}
	return renderPanel(entry);
}

// 网络切换与定时任务共用：只有最近看过视频 (签名未过期) 且结果过期时才测速，平时不耗流量
async function refreshInBackground(delay) {
	if (!isAuto(Settings["CDN.UPOS"])) return;
	if (delay) await new Promise(r => setTimeout(r, delay)); // 等新网络稳定
	const sample = load(KEY_SAMPLE, null);
	const entry = loadEntry();
	if (!sampleUsable(sample)) return;
	if (entry?.mode === "full" && Date.now() - entry.at < TTL) return;
	if (!tryLock()) return;
	try {
		await runFullTest(sample);
	} finally {
		unlock();
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
	switch (String(Settings.Mode ?? "request").toLowerCase()) {
		case "response":
			return onResponse($request, $response);
		case "panel":
			return onPanel();
		case "event":
			return refreshInBackground(3000);
		case "cron":
			return refreshInBackground(0);
		default:
			return onRequest($request);
	}
}

if (typeof $done === "function") {
	main()
		.catch(e => {
			console.log(`❌ CDN: ${e?.message ?? e}`);
			return undefined;
		})
		.then(result => $done(result ?? {}));
}

if (typeof module !== "undefined") module.exports = { parseArgument, candidates, normalizeHost };
