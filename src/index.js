/* oil-price Worker：API + 静态页（ASSETS）。
   数据事实唯一来源：qiyoujiage.com 首页 31 省表。未验证数据一律 no_data/pending，不编造。 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=300",
};
const OIL_KEYS = { 92: "p92", 95: "p95", 98: "p98", 0: "d0", "92": "p92", "95": "p95", "98": "p98", "0": "d0" };
const OIL_LABEL = { p92: "92号汽油", p95: "95号汽油", p98: "98号汽油", d0: "0号柴油" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
function text(body, type, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": type, ...CORS } });
}
async function load(env, url, name) {
  const r = await env.ASSETS.fetch(new URL(`/data/${name}`, url));
  if (!r.ok) throw new Error(`missing data ${name}`);
  return r;
}
async function loadJson(env, url, name) {
  return load(env, url, name).then((r) => r.json());
}
async function loadText(env, url, name) {
  return load(env, url, name).then((r) => r.text());
}
function filterPrices(prices, search) {
  let rows = [...(prices.provinces || [])];
  const province = search.get("province");
  if (province) rows = rows.filter((r) => r.province === province || r.province.includes(province));
  const oil = search.get("oil");
  if (oil && OIL_KEYS[oil]) {
    const k = OIL_KEYS[oil];
    rows = rows.map((r) => ({ province: r.province, oil: OIL_LABEL[k], price: r[k], unit: "元/升" }));
  }
  return { ...prices, count: rows.length, provinces: rows };
}
function avg(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === "number");
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
}
function ruleInterpretation(meta, forecast) {
  // 规则生成，非 LLM：一句话解读
  if (meta.adjustment_status?.includes("搁浅")) return "本次调整搁浅：调价金额未达到 50 元/吨门槛，价格维持不变。";
  if (forecast?.status === "estimated" && forecast.direction) {
    return `按 10 工作日原油变化率规则估算，下次可能${forecast.direction}约 ${forecast.estimated_adjustment_yuan_per_ton} 元/吨，正式结果以发改委为准。`;
  }
  return "暂无预测数据：上游公开源未验证通过，不作预测。";
}

// ---- AI 解读：Workers AI（免费额度）+ 数字守门 + 规则兜底 ----
// 原则：AI 只负责把已验证的数字组织成自然语言，不许编新数字。
// 数字守门：AI 文本里出现的每个数字，必须能在 facts 里找到（±0.02 容差）
// 或属于通用白名单（50 元/吨门槛、40/130 地板天花板、10 工作日、油号、日期）。
// 守门失败 / AI 报错 / 配额耗尽 / 无 AI 绑定 -> 回退规则解读，source=rule，绝不返回编造文本。
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
// 注：曾用 @cf/qwen/qwen3-30b-a3b-fp8，线上实测返回空（Qwen3 默认思考模式把 token 耗在思考里，
// max_tokens 300 内出不了正文），改用无思考模式的 Llama 3.1 8B fp8-fast。
const AI_CACHE_TTL = 3600;
function collectAllowedNumbers(facts) {
  const nums = [];
  const walk = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return nums;
}
function aiNumbersPass(text, facts) {
  if (!text || text.length > 600) return false;
  const allowed = collectAllowedNumbers(facts);
  const generic = new Set([0, 10, 40, 50, 92, 95, 98, 130, 1380, 1190, 7.33, 2026, 2025]);
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[0]);
    if (generic.has(n)) continue;
    // 仅当数字紧贴 年/月/日/时 才当作日期放行，避免“30 元/吨”这类编造借日期通道漏网
    const prev = text[m.index - 1] || "";
    const next = text[m.index + m[0].length] || "";
    if (Number.isInteger(n) && ["年", "月", "日", "时"].includes(next)) continue;
    if (Number.isInteger(n) && ["年", "月"].includes(prev)) continue;
    if (!allowed.some((a) => Math.abs(a - n) <= 0.02)) return false;
  }
  return true;
}
function cleanAiText(raw) {
  if (!raw) return "";
  let t = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/[*#`>]/g, "").replace(/\n+/g, " ").trim();
  // 去掉模型可能带的前缀
  t = t.replace(/^(解读[:：]|AI 解读[:：])/, "").trim();
  if (t.length > 400) t = t.slice(0, 400);
  return t;
}
async function aiInterpretation(env, request, facts, ruleText) {
  const base = {
    source: "rule",
    model: null,
    province: facts.province,
    generated_at: new Date().toISOString(),
    data_as_of: { prices_fetched_at: facts.prices_fetched_at, forecast_as_of: facts.forecast_as_of },
    interpretation: ruleText,
    facts_used: facts,
    disclaimer: "AI 解读仅把已验证数据组织成自然语言，不产生新预测；正式结果以国家发改委官方通知为准。",
    fallback_reason: null,
  };
  if (!env.AI?.run) return { ...base, fallback_reason: "no_ai_binding" };
  const system = "你是今日油价站的解读助手。只用用户给定的数字，不编造、不推测任何新数字、不编造日期和油价。输出 2-3 句中文，约 150 字：先说当前省份与全国均价现状，再说下次调价预测（方向、元/吨、每升变动），最后给一句加油建议（可等/可加/影响不大）。不要输出 Markdown、不要列数字表格、不要重复公式。";
  const user = `事实（只许用这些数字）：${JSON.stringify(facts)}。规则解读参考：${ruleText}`;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    const raw = res?.response ?? res?.result?.response ?? res?.choices?.[0]?.message?.content ?? res?.result?.choices?.[0]?.message?.content ?? "";
    const text = cleanAiText(raw);
    if (!text || text.length < 20) return { ...base, fallback_reason: "empty_ai_output" };
    if (!aiNumbersPass(text, facts)) return { ...base, fallback_reason: "number_guard_failed" };
    return { ...base, source: "workers-ai", model: AI_MODEL, interpretation: text, fallback_reason: null };
  } catch (e) {
    return { ...base, fallback_reason: `ai_error:${String(e?.message || e).slice(0, 80)}` };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      if (url.pathname === "/health") {
        return json({ status: "ok", service: "oil-price", time: new Date().toISOString() });
      }
      if (url.pathname === "/api/prices") {
        const prices = await loadJson(env, url, "prices.json");
        const out = filterPrices(prices, url.searchParams);
        out.national_avg = { p92: avg(prices.provinces, "p92"), p95: avg(prices.provinces, "p95"), p98: avg(prices.provinces, "p98"), d0: avg(prices.provinces, "d0") };
        const meta = await loadJson(env, url, "meta.json");
        // adjustment_status 在 prices.json 中，合并后传给解读函数，避免 meta 缺字段导致搁浅被误判为暂无预测
        out.interpretation = ruleInterpretation({ ...meta, adjustment_status: prices.adjustment_status || meta.adjustment_status }, await loadJson(env, url, "forecast.json").catch(() => ({})));
        return json(out);
      }
      if (url.pathname === "/api/meta") return json(await loadJson(env, url, "meta.json"));
      if (url.pathname === "/api/forecast") return json(await loadJson(env, url, "forecast.json"));
      if (url.pathname === "/api/ai-interpretation") {
        // 缓存 1 小时：同一省份 1 小时内只调一次 Workers AI，省免费额度
        const cache = caches.default;
        const cacheKey = new Request(request.url, { method: "GET" });
        const hit = await cache.match(cacheKey).catch(() => null);
        if (hit) {
          const body = await hit.json().catch(() => null);
          if (body) return json({ ...body, cached: true });
        }
        const prices = await loadJson(env, url, "prices.json");
        const meta = await loadJson(env, url, "meta.json");
        const forecast = await loadJson(env, url, "forecast.json").catch(() => ({}));
        const province = url.searchParams.get("province") || "上海";
        const row = prices.provinces.find((r) => r.province === province) || prices.provinces.find((r) => r.province === "上海") || {};
        const nationalAvg = {
          p92: avg(prices.provinces, "p92"), p95: avg(prices.provinces, "p95"),
          p98: avg(prices.provinces, "p98"), d0: avg(prices.provinces, "d0"),
        };
        const facts = {
          province: row.province || province,
          province_prices: { p92: row.p92, p95: row.p95, p98: row.p98, d0: row.d0 },
          national_avg: nationalAvg,
          prices_fetched_at: prices.fetched_at,
          next_adjustment_label: prices.next_adjustment_label || meta.next_adjustment_label,
          adjustment_status: prices.adjustment_status || meta.adjustment_status,
          forecast_status: forecast.status || "no_data",
          forecast_as_of: forecast.as_of || null,
          forecast_direction: forecast.direction || null,
          estimated_adjustment_yuan_per_ton: forecast.estimated_adjustment_yuan_per_ton ?? null,
          estimated_range: forecast.estimated_adjustment_range || null,
          change_rate_pct: forecast.change_rate_pct ?? null,
          delta_per_liter: forecast.delta_per_liter || null,
          brent_avg_recent_10: forecast.brent?.avg_recent_10 ?? null,
          wti_avg_recent_10: forecast.wti?.avg_recent_10 ?? null,
          fx_usd_cny: forecast.fx_usd_cny ?? null,
        };
        const ruleText = ruleInterpretation({ ...meta, adjustment_status: facts.adjustment_status }, forecast);
        const out = await aiInterpretation(env, request, facts, ruleText);
        out.cached = false;
        // 只缓存 AI 成功的结果；规则兜底不缓存，下次请求可重试 AI
        if (out.source === "workers-ai") {
          const toCache = new Response(JSON.stringify(out), {
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${AI_CACHE_TTL}` },
          });
          await cache.put(cacheKey, toCache).catch(() => {});
        }
        return json(out);
      }
      if (url.pathname === "/api/global") return json(await loadJson(env, url, "global.json"));
      if (url.pathname === "/api/cities") {
        const cities = await loadJson(env, url, "cities.json");
        // 新格式：{provinces: {四川: [{city, ...}]}}；旧格式：{cities: [{province, ...}]}，两者兼容
        let list = [];
        if (Array.isArray(cities.cities)) list = cities.cities;
        else if (cities.provinces && typeof cities.provinces === "object") {
          for (const [prov, arr] of Object.entries(cities.provinces)) {
            for (const c of arr || []) list.push({ province: prov, ...c });
          }
        }
        const p = url.searchParams.get("province");
        let provinces = cities.provinces || null;
        if (p) {
          list = list.filter((c) => c.province === p || c.province?.includes(p));
          if (provinces) provinces = { [p]: (provinces[p] || []) };
        }
        return json({ ...cities, provinces, count: list.length, cities: list });
      }
      if (url.pathname === "/api/history") {
        const raw = await loadText(env, url, "history.jsonl");
        const rows = raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
        return json({ history_start: "2026-01-06", count: rows.length, note: "历史从 2026-01-06 开始（20 个调价点，2026-10-15 实测，其余按调价幅度反推）。", snapshots: rows });
      }
      if (url.pathname === "/api/trend") {
        const raw = await loadText(env, url, "history.jsonl");
        const rows = raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
        const province = url.searchParams.get("province") || "";
        const oil = url.searchParams.get("oil") || "95";
        const key = OIL_KEYS[oil] || "p95";
        const series = rows.map((s) => {
          const hit = (s.provinces || []).find((r) => r.province === province);
          return { date: (s.fetched_at || "").slice(0, 10), fetched_at: s.fetched_at, price: hit ? hit[key] : null };
        }).filter((x) => x.price !== null);
        return json({ province, oil: OIL_LABEL[key], history_start: "2026-01-06", count: series.length, series });
      }
      if (url.pathname === "/api/export.csv") {
        const prices = await loadJson(env, url, "prices.json");
        const lines = ["province,92,95,98,0号柴油,unit,fetched_at,source"];
        for (const r of prices.provinces) lines.push([r.province, r.p92, r.p95, r.p98, r.d0, "元/升", prices.fetched_at, prices.source].join(","));
        return text("\uFEFF" + lines.join("\n"), "text/csv; charset=utf-8", 200);
      }
      if (url.pathname === "/rss.xml") {
        const prices = await loadJson(env, url, "prices.json");
        const sh = prices.provinces.find((r) => r.province === "上海") || {};
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>今日油价</title><link>${url.origin}/</link><description>31 省汽油柴油价格，数据来源 qiyoujiage.com，仅供参考。</description><item><title>今日油价更新 ${prices.fetched_at}</title><description>上海 92# ${sh.p92} / 95# ${sh.p95} / 98# ${sh.p98} / 0#柴油 ${sh.d0} 元/升；下次调整 ${prices.next_adjustment_label || ""}</description><pubDate>${new Date(prices.fetched_at).toUTCString()}</pubDate></item></channel></rss>`;
        return text(xml, "application/rss+xml; charset=utf-8");
      }
      if (url.pathname === "/openapi.yaml") {
        const r = await env.ASSETS.fetch(new URL("/openapi.yaml", url));
        if (r.ok) return text(await r.text(), "application/yaml; charset=utf-8");
        return text("not found", "text/plain", 404);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found", path: url.pathname }, 404);
      // 真实多页（History 模式，无 #）：干净 URL -> 对应 HTML 文件
      const PAGES = {
        "/": "/index.html",
        "/trend": "/trend.html",
        "/trend/": "/trend.html",
        "/tools": "/tools.html",
        "/tools/": "/tools.html",
        "/forecast": "/forecast.html",
        "/forecast/": "/forecast.html",
        "/api-docs": "/api-docs.html",
        "/api-docs/": "/api-docs.html",
      };
      if (PAGES[url.pathname]) {
        const r = await env.ASSETS.fetch(new URL(PAGES[url.pathname], url));
        if (r.ok) return new Response(r.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
        return text("not found", "text/plain", 404);
      }
      // 静态资源白名单（CSS/JS/图标/数据/manifest/openapi 等）才走 ASSETS；未知路径 404，不用 SPA fallback
      const STATIC_OK = /^\/(tailwind\.css|shared\.js|sw\.js|manifest\.webmanifest|icon-.*\.png|logo\.png|favicon.*\.(png|ico)|openapi\.yaml|index\.html|trend\.html|tools\.html|forecast\.html|api-docs\.html|data\/.*)$/;
      if (STATIC_OK.test(url.pathname)) {
        const asset = await env.ASSETS.fetch(request);
        return asset;
      }
      return json({ error: "not_found", path: url.pathname }, 404);
    } catch (e) {
      return json({ error: "internal_error", message: String(e?.message || e) }, 500);
    }
  },
};
