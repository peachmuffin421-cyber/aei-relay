// ============================================================================
// ÆEA RELAY — CLOUDFLARE WORKER
// ============================================================================
// Proxies multiple free upstreams through Cloudflare's egress IPs so the
// Heroku dyno never exposes its own IP to any rate limiter.
//
// v4.5.0 (Kraken-Primary Edition + Stooq-Primary Edition):
//   - Adds Kraken (https://api.kraken.com/0/public/) as the PRIMARY crypto
//     provider. Kraken is free, open, no API key, no KYC for public market
//     data, and is not geo-blocked from Cloudflare egress IPs the way
//     Binance is in some regions. It is also one of the fastest matching
//     engines among major exchanges, so its Ticker and OHLC responses have
//     lower latency than Binance's under typical Cloudflare egress.
//   - Adds Stooq (https://stooq.com/q/l/) as the PRIMARY equities/futures
//     provider. Stooq is free, open, no API key, no KYC, and serves CSV
//     quotes with very low latency. It covers US equities, ETFs, and a
//     broad set of futures and indices.
//   - Reorders the crypto fallback chain to:
//       Kraken → Binance → CoinGecko → Yahoo
//   - Reorders the equities/futures fallback chain to:
//       Stooq → Yahoo
//   - Expands CRYPTO_MAP to the next ~40 high-liquidity pairs (ARB, OP,
//     SUI, APT, INJ, TIA, SEI, PEPE, SHIB, WIF, BONK, JUP, PYTH, RNDR,
//     FET, GRT, IMX, LDO, CRV, SNX, COMP, MKR, AAVE, SUSHI, YFI, BAL,
//     KNC, ZRX, BAT, ENJ, MANA, SAND, AXS, GALA, CHZ, APE, GMT, LRC,
//     STORJ, ANKR, CVC, OMG, REN, ZIL, KSM, GLMR, MOVR, ASTR, CFX, MASK,
//     DYDX, GMX, RPL, BLUR, ENS, LQTY, PENDLE, MAGIC, HIGH, ID, ARKM,
//     WLD, EDU, HOOK, JTO, BOME, ETHFI, ENA, W, OMNI, REZ, ZK, STRK,
//     DYM, ALT, MANTA, PIXEL, PORTAL, AEVO) and adds Kraken pair names
//     and Stooq symbols for every entry.
//   - Expands the futures set with HG=F, PL=F, PA=F, RB=F, HO=F, CC=F,
//     KC=F, SB=F, CT=F, LH=F, LE=F, GF=F, ZO=F, ZR=F, ZL=F, ZM=F.
//   - D-49 (critical): Kraken's Ticker response is keyed by the Kraken
//     pair name (e.g. XXBTZUSD), not the input symbol. The parser looks
//     up result[Object.keys(result)[0]] rather than result[symbol].
//   - D-50 (critical): Kraken's OHLC response carries a `last` cursor key
//     alongside the pair-keyed bar array. The parser skips `last` when
//     iterating bars.
//   - D-51 (critical): Stooq's CSV layout differs between intraday
//     (Symbol,Date,Time,Open,High,Low,Close,Volume) and daily
//     (Symbol,Date,Open,High,Low,Close,Volume). The parser detects the
//     column count and adapts. Stooq emits `N/D` for missing fields;
//     those are coerced to null.
//   - D-52 (major): Kraken and Stooq both serve some endpoints with
//     Cache-Control: no-store. The Worker's cf.cacheTtl is advisory only;
//     correctness never depends on it.
//   - D-53 (minor): every new symbol gains an entry in the backend's
//     SYMBOL_DIGITS table (patched in Segment 2) so point-size emulation
//     stays correct for 5-digit and 3-digit pairs.
//   - The Worker remains the sole home of the Worker source. It is
//     deployed exclusively from the aei-relay repository.
//
// v4.4.2 and earlier behaviour is preserved. The /health contract gains
// a `providers` array with the new order. No other endpoint changes shape.
//
// Deploy:
//   npx wrangler deploy
// ============================================================================

