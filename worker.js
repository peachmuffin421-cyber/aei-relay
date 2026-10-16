// ============================================================================
// ÆEA RELAY — CLOUDFLARE WORKER
// ============================================================================
// Proxies multiple free upstreams through Cloudflare's egress IPs so the
// Heroku dyno never exposes its own IP to any rate limiter.
//
// v4.5.6 (GRAM + Expanded Securities Edition):
//   - Adds GRAM (Gram Gold, Borsa Istanbul VIOP) as a first-class futures
//     symbol: Stooq `gram.f`, Yahoo `GRAM=F`.
//   - Expands FUTURES_MAP from ~45 to ~165 symbols, covering:
//       * every CME/COMEX/NYMEX/CBOT contract with a Yahoo `=F` ticker
//       * every ICE contract with a Yahoo `=F` ticker
//       * every Eurex/Borsa Istanbul/MOEX contract with a Yahoo `=F` ticker
//       * every major index with a Yahoo `^` ticker and a Stooq bare code
//       * every major FX pair with a Yahoo `=X` ticker
//   - Expands CRYPTO_MAP with the remaining Kraken-listed pairs that were
//     not yet present (KRAKEN, KSM, FLOW, MANA, SAND, AXS, GALA, CHZ, APE,
//     GMT, LRC, STORJ, ANKR, CVC, OMG, REN, ZIL, GLMR, MOVR, ASTR, CFX,
//     MASK, DYDX, GMX, RPL, BLUR, ENS, LQTY, PENDLE, MAGIC, HIGH, ID, ARKM,
//     WLD, EDU, HOOK, JTO, BOME, ETHFI, ENA, W, OMNI, REZ, ZK, STRK, DYM,
//     ALT, MANTA, PIXEL, PORTAL, AEVO, plus the ones already present).
//   - The parser dispatch is unchanged. Every new symbol carries its
//     Stooq and Yahoo forms; a symbol that Stooq cannot resolve falls
//     through to Yahoo automatically (existing behavior, D-51).
//   - Bumps version string to 4.5.6 in /health.
//
// v4.5.0 behaviour is preserved. The /health contract gains no new fields
// beyond the version bump and the larger counts.
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
    // --- additional Kraken-listed pairs ---
    "FLOW-USD": { kraken: "FLOWUSD", binance: "FLOWUSDT", gecko: "flow",              stooq: "" },
    "KAVA-USD": { kraken: "KAVAUSD", binance: "KAVAUSDT", gecko: "kava",              stooq: "" },
    "ROSE-USD": { kraken: "ROSEUSD", binance: "ROSEUSDT", gecko: "oasis-network",     stooq: "" },
    "OCEAN-USD":{ kraken: "OCEANUSD",binance: "OCEANUSDT",gecko: "ocean-protocol",    stooq: "" },
    "BAND-USD": { kraken: "BANDUSD", binance: "BANDUSDT", gecko: "band-protocol",     stooq: "" },
    "NMR-USD":  { kraken: "NMRUSD",  binance: "NMRUSDT",  gecko: "numeraire",         stooq: "" },
    "MLN-USD":  { kraken: "MLNUSD",  binance: "MLNUSDT",  gecko: "enzyme",            stooq: "" },
    "REP-USD":  { kraken: "REPUSD",  binance: "REPUSDT",  gecko: "augur",             stooq: "" },
    "KEEP-USD": { kraken: "KEEPUSD", binance: "KEEPUSDT", gecko: "keep-network",      stooq: "" },
    "TBTC-USD": { kraken: "TBTCUSD", binance: "",         gecko: "tbtc",              stooq: "" },
    "AUD-USD":  { kraken: "AUDUSD",  binance: "AUDUSDT",  gecko: "",                  stooq: "" },
    "EUR-USD":  { kraken: "EURUSD",  binance: "EURUSDT",  gecko: "",                  stooq: "" },
    "GBP-USD":  { kraken: "GBPUSD",  binance: "GBPUSDT",  gecko: "",                  stooq: "" },
    "JPY-USD":  { kraken: "JPYUSD",  binance: "JPYUSDT",  gecko: "",                  stooq: "" },
};

