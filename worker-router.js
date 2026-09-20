// Æea Relay Worker — Variant B (router/edge-cache/failover)
// Deploy alongside Variant A when you need:
//   • multi-region failover (query1 → query2 → query1 with retry)
//   • per-symbol in-memory rate budget (KV optional)
//   • edge-cache-API read-through
//
// Route contract: identical to Variant A, plus:
//   GET /budget?symbol=<SYM>   → { symbol, window_sec, used, cap }
//
// Optional bindings (wrangler.toml):
//   [[kv_namespaces]] binding = "RELAY_KV" id = "<id>"
// If RELAY_KV missing, budget is per-isolate only.

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com/v8/finance/chart",
  "https://query2.finance.yahoo.com/v8/finance/chart",
];
const DEFAULT_SYMBOL = "BTC-USD";
const DEFAULT_INTERVAL = "1m";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const CACHE_TTL_SECONDS = 15;
const RATE_WINDOW_SECONDS = 60;
const RATE_CAP_PER_SYMBOL = 120;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Per-isolate budget (fallback when no KV binding)
const _budget = new Map();

function budgetKey(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(now / RATE_WINDOW_SECONDS);
  return `${symbol}:${windowId}`;
}

async function budgetCheck(env, symbol) {
  const key = budgetKey(symbol);
  if (env && env.RELAY_KV) {
    const raw = await env.RELAY_KV.get(key);
    const used = raw ? parseInt(raw, 10) : 0;
    if (used >= RATE_CAP_PER_SYMBOL) return { ok: false, used, cap: RATE_CAP_PER_SYMBOL };
    await env.RELAY_KV.put(key, String(used + 1), { expirationTtl: RATE_WINDOW_SECONDS * 2 });
    return { ok: true, used: used + 1, cap: RATE_CAP_PER_SYMBOL };
  }
  const used = _budget.get(key) || 0;
  if (used >= RATE_CAP_PER_SYMBOL) return { ok: false, used, cap: RATE_CAP_PER_SYMBOL };
  _budget.set(key, used + 1);
  return { ok: true, used: used + 1, cap: RATE_CAP_PER_SYMBOL };
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      ...extraHeaders,
    },
  });
}

function errorResponse(status, code, detail) {
  return jsonResponse({ error: code, detail }, status);
}

function clampLimit(raw) {
  const n = parseInt(raw || String(DEFAULT_LIMIT), 10);
  if (!isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function shape(ts, q, i) {
  return {
    open: q.open ? q.open[i] : null,
    high: q.high ? q.high[i] : null,
    low: q.low ? q.low[i] : null,
    close: q.close ? q.close[i] : null,
    volume: q.volume ? q.volume[i] : null,
    timestamp: ts[i] ? new Date(ts[i] * 1000).toISOString() : new Date().toISOString(),
  };
}

async function tryHosts(symbol, interval, range) {
  let lastErr = null;
  for (let attempt = 0; attempt < YAHOO_HOSTS.length * 2; attempt++) {
    const base = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];
    const url = `${base}/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (res.ok) return { ok: true, res };
      lastErr = `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 429) {
        // Rotate to next host immediately
        continue;
      }
      return { ok: false, status: res.status, err: lastErr };
    } catch (e) {
      lastErr = String(e);
      continue;
    }
  }
  return { ok: false, status: 502, err: lastErr || "all hosts failed" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const requiredKey = (env && env.RELAY_KEY) ? String(env.RELAY_KEY) : "";
      return jsonResponse({
        ok: true,
        service: "aei-relay-router",
        version: "1.1-router",
        gated: !!requiredKey,
        kv_bound: !!(env && env.RELAY_KV),
        region: (request.cf && request.cf.colo) || "unknown",
        ts: new Date().toISOString(),
      });
    }

    const requiredKey = (env && env.RELAY_KEY) ? String(env.RELAY_KEY) : "";
    if (requiredKey) {
      const provided = request.headers.get("X-Relay-Key")
        || url.searchParams.get("key")
        || "";
      if (provided !== requiredKey) {
        return errorResponse(401, "unauthorized", "missing or invalid X-Relay-Key");
      }
    }

    const symbol = url.searchParams.get("symbol") || DEFAULT_SYMBOL;
    const kind = url.searchParams.get("kind") || "price";
    const interval = url.searchParams.get("interval") || DEFAULT_INTERVAL;
    const range = kind === "intraday" ? "2d" : "1d";

    if (url.pathname === "/budget") {
      const key = budgetKey(symbol);
      const used = (env && env.RELAY_KV)
        ? parseInt((await env.RELAY_KV.get(key)) || "0", 10)
        : (_budget.get(key) || 0);
      return jsonResponse({
        symbol,
        window_sec: RATE_WINDOW_SECONDS,
        used,
        cap: RATE_CAP_PER_SYMBOL,
      });
    }

    // Budget gate (skips for /health and /budget)
    const budget = await budgetCheck(env, symbol);
    if (!budget.ok) {
      return errorResponse(
        429,
        "rate_budget_exceeded",
        `symbol=${symbol} used=${budget.used} cap=${budget.cap} window=${RATE_WINDOW_SECONDS}s`
      );
    }

    // Edge cache lookup
    const cacheKey = new Request(
      `${url.origin}${url.pathname}?symbol=${encodeURIComponent(symbol)}&kind=${kind}&interval=${encodeURIComponent(interval)}&limit=${clampLimit(url.searchParams.get("limit"))}`,
      { method: "GET" }
    );
    const cache = caches.default;
    let cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set("X-Relay-Cache", "HIT");
      return resp;
    }

    const result = await tryHosts(symbol, interval, range);
    if (!result.ok) {
      return errorResponse(
        result.status === 403 ? 403 : 502,
        "upstream_blocked",
        result.err || "upstream failed"
      );
    }

    let raw;
    try {
      raw = await result.res.json();
    } catch (e) {
      return errorResponse(502, "invalid_json", "Upstream did not return valid JSON");
    }

    const r = raw && raw.chart && raw.chart.result && raw.chart.result[0];
    if (!r) {
      return errorResponse(404, "no_data", `symbol=${symbol}`);
    }

    const meta = r.meta || {};
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};

    let payload;
    let status = 200;

    if (kind === "price") {
      const last = shape(ts, q, ts.length - 1);
      const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : last.close;
      payload = {
        close: price, bid: price, ask: price, volume: last.volume,
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        exchange: meta.exchangeName || null,
      };
    } else if (kind === "intraday") {
      const last = shape(ts, q, ts.length - 1);
      payload = { ...last, symbol: meta.symbol || symbol, currency: meta.currency || "USD" };
    } else if (kind === "history") {
      const limit = clampLimit(url.searchParams.get("limit"));
      const out = [];
      const start = Math.max(0, ts.length - limit);
      for (let i = start; i < ts.length; i++) {
        const row = shape(ts, q, i);
        if (row.close == null) continue;
        out.push(row);
      }
      payload = out;
    } else {
      payload = { error: "unknown_kind", detail: `kind=${kind}` };
      status = 400;
    }

    const response = jsonResponse(payload, status);
    response.headers.set("X-Relay-Cache", "MISS");
    // Fire-and-forget edge cache write
    if (status === 200 && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};