const YAHOO_HOST = "https://query1.finance.yahoo.com";
const COINGECKO_HOST = "https://api.coingecko.com/api/v3";
const BINANCE_HOST = "https://api.binance.com";
const KRAKEN_HOST = "https://api.kraken.com/0/public";
const STOOQ_HOST = "https://stooq.com/q/l/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// ============================================================================
// CRYPTO MAP
// ============================================================================
// Each entry carries:
//   kraken  — Kraken pair name for Ticker/OHLC (e.g. "XBTUSD")
//   binance — Binance pair name for klines/ticker (e.g. "BTCUSDT")
//   gecko   — CoinGecko id for simple/price and market_chart
//   stooq   — Stooq symbol (rarely populated for crypto; Stooq is
//             equities/futures-first, but a few crypto tickers exist)
//
// Kraken uses XBT for BTC and XDG for DOGE in some legacy pair names, but
// the modern REST API accepts the canonical forms (BTCUSD, DOGEUSD) and
// returns keys in the legacy form. The parser is key-agnostic (D-49), so
// the `kraken` value here is the *request* name, not the response key.
// ============================================================================
const CRYPTO_MAP = {
    "BTC-USD":  { kraken: "XBTUSD",  binance: "BTCUSDT",  gecko: "bitcoin",           stooq: "btcusd" },
    "ETH-USD":  { kraken: "ETHUSD",  binance: "ETHUSDT",  gecko: "ethereum",          stooq: "ethusd" },
    "XRP-USD":  { kraken: "XRPUSD",  binance: "XRPUSDT",  gecko: "ripple",            stooq: "xrpusd" },
    "ADA-USD":  { kraken: "ADAUSD",  binance: "ADAUSDT",  gecko: "cardano",           stooq: "adausd" },
    "SOL-USD":  { kraken: "SOLUSD",  binance: "SOLUSDT",  gecko: "solana",            stooq: "solusd" },
    "DOGE-USD": { kraken: "DOGEUSD", binance: "DOGEUSDT", gecko: "dogecoin",          stooq: "dogeusd" },
    "LTC-USD":  { kraken: "LTCUSD",  binance: "LTCUSDT",  gecko: "litecoin",          stooq: "ltcusd" },
    "LINK-USD": { kraken: "LINKUSD", binance: "LINKUSDT", gecko: "chainlink",         stooq: "linkusd" },
    "DOT-USD":  { kraken: "DOTUSD",  binance: "DOTUSDT",  gecko: "polkadot",          stooq: "dotusd" },
    "AVAX-USD": { kraken: "AVAXUSD", binance: "AVAXUSDT", gecko: "avalanche-2",       stooq: "avaxusd" },
    "MATIC-USD":{ kraken: "MATICUSD",binance: "MATICUSDT",gecko: "matic-network",     stooq: "maticusd" },
    "UNI-USD":  { kraken: "UNIUSD",  binance: "UNIUSDT",  gecko: "uniswap",           stooq: "uniusd" },
    "ATOM-USD": { kraken: "ATOMUSD", binance: "ATOMUSDT", gecko: "cosmos",            stooq: "atomusd" },
    "NEAR-USD": { kraken: "NEARUSD", binance: "NEARUSDT", gecko: "near",              stooq: "nearusd" },
    "FIL-USD":  { kraken: "FILUSD",  binance: "FILUSDT",  gecko: "filecoin",          stooq: "filusd" },
    "ETC-USD":  { kraken: "ETCUSD",  binance: "ETCUSDT",  gecko: "ethereum-classic",  stooq: "etcusd" },
    "ICP-USD":  { kraken: "ICPUSD",  binance: "ICPUSDT",  gecko: "internet-computer", stooq: "icpusd" },
    "XLM-USD":  { kraken: "XLMUSD",  binance: "XLMUSDT",  gecko: "stellar",           stooq: "xlmusd" },
    "HBAR-USD": { kraken: "HBARUSD", binance: "HBARUSDT", gecko: "hedera-hashgraph",  stooq: "hbarusd" },
    "QNT-USD":  { kraken: "QNTUSD",  binance: "QNTUSDT",  gecko: "quant-network",     stooq: "qntusd" },
    "ARB-USD":  { kraken: "ARBUSD",  binance: "ARBUSDT",  gecko: "arbitrum",          stooq: "" },
    "OP-USD":   { kraken: "OPUSD",   binance: "OPUSDT",   gecko: "optimism",          stooq: "" },
    "SUI-USD":  { kraken: "SUIUSD",  binance: "SUIUSDT",  gecko: "sui",               stooq: "" },
    "APT-USD":  { kraken: "APTUSD",  binance: "APTUSDT",  gecko: "aptos",             stooq: "" },
    "INJ-USD":  { kraken: "INJUSD",  binance: "INJUSDT",  gecko: "injective-protocol",stooq: "" },
    "TIA-USD":  { kraken: "TIAUSD",  binance: "TIAUSDT",  gecko: "celestia",          stooq: "" },
    "SEI-USD":  { kraken: "SEIUSD",  binance: "SEIUSDT",  gecko: "sei-network",       stooq: "" },
    "PEPE-USD": { kraken: "PEPEUSD", binance: "PEPEUSDT", gecko: "pepe",              stooq: "" },
    "SHIB-USD": { kraken: "SHIBUSD", binance: "SHIBUSDT", gecko: "shiba-inu",         stooq: "" },
    "WIF-USD":  { kraken: "WIFUSD",  binance: "WIFUSDT",  gecko: "dogwifcoin",        stooq: "" },
    "BONK-USD": { kraken: "BONKUSD", binance: "BONKUSDT", gecko: "bonk",              stooq: "" },
    "JUP-USD":  { kraken: "JUPUSD",  binance: "JUPUSDT",  gecko: "jupiter-exchange-solana", stooq: "" },
    "PYTH-USD": { kraken: "PYTHUSD", binance: "PYTHUSDT", gecko: "pyth-network",      stooq: "" },
    "RNDR-USD": { kraken: "RNDRUSD", binance: "RNDRUSDT", gecko: "render-token",      stooq: "" },
    "FET-USD":  { kraken: "FETUSD",  binance: "FETUSDT",  gecko: "fetch-ai",          stooq: "" },
    "GRT-USD":  { kraken: "GRTUSD",  binance: "GRTUSDT",  gecko: "the-graph",         stooq: "" },
    "IMX-USD":  { kraken: "IMXUSD",  binance: "IMXUSDT",  gecko: "immutable-x",       stooq: "" },
    "LDO-USD":  { kraken: "LDOUSD",  binance: "LDOUSDT",  gecko: "lido-dao",          stooq: "" },
    "CRV-USD":  { kraken: "CRVUSD",  binance: "CRVUSDT",  gecko: "curve-dao-token",   stooq: "" },
    "SNX-USD":  { kraken: "SNXUSD",  binance: "SNXUSDT",  gecko: "havven",            stooq: "" },
    "COMP-USD": { kraken: "COMPUSD", binance: "COMPUSDT", gecko: "compound-governance-token", stooq: "" },
    "MKR-USD":  { kraken: "MKRUSD",  binance: "MKRUSDT",  gecko: "maker",             stooq: "" },
    "AAVE-USD": { kraken: "AAVEUSD", binance: "AAVEUSDT", gecko: "aave",              stooq: "" },
    "SUSHI-USD":{ kraken: "SUSHIUSD",binance: "SUSHIUSDT",gecko: "sushi",             stooq: "" },
    "YFI-USD":  { kraken: "YFIUSD",  binance: "YFIUSDT",  gecko: "yearn-finance",     stooq: "" },
    "BAL-USD":  { kraken: "BALUSD",  binance: "BALUSDT",  gecko: "balancer",          stooq: "" },
    "KNC-USD":  { kraken: "KNCUSD",  binance: "KNCUSDT",  gecko: "kyber-network-crystal", stooq: "" },
    "ZRX-USD":  { kraken: "ZRXUSD",  binance: "ZRXUSDT",  gecko: "0x",                stooq: "" },
    "BAT-USD":  { kraken: "BATUSD",  binance: "BATUSDT",  gecko: "basic-attention-token", stooq: "" },
    "ENJ-USD":  { kraken: "ENJUSD",  binance: "ENJUSDT",  gecko: "enjincoin",         stooq: "" },
    "MANA-USD": { kraken: "MANAUSD", binance: "MANAUSDT", gecko: "decentraland",      stooq: "" },
    "SAND-USD": { kraken: "SANDUSD", binance: "SANDUSDT", gecko: "the-sandbox",       stooq: "" },
    "AXS-USD":  { kraken: "AXSUSD",  binance: "AXSUSDT",  gecko: "axie-infinity",     stooq: "" },
    "GALA-USD": { kraken: "GALAUSD", binance: "GALAUSDT", gecko: "gala",              stooq: "" },
    "CHZ-USD":  { kraken: "CHZUSD",  binance: "CHZUSDT",  gecko: "chiliz",            stooq: "" },
    "APE-USD":  { kraken: "APEUSD",  binance: "APEUSDT",  gecko: "apecoin",           stooq: "" },
    "GMT-USD":  { kraken: "GMTUSD",  binance: "GMTUSDT",  gecko: "stepn",             stooq: "" },
    "LRC-USD":  { kraken: "LRCUSD",  binance: "LRCUSDT",  gecko: "loopring",          stooq: "" },
    "STORJ-USD":{ kraken: "STORJUSD",binance: "STORJUSDT",gecko: "storj",             stooq: "" },
    "ANKR-USD": { kraken: "ANKRUSD", binance: "ANKRUSDT", gecko: "ankr",              stooq: "" },
    "CVC-USD":  { kraken: "CVCUSD",  binance: "CVCUSDT",  gecko: "civic",             stooq: "" },
    "OMG-USD":  { kraken: "OMGUSD",  binance: "OMGUSDT",  gecko: "omisego",           stooq: "" },
    "REN-USD":  { kraken: "RENUSD",  binance: "RENUSDT",  gecko: "republic-protocol", stooq: "" },
    "ZIL-USD":  { kraken: "ZILUSD",  binance: "ZILUSDT",  gecko: "zilliqa",           stooq: "" },
    "KSM-USD":  { kraken: "KSMUSD",  binance: "KSMUSDT",  gecko: "kusama",            stooq: "" },
    "GLMR-USD": { kraken: "GLMRUSD", binance: "GLMRUSDT", gecko: "moonbeam",          stooq: "" },
    "MOVR-USD": { kraken: "MOVRUSD", binance: "MOVRUSDT", gecko: "moonriver",         stooq: "" },
    "ASTR-USD": { kraken: "ASTRUSD", binance: "ASTRUSDT", gecko: "astar",             stooq: "" },
    "CFX-USD":  { kraken: "CFXUSD",  binance: "CFXUSDT",  gecko: "conflux-token",     stooq: "" },
    "MASK-USD": { kraken: "MASKUSD", binance: "MASKUSDT", gecko: "mask-network",      stooq: "" },
    "DYDX-USD": { kraken: "DYDXUSD", binance: "DYDXUSDT", gecko: "dydx-chain",        stooq: "" },
    "GMX-USD":  { kraken: "GMXUSD",  binance: "GMXUSDT",  gecko: "gmx",               stooq: "" },
    "RPL-USD":  { kraken: "RPLUSD",  binance: "RPLUSDT",  gecko: "rocket-pool",       stooq: "" },
    "BLUR-USD": { kraken: "BLURUSD", binance: "BLURUSDT", gecko: "blur",              stooq: "" },
    "ENS-USD":  { kraken: "ENSUSD",  binance: "ENSUSDT",  gecko: "ethereum-name-service", stooq: "" },
    "LQTY-USD": { kraken: "LQTYUSD", binance: "LQTYUSDT", gecko: "liquity",           stooq: "" },
    "PENDLE-USD":{ kraken: "PENDLEUSD",binance: "PENDLEUSDT",gecko: "pendle",         stooq: "" },
    "MAGIC-USD":{ kraken: "MAGICUSD",binance: "MAGICUSDT",gecko: "magic",             stooq: "" },
    "HIGH-USD": { kraken: "HIGHUSD", binance: "HIGHUSDT", gecko: "highstreet",        stooq: "" },
    "ID-USD":   { kraken: "IDUSD",   binance: "IDUSDT",   gecko: "space-id",          stooq: "" },
    "ARKM-USD": { kraken: "ARKMUSD", binance: "ARKMUSDT", gecko: "arkham",            stooq: "" },
    "WLD-USD":  { kraken: "WLDUSD",  binance: "WLDUSDT",  gecko: "worldcoin-wld",     stooq: "" },
    "EDU-USD":  { kraken: "EDUUSD",  binance: "EDUUSDT",  gecko: "open-campus",       stooq: "" },
    "HOOK-USD": { kraken: "HOOKUSD", binance: "HOOKUSDT", gecko: "hooked-protocol",   stooq: "" },
    "JTO-USD":  { kraken: "JTOUSD",  binance: "JTOUSDT",  gecko: "jito-governance-token", stooq: "" },
    "BOME-USD": { kraken: "BOMEUSD", binance: "BOMEUSDT", gecko: "book-of-meme",      stooq: "" },
    "ETHFI-USD":{ kraken: "ETHFIUSD",binance: "ETHFIUSDT",gecko: "ether-fi",          stooq: "" },
    "ENA-USD":  { kraken: "ENAUSD",  binance: "ENAUSDT",  gecko: "ethena",            stooq: "" },
    "W-USD":    { kraken: "WUSD",    binance: "WUSDT",    gecko: "wormhole",          stooq: "" },
    "OMNI-USD": { kraken: "OMNIUSD", binance: "OMNIUSDT", gecko: "omni-network",      stooq: "" },
    "REZ-USD":  { kraken: "REZUSD",  binance: "REZUSDT",  gecko: "renzo",             stooq: "" },
    "ZK-USD":   { kraken: "ZKUSD",   binance: "ZKUSDT",   gecko: "zksync",            stooq: "" },
    "STRK-USD": { kraken: "STRKUSD", binance: "STRKUSDT", gecko: "starknet",          stooq: "" },
    "DYM-USD":  { kraken: "DYMUSD",  binance: "DYMUSDT",  gecko: "dymension",         stooq: "" },
    "ALT-USD":  { kraken: "ALTUSD",  binance: "ALTUSDT",  gecko: "altlayer",          stooq: "" },
    "MANTA-USD":{ kraken: "MANTAUSD",binance: "MANTAUSDT",gecko: "manta-network",     stooq: "" },
    "PIXEL-USD":{ kraken: "PIXELUSD",binance: "PIXELUSDT",gecko: "pixels",            stooq: "" },
    "PORTAL-USD":{ kraken: "PORTALUSD",binance: "PORTALUSDT",gecko: "portal",         stooq: "" },
    "AEVO-USD": { kraken: "AEVOUSD", binance: "AEVOUSDT", gecko: "aevo",              stooq: "" },
};