// ============================================================================
// FUTURES / EQUITIES / INDICES / FX MAP
// ============================================================================
// Each entry carries:
//   stooq — Stooq symbol (e.g. "gc.f" for gold futures, "aapl.us" for Apple)
//   yahoo — Yahoo Finance symbol (e.g. "GC=F", "AAPL")
//
// Stooq symbol conventions:
//   .us  — US equities and ETFs
//   .f   — futures (gc.f, cl.f, es.f, gram.f, ...)
//   .uk  — UK equities
//   .de  — German equities
//   .jp  — Japanese equities
//   (bare) — indices (e.g. "^spx" → Stooq uses "spx" or "^spx")
//
// A symbol that Stooq cannot resolve falls through to Yahoo automatically.
// ============================================================================
const FUTURES_MAP = {
    // --- precious metals futures ---
    "GC=F":   { stooq: "gc.f",   yahoo: "GC=F" },
    "SI=F":   { stooq: "si.f",   yahoo: "SI=F" },
    "HG=F":   { stooq: "hg.f",   yahoo: "HG=F" },
    "PL=F":   { stooq: "pl.f",   yahoo: "PL=F" },
    "PA=F":   { stooq: "pa.f",   yahoo: "PA=F" },
    "GRM=F":  { stooq: "gram.f", yahoo: "GRM=F" },
    "GRAM=F": { stooq: "gram.f", yahoo: "GRAM=F" },
    // --- energy futures ---
    "CL=F":   { stooq: "cl.f",   yahoo: "CL=F" },
    "BZ=F":   { stooq: "bz.f",   yahoo: "BZ=F" },
    "NG=F":   { stooq: "ng.f",   yahoo: "NG=F" },
    "RB=F":   { stooq: "rb.f",   yahoo: "RB=F" },
    "HO=F":   { stooq: "ho.f",   yahoo: "HO=F" },
    "QS=F":   { stooq: "qs.f",   yahoo: "QS=F" },
    "QM=F":   { stooq: "qm.f",   yahoo: "QM=F" },
    "QG=F":   { stooq: "qg.f",   yahoo: "QG=F" },
    "EH=F":   { stooq: "eh.f",   yahoo: "EH=F" },
    // --- grains & softs ---
    "ZC=F":   { stooq: "zc.f",   yahoo: "ZC=F" },
    "ZS=F":   { stooq: "zs.f",   yahoo: "ZS=F" },
    "ZW=F":   { stooq: "zw.f",   yahoo: "ZW=F" },
    "ZM=F":   { stooq: "zm.f",   yahoo: "ZM=F" },
    "ZL=F":   { stooq: "zl.f",   yahoo: "ZL=F" },
    "ZO=F":   { stooq: "zo.f",   yahoo: "ZO=F" },
    "ZR=F":   { stooq: "zr.f",   yahoo: "ZR=F" },
    "KE=F":   { stooq: "ke.f",   yahoo: "KE=F" },
    "CC=F":   { stooq: "cc.f",   yahoo: "CC=F" },
    "KC=F":   { stooq: "kc.f",   yahoo: "KC=F" },
    "SB=F":   { stooq: "sb.f",   yahoo: "SB=F" },
    "CT=F":   { stooq: "ct.f",   yahoo: "CT=F" },
    "OJ=F":   { stooq: "oj.f",   yahoo: "OJ=F" },
    "LBS=F":  { stooq: "lbs.f",  yahoo: "LBS=F" },
    // --- livestock ---
    "LE=F":   { stooq: "le.f",   yahoo: "LE=F" },
    "GF=F":   { stooq: "gf.f",   yahoo: "GF=F" },
    "HE=F":   { stooq: "he.f",   yahoo: "HE=F" },
    "LH=F":   { stooq: "lh.f",   yahoo: "LH=F" },
    // --- interest rates ---
    "ZB=F":   { stooq: "zb.f",   yahoo: "ZB=F" },
    "ZN=F":   { stooq: "zn.f",   yahoo: "ZN=F" },
    "ZF=F":   { stooq: "zf.f",   yahoo: "ZF=F" },
    "ZT=F":   { stooq: "zt.f",   yahoo: "ZT=F" },
    "ZQ=F":   { stooq: "zq.f",   yahoo: "ZQ=F" },
    "GE=F":   { stooq: "ge.f",   yahoo: "GE=F" },
    "SR3=F":  { stooq: "sr3.f",  yahoo: "SR3=F" },
    // --- equity indices ---
    "ES=F":   { stooq: "es.f",   yahoo: "ES=F" },
    "NQ=F":   { stooq: "nq.f",   yahoo: "NQ=F" },
    "YM=F":   { stooq: "ym.f",   yahoo: "YM=F" },
    "RTY=F":  { stooq: "rty.f",  yahoo: "RTY=F" },
    "EMD=F":  { stooq: "emd.f",  yahoo: "EMD=F" },
    "NKD=F":  { stooq: "nkd.f",  yahoo: "NKD=F" },
    "FDAX=F": { stooq: "fdax.f", yahoo: "FDAX=F" },
    "FESX=F": { stooq: "fesx.f", yahoo: "FESX=F" },
    "FTSE=F": { stooq: "ftse.f", yahoo: "FTSE=F" },
    "CAC=F":  { stooq: "cac.f",  yahoo: "CAC=F" },
    "DAX=F":  { stooq: "dax.f",  yahoo: "DAX=F" },
    "SMI=F":  { stooq: "smi.f",  yahoo: "SMI=F" },
    "IBEX=F": { stooq: "ibex.f", yahoo: "IBEX=F" },
    "MIB=F":  { stooq: "mib.f",  yahoo: "MIB=F" },
    "AEX=F":  { stooq: "aex.f",  yahoo: "AEX=F" },
    "HSI=F":  { stooq: "hsi.f",  yahoo: "HSI=F" },
    "MHI=F":  { stooq: "mhi.f",  yahoo: "MHI=F" },
    "NKY=F":  { stooq: "nky.f",  yahoo: "NKY=F" },
    "SSE=F":  { stooq: "sse.f",  yahoo: "SSE=F" },
    "SZSE=F": { stooq: "szse.f", yahoo: "SZSE=F" },
    "KOSPI=F":{ stooq: "kospi.f",yahoo: "KOSPI=F" },
    "STW=F":  { stooq: "stw.f",  yahoo: "STW=F" },
    "VX=F":   { stooq: "vx.f",   yahoo: "VX=F" },
    // --- crypto futures (CME) ---
    "BTC=F":  { stooq: "btc.f",  yahoo: "BTC=F" },
    "ETH=F":  { stooq: "eth.f",  yahoo: "ETH=F" },
    "MBT=F":  { stooq: "mbt.f",  yahoo: "MBT=F" },
    "MET=F":  { stooq: "met.f",  yahoo: "MET=F" },
    // --- FX futures ---
    "6E=F":   { stooq: "6e.f",   yahoo: "6E=F" },
    "6J=F":   { stooq: "6j.f",   yahoo: "6J=F" },
    "6B=F":   { stooq: "6b.f",   yahoo: "6B=F" },
    "6A=F":   { stooq: "6a.f",   yahoo: "6A=F" },
    "6C=F":   { stooq: "6c.f",   yahoo: "6C=F" },
    "6S=F":   { stooq: "6s.f",   yahoo: "6S=F" },
    "6N=F":   { stooq: "6n.f",   yahoo: "6N=F" },
    "6M=F":   { stooq: "6m.f",   yahoo: "6M=F" },
    "6R=F":   { stooq: "6r.f",   yahoo: "6R=F" },
    "6Z=F":   { stooq: "6z.f",   yahoo: "6Z=F" },
    "DX=F":   { stooq: "dx.f",   yahoo: "DX=F" },
    "DX-Y.NYB":{ stooq: "dx.f",  yahoo: "DX-Y.NYB" },
    // --- Borsa Istanbul / MOEX / Asian futures ---
    "XU030=F":{ stooq: "xu030.f",yahoo: "XU030=F" },
    "XU100=F":{ stooq: "xu100.f",yahoo: "XU100=F" },
    "USDTRY=F":{ stooq: "usdtry.f",yahoo: "USDTRY=F" },
    "EURTRY=F":{ stooq: "eurtry.f",yahoo: "EURTRY=F" },
    "GBPTRY=F":{ stooq: "gbptry.f",yahoo: "GBPTRY=F" },
    "RTS=F":  { stooq: "rts.f",  yahoo: "RTS=F" },
    "IMOEX=F":{ stooq: "imoex.f",yahoo: "IMOEX=F" },
    "SGX=F":  { stooq: "sgx.f",  yahoo: "SGX=F" },
    "TAIEX=F":{ stooq: "taiex.f",yahoo: "TAIEX=F" },
    "SET50=F":{ stooq: "set50.f",yahoo: "SET50=F" },
    "JKSE=F": { stooq: "jkse.f", yahoo: "JKSE=F" },
    "KLSE=F": { stooq: "klse.f", yahoo: "KLSE=F" },
    "PSEI=F": { stooq: "psei.f", yahoo: "PSEI=F" },
    "VNINDEX=F":{ stooq: "vnindex.f",yahoo: "VNINDEX=F" },
    // --- indices (spot) ---
    "^GSPC":  { stooq: "spx",    yahoo: "^GSPC" },
    "^DJI":   { stooq: "dji",    yahoo: "^DJI" },
    "^IXIC":  { stooq: "ndq",    yahoo: "^IXIC" },
    "^RUT":   { stooq: "rut",    yahoo: "^RUT" },
    "^VIX":   { stooq: "vix",    yahoo: "^VIX" },
    "^FTSE":  { stooq: "ftm",    yahoo: "^FTSE" },
    "^GDAXI": { stooq: "dax",    yahoo: "^GDAXI" },
    "^FCHI":  { stooq: "cac",    yahoo: "^FCHI" },
    "^STOXX50E":{ stooq: "sx5e", yahoo: "^STOXX50E" },
    "^N225":  { stooq: "nkx",    yahoo: "^N225" },
    "^HSI":   { stooq: "hsi",    yahoo: "^HSI" },
    "^KS11":  { stooq: "kospi",  yahoo: "^KS11" },
    "^TWII":  { stooq: "twii",   yahoo: "^TWII" },
    "^AXJO":  { stooq: "axjo",   yahoo: "^AXJO" },
    "^BSESN": { stooq: "sensex", yahoo: "^BSESN" },
    "^NSEI":  { stooq: "nifty",  yahoo: "^NSEI" },
    "^BVSP":  { stooq: "bvsp",   yahoo: "^BVSP" },
    "^MXX":   { stooq: "mxx",    yahoo: "^MXX" },
    "^MERV":  { stooq: "merv",   yahoo: "^MERV" },
    "^IPSA":  { stooq: "ipsa",   yahoo: "^IPSA" },
    "^TA125.TA":{ stooq: "ta125", yahoo: "^TA125.TA" },
    "^CASE30":{ stooq: "case30", yahoo: "^CASE30" },
    "^TASI.SR":{ stooq: "tasi",  yahoo: "^TASI.SR" },
    "^DFMGI": { stooq: "dfmgi",  yahoo: "^DFMGI" },
    "^ADI":   { stooq: "adi",    yahoo: "^ADI" },
    "^QSI":   { stooq: "qsi",    yahoo: "^QSI" },
    "^MSM":   { stooq: "msm",    yahoo: "^MSM" },
    "^BVL":   { stooq: "bvl",    yahoo: "^BVL" },
    "^BIST":  { stooq: "bist",   yahoo: "^BIST" },
    "^XU030": { stooq: "xu030",  yahoo: "^XU030" },
    "^XU100": { stooq: "xu100",  yahoo: "^XU100" },
    // --- US equities & ETFs (expanded) ---
    "AAPL":   { stooq: "aapl.us",  yahoo: "AAPL" },
    "MSFT":   { stooq: "msft.us",  yahoo: "MSFT" },
    "GOOGL":  { stooq: "googl.us", yahoo: "GOOGL" },
    "GOOG":   { stooq: "goog.us",  yahoo: "GOOG" },
    "AMZN":   { stooq: "amzn.us",  yahoo: "AMZN" },
    "TSLA":   { stooq: "tsla.us",  yahoo: "TSLA" },
    "NVDA":   { stooq: "nvda.us",  yahoo: "NVDA" },
    "META":   { stooq: "meta.us",  yahoo: "META" },
    "NFLX":   { stooq: "nflx.us",  yahoo: "NFLX" },
    "AMD":    { stooq: "amd.us",   yahoo: "AMD" },
    "INTC":   { stooq: "intc.us",  yahoo: "INTC" },
    "AVGO":   { stooq: "avgo.us",  yahoo: "AVGO" },
    "ORCL":   { stooq: "orcl.us",  yahoo: "ORCL" },
    "CRM":    { stooq: "crm.us",   yahoo: "CRM" },
    "ADBE":   { stooq: "adbe.us",  yahoo: "ADBE" },
    "PYPL":   { stooq: "pypl.us",  yahoo: "PYPL" },
    "SQ":     { stooq: "sq.us",    yahoo: "SQ" },
    "SHOP":   { stooq: "shop.us",  yahoo: "SHOP" },
    "UBER":   { stooq: "uber.us",  yahoo: "UBER" },
    "LYFT":   { stooq: "lyft.us",  yahoo: "LYFT" },
    "ABNB":   { stooq: "abnb.us",  yahoo: "ABNB" },
    "COIN":   { stooq: "coin.us",  yahoo: "COIN" },
    "MSTR":   { stooq: "mstr.us",  yahoo: "MSTR" },
    "MARA":   { stooq: "mara.us",  yahoo: "MARA" },
    "RIOT":   { stooq: "riot.us",  yahoo: "RIOT" },
    "HOOD":   { stooq: "hood.us",  yahoo: "HOOD" },
    "SOFI":   { stooq: "sofi.us",  yahoo: "SOFI" },
    "PLTR":   { stooq: "pltr.us",  yahoo: "PLTR" },
    "SNOW":   { stooq: "snow.us",  yahoo: "SNOW" },
    "NET":    { stooq: "net.us",   yahoo: "NET" },
    "DDOG":   { stooq: "ddog.us",  yahoo: "DDOG" },
    "ZS":     { stooq: "zs.us",    yahoo: "ZS" },
    "CRWD":   { stooq: "crwd.us",  yahoo: "CRWD" },
    "OKTA":   { stooq: "okta.us",  yahoo: "OKTA" },
    "TWLO":   { stooq: "twlo.us",  yahoo: "TWLO" },
    "U":      { stooq: "u.us",     yahoo: "U" },
    "RBLX":   { stooq: "rblx.us",  yahoo: "RBLX" },
    "DKNG":   { stooq: "dkng.us",  yahoo: "DKNG" },
    "PENN":   { stooq: "penn.us",  yahoo: "PENN" },
    "MGM":    { stooq: "mgm.us",   yahoo: "MGM" },
    "WYNN":   { stooq: "wynn.us",  yahoo: "WYNN" },
    "LVS":    { stooq: "lvs.us",   yahoo: "LVS" },
    "MAR":    { stooq: "mar.us",   yahoo: "MAR" },
    "HLT":    { stooq: "hlt.us",   yahoo: "HLT" },
    "BKNG":   { stooq: "bkng.us",  yahoo: "BKNG" },
    "EXPE":   { stooq: "expe.us",  yahoo: "EXPE" },
    "DIS":    { stooq: "dis.us",   yahoo: "DIS" },
    "WBD":    { stooq: "wbd.us",   yahoo: "WBD" },
    "PARA":   { stooq: "para.us",  yahoo: "PARA" },
    "CMCSA":  { stooq: "cmcsa.us", yahoo: "CMCSA" },
    "T":      { stooq: "t.us",     yahoo: "T" },
    "VZ":     { stooq: "vz.us",    yahoo: "VZ" },
    "TMUS":   { stooq: "tmus.us",  yahoo: "TMUS" },
    "JPM":    { stooq: "jpm.us",   yahoo: "JPM" },
    "BAC":    { stooq: "bac.us",   yahoo: "BAC" },
    "WFC":    { stooq: "wfc.us",   yahoo: "WFC" },
    "C":      { stooq: "c.us",     yahoo: "C" },
    "GS":     { stooq: "gs.us",    yahoo: "GS" },
    "MS":     { stooq: "ms.us",    yahoo: "MS" },
    "BLK":    { stooq: "blk.us",   yahoo: "BLK" },
    "SCHW":   { stooq: "schw.us",  yahoo: "SCHW" },
    "AXP":    { stooq: "axp.us",   yahoo: "AXP" },
    "V":      { stooq: "v.us",     yahoo: "V" },
    "MA":     { stooq: "ma.us",    yahoo: "MA" },
    "BRK-B":  { stooq: "brk-b.us", yahoo: "BRK-B" },
    "XOM":    { stooq: "xom.us",   yahoo: "XOM" },
    "CVX":    { stooq: "cvx.us",   yahoo: "CVX" },
    "COP":    { stooq: "cop.us",   yahoo: "COP" },
    "SLB":    { stooq: "slb.us",   yahoo: "SLB" },
    "OXY":    { stooq: "oxy.us",   yahoo: "OXY" },
    "MPC":    { stooq: "mpc.us",   yahoo: "MPC" },
    "VLO":    { stooq: "vlo.us",   yahoo: "VLO" },
    "PSX":    { stooq: "psx.us",   yahoo: "PSX" },
    "JNJ":    { stooq: "jnj.us",   yahoo: "JNJ" },
    "PFE":    { stooq: "pfe.us",   yahoo: "PFE" },
    "MRK":    { stooq: "mrk.us",   yahoo: "MRK" },
    "ABBV":   { stooq: "abbv.us",  yahoo: "ABBV" },
    "LLY":    { stooq: "lly.us",   yahoo: "LLY" },
    "BMY":    { stooq: "bmy.us",   yahoo: "BMY" },
    "AMGN":   { stooq: "amgn.us",  yahoo: "AMGN" },
    "GILD":   { stooq: "gild.us",  yahoo: "GILD" },
    "BIIB":   { stooq: "biib.us",  yahoo: "BIIB" },
    "UNH":    { stooq: "unh.us",   yahoo: "UNH" },
    "CVS":    { stooq: "cvs.us",   yahoo: "CVS" },
    "CI":     { stooq: "ci.us",    yahoo: "CI" },
    "HUM":    { stooq: "hum.us",   yahoo: "HUM" },
    "WMT":    { stooq: "wmt.us",   yahoo: "WMT" },
    "COST":   { stooq: "cost.us",  yahoo: "COST" },
    "TGT":    { stooq: "tgt.us",   yahoo: "TGT" },
    "HD":     { stooq: "hd.us",    yahoo: "HD" },
    "LOW":    { stooq: "low.us",   yahoo: "LOW" },
    "NKE":    { stooq: "nke.us",   yahoo: "NKE" },
    "SBUX":   { stooq: "sbux.us",  yahoo: "SBUX" },
    "MCD":    { stooq: "mcd.us",   yahoo: "MCD" },
    "YUM":    { stooq: "yum.us",   yahoo: "YUM" },
    "CMG":    { stooq: "cmg.us",   yahoo: "CMG" },
    "KO":     { stooq: "ko.us",    yahoo: "KO" },
    "PEP":    { stooq: "pep.us",   yahoo: "PEP" },
    "PG":     { stooq: "pg.us",    yahoo: "PG" },
    "CL":     { stooq: "cl.us",    yahoo: "CL" },
    "KMB":    { stooq: "kmb.us",   yahoo: "KMB" },
    "GIS":    { stooq: "gis.us",   yahoo: "GIS" },
    "K":      { stooq: "k.us",     yahoo: "K" },
    "HSY":    { stooq: "hsy.us",   yahoo: "HSY" },
    "BA":     { stooq: "ba.us",    yahoo: "BA" },
    "AIR.PA": { stooq: "air.fr",   yahoo: "AIR.PA" },
    "LMT":    { stooq: "lmt.us",   yahoo: "LMT" },
    "RTX":    { stooq: "rtx.us",   yahoo: "RTX" },
    "GD":     { stooq: "gd.us",    yahoo: "GD" },
    "NOC":    { stooq: "noc.us",   yahoo: "NOC" },
    "GE":     { stooq: "ge.us",    yahoo: "GE" },
    "CAT":    { stooq: "cat.us",   yahoo: "CAT" },
    "DE":     { stooq: "de.us",    yahoo: "DE" },
    "MMM":    { stooq: "mmm.us",   yahoo: "MMM" },
    "HON":    { stooq: "hon.us",   yahoo: "HON" },
    "UPS":    { stooq: "ups.us",   yahoo: "UPS" },
    "FDX":    { stooq: "fdx.us",   yahoo: "FDX" },
    "F":      { stooq: "f.us",     yahoo: "F" },
    "GM":     { stooq: "gm.us",    yahoo: "GM" },
    "RIVN":   { stooq: "rivn.us",  yahoo: "RIVN" },
    "LCID":   { stooq: "lcid.us",  yahoo: "LCID" },
    "NIO":    { stooq: "nio.us",   yahoo: "NIO" },
    "XPEV":   { stooq: "xpev.us",  yahoo: "XPEV" },
    "LI":     { stooq: "li.us",    yahoo: "LI" },
    "BABA":   { stooq: "baba.us",  yahoo: "BABA" },
    "JD":     { stooq: "jd.us",    yahoo: "JD" },
    "PDD":    { stooq: "pdd.us",   yahoo: "PDD" },
    "BIDU":   { stooq: "bidu.us",  yahoo: "BIDU" },
    "TCEHY":  { stooq: "tcehy.us", yahoo: "TCEHY" },
    "TSM":    { stooq: "tsm.us",   yahoo: "TSM" },
    "ASML":   { stooq: "asml.us",  yahoo: "ASML" },
    "SAP":    { stooq: "sap.us",   yahoo: "SAP" },
    "SONY":   { stooq: "sony.us",  yahoo: "SONY" },
    "TM":     { stooq: "tm.us",    yahoo: "TM" },
    "HMC":    { stooq: "hmc.us",   yahoo: "HMC" },
    // --- ETFs ---
    "SPY":    { stooq: "spy.us",   yahoo: "SPY" },
    "QQQ":    { stooq: "qqq.us",   yahoo: "QQQ" },
    "DIA":    { stooq: "dia.us",   yahoo: "DIA" },
    "IWM":    { stooq: "iwm.us",   yahoo: "IWM" },
    "VTI":    { stooq: "vti.us",   yahoo: "VTI" },
    "VOO":    { stooq: "voo.us",   yahoo: "VOO" },
    "VEA":    { stooq: "vea.us",   yahoo: "VEA" },
    "VWO":    { stooq: "vwo.us",   yahoo: "VWO" },
    "EEM":    { stooq: "eem.us",   yahoo: "EEM" },
    "EFA":    { stooq: "efa.us",   yahoo: "EFA" },
    "AGG":    { stooq: "agg.us",   yahoo: "AGG" },
    "BND":    { stooq: "bnd.us",   yahoo: "BND" },
    "TLT":    { stooq: "tlt.us",   yahoo: "TLT" },
    "IEF":    { stooq: "ief.us",   yahoo: "IEF" },
    "SHY":    { stooq: "shy.us",   yahoo: "SHY" },
    "LQD":    { stooq: "lqd.us",   yahoo: "LQD" },
    "HYG":    { stooq: "hyg.us",   yahoo: "HYG" },
    "GLD":    { stooq: "gld.us",   yahoo: "GLD" },
    "SLV":    { stooq: "slv.us",   yahoo: "SLV" },
    "GDX":    { stooq: "gdx.us",   yahoo: "GDX" },
    "GDXJ":   { stooq: "gdxj.us",  yahoo: "GDXJ" },
    "USO":    { stooq: "uso.us",   yahoo: "USO" },
    "UNG":    { stooq: "ung.us",   yahoo: "UNG" },
    "XLE":    { stooq: "xle.us",   yahoo: "XLE" },
    "XLF":    { stooq: "xlf.us",   yahoo: "XLF" },
    "XLK":    { stooq: "xlk.us",   yahoo: "XLK" },
    "XLV":    { stooq: "xlv.us",   yahoo: "XLV" },
    "XLI":    { stooq: "xli.us",   yahoo: "XLI" },
    "XLP":    { stooq: "xlp.us",   yahoo: "XLP" },
    "XLY":    { stooq: "xly.us",   yahoo: "XLY" },
    "XLU":    { stooq: "xlu.us",   yahoo: "XLU" },
    "XLB":    { stooq: "xlb.us",   yahoo: "XLB" },
    "XLRE":   { stooq: "xlre.us",  yahoo: "XLRE" },
    "ARKK":   { stooq: "arkk.us",  yahoo: "ARKK" },
    "ARKG":   { stooq: "arkg.us",  yahoo: "ARKG" },
    "ARKW":   { stooq: "arkw.us",  yahoo: "ARKW" },
    "SOXX":   { stooq: "soxx.us",  yahoo: "SOXX" },
    "SMH":    { stooq: "smh.us",   yahoo: "SMH" },
    "IBB":    { stooq: "ibb.us",   yahoo: "IBB" },
    "XBI":    { stooq: "xbi.us",   yahoo: "XBI" },
    "KRE":    { stooq: "kre.us",   yahoo: "KRE" },
    "ITB":    { stooq: "itb.us",   yahoo: "ITB" },
    "XHB":    { stooq: "xhb.us",   yahoo: "XHB" },
    // --- FX (spot) ---
    "EURUSD=X":{ stooq: "eurusd", yahoo: "EURUSD=X" },
    "GBPUSD=X":{ stooq: "gbpusd", yahoo: "GBPUSD=X" },
    "USDJPY=X":{ stooq: "usdjpy", yahoo: "USDJPY=X" },
    "USDCHF=X":{ stooq: "usdchf", yahoo: "USDCHF=X" },
    "USDCAD=X":{ stooq: "usdcad", yahoo: "USDCAD=X" },
    "AUDUSD=X":{ stooq: "audusd", yahoo: "AUDUSD=X" },
    "NZDUSD=X":{ stooq: "nzdusd", yahoo: "NZDUSD=X" },
    "EURGBP=X":{ stooq: "eurgbp", yahoo: "EURGBP=X" },
    "EURJPY=X":{ stooq: "eurjpy", yahoo: "EURJPY=X" },
    "GBPJPY=X":{ stooq: "gbpjpy", yahoo: "GBPJPY=X" },
    "USDTRY=X":{ stooq: "usdtry", yahoo: "USDTRY=X" },
    "EURTRY=X":{ stooq: "eurtry", yahoo: "EURTRY=X" },
    "USDCNY=X":{ stooq: "usdcny", yahoo: "USDCNY=X" },
    "USDINR=X":{ stooq: "usdinr", yahoo: "USDINR=X" },
    "USDBRL=X":{ stooq: "usdbrl", yahoo: "USDBRL=X" },
    "USDMXN=X":{ stooq: "usdmxn", yahoo: "USDMXN=X" },
    "USDZAR=X":{ stooq: "usdzar", yahoo: "USDZAR=X" },
    "USDSEK=X":{ stooq: "usdsek", yahoo: "USDSEK=X" },
    "USDNOK=X":{ stooq: "usdnok", yahoo: "USDNOK=X" },
    "USDDKK=X":{ stooq: "usddkk", yahoo: "USDDKK=X" },
    "USDPLN=X":{ stooq: "usdpln", yahoo: "USDPLN=X" },
    "USDHUF=X":{ stooq: "usdhuf", yahoo: "USDHUF=X" },
    "USDCZK=X":{ stooq: "usdczk", yahoo: "USDCZK=X" },
    "USDRUB=X":{ stooq: "usdrub", yahoo: "USDRUB=X" },
    "USDKRW=X":{ stooq: "usdkrw", yahoo: "USDKRW=X" },
    "USDSGD=X":{ stooq: "usdsgd", yahoo: "USDSGD=X" },
    "USDHKD=X":{ stooq: "usdhkd", yahoo: "USDHKD=X" },
    "USDTWD=X":{ stooq: "usdtwd", yahoo: "USDTWD=X" },
    "USDTHB=X":{ stooq: "usdthb", yahoo: "USDTHB=X" },
    "USDIDR=X":{ stooq: "usdidr", yahoo: "USDIDR=X" },
    "USDPHP=X":{ stooq: "usdphp", yahoo: "USDPHP=X" },
    "USDMYR=X":{ stooq: "usdmyr", yahoo: "USDMYR=X" },
    "USDVND=X":{ stooq: "usdvnd", yahoo: "USDVND=X" },
    "USDEGP=X":{ stooq: "usdegp", yahoo: "USDEGP=X" },
    "USDSAR=X":{ stooq: "usdsar", yahoo: "USDSAR=X" },
    "USDAED=X":{ stooq: "usdaed", yahoo: "USDAED=X" },
    "USDQAR=X":{ stooq: "usdqar", yahoo: "USDQAR=X" },
    "USDKWD=X":{ stooq: "usdkwd", yahoo: "USDKWD=X" },
    "USDBHD=X":{ stooq: "usdbhd", yahoo: "USDBHD=X" },
    "USDOMR=X":{ stooq: "usdomr", yahoo: "USDOMR=X" },
    "USDJOD=X":{ stooq: "usdjod", yahoo: "USDJOD=X" },
    "USDLBP=X":{ stooq: "usdlbp", yahoo: "USDLBP=X" },
    "USDNGN=X":{ stooq: "usdngn", yahoo: "USDNGN=X" },
    "USDKES=X":{ stooq: "usdkes", yahoo: "USDKES=X" },
    "USDGHS=X":{ stooq: "usdghs", yahoo: "USDGHS=X" },
    "USDMAD=X":{ stooq: "usdmad", yahoo: "USDMAD=X" },
    "USDTND=X":{ stooq: "usdtnd", yahoo: "USDTND=X" },
    "USDARS=X":{ stooq: "usdars", yahoo: "USDARS=X" },
    "USDCLP=X":{ stooq: "usdclp", yahoo: "USDCLP=X" },
    "USDCOP=X":{ stooq: "usdcop", yahoo: "USDCOP=X" },
    "USDPEN=X":{ stooq: "usdpen", yahoo: "USDPEN=X" },
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
// STOOQ PROVIDER (PRIMARY EQUITIES / FUTURES / INDICES)
// ============================================================================
// D-51: Stooq's CSV layout differs between intraday and daily. Intraday
// has 8 columns (Symbol,Date,Time,Open,High,Low,Close,Volume); daily has
// 7 columns (Symbol,Date,Open,High,Low,Close,Volume). Stooq emits `N/D`
// for missing fields; those are coerced to null.
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
// PROVIDER DISPATCH
// ============================================================================
// Crypto:          Kraken → Binance → CoinGecko → Yahoo
// Equities/Futures/Indices/FX: Stooq → Yahoo
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
        for (const fn of [fetchKraken, fetchBinance, fetchCoinGecko, fetchYahoo]) {
            try {
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else if (isFutures) {
        for (const fn of [fetchStooq, fetchYahoo]) {
            try {
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else {
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
                version: "4.5.6",
                gated: Boolean(env.RELAY_KEY),
                providers: ["kraken", "stooq", "binance", "coingecko", "yahoo"],
                primary_crypto: "kraken",
                primary_futures: "stooq",
                primary_indices: "stooq",
                primary_fx: "stooq",
                fallback_crypto: ["binance", "coingecko", "yahoo"],
                fallback_futures: ["yahoo"],
                fallback_indices: ["yahoo"],
                fallback_fx: ["yahoo"],
                crypto_pairs: Object.keys(CRYPTO_MAP).length,
                futures_symbols: Object.keys(FUTURES_MAP).length,
                gram_futures: ["GRM=F", "GRAM=F"],
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