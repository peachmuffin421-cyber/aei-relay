// ============================================================================
// ÆEA RELAY — CLOUDFLARE WORKER
// ============================================================================
// Proxies multiple free upstreams through Cloudflare's egress IPs so the
// Heroku dyno never exposes its own IP to any rate limiter.
//
// v4.5.6 (Expanded-Universe Edition):
//   - Adds GRAM-USD (TON / The Open Network) to the crypto map. Kraken
//     lists it as TONUSD; Binance as TONUSDT; CoinGecko id
//     "the-open-network". Stooq does not carry it. The canonical request
//     form is GRAM-USD; the parser is key-agnostic (D-49), so the Kraken
//     response key (XTONUSD or TONUSD depending on Kraken's current
//     naming) does not matter.
//   - Expands CRYPTO_MAP to ~200 pairs (adds TON, NEAR-adjacent L1s,
//     memecoins, DeFi blue chips, and the full Kraken/Binance overlap).
//   - Expands FUTURES_MAP to ~70 contracts (adds micros, more ags,
//     more energies, more rates).
//   - Adds EQUITIES_MAP with ~500 US equities and ETFs (Stooq-primary,
//     Yahoo fallback).
//   - Adds FOREX_MAP with ~30 major/minor pairs (Yahoo only; Stooq does
//     not carry FX in a stable CSV shape).
//   - Adds INDICES_MAP with ~15 major world indices (Yahoo only).
//   - dispatchProvider() now routes by class: crypto → Kraken → Binance
//     → CoinGecko → Yahoo; futures/equities → Stooq → Yahoo; forex →
//     Yahoo; indices → Yahoo; unknown → Yahoo.
//   - /health payload gains forex_pairs, equities_symbols, indices
//     counts.
//   - D-49/D-50/D-51/D-52 parser fixes preserved verbatim.
//   - All v4.5.0 provider-order semantics preserved.
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
//   kraken  — Kraken pair name for Ticker/OHLC (request form)
//   binance — Binance pair name for klines/ticker
//   gecko   — CoinGecko id for simple/price and market_chart
//   stooq   — Stooq symbol (rarely populated for crypto)
//
// The parser is key-agnostic (D-49), so the response key returned by
// Kraken does not need to match the request form.
// ============================================================================
const CRYPTO_MAP = {
    // --- top caps ---
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

    // --- GRAM / TON (The Open Network) ---
    // Kraken lists it as TONUSD; Binance as TONUSDT; CoinGecko id is
    // "the-open-network". The legacy GRAM ticker was renamed to TON after
    // the Telegram-SEC settlement, but the canonical request form here is
    // GRAM-USD so the user can address it by its historical name.
    "GRAM-USD": { kraken: "TONUSD",  binance: "TONUSDT",  gecko: "the-open-network",  stooq: "" },
    "TON-USD":  { kraken: "TONUSD",  binance: "TONUSDT",  gecko: "the-open-network",  stooq: "" },

    // --- L1 / L2 ---
    "ARB-USD":  { kraken: "ARBUSD",  binance: "ARBUSDT",  gecko: "arbitrum",          stooq: "" },
    "OP-USD":   { kraken: "OPUSD",   binance: "OPUSDT",   gecko: "optimism",          stooq: "" },
    "SUI-USD":  { kraken: "SUIUSD",  binance: "SUIUSDT",  gecko: "sui",               stooq: "" },
    "APT-USD":  { kraken: "APTUSD",  binance: "APTUSDT",  gecko: "aptos",             stooq: "" },
    "INJ-USD":  { kraken: "INJUSD",  binance: "INJUSDT",  gecko: "injective-protocol",stooq: "" },
    "TIA-USD":  { kraken: "TIAUSD",  binance: "TIAUSDT",  gecko: "celestia",          stooq: "" },
    "SEI-USD":  { kraken: "SEIUSD",  binance: "SEIUSDT",  gecko: "sei-network",       stooq: "" },
    "STX-USD":  { kraken: "STXUSD",  binance: "STXUSDT",  gecko: "blockstack",        stooq: "" },
    "IMX-USD":  { kraken: "IMXUSD",  binance: "IMXUSDT",  gecko: "immutable-x",       stooq: "" },
    "MINA-USD": { kraken: "MINAUSD", binance: "MINAUSDT", gecko: "mina-protocol",     stooq: "" },
    "FLOW-USD": { kraken: "FLOWUSD", binance: "FLOWUSDT", gecko: "flow",              stooq: "" },
    "EGLD-USD": { kraken: "EGLDUSD", binance: "EGLDUSDT", gecko: "elrond-erd-2",      stooq: "" },
    "XTZ-USD":  { kraken: "XTZUSD",  binance: "XTZUSDT",  gecko: "tezos",             stooq: "" },
    "ALGO-USD": { kraken: "ALGOUSD", binance: "ALGOUSDT", gecko: "algorand",          stooq: "" },
    "VET-USD":  { kraken: "VETUSD",  binance: "VETUSDT",  gecko: "vechain",           stooq: "" },
    "THETA-USD":{ kraken: "THETAUSD",binance: "THETAUSDT",gecko: "theta-token",       stooq: "" },
    "FTM-USD":  { kraken: "FTMUSD",  binance: "FTMUSDT",  gecko: "fantom",            stooq: "" },
    "ONE-USD":  { kraken: "ONEUSD",  binance: "ONEUSDT",  gecko: "harmony",           stooq: "" },
    "ZIL-USD":  { kraken: "ZILUSD",  binance: "ZILUSDT",  gecko: "zilliqa",           stooq: "" },
    "KSM-USD":  { kraken: "KSMUSD",  binance: "KSMUSDT",  gecko: "kusama",            stooq: "" },
    "GLMR-USD": { kraken: "GLMRUSD", binance: "GLMRUSDT", gecko: "moonbeam",          stooq: "" },
    "MOVR-USD": { kraken: "MOVRUSD", binance: "MOVRUSDT", gecko: "moonriver",         stooq: "" },
    "ASTR-USD": { kraken: "ASTRUSD", binance: "ASTRUSDT", gecko: "astar",             stooq: "" },
    "CFX-USD":  { kraken: "CFXUSD",  binance: "CFXUSDT",  gecko: "conflux-token",     stooq: "" },
    "ROSE-USD": { kraken: "ROSEUSD", binance: "ROSEUSDT", gecko: "oasis-network",     stooq: "" },
    "KAVA-USD": { kraken: "KAVAUSD", binance: "KAVAUSDT", gecko: "kava",              stooq: "" },
    "CELO-USD": { kraken: "CELOUSD", binance: "CELOUSDT", gecko: "celo",              stooq: "" },
    "IOTX-USD": { kraken: "IOTXUSD", binance: "IOTXUSDT", gecko: "iotex",             stooq: "" },
    "CKB-USD":  { kraken: "CKBUSD",  binance: "CKBUSDT",  gecko: "nervos-network",    stooq: "" },
    "AR-USD":   { kraken: "ARUSD",   binance: "ARUSDT",   gecko: "arweave",           stooq: "" },
    "DYM-USD":  { kraken: "DYMUSD",  binance: "DYMUSDT",  gecko: "dymension",         stooq: "" },
    "ALT-USD":  { kraken: "ALTUSD",  binance: "ALTUSDT",  gecko: "altlayer",          stooq: "" },
    "MANTA-USD":{ kraken: "MANTAUSD",binance: "MANTAUSDT",gecko: "manta-network",     stooq: "" },
    "ZK-USD":   { kraken: "ZKUSD",   binance: "ZKUSDT",   gecko: "zksync",            stooq: "" },
    "STRK-USD": { kraken: "STRKUSD", binance: "STRKUSDT", gecko: "starknet",          stooq: "" },
    "BLUR-USD": { kraken: "BLURUSD", binance: "BLURUSDT", gecko: "blur",              stooq: "" },

    // --- DeFi ---
    "AAVE-USD": { kraken: "AAVEUSD", binance: "AAVEUSDT", gecko: "aave",              stooq: "" },
    "MKR-USD":  { kraken: "MKRUSD",  binance: "MKRUSDT",  gecko: "maker",             stooq: "" },
    "COMP-USD": { kraken: "COMPUSD", binance: "COMPUSDT", gecko: "compound-governance-token", stooq: "" },
    "CRV-USD":  { kraken: "CRVUSD",  binance: "CRVUSDT",  gecko: "curve-dao-token",   stooq: "" },
    "SNX-USD":  { kraken: "SNXUSD",  binance: "SNXUSDT",  gecko: "havven",            stooq: "" },
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
    "LDO-USD":  { kraken: "LDOUSD",  binance: "LDOUSDT",  gecko: "lido-dao",          stooq: "" },
    "RPL-USD":  { kraken: "RPLUSD",  binance: "RPLUSDT",  gecko: "rocket-pool",       stooq: "" },
    "GMX-USD":  { kraken: "GMXUSD",  binance: "GMXUSDT",  gecko: "gmx",               stooq: "" },
    "DYDX-USD": { kraken: "DYDXUSD", binance: "DYDXUSDT", gecko: "dydx-chain",        stooq: "" },
    "PENDLE-USD":{ kraken: "PENDLEUSD",binance: "PENDLEUSDT",gecko: "pendle",         stooq: "" },
    "LQTY-USD": { kraken: "LQTYUSD", binance: "LQTYUSDT", gecko: "liquity",           stooq: "" },
    "ENS-USD":  { kraken: "ENSUSD",  binance: "ENSUSDT",  gecko: "ethereum-name-service", stooq: "" },
    "1INCH-USD":{ kraken: "1INCHUSD",binance: "1INCHUSDT",gecko: "1inch",             stooq: "" },
    "OCEAN-USD":{ kraken: "OCEANUSD",binance: "OCEANUSDT",gecko: "ocean-protocol",    stooq: "" },
    "FET-USD":  { kraken: "FETUSD",  binance: "FETUSDT",  gecko: "fetch-ai",          stooq: "" },
    "GRT-USD":  { kraken: "GRTUSD",  binance: "GRTUSDT",  gecko: "the-graph",         stooq: "" },

    // --- memecoins ---
    "PEPE-USD": { kraken: "PEPEUSD", binance: "PEPEUSDT", gecko: "pepe",              stooq: "" },
    "SHIB-USD": { kraken: "SHIBUSD", binance: "SHIBUSDT", gecko: "shiba-inu",         stooq: "" },
    "WIF-USD":  { kraken: "WIFUSD",  binance: "WIFUSDT",  gecko: "dogwifcoin",        stooq: "" },
    "BONK-USD": { kraken: "BONKUSD", binance: "BONKUSDT", gecko: "bonk",              stooq: "" },
    "FLOKI-USD":{ kraken: "FLOKIUSD",binance: "FLOKIUSDT",gecko: "floki",             stooq: "" },
    "MEME-USD": { kraken: "MEMEUSD", binance: "MEMEUSDT", gecko: "memecoin",          stooq: "" },
    "BOME-USD": { kraken: "BOMEUSD", binance: "BOMEUSDT", gecko: "book-of-meme",      stooq: "" },
    "MOG-USD":  { kraken: "MOGUSD",  binance: "MOGUSDT",  gecko: "mog-coin",          stooq: "" },

    // --- Solana ecosystem ---
    "JUP-USD":  { kraken: "JUPUSD",  binance: "JUPUSDT",  gecko: "jupiter-exchange-solana", stooq: "" },
    "PYTH-USD": { kraken: "PYTHUSD", binance: "PYTHUSDT", gecko: "pyth-network",      stooq: "" },
    "JTO-USD":  { kraken: "JTOUSD",  binance: "JTOUSDT",  gecko: "jito-governance-token", stooq: "" },
    "RNDR-USD": { kraken: "RNDRUSD", binance: "RNDRUSDT", gecko: "render-token",      stooq: "" },

    // --- AI / data ---
    "WLD-USD":  { kraken: "WLDUSD",  binance: "WLDUSDT",  gecko: "worldcoin-wld",     stooq: "" },
    "ARKM-USD": { kraken: "ARKMUSD", binance: "ARKMUSDT", gecko: "arkham",            stooq: "" },
    "AI-USD":   { kraken: "AIUSD",   binance: "AIUSDT",   gecko: "sleepless-ai",      stooq: "" },
    "TAO-USD":  { kraken: "TAOUSD",  binance: "TAOUSDT",  gecko: "bittensor",         stooq: "" },

    // --- payment / legacy ---
    "BCH-USD":  { kraken: "BCHUSD",  binance: "BCHUSDT",  gecko: "bitcoin-cash",      stooq: "bchusd" },
    "BSV-USD":  { kraken: "BSVUSD",  binance: "BSVUSDT",  gecko: "bitcoin-cash-sv",   stooq: "" },
    "XMR-USD":  { kraken: "XMRUSD",  binance: "XMRUSDT",  gecko: "monero",            stooq: "xmrusd" },
    "DASH-USD": { kraken: "DASHUSD", binance: "DASHUSDT", gecko: "dash",              stooq: "dashusd" },
    "ZEC-USD":  { kraken: "ZECUSD",  binance: "ZECUSDT",  gecko: "zcash",             stooq: "zecusd" },
    "EOS-USD":  { kraken: "EOSUSD",  binance: "EOSUSDT",  gecko: "eos",               stooq: "eosusd" },
    "TRX-USD":  { kraken: "TRXUSD",  binance: "TRXUSDT",  gecko: "tron",              stooq: "trxusd" },
    "NEO-USD":  { kraken: "NEOUSD",  binance: "NEOUSDT",  gecko: "neo",               stooq: "" },
    "WAVES-USD":{ kraken: "WAVESUSD",binance: "WAVESUSDT",gecko: "waves",             stooq: "" },
    "IOTA-USD": { kraken: "IOTAUSD", binance: "IOTAUSDT", gecko: "iota",              stooq: "" },
    "QTUM-USD": { kraken: "QTUMUSD", binance: "QTUMUSDT", gecko: "qtum",              stooq: "" },
    "DGB-USD":  { kraken: "DGBUSD",  binance: "DGBUSDT",  gecko: "digibyte",          stooq: "" },
    "LSK-USD":  { kraken: "LSKUSD",  binance: "LSKUSDT",  gecko: "lisk",              stooq: "" },
    "SC-USD":   { kraken: "SCUSD",   binance: "SCUSDT",   gecko: "siacoin",           stooq: "" },
    "RVN-USD":  { kraken: "RVNUSD",  binance: "RVNUSDT",  gecko: "ravencoin",         stooq: "" },
    "ETC-USD2": { kraken: "ETCUSD",  binance: "ETCUSDT",  gecko: "ethereum-classic",  stooq: "" },
    "KAS-USD":  { kraken: "KASUSD",  binance: "KASUSDT",  gecko: "kaspa",             stooq: "" },

    // --- stablecoins (for reference; usually not traded against) ---
    "USDT-USD": { kraken: "USDTUSD", binance: "USDCUSDT", gecko: "tether",            stooq: "" },
    "USDC-USD": { kraken: "USDCUSD", binance: "USDCUSDT", gecko: "usd-coin",          stooq: "" },
    "DAI-USD":  { kraken: "DAIUSD",  binance: "DAIUSDT",  gecko: "dai",               stooq: "" },

    // --- exchange tokens ---
    "BNB-USD":  { kraken: "BNBUSD",  binance: "BNBUSDT",  gecko: "binancecoin",       stooq: "" },
    "OKB-USD":  { kraken: "OKBUSD",  binance: "OKBUSDT",  gecko: "okb",               stooq: "" },
    "HT-USD":   { kraken: "HTUSD",   binance: "HTUSDT",   gecko: "huobi-token",       stooq: "" },
    "KCS-USD":  { kraken: "KCSUSD",  binance: "KCSUSDT",  gecko: "kucoin-shares",     stooq: "" },

    // --- newer L1/L2 ---
    "W-USD":    { kraken: "WUSD",    binance: "WUSDT",    gecko: "wormhole",          stooq: "" },
    "OMNI-USD": { kraken: "OMNIUSD", binance: "OMNIUSDT", gecko: "omni-network",      stooq: "" },
    "REZ-USD":  { kraken: "REZUSD",  binance: "REZUSDT",  gecko: "renzo",             stooq: "" },
    "ETHFI-USD":{ kraken: "ETHFIUSD",binance: "ETHFIUSDT",gecko: "ether-fi",          stooq: "" },
    "ENA-USD":  { kraken: "ENAUSD",  binance: "ENAUSDT",  gecko: "ethena",            stooq: "" },
    "EIGEN-USD":{ kraken: "EIGENUSD",binance: "EIGENUSDT",gecko: "eigenlayer",        stooq: "" },
    "MOVE-USD": { kraken: "MOVEUSD", binance: "MOVEUSDT", gecko: "movement",          stooq: "" },
    "ME-USD":   { kraken: "MEUSD",   binance: "MEUSDT",   gecko: "magic-eden",        stooq: "" },
    "PNUT-USD": { kraken: "PNUTUSD", binance: "PNUTUSDT", gecko: "peanut-the-squirrel", stooq: "" },
    "ACT-USD":  { kraken: "ACTUSD",  binance: "ACTUSDT",  gecko: "act-i-the-ai-prophecy", stooq: "" },
    "GOAT-USD": { kraken: "GOATUSDT",binance: "GOATUSDT", gecko: "goatseus-maximus",  stooq: "" },
    "MOODENG-USD":{ kraken: "MOODENGUSD",binance: "MOODENGUSDT",gecko: "moo-deng",  stooq: "" },
    "POPCAT-USD":{ kraken: "POPCATUSD",binance: "POPCATUSDT",gecko: "popcat",        stooq: "" },
    "NEIRO-USD":{ kraken: "NEIROUSD",binance: "NEIROUSDT",gecko: "neiro-3",          stooq: "" },
    "TURBO-USD":{ kraken: "TURBOUSD",binance: "TURBOUSDT",gecko: "turbo",            stooq: "" },
    "MEW-USD":  { kraken: "MEWUSD",  binance: "MEWUSDT",  gecko: "cat-in-a-dogs-world", stooq: "" },
    "BRETT-USD":{ kraken: "BRETTUSD",binance: "BRETTUSDT",gecko: "based-brett",      stooq: "" },
    "TOSHI-USD":{ kraken: "TOSHIUSD",binance: "TOSHIUSDT",gecko: "toshi",            stooq: "" },
    "DEGEN-USD":{ kraken: "DEGENUSD",binance: "DEGENUSDT",gecko: "degen-base",       stooq: "" },
    "HIGH-USD": { kraken: "HIGHUSD", binance: "HIGHUSDT", gecko: "highstreet",        stooq: "" },
    "ID-USD":   { kraken: "IDUSD",   binance: "IDUSDT",   gecko: "space-id",          stooq: "" },
    "EDU-USD":  { kraken: "EDUUSD",  binance: "EDUUSDT",  gecko: "open-campus",       stooq: "" },
    "HOOK-USD": { kraken: "HOOKUSD", binance: "HOOKUSDT", gecko: "hooked-protocol",   stooq: "" },
    "MAGIC-USD":{ kraken: "MAGICUSD",binance: "MAGICUSDT",gecko: "magic",             stooq: "" },
    "PIXEL-USD":{ kraken: "PIXELUSD",binance: "PIXELUSDT",gecko: "pixels",            stooq: "" },
    "PORTAL-USD":{ kraken: "PORTALUSD",binance: "PORTALUSDT",gecko: "portal",         stooq: "" },
    "AEVO-USD": { kraken: "AEVOUSD", binance: "AEVOUSDT", gecko: "aevo",              stooq: "" },
    "MASK-USD": { kraken: "MASKUSD", binance: "MASKUSDT", gecko: "mask-network",      stooq: "" },
    "CYBER-USD":{ kraken: "CYBERUSD",binance: "CYBERUSDT",gecko: "cyberconnect",      stooq: "" },
    "RDNT-USD": { kraken: "RDNTUSD", binance: "RDNTUSDT", gecko: "radiant-capital",   stooq: "" },
    "MUBI-USD": { kraken: "MUBIUSD", binance: "MUBIUSDT", gecko: "multibit",          stooq: "" },
    "BIGTIME-USD":{ kraken: "BIGTIMEUSD",binance: "BIGTIMEUSDT",gecko: "big-time",    stooq: "" },
    "NTRN-USD": { kraken: "NTRNUSD", binance: "NTRNUSDT", gecko: "neutron-3",         stooq: "" },
    "SXP-USD":  { kraken: "SXPUSD",  binance: "SXPUSDT",  gecko: "swipe",             stooq: "" },
    "TRB-USD":  { kraken: "TRBUSD",  binance: "TRBUSDT",  gecko: "tellor",            stooq: "" },
    "UMA-USD":  { kraken: "UMAUSD",  binance: "UMAUSDT",  gecko: "uma",               stooq: "" },
    "API3-USD": { kraken: "API3USD", binance: "API3USDT", gecko: "api3",              stooq: "" },
    "BAND-USD": { kraken: "BANDUSD", binance: "BANDUSDT", gecko: "band-protocol",     stooq: "" },
    "CTSI-USD": { kraken: "CTSIUSD", binance: "CTSIUSDT", gecko: "cartesi",           stooq: "" },
    "NMR-USD":  { kraken: "NMRUSD",  binance: "NMRUSDT",  gecko: "numeraire",         stooq: "" },
    "REQ-USD":  { kraken: "REQUSD",  binance: "REQUSDT",  gecko: "request-network",   stooq: "" },
    "POWR-USD": { kraken: "POWRUSD", binance: "POWRUSDT", gecko: "power-ledger",      stooq: "" },
    "RLC-USD":  { kraken: "RLCUSD",  binance: "RLCUSDT",  gecko: "iexec-rlc",         stooq: "" },
    "OGN-USD":  { kraken: "OGNUSD",  binance: "OGNUSDT",  gecko: "origin-protocol",   stooq: "" },
    "SNT-USD":  { kraken: "SNTUSD",  binance: "SNTUSDT",  gecko: "status",            stooq: "" },
    "MLN-USD":  { kraken: "MLNUSD",  binance: "MLNUSDT",  gecko: "enzyme",            stooq: "" },
    "KEEP-USD": { kraken: "KEEPUSD", binance: "KEEPUSDT", gecko: "keep-network",      stooq: "" },
    "TBTC-USD": { kraken: "TBTCUSD", binance: "TBTCUSDT", gecko: "tbtc",              stooq: "" },
    "WAXL-USD": { kraken: "WAXLUSD", binance: "WAXLUSDT", gecko: "axelar",            stooq: "" },
    "OSMO-USD": { kraken: "OSMOUSD", binance: "OSMOUSDT", gecko: "osmosis",           stooq: "" },
    "JUNO-USD": { kraken: "JUNOUSD", binance: "JUNOUSDT", gecko: "juno-network",      stooq: "" },
    "AKT-USD":  { kraken: "AKTUSD",  binance: "AKTUSDT",  gecko: "akash-network",     stooq: "" },
    "SCRT-USD": { kraken: "SCRTUSD", binance: "SCRTUSDT", gecko: "secret",            stooq: "" },
    "DVPN-USD": { kraken: "DVPNUSD", binance: "DVPNUSDT", gecko: "sentinel",          stooq: "" },
    "IRIS-USD": { kraken: "IRISUSD", binance: "IRISUSDT", gecko: "iris-network",      stooq: "" },
    "CTK-USD":  { kraken: "CTKUSD",  binance: "CTKUSDT",  gecko: "certik",            stooq: "" },
    "STRAX-USD":{ kraken: "STRAXUSD",binance: "STRAXUSDT",gecko: "stratis",           stooq: "" },
    "PUNDIX-USD":{ kraken: "PUNDIXUSD",binance: "PUNDIXUSDT",gecko: "pundi-x-2",      stooq: "" },
    "FXS-USD":  { kraken: "FXSUSD",  binance: "FXSUSDT",  gecko: "frax-share",        stooq: "" },
    "FRAX-USD": { kraken: "FRAXUSD", binance: "FRAXUSDT", gecko: "frax",              stooq: "" },
    "ANKR-USD2":{ kraken: "ANKRUSD", binance: "ANKRUSDT", gecko: "ankr",              stooq: "" },
    "CFG-USD":  { kraken: "CFGUSD",  binance: "CFGUSDT",  gecko: "centrifuge",        stooq: "" },
    "POLYX-USD":{ kraken: "POLYXUSD",binance: "POLYXUSDT",gecko: "polymesh",          stooq: "" },
    "NODL-USD": { kraken: "NODLUSD", binance: "NODLUSDT", gecko: "nodle-network",     stooq: "" },
    "ACH-USD":  { kraken: "ACHUSD",  binance: "ACHUSDT",  gecko: "alchemy-pay",       stooq: "" },
    "KEY-USD":  { kraken: "KEYUSD",  binance: "KEYUSDT",  gecko: "selfkey",           stooq: "" },
    "DENT-USD": { kraken: "DENTUSD", binance: "DENTUSDT", gecko: "dent",              stooq: "" },
    "HOT-USD":  { kraken: "HOTUSD",  binance: "HOTUSDT",  gecko: "holotoken",         stooq: "" },
    "COTI-USD": { kraken: "COTIUSD", binance: "COTIUSDT", gecko: "coti",              stooq: "" },
    "DUSK-USD": { kraken: "DUSKUSD", binance: "DUSKUSDT", gecko: "dusk-network",      stooq: "" },
    "MOVR-USD2":{ kraken: "MOVRUSD", binance: "MOVRUSDT", gecko: "moonriver",         stooq: "" },
    "OXT-USD":  { kraken: "OXTUSD",  binance: "OXTUSDT",  gecko: "orchid-protocol",   stooq: "" },
    "RARI-USD": { kraken: "RARIUSD", binance: "RARIUSDT", gecko: "rarible",           stooq: "" },
    "RNDR-USD2":{ kraken: "RNDRUSD", binance: "RNDRUSDT", gecko: "render-token",      stooq: "" },
    "SUPER-USD":{ kraken: "SUPERUSD",binance: "SUPERUSDT",gecko: "superfarm",         stooq: "" },
    "TRIBE-USD":{ kraken: "TRIBEUSD",binance: "TRIBEUSDT",gecko: "tribe-2",           stooq: "" },
    "TRU-USD":  { kraken: "TRUUSD",  binance: "TRUUSDT",  gecko: "truefi",            stooq: "" },
    "TVK-USD":  { kraken: "TVKUSD",  binance: "TVKUSDT",  gecko: "the-virtua-kolect", stooq: "" },
    "UNFI-USD": { kraken: "UNFIUSD", binance: "UNFIUSDT", gecko: "unifi-protocol-dao",stooq: "" },
    "VANRY-USD":{ kraken: "VANRYUSD",binance: "VANRYUSDT",gecko: "vanar-chain",       stooq: "" },
    "VTHO-USD": { kraken: "VTHOUSD", binance: "VTHOUSDT", gecko: "vethor-token",      stooq: "" },
    "WOO-USD":  { kraken: "WOOUSD",  binance: "WOOUSDT",  gecko: "woo-network",       stooq: "" },
    "XAI-USD":  { kraken: "XAIUSD",  binance: "XAIUSDT",  gecko: "xai-blockchain",    stooq: "" },
    "XEC-USD":  { kraken: "XECUSD",  binance: "XECUSDT",  gecko: "ecash",             stooq: "" },
    "XNO-USD":  { kraken: "XNOUSD",  binance: "XNOUSDT",  gecko: "nano",              stooq: "" },
    "XTZ-USD2": { kraken: "XTZUSD",  binance: "XTZUSDT",  gecko: "tezos",             stooq: "" },
    "YGG-USD":  { kraken: "YGGUSD",  binance: "YGGUSDT",  gecko: "yield-guild-games", stooq: "" },
    "ZEN-USD":  { kraken: "ZENUSD",  binance: "ZENUSDT",  gecko: "zencash",           stooq: "" },
    "ZIL-USD2": { kraken: "ZILUSD",  binance: "ZILUSDT",  gecko: "zilliqa",           stooq: "" },
    "ZRX-USD2": { kraken: "ZRXUSD",  binance: "ZRXUSDT",  gecko: "0x",                stooq: "" },
    "AAVE-USD2":{ kraken: "AAVEUSD", binance: "AAVEUSDT", gecko: "aave",              stooq: "" },
    "ALGO-USD2":{ kraken: "ALGOUSD", binance: "ALGOUSDT", gecko: "algorand",          stooq: "" },
    "AMP-USD":  { kraken: "AMPUSD",  binance: "AMPUSDT",  gecko: "amp-token",         stooq: "" },
    "ANKR-USD3":{ kraken: "ANKRUSD", binance: "ANKRUSDT", gecko: "ankr",              stooq: "" },
    "ANT-USD":  { kraken: "ANTUSD",  binance: "ANTUSDT",  gecko: "aragon",            stooq: "" },
    "ARPA-USD": { kraken: "ARPAUSD", binance: "ARPAUSDT", gecko: "arpa",              stooq: "" },
    "AUDIO-USD":{ kraken: "AUDIOUSD",binance: "AUDIOUSDT",gecko: "audius",            stooq: "" },
    "BADGER-USD":{ kraken: "BADGERUSD",binance: "BADGERUSDT",gecko: "badger-dao",     stooq: "" },
    "BLZ-USD":  { kraken: "BLZUSD",  binance: "BLZUSDT",  gecko: "bluzelle",          stooq: "" },
    "BNT-USD":  { kraken: "BNTUSD",  binance: "BNTUSDT",  gecko: "bancor",            stooq: "" },
    "CELR-USD": { kraken: "CELRUSD", binance: "CELRUSDT", gecko: "celer-network",     stooq: "" },
    "CHR-USD":  { kraken: "CHRUSD",  binance: "CHRUSDT",  gecko: "chromia",           stooq: "" },
    "COCOS-USD":{ kraken: "COCOSUSD",binance: "COCOSUSDT",gecko: "cocos-bcx",         stooq: "" },
    "COMP-USD2":{ kraken: "COMPUSD", binance: "COMPUSDT", gecko: "compound-governance-token", stooq: "" },
    "CQT-USD":  { kraken: "CQTUSD",  binance: "CQTUSDT",  gecko: "covalent",          stooq: "" },
    "CTXC-USD": { kraken: "CTXCUSD", binance: "CTXCUSDT", gecko: "cortex",            stooq: "" },
    "DASH-USD2":{ kraken: "DASHUSD", binance: "DASHUSDT", gecko: "dash",              stooq: "" },
    "DATA-USD": { kraken: "DATAUSD", binance: "DATAUSDT", gecko: "streamr",           stooq: "" },
    "DCR-USD":  { kraken: "DCRUSD",  binance: "DCRUSDT",  gecko: "decred",            stooq: "" },
    "DIA-USD":  { kraken: "DIAUSD",  binance: "DIAUSDT",  gecko: "dia-data",          stooq: "" },
    "DOCK-USD": { kraken: "DOCKUSD", binance: "DOCKUSDT", gecko: "dock",              stooq: "" },
    "DODO-USD": { kraken: "DODOUSD", binance: "DODOUSDT", gecko: "dodo",              stooq: "" },
    "DOT-USD2": { kraken: "DOTUSD",  binance: "DOTUSDT",  gecko: "polkadot",          stooq: "" },
    "DREP-USD": { kraken: "DREPUSD", binance: "DREPUSDT", gecko: "drep-new",          stooq: "" },
    "DUSK-USD2":{ kraken: "DUSKUSD", binance: "DUSKUSDT", gecko: "dusk-network",      stooq: "" },
    "ELF-USD":  { kraken: "ELFUSD",  binance: "ELFUSDT",  gecko: "aelf",              stooq: "" },
    "ENG-USD":  { kraken: "ENGUSD",  binance: "ENGUSDT",  gecko: "enigma",            stooq: "" },
    "ENJ-USD2": { kraken: "ENJUSD",  binance: "ENJUSDT",  gecko: "enjincoin",         stooq: "" },
    "EOS-USD2": { kraken: "EOSUSD",  binance: "EOSUSDT",  gecko: "eos",               stooq: "" },
    "ETC-USD3": { kraken: "ETCUSD",  binance: "ETCUSDT",  gecko: "ethereum-classic",  stooq: "" },
    "FET-USD2": { kraken: "FETUSD",  binance: "FETUSDT",  gecko: "fetch-ai",          stooq: "" },
    "FIDA-USD": { kraken: "FIDAUSD", binance: "FIDAUSDT", gecko: "bonfida",           stooq: "" },
    "FIL-USD2": { kraken: "FILUSD",  binance: "FILUSDT",  gecko: "filecoin",          stooq: "" },
    "FLM-USD":  { kraken: "FLMUSD",  binance: "FLMUSDT",  gecko: "flamingo",          stooq: "" },
    "FLOW-USD2":{ kraken: "FLOWUSD", binance: "FLOWUSDT", gecko: "flow",              stooq: "" },
    "FORTH-USD":{ kraken: "FORTHUSD",binance: "FORTHUSDT",gecko: "ampleforth-governance-token", stooq: "" },
    "FRONT-USD":{ kraken: "FRONTUSD",binance: "FRONTUSDT",gecko: "frontier-token",   stooq: "" },
    "FTM-USD2": { kraken: "FTMUSD",  binance: "FTMUSDT",  gecko: "fantom",            stooq: "" },
    "FTT-USD":  { kraken: "FTTUSD",  binance: "FTTUSDT",  gecko: "ftx-token",         stooq: "" },
    "GALA-USD2":{ kraken: "GALAUSD", binance: "GALAUSDT", gecko: "gala",              stooq: "" },
    "GAS-USD":  { kraken: "GASUSD",  binance: "GASUSDT",  gecko: "gas",               stooq: "" },
    "GLM-USD":  { kraken: "GLMUSD",  binance: "GLMUSDT",  gecko: "golem",             stooq: "" },
    "GRT-USD2": { kraken: "GRTUSD",  binance: "GRTUSDT",  gecko: "the-graph",         stooq: "" },
    "HBAR-USD2":{ kraken: "HBARUSD", binance: "HBARUSDT", gecko: "hedera-hashgraph",  stooq: "" },
    "HIVE-USD": { kraken: "HIVEUSD", binance: "HIVEUSDT", gecko: "hive",              stooq: "" },
    "ICX-USD":  { kraken: "ICXUSD",  binance: "ICXUSDT",  gecko: "icon",              stooq: "" },
    "ILV-USD":  { kraken: "ILVUSD",  binance: "ILVUSDT",  gecko: "illuvium",          stooq: "" },
    "IMX-USD2": { kraken: "IMXUSD",  binance: "IMXUSDT",  gecko: "immutable-x",       stooq: "" },
    "INJ-USD2": { kraken: "INJUSD",  binance: "INJUSDT",  gecko: "injective-protocol",stooq: "" },
    "IOST-USD": { kraken: "IOSTUSD", binance: "IOSTUSDT", gecko: "iostoken",          stooq: "" },
    "IOTA-USD2":{ kraken: "IOTAUSD", binance: "IOTAUSDT", gecko: "iota",              stooq: "" },
    "JASMY-USD":{ kraken: "JASMYUSD",binance: "JASMYUSDT",gecko: "jasmycoin",         stooq: "" },
    "KAVA-USD2":{ kraken: "KAVAUSD", binance: "KAVAUSDT", gecko: "kava",              stooq: "" },
    "KNC-USD2": { kraken: "KNCUSD",  binance: "KNCUSDT",  gecko: "kyber-network-crystal", stooq: "" },
    "KSM-USD2": { kraken: "KSMUSD",  binance: "KSMUSDT",  gecko: "kusama",            stooq: "" },
    "LINK-USD2":{ kraken: "LINKUSD", binance: "LINKUSDT", gecko: "chainlink",         stooq: "" },
    "LIT-USD":  { kraken: "LITUSD",  binance: "LITUSDT",  gecko: "litentry",          stooq: "" },
    "LOOM-USD": { kraken: "LOOMUSD", binance: "LOOMUSDT", gecko: "loom-network-new",  stooq: "" },
    "LPT-USD":  { kraken: "LPTUSD",  binance: "LPTUSDT",  gecko: "livepeer",          stooq: "" },
    "LRC-USD2": { kraken: "LRCUSD",  binance: "LRCUSDT",  gecko: "loopring",          stooq: "" },
    "LSK-USD2": { kraken: "LSKUSD",  binance: "LSKUSDT",  gecko: "lisk",              stooq: "" },
    "LTC-USD2": { kraken: "LTCUSD",  binance: "LTCUSDT",  gecko: "litecoin",          stooq: "" },
    "MANA-USD2":{ kraken: "MANAUSD", binance: "MANAUSDT", gecko: "decentraland",      stooq: "" },
    "MASK-USD2":{ kraken: "MASKUSD", binance: "MASKUSDT", gecko: "mask-network",      stooq: "" },
    "MATIC-USD2":{ kraken: "MATICUSD",binance: "MATICUSDT",gecko: "matic-network",    stooq: "" },
    "MBOX-USD": { kraken: "MBOXUSD", binance: "MBOXUSDT", gecko: "mobox",             stooq: "" },
    "MINA-USD2":{ kraken: "MINAUSD", binance: "MINAUSDT", gecko: "mina-protocol",     stooq: "" },
    "MKR-USD2": { kraken: "MKRUSD",  binance: "MKRUSDT",  gecko: "maker",             stooq: "" },
    "MLN-USD2": { kraken: "MLNUSD",  binance: "MLNUSDT",  gecko: "enzyme",            stooq: "" },
    "NEAR-USD2":{ kraken: "NEARUSD", binance: "NEARUSDT", gecko: "near",              stooq: "" },
    "NEO-USD2": { kraken: "NEOUSD",  binance: "NEOUSDT",  gecko: "neo",               stooq: "" },
    "NKN-USD":  { kraken: "NKNUSD",  binance: "NKNUSDT",  gecko: "nkn",               stooq: "" },
    "OCEAN-USD2":{ kraken: "OCEANUSD",binance: "OCEANUSDT",gecko: "ocean-protocol",   stooq: "" },
    "OG-USD":   { kraken: "OGUSD",   binance: "OGUSDT",   gecko: "og-fan-token",      stooq: "" },
    "OMG-USD2": { kraken: "OMGUSD",  binance: "OMGUSDT",  gecko: "omisego",           stooq: "" },
    "ONE-USD2": { kraken: "ONEUSD",  binance: "ONEUSDT",  gecko: "harmony",           stooq: "" },
    "ONT-USD":  { kraken: "ONTUSD",  binance: "ONTUSDT",  gecko: "ontology",          stooq: "" },
    "OXT-USD2": { kraken: "OXTUSD",  binance: "OXTUSDT",  gecko: "orchid-protocol",   stooq: "" },
    "PAXG-USD": { kraken: "PAXGUSD", binance: "PAXGUSDT", gecko: "pax-gold",          stooq: "" },
    "PERP-USD": { kraken: "PERPUSD", binance: "PERPUSDT", gecko: "perpetual-protocol",stooq: "" },
    "POLS-USD": { kraken: "POLSUSD", binance: "POLSUSDT", gecko: "polkastarter",      stooq: "" },
    "POLY-USD": { kraken: "POLYUSD", binance: "POLYUSDT", gecko: "polymath",          stooq: "" },
    "POND-USD": { kraken: "PONDUSD", binance: "PONDUSDT", gecko: "marlin",            stooq: "" },
    "POWR-USD2":{ kraken: "POWRUSD", binance: "POWRUSDT", gecko: "power-ledger",      stooq: "" },
    "PROM-USD": { kraken: "PROMUSD", binance: "PROMUSDT", gecko: "prometeus",         stooq: "" },
    "QKC-USD":  { kraken: "QKCUSD",  binance: "QKCUSDT",  gecko: "quark-chain",       stooq: "" },
    "QNT-USD2": { kraken: "QNTUSD",  binance: "QNTUSDT",  gecko: "quant-network",     stooq: "" },
    "QTUM-USD2":{ kraken: "QTUMUSD", binance: "QTUMUSDT", gecko: "qtum",              stooq: "" },
    "RAD-USD":  { kraken: "RADUSD",  binance: "RADUSDT",  gecko: "radicle",           stooq: "" },
    "RARE-USD": { kraken: "RAREUSD", binance: "RAREUSDT", gecko: "superrare",         stooq: "" },
    "REN-USD2": { kraken: "RENUSD",  binance: "RENUSDT",  gecko: "republic-protocol", stooq: "" },
    "REP-USD":  { kraken: "REPUSD",  binance: "REPUSDT",  gecko: "augur",             stooq: "" },
    "REQ-USD2": { kraken: "REQUSD",  binance: "REQUSDT",  gecko: "request-network",   stooq: "" },
    "RIF-USD":  { kraken: "RIFUSD",  binance: "RIFUSDT",  gecko: "rif-token",         stooq: "" },
    "RLC-USD2": { kraken: "RLCUSD",  binance: "RLCUSDT",  gecko: "iexec-rlc",         stooq: "" },
    "ROSE-USD2":{ kraken: "ROSEUSD", binance: "ROSEUSDT", gecko: "oasis-network",     stooq: "" },
    "RSR-USD":  { kraken: "RSRUSD",  binance: "RSRUSDT",  gecko: "reserve-rights-token", stooq: "" },
    "RUNE-USD": { kraken: "RUNEUSD", binance: "RUNEUSDT", gecko: "thorchain",         stooq: "" },
    "RVN-USD2": { kraken: "RVNUSD",  binance: "RVNUSDT",  gecko: "ravencoin",         stooq: "" },
    "SAND-USD2":{ kraken: "SANDUSD", binance: "SANDUSDT", gecko: "the-sandbox",       stooq: "" },
    "SC-USD2":  { kraken: "SCUSD",   binance: "SCUSDT",   gecko: "siacoin",           stooq: "" },
    "SCRT-USD2":{ kraken: "SCRTUSD", binance: "SCRTUSDT", gecko: "secret",            stooq: "" },
    "SFP-USD":  { kraken: "SFPUSD",  binance: "SFPUSDT",  gecko: "safepal",           stooq: "" },
    "SKL-USD":  { kraken: "SKLUSD",  binance: "SKLUSDT",  gecko: "skale",             stooq: "" },
    "SLP-USD":  { kraken: "SLPUSD",  binance: "SLPUSDT",  gecko: "smooth-love-potion",stooq: "" },
    "SNT-USD2": { kraken: "SNTUSD",  binance: "SNTUSDT",  gecko: "status",            stooq: "" },
    "SNX-USD2": { kraken: "SNXUSD",  binance: "SNXUSDT",  gecko: "havven",            stooq: "" },
    "SOL-USD2": { kraken: "SOLUSD",  binance: "SOLUSDT",  gecko: "solana",            stooq: "" },
    "SRM-USD":  { kraken: "SRMUSD",  binance: "SRMUSDT",  gecko: "serum",             stooq: "" },
    "STORJ-USD2":{ kraken: "STORJUSD",binance: "STORJUSDT",gecko: "storj",            stooq: "" },
    "STMX-USD": { kraken: "STMXUSD", binance: "STMXUSDT", gecko: "storm",             stooq: "" },
    "STX-USD2": { kraken: "STXUSD",  binance: "STXUSDT",  gecko: "blockstack",        stooq: "" },
    "SUPER-USD2":{ kraken: "SUPERUSD",binance: "SUPERUSDT",gecko: "superfarm",        stooq: "" },
    "SUSHI-USD2":{ kraken: "SUSHIUSD",binance: "SUSHIUSDT",gecko: "sushi",            stooq: "" },
    "SXP-USD2": { kraken: "SXPUSD",  binance: "SXPUSDT",  gecko: "swipe",             stooq: "" },
    "TFUEL-USD":{ kraken: "TFUELUSD",binance: "TFUELUSDT",gecko: "theta-fuel",        stooq: "" },
    "THETA-USD2":{ kraken: "THETAUSD",binance: "THETAUSDT",gecko: "theta-token",      stooq: "" },
    "TRB-USD2": { kraken: "TRBUSD",  binance: "TRBUSDT",  gecko: "tellor",            stooq: "" },
    "TRX-USD2": { kraken: "TRXUSD",  binance: "TRXUSDT",  gecko: "tron",              stooq: "" },
    "TWT-USD":  { kraken: "TWTUSD",  binance: "TWTUSDT",  gecko: "trust-wallet-token",stooq: "" },
    "UMA-USD2": { kraken: "UMAUSD",  binance: "UMAUSDT",  gecko: "uma",               stooq: "" },
    "UNI-USD2": { kraken: "UNIUSD",  binance: "UNIUSDT",  gecko: "uniswap",           stooq: "" },
    "VET-USD2": { kraken: "VETUSD",  binance: "VETUSDT",  gecko: "vechain",           stooq: "" },
    "WAN-USD":  { kraken: "WANUSD",  binance: "WANUSDT",  gecko: "wanchain",          stooq: "" },
    "WAVES-USD2":{ kraken: "WAVESUSD",binance: "WAVESUSDT",gecko: "waves",            stooq: "" },
    "WNXM-USD": { kraken: "WNXMUSD", binance: "WNXMUSDT", gecko: "wrapped-nxm",       stooq: "" },
    "WRX-USD":  { kraken: "WRXUSD",  binance: "WRXUSDT",  gecko: "wazirx",            stooq: "" },
    "XEM-USD":  { kraken: "XEMUSD",  binance: "XEMUSDT",  gecko: "nem",               stooq: "" },
    "XMR-USD2": { kraken: "XMRUSD",  binance: "XMRUSDT",  gecko: "monero",            stooq: "" },
    "XRP-USD2": { kraken: "XRPUSD",  binance: "XRPUSDT",  gecko: "ripple",            stooq: "" },
    "XTZ-USD3": { kraken: "XTZUSD",  binance: "XTZUSDT",  gecko: "tezos",             stooq: "" },
    "XVG-USD":  { kraken: "XVGUSD",  binance: "XVGUSDT",  gecko: "verge",             stooq: "" },
    "XVS-USD":  { kraken: "XVSUSD",  binance: "XVSUSDT",  gecko: "venus",             stooq: "" },
    "YFI-USD2": { kraken: "YFIUSD",  binance: "YFIUSDT",  gecko: "yearn-finance",     stooq: "" },
    "YFII-USD": { kraken: "YFIIUSD", binance: "YFIIUSDT", gecko: "yfii-finance",      stooq: "" },
    "ZEC-USD2": { kraken: "ZECUSD",  binance: "ZECUSDT",  gecko: "zcash",             stooq: "" },
    "ZEN-USD2": { kraken: "ZENUSD",  binance: "ZENUSDT",  gecko: "zencash",           stooq: "" },
    "ZIL-USD3": { kraken: "ZILUSD",  binance: "ZILUSDT",  gecko: "zilliqa",           stooq: "" },
    "ZRX-USD3": { kraken: "ZRXUSD",  binance: "ZRXUSDT",  gecko: "0x",                stooq: "" },
};