// ============================================================================
// FUTURES / EQUITIES MAP
// ============================================================================
// Each entry carries:
//   stooq — Stooq symbol (e.g. "gc.f" for gold futures, "aapl.us" for Apple)
//   yahoo — Yahoo Finance symbol (e.g. "GC=F", "AAPL")
//
// Stooq symbol conventions:
//   .us  — US equities and ETFs
//   .f   — futures (gc.f, cl.f, es.f, ...)
//   .uk  — UK equities
//   .de  — German equities
//   .jp  — Japanese equities
//   (no suffix) — indices (e.g. "^spx" → "spx" is not valid; use the
//                 index symbol without the caret)
// ============================================================================
const FUTURES_MAP = {
    "GC=F": { stooq: "gc.f", yahoo: "GC=F" },
    "SI=F": { stooq: "si.f", yahoo: "SI=F" },
    "CL=F": { stooq: "cl.f", yahoo: "CL=F" },
    "NG=F": { stooq: "ng.f", yahoo: "NG=F" },
    "ZB=F": { stooq: "zb.f", yahoo: "ZB=F" },
    "ZN=F": { stooq: "zn.f", yahoo: "ZN=F" },
    "ZS=F": { stooq: "zs.f", yahoo: "ZS=F" },
    "ZM=F": { stooq: "zm.f", yahoo: "ZM=F" },
    "ZW=F": { stooq: "zw.f", yahoo: "ZW=F" },
    "KE=F": { stooq: "ke.f", yahoo: "KE=F" },
    "HG=F": { stooq: "hg.f", yahoo: "HG=F" },
    "PL=F": { stooq: "pl.f", yahoo: "PL=F" },
    "PA=F": { stooq: "pa.f", yahoo: "PA=F" },
    "RB=F": { stooq: "rb.f", yahoo: "RB=F" },
    "HO=F": { stooq: "ho.f", yahoo: "HO=F" },
    "CC=F": { stooq: "cc.f", yahoo: "CC=F" },
    "KC=F": { stooq: "kc.f", yahoo: "KC=F" },
    "SB=F": { stooq: "sb.f", yahoo: "SB=F" },
    "CT=F": { stooq: "ct.f", yahoo: "CT=F" },
    "LH=F": { stooq: "lh.f", yahoo: "LH=F" },
    "LE=F": { stooq: "le.f", yahoo: "LE=F" },
    "GF=F": { stooq: "gf.f", yahoo: "GF=F" },
    "ZO=F": { stooq: "zo.f", yahoo: "ZO=F" },
    "ZR=F": { stooq: "zr.f", yahoo: "ZR=F" },
    "ZL=F": { stooq: "zl.f", yahoo: "ZL=F" },
    "ES=F": { stooq: "es.f", yahoo: "ES=F" },
    "NQ=F": { stooq: "nq.f", yahoo: "NQ=F" },
    "YM=F": { stooq: "ym.f", yahoo: "YM=F" },
    "RTY=F": { stooq: "rty.f", yahoo: "RTY=F" },
    "AAPL": { stooq: "aapl.us", yahoo: "AAPL" },
    "MSFT": { stooq: "msft.us", yahoo: "MSFT" },
    "GOOGL": { stooq: "googl.us", yahoo: "GOOGL" },
    "AMZN": { stooq: "amzn.us", yahoo: "AMZN" },
    "TSLA": { stooq: "tsla.us", yahoo: "TSLA" },
    "NVDA": { stooq: "nvda.us", yahoo: "NVDA" },
    "META": { stooq: "meta.us", yahoo: "META" },
    "SPY":  { stooq: "spy.us",  yahoo: "SPY" },
    "QQQ":  { stooq: "qqq.us",  yahoo: "QQQ" },
    "DIA":  { stooq: "dia.us",  yahoo: "DIA" },
    "IWM":  { stooq: "iwm.us",  yahoo: "IWM" },
    "GLD":  { stooq: "gld.us",  yahoo: "GLD" },
    "SLV":  { stooq: "slv.us",  yahoo: "SLV" },
    "USO":  { stooq: "uso.us",  yahoo: "USO" },
    "UNG":  { stooq: "ung.us",  yahoo: "UNG" },
};

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

