// ============================================================================
// ÆEA RELAY — CLOUDFLARE WORKER (relay-only repo variant)
// ============================================================================
// Identical to aei-backend/worker.js. Kept in sync via git subtree or
// manual copy. Deploy with `wrangler deploy` from this repo root.
// ============================================================================

const YAHOO_HOST = "https://query1.finance.yahoo.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, X-Relay-Key",
      "Cache-Control": "public, max-age=15",
      ...extraHeaders,
    },
  });
}

function shapeBar(quote, ts, i) {
  const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v));
  const iso = ts && ts[i] ? new Date(ts[i] * 1000).toISOString() : new Date().toISOString();
  return {
    open: num(quote.open?.[i]),
    high: num(quote.high?.[i]),
    low: num(quote.low?.[i]),
    close: num(quote.close?.[i]),
    volume: num(quote.volume?.[i]),
    timestamp: iso,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, X-Relay-Key",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "aei-relay", gated: Boolean(env.RELAY_KEY) });
    }

    if (env.RELAY_KEY) {
      const presented = request.headers.get("X-Relay-Key") || "";
      if (presented !== env.RELAY_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    const symbol = url.searchParams.get("symbol") || "BTC-USD";
    const kind = url.searchParams.get("kind") || "price";
    const interval = url.searchParams.get("interval") || "1m";
    const range = kind === "intraday" || kind === "history" ? "2d" : "1d";

    const upstream = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${range}`;

    let response;
    try {
      response = await fetch(upstream, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        cf: { cacheTtl: 10, cacheEverything: true },
      });
    } catch (e) {
      return json({ error: "upstream_failed", detail: String(e), symbol }, 502);
    }

    if (!response.ok) {
      return json({ error: "upstream_status", status: response.status, symbol }, 502);
    }

    let raw;
    try {
      raw = await response.json();
    } catch (e) {
      return json({ error: "upstream_invalid_json", detail: String(e), symbol }, 502);
    }

    const result = raw?.chart?.result?.[0];
    if (!result) {
      const yahooErr = raw?.chart?.error || null;
      return json({ error: "no_data", symbol, yahoo_error: yahooErr }, 404);
    }

    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

    if (kind === "price") {
      const last = shapeBar(quote, ts, ts.length - 1);
      const px = meta.regularMarketPrice ?? last.close;
      if (px === null || px === undefined) {
        return json({ error: "no_price", symbol }, 404);
      }
      return json({
        symbol,
        close: Number(px),
        bid: Number(px),
        ask: Number(px),
        volume: last.volume,
        timestamp: last.timestamp,
      });
    }

    if (kind === "intraday") {
      if (ts.length === 0) {
        return json({ error: "no_intraday", symbol }, 404);
      }
      const last = shapeBar(quote, ts, ts.length - 1);
      if (last.close === null) {
        return json({ error: "no_intraday_close", symbol }, 404);
      }
      return json({ symbol, ...last });
    }

    if (kind === "history") {
      const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
      const start = Math.max(0, ts.length - limit);
      const out = [];
      for (let i = start; i < ts.length; i++) {
        const bar = shapeBar(quote, ts, i);
        if (bar.close === null) continue;
        out.push(bar);
      }
      return json(out);
    }

    return json({ error: "unknown_kind", kind }, 400);
  },
};