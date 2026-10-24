/*
 * 哔哩哔哩去广告 (Surge)
 * 同时处理 JSON 接口与 gRPC 接口的响应
 *
 * gRPC 部分不依赖任何 protobuf 库：按字段编号做最小改动，
 * 未触及的字段保留原始字节，避免因 proto 定义过时而破坏数据。
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULTS = {
	"Splash": true,
	"Feed.AD": true,
	"Feed.Vertical": false,
	"Feed.BlockUpLiveList": "",
	"Story.AD": true,
	"Search.AD": true,
	"Search.HotSearch": true,
	"View.AD": true,
	"Dynamic.AD": true,
	"Dynamic.HotTopics": true,
	"Dynamic.MostVisited": "KEEP",
	"Reply.AD": true,
	"Reply.EditorCommercial": false,
	"DM.Command": false,
	"DM.Colorful": false,
	"PGC.AD": true,
	"Live.AD": true,
	"Mine.Clean": true,
	"Tab.Clean": true,
	"Teenagers": true,
	"LogLevel": "WARN",
};

function parseArgument(raw) {
	const settings = { ...DEFAULTS };
	if (typeof raw === "object" && raw !== null) {
		Object.assign(settings, raw);
	} else if (typeof raw === "string" && raw.length > 0) {
		for (const pair of raw.split("&")) {
			const i = pair.indexOf("=");
			if (i < 0) continue;
			const key = decodeURIComponent(pair.slice(0, i)).trim();
			let value = decodeURIComponent(pair.slice(i + 1)).trim().replace(/^"|"$/g, "");
			// 模块参数未替换时保持默认值
			if (value === "" && typeof DEFAULTS[key] === "boolean") continue;
			if (value.startsWith("{{{")) continue;
			settings[key] = value;
		}
	}
	for (const [key, value] of Object.entries(settings)) {
		if (value === "true") settings[key] = true;
		else if (value === "false") settings[key] = false;
	}
	return settings;
}

const Settings = parseArgument(typeof $argument === "undefined" ? undefined : $argument);

const LEVELS = { OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, ALL: 5 };
const logLevel = LEVELS[String(Settings.LogLevel).toUpperCase()] ?? 2;
const log = {
	error: (...a) => logLevel >= 1 && console.log("❌ " + a.join(" ")),
	warn: (...a) => logLevel >= 2 && console.log("⚠️ " + a.join(" ")),
	info: (...a) => logLevel >= 3 && console.log("ℹ️ " + a.join(" ")),
	debug: (...a) => logLevel >= 4 && console.log("🅱️ " + a.join(" ")),
};

// ---------------------------------------------------------------------------
// gzip / deflate 解压 (RFC 1951 / 1952)
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths) {
	const counts = new Uint16Array(16);
	for (const len of lengths) counts[len]++;
	counts[0] = 0;
	const offsets = new Uint16Array(16);
	for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
	const symbols = new Uint16Array(lengths.length);
	for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offsets[lengths[s]]++] = s;
	return { counts, symbols };
}

let FIXED_LIT, FIXED_DIST;
function fixedTables() {
	if (!FIXED_LIT) {
		const lit = new Uint8Array(288);
		lit.fill(8, 0, 144);
		lit.fill(9, 144, 256);
		lit.fill(7, 256, 280);
		lit.fill(8, 280, 288);
		FIXED_LIT = buildHuffman(lit);
		FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));
	}
	return [FIXED_LIT, FIXED_DIST];
}

function inflateRaw(src) {
	let pos = 0;
	let bitBuf = 0;
	let bitCnt = 0;
	let out = new Uint8Array(Math.max(1024, src.length * 4));
	let outLen = 0;

	const ensure = n => {
		if (outLen + n <= out.length) return;
		const next = new Uint8Array(Math.max(out.length * 2, outLen + n));
		next.set(out.subarray(0, outLen));
		out = next;
	};
	const bits = n => {
		while (bitCnt < n) {
			if (pos >= src.length) throw new Error("inflate: 数据不完整");
			bitBuf |= src[pos++] << bitCnt;
			bitCnt += 8;
		}
		const value = bitBuf & ((1 << n) - 1);
		bitBuf >>>= n;
		bitCnt -= n;
		return value;
	};
	const decode = table => {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len < 16; len++) {
			code |= bits(1);
			const count = table.counts[len];
			if (code - count < first) return table.symbols[index + (code - first)];
			index += count;
			first = (first + count) << 1;
			code <<= 1;
		}
		throw new Error("inflate: 无效的霍夫曼编码");
	};

	let last = 0;
	while (!last) {
		last = bits(1);
		const type = bits(2);
		if (type === 0) {
			bitBuf = 0;
			bitCnt = 0;
			if (pos + 4 > src.length) throw new Error("inflate: 数据不完整");
			const len = src[pos] | (src[pos + 1] << 8);
			pos += 4;
			if (pos + len > src.length) throw new Error("inflate: 数据不完整");
			ensure(len);
			out.set(src.subarray(pos, pos + len), outLen);
			outLen += len;
			pos += len;
			continue;
		}
		let lit;
		let dist;
		if (type === 1) {
			[lit, dist] = fixedTables();
		} else if (type === 2) {
			const hlit = bits(5) + 257;
			const hdist = bits(5) + 1;
			const hclen = bits(4) + 4;
			const clLengths = new Uint8Array(19);
			for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = bits(3);
			const clTable = buildHuffman(clLengths);
			const lengths = new Uint8Array(hlit + hdist);
			for (let i = 0; i < hlit + hdist; ) {
				const sym = decode(clTable);
				if (sym < 16) {
					lengths[i++] = sym;
					continue;
				}
				let repeat;
				let value = 0;
				if (sym === 16) {
					if (i === 0) throw new Error("inflate: 无效的重复长度");
					value = lengths[i - 1];
					repeat = 3 + bits(2);
				} else if (sym === 17) {
					repeat = 3 + bits(3);
				} else {
					repeat = 11 + bits(7);
				}
				if (i + repeat > lengths.length) throw new Error("inflate: 长度表越界");
				lengths.fill(value, i, i + repeat);
				i += repeat;
			}
			lit = buildHuffman(lengths.subarray(0, hlit));
			dist = buildHuffman(lengths.subarray(hlit));
		} else {
			throw new Error("inflate: 无效的块类型");
		}
		for (;;) {
			const sym = decode(lit);
			if (sym < 256) {
				ensure(1);
				out[outLen++] = sym;
			} else if (sym === 256) {
				break;
			} else {
				const li = sym - 257;
				if (li >= 29) throw new Error("inflate: 无效的长度码");
				const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
				const di = decode(dist);
				if (di >= 30) throw new Error("inflate: 无效的距离码");
				const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
				if (distance > outLen) throw new Error("inflate: 距离越界");
				ensure(len);
				for (let k = 0; k < len; k++, outLen++) out[outLen] = out[outLen - distance];
			}
		}
	}
	return out.subarray(0, outLen);
}

function gunzip(src) {
	if (src[0] === 0x1f && src[1] === 0x8b) {
		const flags = src[3];
		let p = 10;
		if (flags & 4) p += 2 + (src[p] | (src[p + 1] << 8));
		if (flags & 8) while (src[p++] !== 0);
		if (flags & 16) while (src[p++] !== 0);
		if (flags & 2) p += 2;
		return inflateRaw(src.subarray(p));
	}
	if ((src[0] & 0x0f) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) return inflateRaw(src.subarray(2));
	return inflateRaw(src);
}

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

function utf8Decode(bytes) {
	if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
	let s = "";
	for (let i = 0; i < bytes.length; ) {
		const b = bytes[i++];
		let cp;
		if (b < 0x80) cp = b;
		else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
		else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
		else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
		s += String.fromCodePoint(cp);
	}
	return s;
}

// ---------------------------------------------------------------------------
// protobuf 线格式 (只解析访问到的路径)
// ---------------------------------------------------------------------------

function readVarint(buf, p) {
	let value = 0;
	let mul = 1;
	let byte;
	do {
		if (p >= buf.length) throw new Error("protobuf: varint 越界");
		byte = buf[p++];
		value += (byte & 0x7f) * mul;
		mul *= 128;
	} while (byte & 0x80);
	return [value, p];
}

function pushVarint(out, value) {
	while (value >= 128) {
		out.push((value % 128) | 128);
		value = Math.floor(value / 128);
	}
	out.push(value);
}

function concat(chunks, total) {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

class Message {
	constructor(bytes = new Uint8Array(0)) {
		this.fields = [];
		let p = 0;
		while (p < bytes.length) {
			const start = p;
			let tag;
			[tag, p] = readVarint(bytes, p);
			const no = Math.floor(tag / 8);
			const wt = tag % 8;
			const field = { no, wt };
			switch (wt) {
				case 0:
					[field.val, p] = readVarint(bytes, p);
					break;
				case 1:
					p += 8;
					break;
				case 2: {
					let len;
					[len, p] = readVarint(bytes, p);
					field.data = bytes.subarray(p, p + len);
					p += len;
					break;
				}
				case 5:
					p += 4;
					break;
				default:
					throw new Error(`protobuf: 不支持的 wire type ${wt}`);
			}
			if (p > bytes.length) throw new Error("protobuf: 字段越界");
			field.raw = bytes.subarray(start, p);
			this.fields.push(field);
		}
	}

	// 字段若不是合法的子消息（如字符串），返回 undefined 而不是抛错
	#sub(field) {
		if (field.wt !== 2 || field.bad) return undefined;
		if (!field.msg) {
			try {
				field.msg = new Message(field.data);
			} catch {
				field.bad = true;
				return undefined;
			}
		}
		return field.msg;
	}

	has(no) {
		return this.fields.some(f => f.no === no);
	}

	msg(no) {
		const field = this.fields.find(f => f.no === no);
		return field ? this.#sub(field) : undefined;
	}

	msgs(no) {
		return this.fields
			.filter(f => f.no === no && f.wt === 2)
			.map(f => this.#sub(f))
			.filter(Boolean);
	}

	uint(no) {
		let value = 0;
		for (const f of this.fields) if (f.no === no && f.wt === 0) value = f.val;
		return value;
	}

	str(no) {
		const field = this.fields.find(f => f.no === no && f.wt === 2);
		return field ? utf8Decode(field.data) : "";
	}

	setUint(no, value) {
		const index = this.fields.findIndex(f => f.no === no);
		this.remove(no);
		if (value === 0) return;
		const field = { no, wt: 0, val: value };
		if (index < 0) this.fields.push(field);
		else this.fields.splice(index, 0, field);
	}

	remove(no) {
		const before = this.fields.length;
		this.fields = this.fields.filter(f => f.no !== no);
		return before - this.fields.length;
	}

	// 只保留满足条件的重复子消息，返回删除数量
	keep(no, predicate) {
		const before = this.fields.length;
		this.fields = this.fields.filter(f => {
			if (f.no !== no || f.wt !== 2) return true;
			const sub = this.#sub(f);
			return !sub || predicate(sub);
		});
		return before - this.fields.length;
	}

	encode() {
		const chunks = [];
		let total = 0;
		for (const f of this.fields) {
			let chunk;
			if (f.msg) {
				const body = f.msg.encode();
				const head = [];
				pushVarint(head, f.no * 8 + 2);
				pushVarint(head, body.length);
				chunks.push(Uint8Array.from(head));
				total += head.length;
				chunk = body;
			} else if (f.raw) {
				chunk = f.raw;
			} else {
				const head = [];
				pushVarint(head, f.no * 8 + f.wt);
				pushVarint(head, f.val);
				chunk = Uint8Array.from(head);
			}
			chunks.push(chunk);
			total += chunk.length;
		}
		return concat(chunks, total);
	}
}

// ---------------------------------------------------------------------------
// gRPC 帧
// ---------------------------------------------------------------------------

function grpcDecode(body) {
	const frames = [];
	let p = 0;
	while (p + 5 <= body.length) {
		const flag = body[p];
		const len = ((body[p + 1] << 24) | (body[p + 2] << 16) | (body[p + 3] << 8) | body[p + 4]) >>> 0;
		p += 5;
		if (p + len > body.length) throw new Error("gRPC: 帧长度越界");
		let data = body.subarray(p, p + len);
		p += len;
		if (flag & 1) data = gunzip(data);
		frames.push(data);
	}
	if (p !== body.length) throw new Error("gRPC: 帧头不完整");
	return frames;
}

// 统一以未压缩形式回写；flag=0 时客户端不会再按 grpc-encoding 解压
function grpcEncode(frames) {
	const chunks = [];
	let total = 0;
	for (const data of frames) {
		const head = new Uint8Array(5);
		head[1] = (data.length >>> 24) & 0xff;
		head[2] = (data.length >>> 16) & 0xff;
		head[3] = (data.length >>> 8) & 0xff;
		head[4] = data.length & 0xff;
		chunks.push(head, data);
		total += 5 + data.length;
	}
	return concat(chunks, total);
}

// ---------------------------------------------------------------------------
// gRPC 处理
// ---------------------------------------------------------------------------

const AD_RELATE_CARD_TYPES = [4, 5, 11]; // GAME, CM, CM_STOCK
const PROMO_MODULE_TYPES = [18, 29, 55]; // 活动横幅, 大会员横幅, UP 主好物
const MODULE_RELATED_RECOMMEND = 28;
const REPLY_CM_TOP_CARD = 3;
const REPLY_EDITOR_COMMERCIAL_BUTTONS = [5, 8];
const COMMERCIAL_URL = /https?:\/\/(?:b23\.tv\/(?:cm|mall)|cm\.bilibili\.com\/ad-showcase-h5\/?#\/goods-select)/i;
const DYNAMIC_AD_CARD = 15;
const DM_VIP_COLORFUL = 60001;

// viewunite.common.RelateCard: 1 relate_card_type, 11 cm_stock, 12 basic_info(6 unique_id)
function isRelateAd(card) {
	if (AD_RELATE_CARD_TYPES.includes(card.uint(1))) return true;
	if (card.has(6) || card.has(5)) return true; // cm / game oneof
	if (card.has(11)) return true;
	const basic = card.msg(12);
	return !!basic && basic.str(6).length > 0;
}

// viewunite.common.Module: 1 type, 22 relates(1 cards)
function cleanModules(holder, fieldNo) {
	let removed = holder.keep(fieldNo, mod => !PROMO_MODULE_TYPES.includes(mod.uint(1)));
	for (const mod of holder.msgs(fieldNo)) {
		if (mod.uint(1) !== MODULE_RELATED_RECOMMEND) continue;
		const relates = mod.msg(22);
		if (relates) removed += relates.keep(1, card => !isRelateAd(card));
	}
	return removed;
}

// main.community.reply.v1.ReplyInfo: 12 content(1 message, 5 url map<string, Url(4 app_url_schema, 13 pc_url)>)
function isCommercialReply(reply) {
	const content = reply?.msg(12);
	if (!content) return false;
	if (COMMERCIAL_URL.test(content.str(1))) return true;
	for (const entry of content.msgs(5)) {
		if (COMMERCIAL_URL.test(entry.str(1))) return true;
		const url = entry.msg(2);
		if (url && (COMMERCIAL_URL.test(url.str(4)) || COMMERCIAL_URL.test(url.str(13)))) return true;
	}
	return false;
}

const GRPC_HANDLERS = {
	// 新版播放器：9 view_info(2 prompt_bar)，10 fragment_video(1 videos(1 fragment_info(3 fragment_type)))
	"bilibili.app.playerunite.v1.Player/PlayViewUnite"(m) {
		if (!Settings["View.AD"]) return 0;
		let n = m.msg(9)?.remove(2) ?? 0;
		const fragments = m.msg(10);
		if (fragments) n += fragments.keep(1, video => video.msg(1)?.uint(3) !== 1);
		return n;
	},
	// 视频详情：7 cm，5 tab(1 tab_module(2 introduction(2 modules)))
	"bilibili.app.viewunite.v1.View/View"(m) {
		if (!Settings["View.AD"]) return 0;
		let n = m.remove(7);
		for (const tabModule of m.msg(5)?.msgs(1) ?? []) {
			const intro = tabModule.msg(2);
			if (intro) n += cleanModules(intro, 2);
		}
		return n;
	},
	// 异步推荐：1 cm，2 tab(1 modules)
	"bilibili.app.viewunite.v1.View/AIRelateAsync"(m) {
		if (!Settings["View.AD"]) return 0;
		let n = m.remove(1);
		const tab = m.msg(2);
		if (tab) n += cleanModules(tab, 1);
		return n;
	},
	"bilibili.app.viewunite.v1.View/RelatesFeed"(m) {
		if (!Settings["View.AD"]) return 0;
		return m.keep(1, card => !isRelateAd(card));
	},
	// 播放中弹出的推广素材：1 video_guide(1 material)
	"bilibili.app.viewunite.v1.View/ViewProgress"(m) {
		if (!Settings["View.AD"]) return 0;
		return m.msg(1)?.remove(1) ?? 0;
	},
	// 暂停广告、播放结束页广告：整条回复置空
	"bilibili.app.viewunite.v1.View/PlayPause": clearReply,
	"bilibili.app.viewunite.v1.View/ViewEndPage": clearReply,
	// 动态综合：1 dynamic_list(1 list(1 card_type))，2 up_list(2 list, 10 list_second(10 live_state))，3 topic_list
	"bilibili.app.dynamic.v2.Dynamic/DynAll"(m) {
		let n = 0;
		if (Settings["Dynamic.HotTopics"]) n += m.remove(3);
		n += cleanUpList(m, 2);
		if (Settings["Dynamic.AD"]) n += m.msg(1)?.keep(1, item => item.uint(1) !== DYNAMIC_AD_CARD) ?? 0;
		return n;
	},
	// 动态视频：1 dynamic_list(1 list)，2 video_up_list
	"bilibili.app.dynamic.v2.Dynamic/DynVideo"(m) {
		let n = cleanUpList(m, 2);
		if (Settings["Dynamic.AD"]) n += m.msg(1)?.keep(1, item => item.uint(1) !== DYNAMIC_AD_CARD) ?? 0;
		return n;
	},
	"bilibili.app.dynamic.v2.Dynamic/DynAllPersonal"(m) {
		return Settings["Dynamic.AD"] ? m.keep(1, item => item.uint(1) !== DYNAMIC_AD_CARD) : 0;
	},
	"bilibili.app.dynamic.v2.Dynamic/DynVideoPersonal"(m) {
		return Settings["Dynamic.AD"] ? m.keep(1, item => item.uint(1) !== DYNAMIC_AD_CARD) : 0;
	},
	// 青少年模式弹窗：1 modes(2 name, 5 f5(1 f1))
	"bilibili.app.interface.v1.Teenagers/ModeStatus"(m) {
		if (!Settings.Teenagers) return 0;
		let n = 0;
		for (const mode of m.msgs(1)) {
			const f5 = mode.msg(5);
			if (mode.str(2) === "teenagers" && f5 && f5.uint(1) !== 0) {
				f5.setUint(1, 0);
				n++;
			}
		}
		return n;
	},
	// 弹幕配置：18 activity_meta，22 commandDms(1 data)
	"bilibili.community.service.dm.v1.DM/DmView"(m) {
		let n = m.remove(18);
		if (Settings["DM.Command"]) for (const group of m.msgs(22)) n += group.remove(1);
		return n;
	},
	// 弹幕列表：1 elems(24 colorful)
	"bilibili.community.service.dm.v1.DM/DmSegMobile"(m) {
		if (!Settings["DM.Colorful"]) return 0;
		let n = 0;
		for (const elem of m.msgs(1)) {
			if (elem.uint(24) === DM_VIP_COLORFUL) {
				elem.setUint(24, 0);
				n++;
			}
		}
		return n;
	},
	// 评论区：4 up_top，5 admin_top，6 vote_top，11 cm，14 top_replies，28 subject_top_cards(1 type)
	"bilibili.main.community.reply.v1.Reply/MainList"(m) {
		if (!Settings["Reply.AD"]) return 0;
		let n = m.remove(11);
		n += m.keep(14, reply => !isCommercialReply(reply));
		for (const no of [4, 5, 6]) if (isCommercialReply(m.msg(no))) n += m.remove(no);
		n += m.keep(28, card => card.uint(1) !== REPLY_CM_TOP_CARD);
		return n;
	},
	// 评论输入框：2 input(7 func_buttons(1 buttons(1 type)))
	"bilibili.main.community.reply.v2.Reply/SubjectDescription"(m) {
		if (!Settings["Reply.EditorCommercial"]) return 0;
		const group = m.msg(2)?.msg(7);
		return group ? group.keep(1, button => !REPLY_EDITOR_COMMERCIAL_BUTTONS.includes(button.uint(1))) : 0;
	},
	// 搜索结果：4 item，card oneof 11 game，25 cm
	"bilibili.polymer.app.search.v1.Search/SearchAll"(m) {
		if (!Settings["Search.AD"]) return 0;
		return m.keep(4, item => !item.has(25) && !item.has(11));
	},
	// 番剧播放：5 view_info(8 try_watch_prompt_bar)，6 play_ext_conf(3 cast_tips)
	"bilibili.pgc.gateway.player.v2.PlayURL/PlayView"(m) {
		if (!Settings["PGC.AD"]) return 0;
		let n = m.msg(5)?.remove(8) ?? 0;
		n += m.msg(6)?.remove(3) ?? 0;
		return n;
	},
};

function clearReply(m) {
	if (!Settings["View.AD"]) return 0;
	const n = m.fields.length;
	m.fields = [];
	return n;
}

// 最常访问：KEEP 保留，LIVE 只保留直播中，REMOVE 整栏去除
function cleanUpList(m, fieldNo) {
	const mode = String(Settings["Dynamic.MostVisited"]).toUpperCase();
	if (mode === "REMOVE") return m.remove(fieldNo);
	if (mode !== "LIVE") return 0;
	const upList = m.msg(fieldNo);
	if (!upList) return 0;
	return upList.keep(2, up => up.uint(10) === 1) + upList.keep(10, up => up.uint(10) === 1);
}

// 功能全部关闭的接口直接放行，免去解压和解析
const GRPC_ENABLED = {
	"bilibili.community.service.dm.v1.DM/DmSegMobile": () => Settings["DM.Colorful"],
	"bilibili.main.community.reply.v2.Reply/SubjectDescription": () => Settings["Reply.EditorCommercial"],
	"bilibili.main.community.reply.v1.Reply/MainList": () => Settings["Reply.AD"],
	"bilibili.polymer.app.search.v1.Search/SearchAll": () => Settings["Search.AD"],
	"bilibili.app.interface.v1.Teenagers/ModeStatus": () => Settings.Teenagers,
	"bilibili.pgc.gateway.player.v2.PlayURL/PlayView": () => Settings["PGC.AD"],
};

function handleGrpc(path) {
	const key = path.replace(/^\//, "");
	const handler = GRPC_HANDLERS[key];
	if (!handler) return undefined;
	if (GRPC_ENABLED[key] && !GRPC_ENABLED[key]()) return undefined;
	if (key.startsWith("bilibili.app.viewunite.") || key.startsWith("bilibili.app.playerunite.")) {
		if (!Settings["View.AD"]) return undefined;
	}
	const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body ?? []);
	if (raw.length === 0) return undefined;
	const frames = grpcDecode(raw);
	let changed = 0;
	const output = frames.map(data => {
		const message = new Message(data);
		const n = handler(message);
		changed += n;
		return n ? message.encode() : data;
	});
	if (!changed) return undefined;
	log.info(`${key}: 去除 ${changed} 项`);
	const result = { body: grpcEncode(output) };
	const headers = fixGrpcHeaders($response.headers);
	if (headers) result.headers = headers;
	return result;
}

// 粉版客户端带 x-bili-moss-engine-type: 1 时要求响应头有 grpc-status
function fixGrpcHeaders(headers) {
	const req = $request.headers ?? {};
	const moss = req["x-bili-moss-engine-type"] ?? req["X-Bili-Moss-Engine-Type"];
	if (moss !== "1") return undefined;
	const lower = Object.keys(headers ?? {}).map(k => k.toLowerCase());
	if (lower.includes("grpc-status")) return undefined;
	return { ...headers, "grpc-status": "0" };
}

// ---------------------------------------------------------------------------
// JSON 处理
// ---------------------------------------------------------------------------

const STORY_AD_GOTOS = ["vertical_ad_av", "vertical_ad_picture", "vertical_ad_live", "vertical_pgc"];

// ad_info.is_ad_loc 只是广告位，填的可能是普通内容；有 creative_id 才是真正的广告
function isFeedAd(item) {
	if (!item || typeof item !== "object") return false;
	const cardType = typeof item.card_type === "string" ? item.card_type : "";
	const cardGoto = typeof item.card_goto === "string" ? item.card_goto : "";
	if (cardType.startsWith("cm_") || cardGoto.startsWith("ad_") || item.goto === "ad" || item.is_ad === true) return true;
	return !!item.ad_info?.creative_id;
}

function cleanFeed(data) {
	if (!Array.isArray(data?.items)) return 0;
	const blockUps = String(Settings["Feed.BlockUpLiveList"] ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	const before = data.items.length;
	data.items = data.items.filter(item => {
		if (!item || typeof item !== "object") return false;
		if (item.card_goto === "banner" && Array.isArray(item.banner_item)) {
			item.banner_item = item.banner_item.filter(b => b.type !== "ad" && b.type !== "ad_inline" && !b.ad_banner);
			return item.banner_item.length > 0;
		}
		if (isFeedAd(item)) return false;
		if (item.card_type === "small_cover_v10" && item.card_goto === "game") return false;
		if (Settings["Feed.Vertical"] && item.goto === "vertical_av") return false;
		if (blockUps.length && item.card_goto === "live" && blockUps.includes(String(item.args?.up_id))) return false;
		return true;
	});
	return before - data.items.length;
}

function cleanStory(data) {
	if (!Array.isArray(data?.items)) return 0;
	const before = data.items.length;
	data.items = data.items.filter(item => !isFeedAd(item) && !STORY_AD_GOTOS.includes(item?.card_goto));
	let n = before - data.items.length;
	// “助TA必火”等商业按钮
	for (const item of data.items) {
		if (!Array.isArray(item.share_bottom_button)) continue;
		const len = item.share_bottom_button.length;
		item.share_bottom_button = item.share_bottom_button.filter(button => {
			if (button?.type !== 20 || !Array.isArray(button.button_metas)) return true;
			return !button.button_metas.some(meta => meta?.text === "助TA必火" || /cm\.bilibili\.com\/fly-h5/.test(meta?.link ?? ""));
		});
		n += len - item.share_bottom_button.length;
	}
	return n;
}

const MINE_PROMO = [/^https?:\/\/cm\.bilibili\.com\//, /\/blackboard\/(?:era|tab)\//, /^bilibili:\/\/game_center\//, /^https?:\/\/mall\.bilibili\.com\/neul-next\//];

function cleanMine(data) {
	let n = 0;
	for (const key of ["sections_v2", "ipad_sections", "ipad_upper_sections", "ipad_recommend_sections", "ipad_more_sections"]) {
		const sections = data?.[key];
		if (!Array.isArray(sections)) continue;
		for (const section of sections) {
			if (!Array.isArray(section?.items)) continue;
			const len = section.items.length;
			section.items = section.items.filter(item => !MINE_PROMO.some(re => re.test(item?.uri ?? "")));
			n += len - section.items.length;
		}
		data[key] = sections.filter(section => !Array.isArray(section?.items) || section.items.length > 0);
	}
	return n;
}

function cleanTab(data) {
	let n = 0;
	const drop = (key, predicate) => {
		if (!Array.isArray(data?.[key])) return;
		const len = data[key].length;
		data[key] = data[key].filter(item => !predicate(item));
		n += len - data[key].length;
	};
	drop("tab", item => /^bilibili:\/\/following\/home_activity_tab/.test(item?.uri ?? ""));
	drop("top", item => /^bilibili:\/\/game_center/.test(item?.uri ?? ""));
	drop("bottom", item => /^bilibili:\/\/mall\//.test(item?.uri ?? ""));
	return n;
}

function isLiveCardAd(card) {
	if (!card || typeof card !== "object") return false;
	const flag = v => v === true || v === 1 || v === "1";
	const t = card.ad_transparent_content;
	const transparent = typeof t === "string" ? t.trim().length > 0 : t && typeof t === "object" ? Object.keys(t).length > 0 : !!t;
	return flag(card.is_ad) || flag(card.show_ad_icon) || transparent;
}

function handleJson(host, path) {
	let body;
	try {
		body = JSON.parse($response.body ?? "");
	} catch {
		return undefined;
	}
	const data = body?.data;
	let n = 0;
	switch (path) {
		case "/x/v2/splash/list":
		case "/x/v2/splash/show":
		case "/x/v2/splash/brand/list":
		case "/x/v2/splash/event/list2":
			if (!Settings.Splash || !data || typeof data !== "object") break;
			for (const key of ["show", "event_list", "preload"]) {
				if (Array.isArray(data[key]) && data[key].length) {
					n += data[key].length;
					data[key] = [];
				}
			}
			// 广告素材列表只在 splash/list 里；品牌开屏 (brand/list) 是用户可选的官方开屏，保留
			if (path === "/x/v2/splash/list" && Array.isArray(data.list)) {
				n += data.list.length;
				data.list = [];
				data.keep_ids = [];
			}
			break;
		case "/x/v2/feed/index":
			if (Settings["Feed.AD"]) n += cleanFeed(data);
			break;
		case "/x/v2/feed/index/story":
		case "/x/v2/feed/index/relate/story":
			if (Settings["Story.AD"]) n += cleanStory(data);
			break;
		case "/x/v2/feed/index/story/cart":
			if (Settings["Story.AD"] && data?.anchor) {
				delete data.anchor;
				n++;
			}
			break;
		case "/x/v2/search/square":
			if (Settings["Search.HotSearch"] && Array.isArray(data)) {
				const len = data.length;
				body.data = data.filter(item => item?.type !== "trending");
				n += len - body.data.length;
			}
			break;
		case "/x/v2/account/mine":
			if (Settings["Mine.Clean"]) n += cleanMine(data);
			break;
		case "/x/resource/show/tab/v2":
			if (Settings["Tab.Clean"]) n += cleanTab(data);
			break;
		case "/x/vip/ads/materials":
			if (Settings["View.AD"]) {
				body = { code: -404, message: "-404", ttl: 1, data: null };
				n++;
			}
			break;
		case "/x/web-interface/wbi/index/top/feed/rcmd":
			if (Settings["Feed.AD"] && Array.isArray(data?.item)) {
				const len = data.item.length;
				data.item = data.item.filter(i => i?.goto !== "ad");
				n += len - data.item.length;
			}
			break;
		case "/pgc/page/bangumi":
		case "/pgc/page/cinema/tab":
			if (!Settings["PGC.AD"] || !Array.isArray(body?.result?.modules)) break;
			for (const mod of body.result.modules) {
				if (!Array.isArray(mod?.items)) continue;
				const len = mod.items.length;
				const style = String(mod.style ?? "");
				if (style.startsWith("banner")) mod.items = mod.items.filter(i => String(i?.link ?? "").includes("play"));
				else if (style.startsWith("function")) mod.items = mod.items.filter(i => String(i?.blink ?? "").startsWith("bilibili"));
				else if ([241, 1283, 1284, 1441].includes(mod.module_id) || style.startsWith("tip")) mod.items = [];
				n += len - mod.items.length;
			}
			break;
		case "/xlive/app-interface/v2/index/feed":
			if (Settings["Live.AD"] && Array.isArray(data?.card_list)) {
				const len = data.card_list.length;
				data.card_list = data.card_list.filter(item => !isLiveCardAd(item?.card_data?.small_card_v1));
				n += len - data.card_list.length;
			}
			break;
		case "/xlive/app-interface/v2/room/recList":
			if (Settings["Live.AD"] && Array.isArray(data?.list)) {
				const len = data.list.length;
				data.list = data.list.filter(item => !isLiveCardAd(item));
				n += len - data.list.length;
			}
			break;
		case "/xlive/app-room/v1/index/getInfoByRoom":
			if (!Settings["Live.AD"] || !data) break;
			if (data.activity_banner_info) {
				delete data.activity_banner_info;
				n++;
			}
			if (data.shopping_info) {
				data.shopping_info = { is_show: 0 };
				n++;
			}
			if (Array.isArray(data.new_tab_info?.outer_list)) {
				const len = data.new_tab_info.outer_list.length;
				data.new_tab_info.outer_list = data.new_tab_info.outer_list.filter(i => i?.biz_id !== 33);
				n += len - data.new_tab_info.outer_list.length;
			}
			break;
		default:
			return undefined;
	}
	if (!n) return undefined;
	log.info(`${host}${path}: 去除 ${n} 项`);
	return { body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
	const match = /^https?:\/\/([^\/?#]+)([^?#]*)/.exec($request.url);
	if (!match) return {};
	const host = match[1].split(":")[0];
	const path = match[2] || "/";
	const contentType = String($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"] ?? "").split(";")[0].trim();
	if (contentType.startsWith("application/grpc")) return handleGrpc(path) ?? {};
	return handleJson(host, path) ?? {};
}

if (typeof $done === "function") {
	let result = {};
	try {
		result = main();
	} catch (e) {
		log.error(`${$request.url.split("?")[0]}: ${e?.message ?? e}`);
		result = {};
	}
	$done(result);
}

if (typeof module !== "undefined") module.exports = { Message, gunzip, grpcDecode, grpcEncode, GRPC_HANDLERS, parseArgument, isFeedAd };