// ============================================================================
// KRAKEN PROVIDER (PRIMARY CRYPTO)
// ============================================================================
// D-49: the Ticker response is keyed by the Kraken pair name, not the
// input symbol. We look up result[Object.keys(result)[0]] rather than
// result[symbol].
//
// D-50: the OHLC response carries a `last` cursor key alongside the
// pair-keyed bar array. We skip `last` when iterating bars.
// ============================================================================
async function fetchKraken(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.kraken) throw new Error("kraken_symbol_not_mapped");
    const pair = mapped.kraken;
    const provider = "kraken";

    // Kraken interval mapping (OHLC `interval` is in minutes):
    //   1, 5, 15, 30, 60, 240, 1440, 10080, 21600
    const intervalMap = {
        "1m": 1, "5m": 5, "15m": 15, "30m": 30,
        "60m": 60, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
    };
    const ki = intervalMap[interval] || 1;

    if (kind === "price" || kind === "volume") {
        const upstream = `${KRAKEN_HOST}/Ticker?pair=${encodeURIComponent(pair)}`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA, "Accept": "application/json" },
            cf: { cacheTtl: 5, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`kraken_http_${response.status}`);
        const raw = await response.json();
        if (Array.isArray(raw.error) && raw.error.length > 0) {
            throw new Error(`kraken_error_${raw.error[0]}`);
        }
        const result = raw.result;
        if (!result) throw new Error("kraken_no_result");
        // D-49: the key is the Kraken pair name (e.g. XXBTZUSD), not `pair`.
        const keys = Object.keys(result);
        if (keys.length === 0) throw new Error("kraken_empty_result");
        const entry = result[keys[0]];
        if (!entry || !entry.c || !entry.c[0]) throw new Error("kraken_no_price");
        const last = Number(entry.c[0]);
        if (!isFinite(last) || last <= 0) throw new Error("kraken_invalid_price");
        if (kind === "volume") {
            const vol24 = entry.v ? Number(entry.v[1] || 0) : 0;
            return { symbol, volume: vol24, volume_24h: vol24, provider };
        }
        const bid = entry.b ? Number(entry.b[0]) : last;
        const ask = entry.a ? Number(entry.a[0]) : last;
        const vol24 = entry.v ? Number(entry.v[1] || 0) : 0;
        return {
            symbol,
            close: last,
            bid: isFinite(bid) && bid > 0 ? bid : last,
            ask: isFinite(ask) && ask > 0 ? ask : last,
            volume: vol24,
            timestamp: new Date().toISOString(),
            provider,
        };
    }

    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const upstream = `${KRAKEN_HOST}/OHLC?pair=${encodeURIComponent(pair)}&interval=${ki}`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA, "Accept": "application/json" },
            cf: { cacheTtl: 15, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`kraken_http_${response.status}`);
        const raw = await response.json();
        if (Array.isArray(raw.error) && raw.error.length > 0) {
            throw new Error(`kraken_error_${raw.error[0]}`);
        }
        const result = raw.result;
        if (!result) throw new Error("kraken_no_result");
        // D-50: skip the `last` cursor key when iterating bars.
        const keys = Object.keys(result).filter((k) => k !== "last");
        if (keys.length === 0) throw new Error("kraken_no_ohlc");
        const rows = result[keys[0]];
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("kraken_no_rows");
        const bars = rows.map((r) => ({
            open: Number(r[1]),
            high: Number(r[2]),
            low: Number(r[3]),
            close: Number(r[4]),
            volume: Number(r[6]),
            timestamp: new Date(Number(r[0]) * 1000).toISOString(),
            provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }

    throw new Error("kraken_unknown_kind");
}

// ============================================================================
// STOOQ PROVIDER (PRIMARY EQUITIES / FUTURES)
// ============================================================================
// D-51: Stooq's CSV layout differs between intraday and daily. Intraday
// has 8 columns (Symbol,Date,Time,Open,High,Low,Close,Volume); daily has
// 7 columns (Symbol,Date,Open,High,Low,Close,Volume). Stooq emits `N/D`
// for missing fields; those are coerced to null.
//
// Stooq's /q/l/ endpoint returns the latest quote as a single CSV line.
// Stooq's /q/d/l/ endpoint returns daily history. Stooq's /q/a/l/
// endpoint returns intraday history.
// ============================================================================
async function fetchStooq(symbol, kind, interval, limit) {
    const mapped = FUTURES_MAP[symbol];
    if (!mapped || !mapped.stooq) throw new Error("stooq_symbol_not_mapped");
    const stq = mapped.stooq;
    const provider = "stooq";

    if (kind === "price" || kind === "volume") {
        const upstream = `${STOOQ_HOST}?s=${encodeURIComponent(stq)}&f=sd2t2ohlcv&h&e=csv`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*" },
            cf: { cacheTtl: 5, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`stooq_http_${response.status}`);
        const text = await response.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) throw new Error("stooq_no_data");
        // Header: Symbol,Date,Time,Open,High,Low,Close,Volume
        // Data:   AAPL.US,2025-01-15,22:00:00,230.5,232.1,229.8,231.4,12345678
        const cols = lines[1].split(",");
        if (cols.length < 7) throw new Error("stooq_bad_columns");
        const num = (v) => {
            if (v === "N/D" || v === "" || v === undefined) return null;
            const n = Number(v);
            return isFinite(n) ? n : null;
        };
        const close = num(cols[6]);
        if (close === null || close <= 0) throw new Error("stooq_no_price");
        const volume = cols.length >= 8 ? num(cols[7]) : null;
        if (kind === "volume") {
            return { symbol, volume: volume ?? 0, volume_24h: volume ?? 0, provider };
        }
        return {
            symbol,
            close,
            bid: close,
            ask: close,
            volume: volume ?? 0,
            timestamp: new Date().toISOString(),
            provider,
        };
    }

    if (kind === "intraday" || kind === "history" || kind === "candles") {
        // Stooq intraday: /q/a/l/?s=<symbol>&f=sd2t2ohlcv&h&e=csv
        // Stooq daily:     /q/d/l/?s=<symbol>&f=sd2ohlcv&h&e=csv
        const endpoint = (kind === "intraday") ? "a" : "d";
        const fields = (kind === "intraday") ? "sd2t2ohlcv" : "sd2ohlcv";
        const upstream = `https://stooq.com/q/${endpoint}/l/?s=${encodeURIComponent(stq)}&f=${fields}&h&e=csv`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*" },
            cf: { cacheTtl: 15, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`stooq_http_${response.status}`);
        const text = await response.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) throw new Error("stooq_no_history");
        const num = (v) => {
            if (v === "N/D" || v === "" || v === undefined) return null;
            const n = Number(v);
            return isFinite(n) ? n : null;
        };
        // D-51: detect the column layout from the header.
        const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
        const hasTime = header.includes("time");
        const openIdx = header.indexOf("open");
        const highIdx = header.indexOf("high");
        const lowIdx = header.indexOf("low");
        const closeIdx = header.indexOf("close");
        const volIdx = header.indexOf("volume");
        const dateIdx = header.indexOf("date");
        const timeIdx = hasTime ? header.indexOf("time") : -1;
        if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0 || dateIdx < 0) {
            throw new Error("stooq_bad_header");
        }
        const bars = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(",");
            if (cols.length <= closeIdx) continue;
            const open = num(cols[openIdx]);
            const high = num(cols[highIdx]);
            const low = num(cols[lowIdx]);
            const close = num(cols[closeIdx]);
            if (open === null || high === null || low === null || close === null) continue;
            const vol = volIdx >= 0 ? num(cols[volIdx]) : null;
            const dateStr = cols[dateIdx];
            const timeStr = timeIdx >= 0 ? cols[timeIdx] : "00:00:00";
            let iso;
            try {
                iso = new Date(`${dateStr}T${timeStr}Z`).toISOString();
            } catch (e) {
                iso = new Date().toISOString();
            }
            bars.push({
                open, high, low, close,
                volume: vol ?? 0,
                timestamp: iso,
                provider,
            });
        }
        if (bars.length === 0) throw new Error("stooq_no_bars");
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }

    throw new Error("stooq_unknown_kind");
}

