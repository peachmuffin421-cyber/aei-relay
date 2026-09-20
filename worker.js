// Æea Relay Worker — v1.1 (PATCH-J: optional shared-secret gate)
// Deploy via wrangler; set secret: wrangler secret put RELAY_KEY
// If RELAY_KEY unset, gate is bypassed (backwards compatible).
//
// Route contract:
//   GET /health                                  → { ok, service, gated, region }
//   GET /?symbol=<SYM>&kind=price                → { close, bid, ask, volume }
//   GET /?symbol=<SYM>&kind=intraday&interval=1m → { open, high, low, close, volume, timestamp }
//   GET /?symbol=<SYM>&kind=history&limit=200    → [ { open, high, low, close, volume, timestamp }, ... ]

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const DEFAULT_SYMBOL = "BTC-USD";
const DEFAULT_INTERVAL = "1m";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const CACHE_TTL_SECONDS = 15;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

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

async function fetchYahoo(symbol, interval, range) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const upstream = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  return upstream;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Health (ungated — audit requirement) ─────────────────────
    if (url.pathname === "/health") {
      const requiredKey = (env && env.RELAY_KEY) ? String(env.RELAY_KEY) : "";
      return jsonResponse({
        ok: true,
        service: "aei-relay",
        version: "1.1",
        gated: !!requiredKey,
        region: (request.cf && request.cf.colo) || "unknown",
        ts: new Date().toISOString(),
      });
    }

    // ── PATCH-J: optional shared-secret gate ─────────────────────
    const requiredKey = (env && env.RELAY_KEY) ? String(env.RELAY_KEY) : "";
    if (requiredKey) {
      const provided = request.headers.get("X-Relay-Key")
        || url.searchParams.get("key")
        || "";
      if (provided !== requiredKey) {
        return errorResponse(401, "unauthorized", "missing or invalid X-Relay-Key");
      }
    }

    // ── Parse query ──────────────────────────────────────────────
    const symbol = url.searchParams.get("symbol") || DEFAULT_SYMBOL;
    const kind = url.searchParams.get("kind") || "price";
    const interval = url.searchParams.get("interval") || DEFAULT_INTERVAL;
    const range = kind === "intraday" ? "2d" : "1d";

    // ── Upstream fetch with error handling ───────────────────────
    let upstream;
    try {
      upstream = await fetchYahoo(symbol, interval, range);
    } catch (e) {
      return errorResponse(502, "upstream_failed", String(e));
    }

    if (!upstream.ok) {
      const isBlocked = upstream.status === 403 || upstream.status === 429;
      return errorResponse(
        isBlocked ? 403 : 502,
        "upstream_blocked",
        `Yahoo Finance rejected request (status=${upstream.status})`
      );
    }

    let raw;
    try {
      raw = await upstream.json();
    } catch (e) {
      return errorResponse(502, "invalid_json", "Upstream did not return valid JSON");
    }

    const result = raw && raw.chart && raw.chart.result && raw.chart.result[0];
    if (!result) {
      return errorResponse(404, "no_data", `symbol=${symbol}`);
    }

    // ── Shape the payload by kind ────────────────────────────────
    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

    if (kind === "price") {
      const last = shape(ts, q, ts.length - 1);
      const price = meta.regularMarketPrice != null
        ? meta.regularMarketPrice
        : last.close;
      return jsonResponse({
        close: price,
        bid: price,
        ask: price,
        volume: last.volume,
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        exchange: meta.exchangeName || null,
      });
    }

    if (kind === "intraday") {
      const last = shape(ts, q, ts.length - 1);
      return jsonResponse({
        ...last,
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
      });
    }

    if (kind === "history") {
      const limit = clampLimit(url.searchParams.get("limit"));
      const out = [];
      const start = Math.max(0, ts.length - limit);
      for (let i = start; i < ts.length; i++) {
        const row = shape(ts, q, i);
        if (row.close == null) continue;
        out.push(row);
      }
      return jsonResponse(out);
    }

    return errorResponse(400, "unknown_kind", `kind=${kind}`);
  },
};