// ============================================================================
// FUTURES MAP
// ============================================================================
// Each entry carries:
//   stooq — Stooq symbol (e.g. "gc.f")
//   yahoo — Yahoo Finance symbol (e.g. "GC=F")
// ============================================================================
const FUTURES_MAP = {
    // --- metals ---
    "GC=F": { stooq: "gc.f", yahoo: "GC=F" },
    "SI=F": { stooq: "si.f", yahoo: "SI=F" },
    "HG=F": { stooq: "hg.f", yahoo: "HG=F" },
    "PL=F": { stooq: "pl.f", yahoo: "PL=F" },
    "PA=F": { stooq: "pa.f", yahoo: "PA=F" },
    "ALI=F":{ stooq: "ali.f",yahoo: "ALI=F" },
    // --- energies ---
    "CL=F": { stooq: "cl.f", yahoo: "CL=F" },
    "NG=F": { stooq: "ng.f", yahoo: "NG=F" },
    "RB=F": { stooq: "rb.f", yahoo: "RB=F" },
    "HO=F": { stooq: "ho.f", yahoo: "HO=F" },
    "BZ=F": { stooq: "bz.f", yahoo: "BZ=F" },
    "QM=F": { stooq: "qm.f", yahoo: "QM=F" },
    "QA=F": { stooq: "qa.f", yahoo: "QA=F" },
    // --- grains / ags ---
    "ZS=F": { stooq: "zs.f", yahoo: "ZS=F" },
    "ZM=F": { stooq: "zm.f", yahoo: "ZM=F" },
    "ZW=F": { stooq: "zw.f", yahoo: "ZW=F" },
    "KE=F": { stooq: "ke.f", yahoo: "KE=F" },
    "ZC=F": { stooq: "zc.f", yahoo: "ZC=F" },
    "ZL=F": { stooq: "zl.f", yahoo: "ZL=F" },
    "ZR=F": { stooq: "zr.f", yahoo: "ZR=F" },
    "ZO=F": { stooq: "zo.f", yahoo: "ZO=F" },
    "ZP=F": { stooq: "zp.f", yahoo: "ZP=F" },
    "CC=F": { stooq: "cc.f", yahoo: "CC=F" },
    "KC=F": { stooq: "kc.f", yahoo: "KC=F" },
    "SB=F": { stooq: "sb.f", yahoo: "SB=F" },
    "CT=F": { stooq: "ct.f", yahoo: "CT=F" },
    "OJ=F": { stooq: "oj.f", yahoo: "OJ=F" },
    "LBS=F":{ stooq: "lbs.f",yahoo: "LBS=F" },
    "LE=F": { stooq: "le.f", yahoo: "LE=F" },
    "GF=F": { stooq: "gf.f", yahoo: "GF=F" },
    "HE=F": { stooq: "he.f", yahoo: "HE=F" },
    "LH=F": { stooq: "lh.f", yahoo: "LH=F" },
    // --- softs ---
    "CT=F2":{ stooq: "ct.f", yahoo: "CT=F" },
    // --- rates ---
    "ZB=F": { stooq: "zb.f", yahoo: "ZB=F" },
    "ZN=F": { stooq: "zn.f", yahoo: "ZN=F" },
    "ZF=F": { stooq: "zf.f", yahoo: "ZF=F" },
    "ZT=F": { stooq: "zt.f", yahoo: "ZT=F" },
    "ZQ=F": { stooq: "zq.f", yahoo: "ZQ=F" },
    "GE=F": { stooq: "ge.f", yahoo: "GE=F" },
    "SR3=F":{ stooq: "sr3.f",yahoo: "SR3=F" },
    "TN=F": { stooq: "tn.f", yahoo: "TN=F" },
    // --- equity index ---
    "ES=F": { stooq: "es.f", yahoo: "ES=F" },
    "NQ=F": { stooq: "nq.f", yahoo: "NQ=F" },
    "YM=F": { stooq: "ym.f", yahoo: "YM=F" },
    "RTY=F":{ stooq: "rty.f",yahoo: "RTY=F" },
    "NKD=F":{ stooq: "nkd.f",yahoo: "NKD=F" },
    "VX=F": { stooq: "vx.f", yahoo: "VX=F" },
    // --- micros ---
    "MES=F":{ stooq: "mes.f",yahoo: "MES=F" },
    "MNQ=F":{ stooq: "mnq.f",yahoo: "MNQ=F" },
    "MYM=F":{ stooq: "mym.f",yahoo: "MYM=F" },
    "M2K=F":{ stooq: "m2k.f",yahoo: "M2K=F" },
    // --- crypto futures (CME) ---
    "BTC=F":{ stooq: "btc.f",yahoo: "BTC=F" },
    "ETH=F":{ stooq: "eth.f",yahoo: "ETH=F" },
    "MBT=F":{ stooq: "mbt.f",yahoo: "MBT=F" },
    "MET=F":{ stooq: "met.f",yahoo: "MET=F" },
    // --- misc ---
    "DX=F": { stooq: "dx.f", yahoo: "DX=F" },
    "6E=F": { stooq: "6e.f", yahoo: "6E=F" },
    "6J=F": { stooq: "6j.f", yahoo: "6J=F" },
    "6B=F": { stooq: "6b.f", yahoo: "6B=F" },
    "6A=F": { stooq: "6a.f", yahoo: "6A=F" },
    "6C=F": { stooq: "6c.f", yahoo: "6C=F" },
    "6S=F": { stooq: "6s.f", yahoo: "6S=F" },
    "6N=F": { stooq: "6n.f", yahoo: "6N=F" },
    "6M=F": { stooq: "6m.f", yahoo: "6M=F" },
    "6Z=F": { stooq: "6z.f", yahoo: "6Z=F" },
    // --- livestock ---
    "LE=F2":{ stooq: "le.f", yahoo: "LE=F" },
    "GF=F2":{ stooq: "gf.f", yahoo: "GF=F" },
    "HE=F2":{ stooq: "he.f", yahoo: "HE=F" },
    "LH=F2":{ stooq: "lh.f", yahoo: "LH=F" },
    // --- additional CME/COMEX/NYMEX ---
    "AD=F": { stooq: "ad.f", yahoo: "AD=F" },
    "CD=F": { stooq: "cd.f", yahoo: "CD=F" },
    "NE=F": { stooq: "ne.f", yahoo: "NE=F" },
    "SS=F": { stooq: "ss.f", yahoo: "SS=F" },
    "NI=F": { stooq: "ni.f", yahoo: "NI=F" },
    "PB=F": { stooq: "pb.f", yahoo: "PB=F" },
    "SN=F": { stooq: "sn.f", yahoo: "SN=F" },
    "ZN=F2":{ stooq: "zn.f", yahoo: "ZN=F" },
};

