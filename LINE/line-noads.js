// LINE 去广告 · 广告拉取接口短路脚本 (Surge http-request script)
// 作用: 拦截 legy-*/ext/lgfp/lad/v1|v2 与 a.line.me/lgfp/lad/v1|v2, 直接返回"结构完整的空广告",
//       命中客户端已验证的优雅降级分支(ladsdk: ads/invs 为空 -> list.isEmpty() -> 静默不展示)。
// 关键: 对 NEWS WebView 的 CORS 预检(OPTIONS)与 POST 均回显 CORS 头, 否则浏览器预检失败,
//       "空广告"会退化为网络错误(等效 REJECT)。CORS 契约取自真实抓包 har i186/i239:
//       Access-Control-Allow-Origin=<回显 Origin>, Access-Control-Allow-Credentials=true。

const req = $request;
const url = req.url;
const headers = req.headers || {};
// 大小写不敏感地取请求头
function h(name) {
  const k = Object.keys(headers).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}
const origin = h("Origin");            // NEWS WebView 会带; 原生 LEGY 请求无此头
const acrh   = h("Access-Control-Request-Headers") || "x-line-channeltoken, content-type";
const method = (req.method || "GET").toUpperCase();

// 仅当存在 Origin(即 WebView 跨域)时才需要 CORS 头; 用请求 Origin 回显(credentials=true 不能用 *)
const cors = origin ? {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Credentials": "true",
} : {};

// 1) CORS 预检: 直接放行预检本身(否则 POST 根本不会发出)
if (method === "OPTIONS") {
  $done({
    response: {
      status: 204,
      headers: Object.assign({}, cors, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": acrh,
        "Access-Control-Max-Age": "600",
      }),
      body: "",
    },
  });
} else {
  // 2) 实际拉取: 合成空广告响应
  let body;
  if (/\/lad\/v2(\?|$|\/)/.test(url)) {
    // v2 (Android kotlinx LyadResponse{rid,t,lang,invs[]}; invs 为 optional, 空数组即无广告)
    body = JSON.stringify({ rid: "", t: 0, lang: null, invs: [] });
  } else {
    // v1 (iOS/HAR: 顶层 ads[]; 保留外壳字段, ads 置空)
    body = JSON.stringify({ deployVersion: "", rid: "", t: 0, lang: "en", ads: [], cf: {}, abtoffsets: null });
  }
  $done({
    response: {
      status: 200,
      headers: Object.assign({}, cors, { "Content-Type": "application/json" }),
      body: body,
    },
  });
}
