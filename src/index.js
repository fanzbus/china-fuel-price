/* china-fuel-price Worker：API + 静态页（ASSETS）。
   数据事实唯一来源：qiyoujiage.com 首页 31 省表。未验证数据一律 no_data/pending，不编造。 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=300",
};
const FUEL_KEYS = { 92: "p92", 95: "p95", 98: "p98", 0: "d0", "92": "p92", "95": "p95", "98": "p98", "0": "d0" };
const FUEL_LABEL = { p92: "92号汽油", p95: "95号汽油", p98: "98号汽油", d0: "0号柴油" };

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
  const fuel = search.get("fuel");
  if (fuel && FUEL_KEYS[fuel]) {
    const k = FUEL_KEYS[fuel];
    rows = rows.map((r) => ({ province: r.province, fuel: FUEL_LABEL[k], price: r[k], unit: "元/升" }));
  }
  return { ...prices, count: rows.length, provinces: rows };
}
function avg(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === "number");
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
}
function ruleInterpretation(meta, forecast) {
  // 规则生成，非 LLM：一句话解读
  if (meta.adjustment_status?.includes("搁浅")) return "本次调整搁浅：调价金额未达到 50 元/吨门槛，价格维持不变（规则生成）。";
  if (forecast?.status === "estimated" && forecast.direction) {
    return `按 10 工作日原油变化率规则估算，下次可能${forecast.direction}约 ${forecast.estimated_adjustment_yuan_per_ton} 元/吨，正式结果以发改委为准（规则生成）。`;
  }
  return "暂无预测数据：上游公开源未验证通过，不作预测（规则生成）。";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      if (url.pathname === "/health") {
        return json({ status: "ok", service: "china-fuel-price", time: new Date().toISOString() });
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
      if (url.pathname === "/api/global") return json(await loadJson(env, url, "global.json"));
      if (url.pathname === "/api/cities") {
        const cities = await loadJson(env, url, "cities.json");
        const p = url.searchParams.get("province");
        if (p) return json({ ...cities, cities: (cities.cities || []).filter((c) => c.province === p || c.province?.includes(p)) });
        return json(cities);
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
        const fuel = url.searchParams.get("fuel") || "95";
        const key = FUEL_KEYS[fuel] || "p95";
        const series = rows.map((s) => {
          const hit = (s.provinces || []).find((r) => r.province === province);
          return { date: (s.fetched_at || "").slice(0, 10), fetched_at: s.fetched_at, price: hit ? hit[key] : null };
        }).filter((x) => x.price !== null);
        return json({ province, fuel: FUEL_LABEL[key], history_start: "2026-01-06", count: series.length, series });
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