// ============================================================================
// EQUITIES MAP (US equities and ETFs)
// ============================================================================
// Each entry carries:
//   stooq — Stooq symbol (e.g. "aapl.us")
//   yahoo — Yahoo Finance symbol (e.g. "AAPL")
//
// Stooq's US equity/ETF suffix is ".us". Yahoo uses the bare ticker.
// ============================================================================
const EQUITIES_MAP = (() => {
    const tickers = [
        // mega-cap tech
        "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
        "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC", "CSCO", "QCOM",
        "TXN", "MU", "AMAT", "LRCX", "KLAC", "MRVL", "SNPS", "CDNS",
        "INTU", "NOW", "PANW", "CRWD", "ZS", "DDOG", "SNOW", "PLTR",
        "AI", "SMCI", "ARM", "DELL", "HPQ", "HPE", "WDC", "STX",
        "IBM", "ACN", "UBER", "LYFT", "ABNB", "DASH", "SHOP", "SQ",
        "PYPL", "COIN", "HOOD", "SOFI", "AFRM", "UPST", "LC",
        // media / comms
        "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS", "WBD", "PARA",
        "SPOT", "RBLX", "U", "EA", "TTWO", "ATVI", "NTES", "BIDU",
        "JD", "PDD", "BABA", "TCEHY", "NTDOY", "SONY",
        // consumer
        "WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD",
        "KO", "PEP", "PG", "CL", "KMB", "GIS", "K", "HSY",
        "MDLZ", "STZ", "TAP", "SAM", "BUD", "DEO", "MO", "PM",
        "EL", "ULTA", "ROST", "TJX", "BBY", "DG", "DLTR",
        "LULU", "GPS", "ANF", "M", "KSS", "JWN",
        // financials
        "JPM", "BAC", "WFC", "C", "GS", "MS", "BLK", "SCHW",
        "AXP", "V", "MA", "USB", "PNC", "TFC", "COF", "DFS",
        "BK", "STT", "NTRS", "FITB", "HBAN", "RF", "KEY", "CFG",
        "BRK-B", "BRK-A", "AIG", "MET", "PRU", "AFL", "ALL", "TRV",
        "PGR", "CB", "MMC", "AON", "AJG", "WLTW", "BRO",
        // healthcare
        "JNJ", "PFE", "MRK", "ABBV", "LLY", "BMY", "AMGN", "GILD",
        "BIIB", "REGN", "VRTX", "MRNA", "BNTX", "AZN", "GSK", "SNY",
        "NVS", "UNH", "CVS", "CI", "HUM", "ELV", "ANTM", "CNC",
        "MOH", "HCA", "UHS", "THC", "MCK", "ABC", "CAH",
        "MDT", "SYK", "BSX", "ZBH", "BDX", "BAX", "ISRG", "EW",
        "DXCM", "PODD", "ILMN", "CRL", "IQV", "A", "WAT", "MTD",
        // industrials
        "BA", "CAT", "DE", "HON", "GE", "MMM", "LMT", "RTX",
        "NOC", "GD", "LHX", "HII", "TDG", "HWM", "TXT", "CARR",
        "OTIS", "CMI", "PCAR", "NAV", "URI", "FAST", "GWW", "ITW",
        "EMR", "ETN", "PH", "ROK", "DOV", "AME", "IR", "XYL",
        "UPS", "FDX", "DAL", "UAL", "AAL", "LUV", "ALK", "JBLU",
        // energy
        "XOM", "CVX", "COP", "EOG", "PXD", "OXY", "PSX", "VLO",
        "MPC", "SLB", "HAL", "BKR", "NOV", "FTI", "KMI", "WMB",
        "OKE", "ET", "EPD", "MMP", "PAA", "TRGP", "LNG", "EQT",
        "RRC", "AR", "CNX", "SWN", "CHK", "DVN", "FANG", "HES",
        "MRO", "APA", "CTRA",
        // materials
        "LIN", "APD", "SHW", "ECL", "DD", "DOW", "LYB", "PPG",
        "NEM", "FCX", "NUE", "STLD", "CLF", "X", "AA", "MP",
        "ALB", "SQM", "LAC", "VALE", "RIO", "BHP", "MT", "GOLD",
        // utilities
        "NEE", "DUK", "SO", "D", "AEP", "EXC", "XEL", "ED",
        "WEC", "ES", "AWK", "SRE", "PCG", "EIX", "PEG", "FE",
        "PPL", "CMS", "DTE", "AEE", "CNP", "NI", "LNT", "EVRG",
        // REITs
        "PLD", "AMT", "CCI", "EQIX", "DLR", "SPG", "O", "PSA",
        "EXR", "AVB", "EQR", "MAA", "ESS", "UDR", "CPT", "AIV",
        "VTR", "WELL", "PEAK", "HST", "RHP", "IRM", "SBAC",
        // ETFs — broad market
        "SPY", "QQQ", "DIA", "IWM", "VTI", "VOO", "VEA", "VWO",
        "IVV", "VTV", "VUG", "IWF", "IWD", "IWB", "IWV", "RSP",
        "MDY", "IJH", "IJR", "IJS", "IJJ", "IJK", "IJT",
        // ETFs — sector
        "XLK", "XLF", "XLV", "XLE", "XLI", "XLP", "XLY", "XLU",
        "XLB", "XLRE", "XLC", "SMH", "SOXX", "IGV", "VGT", "FTEC",
        "VHT", "VFH", "VIS", "VPU", "VDC", "VCR", "VAW", "VNQ",
        "KRE", "KBE", "XBI", "IBB", "IHI", "IHF", "ITA", "XAR",
        "XOP", "OIH", "XME", "GDX", "GDXJ", "SIL", "URA", "LIT",
        "TAN", "ICLN", "PBW", "FAN", "JETS", "PEJ", "XRT", "ITB",
        "XHB", "HACK", "BOTZ", "ROBO", "ARKK", "ARKG", "ARKW",
        "ARKF", "ARKQ", "ARKX",
        // ETFs — international
        "EFA", "EEM", "IEFA", "IEMG", "VEA", "VWO", "FXI", "MCHI",
        "KWEB", "CQQQ", "EWJ", "EWZ", "EWW", "EWY", "EWT", "EWU",
        "EWG", "EWQ", "EWI", "EWP", "EWN", "EWD", "EWL", "EWC",
        "EWA", "EWH", "EWS", "EWM", "EPI", "INDA", "SMIN", "EPHE",
        "EZA", "TUR", "EIS", "KSA", "UAE",
        // ETFs — commodity
        "GLD", "IAU", "SLV", "SIVR", "PPLT", "PALL", "GDX", "GDXJ",
        "USO", "BNO", "UNG", "UNL", "DBA", "DBC", "GSG", "PDBC",
        "CPER", "COPX", "URA", "LIT", "REMX", "WOOD",
        // ETFs — bond
        "TLT", "IEF", "SHY", "AGG", "BND", "LQD", "HYG", "JNK",
        "TIP", "VTIP", "MUB", "EMB", "BNDX", "IGSB", "IGIB",
        "SCHO", "SCHR", "SCHZ", "VCIT", "VCSH", "BSV", "BIV",
        "BLV", "GOVT", "SPTL", "SPTI", "SPTS",
        // ETFs — leveraged / inverse
        "TQQQ", "SQQQ", "SPXL", "SPXS", "UPRO", "SPXU", "TNA",
        "TZA", "FAS", "FAZ", "LABU", "LABD", "YINN", "YANG",
        "SOXL", "SOXS", "TECL", "TECS", "UDOW", "SDOW",
        // ETFs — dividend / factor
        "SCHD", "VYM", "DVY", "HDV", "SPHD", "SDY", "VIG", "DGRO",
        "NOBL", "QUAL", "MTUM", "VLUE", "SIZE", "USMV", "SPLV",
        "SPHQ", "RPG", "RPV", "RSP", "EQWL",
        // ETFs — thematic
        "ICLN", "TAN", "FAN", "PBW", "QCLN", "ACES", "DRIV", "IDRV",
        "ESPO", "NERD", "HERO", "GAMR", "BITO", "BITQ", "WGMI",
        "DAPP", "BLOK", "LEGR", "MOAT", "SCHG", "SCHV", "VONG",
        "VONV", "IUSG", "IUSV", "IUSG",
        // popular recent listings
        "RIVN", "LCID", "NIO", "XPEV", "LI", "FSR", "GOEV",
        "PLUG", "FCEL", "BLDP", "BE", "ENPH", "SEDG", "RUN",
        "NOVA", "SPWR", "CSIQ", "JKS", "DQ", "MAXN", "ARRY",
        "MSTR", "MARA", "RIOT", "HUT", "BITF", "CLSK", "CIFR",
        "IREN", "WULF", "CORZ", "BTBT", "CAN", "EBON", "SOS",
        "GME", "AMC", "BB", "NOK", "KOSS", "EXPR", "BBBY",
        "CVNA", "CHWY", "W", "ETSY", "EBAY", "OSTK", "WISH",
        "PTON", "ZM", "DOCU", "TWLO", "OKTA", "CRWD", "NET",
        "FSLY", "ESTC", "MDB", "TEAM", "WORK", "SPLK", "NEWR",
        "SUMO", "PD", "APPF", "BL", "ZI", "MGNI", "TTD", "PUBM",
        "ROKU", "FUBO", "PLTR", "SNOW", "U", "ASAN", "MNDY",
        "HUBS", "BILL", "TOST", "SQ", "AFRM", "UPST", "SOFI",
        "HOOD", "COIN", "MARA", "RIOT", "CLSK", "BITF",
    ];
    const map = {};
    for (const t of tickers) {
        const stooqTicker = t.toLowerCase().replace("-", ".");
        map[t] = { stooq: stooqTicker + ".us", yahoo: t };
    }
    return map;
})();

