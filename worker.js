export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "aei-relay" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const symbol = url.searchParams.get("symbol") || "BTC-USD";
    const kind = url.searchParams.get("kind") || "price";
    const interval = url.searchParams.get("interval") || "1m";
    const range = kind === "intraday" || kind === "history" ? "2d" : "1d";

    const yahoo = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

    let upstream;
    try {
      upstream = await fetch(yahoo, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "upstream_failed", detail: String(e) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (!upstream.ok) {
        return new Response(JSON.stringify({ error: "upstream_http_error", status: upstream.status, statusText: upstream.statusText }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    const raw = await upstream.json();

    const result = raw?.chart?.result?.[0];
    if (!result) {
      console.error("Yahoo no_data response:", JSON.stringify(raw));
      return new Response(JSON.stringify({ error: "no_data", symbol, detail: raw?.chart?.error }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};

    const shape = (i) => ({
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
      timestamp: ts[i] ? new Date(ts[i] * 1000).toISOString() : new Date().toISOString(),
    });

    let payload;
    if (kind === "price") {
      const last = shape(ts.length - 1);
      payload = {
        close: meta.regularMarketPrice ?? last.close,
        bid: meta.regularMarketPrice ?? last.close,
        ask: meta.regularMarketPrice ?? last.close,
        volume: last.volume,
      };
    } else if (kind === "intraday") {
      payload = shape(ts.length - 1);
    } else if (kind === "history") {
      const limit = parseInt(url.searchParams.get("limit") || "200", 10);
      payload = [];
      // Ensure we don't request more than available
      const startIndex = Math.max(0, ts.length - limit);
      for (let i = startIndex; i < ts.length; i++) {
        payload.push(shape(i));
      }
      console.log(`History request: ${payload.length} bars returned for ${symbol}`);
    } else {
      return new Response(JSON.stringify({ error: "unknown_kind", kind }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=15",
      },
    });
  },
};