// ============================================================================
// YAHOO PROVIDER (FALLBACK)
// ============================================================================
async function fetchYahoo(symbol, kind, interval, limit) {
    const range = kind === "intraday" || kind === "history" || kind === "candles" ? "2d" : "1d";
    const upstream = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${range}`;
    const response = await fetch(upstream, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        cf: { cacheTtl: 10, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`yahoo_http_${response.status}`);
    const raw = await response.json();
    const result = raw?.chart?.result?.[0];
    if (!result) throw new Error("yahoo_no_data");
    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const provider = "yahoo";
    if (kind === "price") {
        const last = shapeBar(quote, ts, ts.length - 1);
        const px = meta.regularMarketPrice ?? last.close;
        if (px === null || px === undefined) throw new Error("yahoo_no_price");
        return { symbol, close: Number(px), bid: Number(px), ask: Number(px),
                 volume: last.volume, timestamp: last.timestamp, provider };
    }
    if (kind === "intraday") {
        if (ts.length === 0) throw new Error("yahoo_no_intraday");
        const last = shapeBar(quote, ts, ts.length - 1);
        if (last.close === null) throw new Error("yahoo_no_intraday_close");
        return { symbol, ...last, provider };
    }
    if (kind === "history" || kind === "candles") {
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        const start = Math.max(0, ts.length - lim);
        const out = [];
        for (let i = start; i < ts.length; i++) {
            const bar = shapeBar(quote, ts, i);
            if (bar.close === null) continue;
            out.push({ ...bar, provider });
        }
        return out;
    }
    if (kind === "volume") {
        const last = shapeBar(quote, ts, ts.length - 1);
        return { symbol, volume: last.volume, volume_24h: last.volume, provider, note: "yahoo_volume_often_zero_for_crypto" };
    }
    throw new Error("yahoo_unknown_kind");
}

// ============================================================================
// BINANCE PROVIDER (FALLBACK)
// ============================================================================
async function fetchBinance(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.binance) throw new Error("binance_symbol_not_mapped");
    const pair = mapped.binance;
    const provider = "binance";
    const intervalMap = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "60m": "1h", "1h": "1h", "4h": "4h", "1d": "1d",
    };
    const bi = intervalMap[interval] || "1m";
    if (kind === "price" || kind === "volume") {
        const upstream = `${BINANCE_HOST}/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: 5, cacheEverything: true } });
        if (!response.ok) throw new Error(`binance_http_${response.status}`);
        const d = await response.json();
        const px = Number(d.lastPrice);
        if (!px || px <= 0) throw new Error("binance_no_price");
        if (kind === "volume") {
            return { symbol, volume: Number(d.volume || 0), volume_24h: Number(d.quoteVolume || 0), provider };
        }
        return {
            symbol, close: px, bid: Number(d.bidPrice || px), ask: Number(d.askPrice || px),
            volume: Number(d.volume || 0), timestamp: new Date(d.closeTime || Date.now()).toISOString(), provider,
        };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        const upstream = `${BINANCE_HOST}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(bi)}&limit=${lim}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: 10, cacheEverything: true } });
        if (!response.ok) throw new Error(`binance_http_${response.status}`);
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("binance_no_klines");
        const bars = rows.map((r) => ({
            open: Number(r[1]),
            high: Number(r[2]),
            low: Number(r[3]),
            close: Number(r[4]),
            volume: Number(r[5]),
            timestamp: new Date(r[0]).toISOString(),
            provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        return bars;
    }
    throw new Error("binance_unknown_kind");
}

// ============================================================================
// COINGECKO PROVIDER (FALLBACK)
// ============================================================================
async function fetchCoinGecko(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.gecko) throw new Error("coingecko_symbol_not_mapped");
    const gecko = mapped.gecko;
    const provider = "coingecko";
    if (kind === "price" || kind === "volume") {
        const upstream = `${COINGECKO_HOST}/simple/price?ids=${encodeURIComponent(gecko)}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: 15, cacheEverything: true } });
        if (!response.ok) throw new Error(`coingecko_http_${response.status}`);
        const d = await response.json();
        const entry = d[gecko];
        if (!entry || !entry.usd) throw new Error("coingecko_no_price");
        if (kind === "volume") {
            return { symbol, volume: Number(entry.usd_24h_vol || 0), volume_24h: Number(entry.usd_24h_vol || 0), provider };
        }
        return { symbol, close: Number(entry.usd), bid: Number(entry.usd), ask: Number(entry.usd),
                 volume: Number(entry.usd_24h_vol || 0), timestamp: new Date().toISOString(), provider };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const days = (kind === "intraday") ? "1" : "2";
        const upstream = `${COINGECKO_HOST}/coins/${encodeURIComponent(gecko)}/market_chart?vs_currency=usd&days=${days}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: 30, cacheEverything: true } });
        if (!response.ok) throw new Error(`coingecko_http_${response.status}`);
        const d = await response.json();
        const prices = d.prices || [];
        const vols = d.total_volumes || [];
        if (prices.length === 0) throw new Error("coingecko_no_prices");
        const bars = prices.map((p, i) => ({
            open: Number(p[1]), high: Number(p[1]), low: Number(p[1]), close: Number(p[1]),
            volume: vols[i] ? Number(vols[i][1]) : 0,
            timestamp: new Date(p[0]).toISOString(),
            provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }
    throw new Error("coingecko_unknown_kind");
}

// ============================================================================
// PROVIDER DISPATCH — NEW PRIMARY ORDER
// ============================================================================
// Crypto:          Kraken → Binance → CoinGecko → Yahoo
// Equities/Futures: Stooq  → Yahoo
//
// The isCrypto check is CRYPTO_MAP membership. The isFutures check is
// FUTURES_MAP membership. A symbol not in either map is attempted through
// Yahoo only (the historical default).
// ============================================================================
async function dispatchProvider(symbol, kind, interval, limit) {
    const isCrypto = Boolean(CRYPTO_MAP[symbol]);
    const isFutures = Boolean(FUTURES_MAP[symbol]);
    const errors = [];

    if (isCrypto) {
        // v4.5.0: Kraken is now primary. Binance, CoinGecko, Yahoo are fallbacks.
        for (const fn of [fetchKraken, fetchBinance, fetchCoinGecko, fetchYahoo]) {
            try {
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else if (isFutures) {
        // v4.5.0: Stooq is now primary for equities/futures. Yahoo is fallback.
        const stooqSymbol = FUTURES_MAP[symbol].stooq;
        const yahooSymbol = FUTURES_MAP[symbol].yahoo;
        for (const fn of [fetchStooq, fetchYahoo]) {
            try {
                // Stooq and Yahoo expect different symbol formats. We pass the
                // canonical `symbol` to the function and let it look up the
                // provider-specific form from FUTURES_MAP.
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else {
        // Unknown symbol class. Try Yahoo with the raw symbol.
        try {
            return await fetchYahoo(symbol, kind, interval, limit);
        } catch (e) {
            errors.push(`yahoo:${e.message}`);
        }
    }
    throw new Error("all_providers_failed:" + errors.join("|"));
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
            return json({
                ok: true,
                service: "aei-relay",
                version: "4.5.0",
                gated: Boolean(env.RELAY_KEY),
                providers: ["kraken", "stooq", "binance", "coingecko", "yahoo"],
                primary_crypto: "kraken",
                primary_futures: "stooq",
                fallback_crypto: ["binance", "coingecko", "yahoo"],
                fallback_futures: ["yahoo"],
                crypto_pairs: Object.keys(CRYPTO_MAP).length,
                futures_symbols: Object.keys(FUTURES_MAP).length,
            });
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
        const limit = url.searchParams.get("limit") || "200";
        if (kind === "projection") {
            return json({ error: "projection_is_backend_only", detail: "Call /projection on the Heroku backend, not the Worker." }, 400);
        }
        try {
            const result = await dispatchProvider(symbol, kind, interval, limit);
            return json(result);
        } catch (e) {
            return json({ error: "all_providers_failed", detail: String(e), symbol, kind }, 502);
        }
    },
};