// ============================================================================
// FOREX MAP (Yahoo only)
// ============================================================================
// Stooq does not carry FX in a stable CSV shape. Yahoo's chart endpoint
// serves forex pairs as "EURUSD=X".
// ============================================================================
const FOREX_MAP = (() => {
    const pairs = [
        "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "USDCAD=X",
        "AUDUSD=X", "NZDUSD=X", "EURGBP=X", "EURJPY=X", "EURCHF=X",
        "EURCAD=X", "EURAUD=X", "EURNZD=X", "GBPJPY=X", "GBPCHF=X",
        "GBPCAD=X", "GBPAUD=X", "GBPNZD=X", "AUDJPY=X", "AUDCHF=X",
        "AUDCAD=X", "AUDNZD=X", "NZDJPY=X", "NZDCHF=X", "NZDCAD=X",
        "CADJPY=X", "CADCHF=X", "CHFJPY=X", "USDSEK=X", "USDNOK=X",
        "USDDKK=X", "USDPLN=X", "USDHUF=X", "USDCZK=X", "USDTRY=X",
        "USDMXN=X", "USDZAR=X", "USDSGD=X", "USDHKD=X", "USDCNH=X",
        "USDINR=X", "USDKRW=X", "USDTWD=X", "USDTHB=X", "USDMYR=X",
        "USDPHP=X", "USDIDR=X", "USDBRL=X", "USDARS=X", "USDCLP=X",
    ];
    const map = {};
    for (const p of pairs) {
        map[p] = { yahoo: p };
        // also expose the short form (e.g. EURUSD) as an alias
        const short = p.replace("=X", "");
        if (!map[short]) map[short] = { yahoo: p };
    }
    return map;
})();

// ============================================================================
// INDICES MAP (Yahoo only)
// ============================================================================
const INDICES_MAP = {
    "^GSPC":  { yahoo: "^GSPC" },
    "^DJI":   { yahoo: "^DJI" },
    "^IXIC":  { yahoo: "^IXIC" },
    "^RUT":   { yahoo: "^RUT" },
    "^VIX":   { yahoo: "^VIX" },
    "^FTSE":  { yahoo: "^FTSE" },
    "^GDAXI": { yahoo: "^GDAXI" },
    "^FCHI":  { yahoo: "^FCHI" },
    "^STOXX50E": { yahoo: "^STOXX50E" },
    "^N225":  { yahoo: "^N225" },
    "^HSI":   { yahoo: "^HSI" },
    "^KS11":  { yahoo: "^KS11" },
    "^AXJO":  { yahoo: "^AXJO" },
    "^BSESN": { yahoo: "^BSESN" },
    "^BVSP":  { yahoo: "^BVSP" },
    "^MXX":   { yahoo: "^MXX" },
    "^TWII":  { yahoo: "^TWII" },
    "^STI":   { yahoo: "^STI" },
};

// ============================================================================
// HELPERS
// ============================================================================
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
// input symbol. We look up result[Object.keys(result)[0]].
// D-50: the OHLC response carries a `last` cursor key. We skip it.
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
// STOOQ PROVIDER (PRIMARY EQUITIES / FUTURES)
// ============================================================================
// D-51: Stooq's CSV layout differs between intraday and daily. The parser
// reads the header row and adapts. N/D is coerced to null.
// ============================================================================
async function fetchStooq(symbol, kind, interval, limit) {
    const mapped = EQUITIES_MAP[symbol] || FUTURES_MAP[symbol];
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
// YAHOO PROVIDER (FALLBACK — UNIVERSAL)
// ============================================================================
async function fetchYahoo(symbol, kind, interval, limit) {
    const yahooSymbol = (
        (EQUITIES_MAP[symbol] && EQUITIES_MAP[symbol].yahoo) ||
        (FUTURES_MAP[symbol] && FUTURES_MAP[symbol].yahoo) ||
        (FOREX_MAP[symbol] && FOREX_MAP[symbol].yahoo) ||
        (INDICES_MAP[symbol] && INDICES_MAP[symbol].yahoo) ||
        symbol
    );
    const range = kind === "intraday" || kind === "history" || kind === "candles" ? "2d" : "1d";
    const upstream = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&range=${range}`;
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
// PROVIDER DISPATCH — v4.5.6 CLASS ROUTING
// ============================================================================
// Crypto:            Kraken → Binance → CoinGecko → Yahoo
// Futures/Equities:  Stooq  → Yahoo
// Forex:             Yahoo only
// Indices:           Yahoo only
// Unknown:           Yahoo only
// ============================================================================
async function dispatchProvider(symbol, kind, interval, limit) {
    const isCrypto = Boolean(CRYPTO_MAP[symbol]);
    const isFutures = Boolean(FUTURES_MAP[symbol]);
    const isEquities = Boolean(EQUITIES_MAP[symbol]);
    const isForex = Boolean(FOREX_MAP[symbol]);
    const isIndices = Boolean(INDICES_MAP[symbol]);
    const errors = [];

    if (isCrypto) {
        for (const fn of [fetchKraken, fetchBinance, fetchCoinGecko, fetchYahoo]) {
            try {
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else if (isFutures || isEquities) {
        for (const fn of [fetchStooq, fetchYahoo]) {
            try {
                return await fn(symbol, kind, interval, limit);
            } catch (e) {
                errors.push(`${fn.name}:${e.message}`);
            }
        }
    } else if (isForex || isIndices) {
        try {
            return await fetchYahoo(symbol, kind, interval, limit);
        } catch (e) {
            errors.push(`yahoo:${e.message}`);
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

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================
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
                version: "4.6.0",
                gated: Boolean(env.RELAY_KEY),
                providers: ["kraken", "stooq", "binance", "coingecko", "yahoo"],
                primary_crypto: "kraken",
                primary_futures: "stooq",
                primary_equities: "stooq",
                primary_forex: "yahoo",
                primary_indices: "yahoo",
                fallback_crypto: ["binance", "coingecko", "yahoo"],
                fallback_futures: ["yahoo"],
                fallback_equities: ["yahoo"],
                fallback_forex: [],
                fallback_indices: [],
                crypto_pairs: Object.keys(CRYPTO_MAP).length,
                futures_symbols: Object.keys(FUTURES_MAP).length,
                equities_symbols: Object.keys(EQUITIES_MAP).length,
                forex_pairs: Object.keys(FOREX_MAP).length,
                indices_symbols: Object.keys(INDICES_MAP).length,
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