#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ÆEA TELEGRAM BOT — HEROKU DEPLOYMENT + LOCAL WEB GUI BRIDGE
Faithful Unabridged Port of æea.mq4
Data Feed: Cloudflare Worker Relay (Yahoo Finance upstream)
Platform: Heroku + Telegram Bot + Local HTTPS Bridge (index.html)
Author: Natalia Tanyatia
Version: 4.1.0 (MQL4-Parity + MT4/TradingView TWA Edition — Audit-Patched)
"""
import asyncio
import hashlib
import hmac
import json
import math
import os
import sys
import ssl
import logging
import subprocess
import threading
import time
import re as _re_bridge
import urllib.parse
import urllib.request
import urllib.error
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qsl
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple, Any
from fractions import Fraction as PyFraction
from decimal import Decimal, getcontext

getcontext().prec = 50

ARC_COHERENCE_TOLERANCE = 1e-6

# ============================================================================
# EXACT FRACTION WRAPPER
# ============================================================================
class Fraction:
    __slots__ = ('_f',)

    def __init__(self, num=0, den=1):
        if isinstance(num, Fraction):
            self._f = num._f
        elif isinstance(num, PyFraction):
            self._f = num._f
        elif isinstance(num, int) and isinstance(den, int):
            if den == 0:
                raise ZeroDivisionError("Fraction denominator cannot be zero")
            self._f = PyFraction(num, den)
        else:
            try:
                self._f = PyFraction(str(num))
            except Exception:
                self._f = PyFraction(0)

    @staticmethod
    def _wrap(x):
        if isinstance(x, Fraction):
            return x
        return Fraction(x)

    @staticmethod
    def from_float(f, precision=1000000000000):
        if isinstance(f, Fraction):
            return f
        return Fraction(int(round(float(f) * precision)), precision)

    @staticmethod
    def from_decimal_string(s):
        s = str(s).strip()
        if 'E' in s or 'e' in s:
            d = Decimal(s)
            sign, digits, exp = d.as_tuple()
            num = int(''.join(str(x) for x in digits)) * (-1 if sign else 1)
            den = 10 ** (-exp) if exp < 0 else 1
            if exp >= 0:
                num = num * (10 ** exp)
                den = 1
            return Fraction(num, den)
        return Fraction.from_string(s)

    @staticmethod
    def from_string(s):
        s = str(s).strip()
        if '/' in s:
            parts = s.split('/')
            return Fraction(int(parts[0]), int(parts[1]))
        if '.' in s:
            sign = -1 if s.startswith('-') else 1
            s_abs = s.lstrip('-')
            int_part, frac_part = s_abs.split('.')
            scale = 10 ** len(frac_part)
            num = int(int_part + frac_part) * sign
            return Fraction(num, scale)
        return Fraction(int(s), 1)

    @staticmethod
    def zero():
        return Fraction(0, 1)

    @staticmethod
    def one():
        return Fraction(1, 1)

    def num(self):
        return self._f.numerator

    def den(self):
        return self._f.denominator

    def is_zero(self):
        return self._f.numerator == 0

    def is_integer(self):
        return self._f.denominator == 1

    def sign(self):
        n = self._f.numerator
        return (n > 0) - (n < 0)

    def abs(self):
        return Fraction(abs(self._f.numerator), self._f.denominator)

    def neg(self):
        return Fraction(-self._f.numerator, self._f.denominator)

    def __add__(self, other):
        o = Fraction._wrap(other)
        return Fraction(self._f + o._f)

    def __radd__(self, other):
        return self.__add__(other)

    def __sub__(self, other):
        o = Fraction._wrap(other)
        return Fraction(self._f - o._f)

    def __rsub__(self, other):
        o = Fraction._wrap(other)
        return Fraction(o._f - self._f)

    def __mul__(self, other):
        o = Fraction._wrap(other)
        return Fraction(self._f * o._f)

    def __rmul__(self, other):
        return self.__mul__(other)

    def __truediv__(self, other):
        o = Fraction._wrap(other)
        if o._f.numerator == 0:
            raise ZeroDivisionError("Fraction division by zero")
        return Fraction(self._f / o._f)

    def __neg__(self):
        return Fraction(-self._f.numerator, self._f.denominator)

    def __pos__(self):
        return self

    def __eq__(self, other):
        try:
            o = Fraction._wrap(other)
            return self._f == o._f
        except Exception:
            return False

    def __lt__(self, other):
        o = Fraction._wrap(other)
        return self._f < o._f

    def __le__(self, other):
        o = Fraction._wrap(other)
        return self._f <= o._f

    def __gt__(self, other):
        o = Fraction._wrap(other)
        return self._f > o._f

    def __ge__(self, other):
        o = Fraction._wrap(other)
        return self._f >= o._f

    def __hash__(self):
        return hash(self._f)

    def to_decimal(self) -> Decimal:
        return Decimal(self._f.numerator) / Decimal(self._f.denominator)

    def to_float(self) -> float:
        return float(self._f.numerator) / float(self._f.denominator)

    def __str__(self):
        if self._f.denominator == 1:
            return str(self._f.numerator)
        return f"{self._f.numerator}/{self._f.denominator}"

    def __repr__(self):
        return f"Fraction({self._f.numerator}/{self._f.denominator})"

    def sqrt(self, iterations: int = 8) -> 'Fraction':
        if self._f.numerator < 0:
            raise ValueError("sqrt of negative fraction")
        if self._f.numerator == 0:
            return Fraction(0, 1)
        n = self._f.numerator
        d = self._f.denominator
        ns = math.isqrt(n)
        ds = math.isqrt(d)
        if ns * ns == n and ds * ds == d:
            return Fraction(ns, ds)
        x0 = max(1, math.isqrt(int(self.to_float() * 10 ** 12)))
        x = Fraction(x0, math.isqrt(10 ** 12))
        two = Fraction(2, 1)
        for _ in range(iterations):
            x = (x + self / x) / two
        return x

# ============================================================================
# CONSTANTS & CONFIGURATION — MQL4 PARITY
# ============================================================================
COMMISSION: Decimal = Decimal('0.0')
STOP_LOSS: Decimal = Decimal('0.0')
TAKE_PROFIT: Decimal = Decimal('0.0')
LOT_SIZE: Decimal = Decimal('0.01')
SLIPPAGE: int = 100
MAX_PERIOD: int = 60
MIN_PERIOD: int = 3
X_PERIOD: int = MAX_PERIOD + 2
Y_START: int = MIN_PERIOD - 2
MIN_HISTORY_WINDOW: int = 52

F_THRESHOLD: Fraction = Fraction(200, 3)
G_THRESHOLD: Fraction = Fraction(100, 3)
GF_TOLERANCE: Fraction = Fraction(40, 15)

F_THRESHOLD_D: Decimal = Decimal(F_THRESHOLD.num()) / Decimal(F_THRESHOLD.den())
G_THRESHOLD_D: Decimal = Decimal(G_THRESHOLD.num()) / Decimal(G_THRESHOLD.den())
GF_TOLERANCE_D: Decimal = Decimal(GF_TOLERANCE.num()) / Decimal(GF_TOLERANCE.den())

TELEGRAM_WEBAPP_URL: str = os.getenv("TELEGRAM_WEBAPP_URL", "").strip()
BRIDGE_HOST: str = os.getenv("BRIDGE_HOST", "0.0.0.0").strip()
BRIDGE_PORT: int = int(os.getenv("PORT", os.getenv("BRIDGE_PORT", "8765")))
BRIDGE_USE_TLS: bool = os.getenv("BRIDGE_USE_TLS", "0").strip() in ("1", "true", "yes")
BRIDGE_TLS_CERT: str = os.getenv("BRIDGE_TLS_CERT", "").strip()
BRIDGE_TLS_KEY: str = os.getenv("BRIDGE_TLS_KEY", "").strip()
BRIDGE_TUNNEL: str = os.getenv("BRIDGE_TUNNEL", "cloudflared").strip().lower()
BRIDGE_PUBLIC_TIMEOUT: int = int(os.getenv("BRIDGE_PUBLIC_TIMEOUT", "45"))
TELEGRAM_BOT_TOKEN_ENV: str = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
REQUIRE_AUTH: bool = os.getenv("REQUIRE_AUTH", "1").strip() in ("1", "true", "yes")
LOG_BUFFER_SIZE: int = int(os.getenv("LOG_BUFFER_SIZE", "200"))

RELAY_URL: str = os.getenv("RELAY_URL", "").strip().rstrip("/")
RELAY_KEY: str = os.getenv("RELAY_KEY", "").strip()
RELAY_TIMEOUT: int = int(os.getenv("RELAY_TIMEOUT", "10"))
RELAY_MAX_RETRIES: int = int(os.getenv("RELAY_MAX_RETRIES", "3"))

CORS_ORIGIN: str = os.getenv("CORS_ORIGIN", "*").strip()
SYMBOL: str = os.getenv("SYMBOL", "BTC-USD").strip() or "BTC-USD"
INTERVAL: str = "1m"
UPDATE_INTERVAL: int = int(os.getenv("UPDATE_INTERVAL", "30"))

SYMBOL_MAP = {
    "BTCUSDT": "BTC-USD", "ETHUSDT": "ETH-USD", "XRPUSDT": "XRP-USD",
    "ADAUSDT": "ADA-USD", "SOLUSDT": "SOL-USD", "DOGEUSDT": "DOGE-USD",
    "LTCUSDT": "LTC-USD", "LINKUSDT": "LINK-USD", "DOTUSDT": "DOT-USD",
    "AVAXUSDT": "AVAX-USD", "MATICUSDT": "MATIC-USD", "UNIUSDT": "UNI-USD",
    "ATOMUSDT": "ATOM-USD", "NEARUSDT": "NEAR-USD", "FILUSDT": "FIL-USD",
    "ETCUSDT": "ETC-USD", "ICPUSDT": "ICP-USD", "XLMUSDT": "XLM-USD",
    "HBARUSDT": "HBAR-USD", "QNTUSDT": "QNT-USD",
    "GC=F": "GC=F", "SI=F": "SI=F", "CL=F": "CL=F", "NG=F": "NG=F",
    "ZB=F": "ZB=F", "ZN=F": "ZN=F", "ZS=F": "ZS=F", "ZM=F": "ZM=F",
    "ZW=F": "ZW=F", "KE=F": "KE=F"
}

SYMBOL_FALLBACKS: Dict[str, List[str]] = {
    "BTC-USD":  ["BTC-USD", "BTCUSD=X"], "ETH-USD":  ["ETH-USD", "ETHUSD=X"],
    "XRP-USD":  ["XRP-USD", "XRPUSD=X"], "ADA-USD":  ["ADA-USD", "ADAUSD=X"],
    "SOL-USD":  ["SOL-USD", "SOLUSD=X"], "DOGE-USD": ["DOGE-USD", "DOGEUSD=X"],
    "LTC-USD":  ["LTC-USD", "LTCUSD=X"], "LINK-USD": ["LINK-USD", "LINKUSD=X"],
    "DOT-USD":  ["DOT-USD", "DOTUSD=X"], "AVAX-USD": ["AVAX-USD", "AVAXUSD=X"],
    "MATIC-USD":["MATIC-USD", "MATICUSD=X"], "UNI-USD":  ["UNI-USD", "UNIUSD=X"],
    "ATOM-USD": ["ATOM-USD", "ATOMUSD=X"], "NEAR-USD": ["NEAR-USD", "NEARUSD=X"],
    "FIL-USD":  ["FIL-USD", "FILUSD=X"], "ETC-USD":  ["ETC-USD", "ETCUSD=X"],
    "ICP-USD":  ["ICP-USD", "ICPUSD=X"], "XLM-USD":  ["XLM-USD", "XLMUSD=X"],
    "HBAR-USD": ["HBAR-USD", "HBARUSD=X"], "QNT-USD":  ["QNT-USD", "QNTUSD=X"],
    "GC=F": ["GC=F"], "SI=F": ["SI=F"], "CL=F": ["CL=F"], "NG=F": ["NG=F"],
    "ZB=F": ["ZB=F"], "ZN=F": ["ZN=F"], "ZS=F": ["ZS=F"], "ZM=F": ["ZM=F"],
    "ZW=F": ["ZW=F"], "KE=F": ["KE=F"],
}

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
    MenuButtonWebApp,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ============================================================================
# LOG RING BUFFER (for /log endpoint)
# ============================================================================
_LOG_BUFFER: deque = deque(maxlen=LOG_BUFFER_SIZE)
_LOG_LOCK = threading.Lock()

class _RingHandler(logging.Handler):
    def emit(self, record):
        try:
            msg = self.format(record)
            with _LOG_LOCK:
                _LOG_BUFFER.append({
                    "ts": datetime.fromtimestamp(record.created).isoformat(),
                    "level": record.levelname.lower(),
                    "msg": msg,
                })
        except Exception:
            pass

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)
logger.addHandler(_RingHandler())
logger.propagate = False

# ============================================================================
# DATACLASSES
# ============================================================================
@dataclass
class PriceData:
    bid: Decimal = Decimal('0.0')
    ask: Decimal = Decimal('0.0')
    close: Decimal = Decimal('0.0')
    open: Decimal = Decimal('0.0')
    high: Decimal = Decimal('0.0')
    low: Decimal = Decimal('0.0')
    volume: Decimal = Decimal('0.0')
    timestamp: datetime = field(default_factory=datetime.now)

    @property
    def spread(self) -> Decimal:
        return self.ask - self.bid

@dataclass
class IndicatorState:
    adx: Decimal = Decimal('50.0')
    stochastic: Decimal = Decimal('50.0')
    rvi: Decimal = Decimal('50.0')
    ac: Decimal = Decimal('50.0')
    force: Decimal = Decimal('50.0')
    obv: Decimal = Decimal('50.0')
    ad: Decimal = Decimal('50.0')
    mfi: Decimal = Decimal('50.0')
    momentum: Decimal = Decimal('50.0')
    dem: Decimal = Decimal('50.0')
    wpr: Decimal = Decimal('50.0')
    cci: Decimal = Decimal('50.0')
    rsi: Decimal = Decimal('50.0')
    ihk_kijun: Decimal = Decimal('50.0')
    ihk_tenkan: Decimal = Decimal('50.0')

@dataclass
class Order:
    ticket: int
    side: str
    entry: Decimal
    sl: Decimal = Decimal('0.0')
    tp: Decimal = Decimal('0.0')
    lot: Decimal = Decimal('0.01')
    opened_at: datetime = field(default_factory=datetime.now)
    closed_at: Optional[datetime] = None
    close_price: Optional[Decimal] = None

    def pnl(self, current_price: Decimal) -> Decimal:
        if self.side == 'BUY':
            return (current_price - self.entry) * self.lot * Decimal('100000')
        else:
            return (self.entry - current_price) * self.lot * Decimal('100000')

@dataclass
class AEI_CoreState:
    KC: bool = True
    invert: bool = True
    tag: int = -1
    prime: int = -1
    dime: int = -1
    mem: int = -1
    tick: int = 0
    y: int = Y_START
    signal: Decimal = Decimal('0.0')
    signature: bool = False
    tick_tock: bool = False
    FG: bool = False
    GF: bool = False
    Buy: int = -1
    Sell: int = -1
    A: bool = True
    B: bool = True
    a: bool = True
    b: bool = True
    ab: bool = False
    ba: bool = True
    u: bool = False
    v: bool = False
    lOrder_id: int = -1
    kOrder_id: int = -1
    D: Decimal = Decimal('0.0')
    E: Decimal = Decimal('0.0')
    p: Decimal = Decimal('0.0')
    q: Decimal = Decimal('0.0')
    K: bool = False
    C: bool = True
    c: bool = True
    iC: bool = True
    jC: bool = True
    Cc: bool = True
    cC: bool = True
    safety: bool = False
    Z: int = Y_START + 1
    z: int = Y_START + 1
    O: int = Y_START + 1
    o: int = Y_START + 1
    r: int = 0
    W: int = Y_START + 1
    w: int = Y_START + 1
    I: int = 0
    iI: int = 0
    J: int = 0
    iJ: int = 0
    ij: int = 0
    h: int = 0
    iZ: int = Y_START + 1
    iz: int = Y_START + 1
    iW: int = Y_START + 1
    iw: int = Y_START + 1
    iO: int = Y_START + 1
    io: int = Y_START + 1
    ir: int = 0
    count: int = 0
    toll: int = 0
    tally: str = "   "
    m: int = 0
    n: int = 0
    m_now: int = 0
    n_now: int = 0
    lPass: Decimal = Decimal('0.0')
    ilPass: Decimal = Decimal('0.0')
    kPass: Decimal = Decimal('0.0')
    ikPass: Decimal = Decimal('0.0')
    Premium: List[Decimal] = field(default_factory=lambda: [Decimal('0.0')] * (X_PERIOD - Y_START))
    Discount: List[Decimal] = field(default_factory=lambda: [Decimal('0.0')] * (X_PERIOD - Y_START))
    HH: List[Decimal] = field(default_factory=lambda: [Decimal('0.0')] * (X_PERIOD - Y_START))
    LL: List[Decimal] = field(default_factory=lambda: [Decimal('0.0')] * (X_PERIOD - Y_START))
    k: List[bool] = field(default_factory=lambda: [False] * (X_PERIOD - Y_START))
    l: List[bool] = field(default_factory=lambda: [False] * (X_PERIOD - Y_START))
    U: List[bool] = field(default_factory=list)
    R: bool = True
    Regime: List[str] = field(default_factory=lambda: ["sRange"] * (X_PERIOD - Y_START))
    iA: List[List[Decimal]] = field(default_factory=lambda: [[Decimal('50.0')] * (X_PERIOD - Y_START) for _ in range(13)])
    cA: List[List[Decimal]] = field(default_factory=lambda: [[Decimal('50.0')] * (X_PERIOD - Y_START) for _ in range(13)])
    kA: List[List[Decimal]] = field(default_factory=lambda: [[Decimal('50.0')] * (X_PERIOD - Y_START) for _ in range(13)])
    lA: List[List[Decimal]] = field(default_factory=lambda: [[Decimal('50.0')] * (X_PERIOD - Y_START) for _ in range(13)])
    IHKk: List[Decimal] = field(default_factory=list)
    IHKt: List[Decimal] = field(default_factory=list)
    RSI: List[Decimal] = field(default_factory=list)
    CCI: List[Decimal] = field(default_factory=list)
    MOM: List[Decimal] = field(default_factory=list)
    AD: List[Decimal] = field(default_factory=list)
    OBV: List[Decimal] = field(default_factory=list)
    Force: List[Decimal] = field(default_factory=list)
    MFI: List[Decimal] = field(default_factory=list)
    DeM: List[Decimal] = field(default_factory=list)
    RVIm: List[Decimal] = field(default_factory=list)
    AC: List[Decimal] = field(default_factory=list)
    StdDev: List[Decimal] = field(default_factory=list)
    ATR: List[Decimal] = field(default_factory=list)
    ADX: List[Decimal] = field(default_factory=list)
    Suply: Decimal = Decimal('0.0')
    iSuply: Decimal = Decimal('0.0')
    Demand: Decimal = Decimal('0.0')
    iDemand: Decimal = Decimal('0.0')
    Sale: Decimal = Decimal('0.0')
    iSale: Decimal = Decimal('0.0')
    Stock: Decimal = Decimal('0.0')
    iStock: Decimal = Decimal('0.0')
    iStdDev: Decimal = Decimal('50.0')
    iATR: Decimal = Decimal('50.0')
    iIHKk: Decimal = Decimal('50.0')
    iIHKt: Decimal = Decimal('50.0')
    FVG: int = -1
    BL: List[Decimal] = field(default_factory=list)
    BL_type: List[str] = field(default_factory=list)
    bottomLine: str = "   "
    bL: str = "   "
    S: int = X_PERIOD
    T: int = X_PERIOD
    X_scan: int = Y_START
    Y_scan: int = Y_START
    t: Optional[datetime] = None
    iopen: Decimal = Decimal('0.0')
    iPrice: Decimal = Decimal('0.0')
    iH: Decimal = Decimal('0.0')
    iL: Decimal = Decimal('0.0')
    price: Decimal = Decimal('0.0')
    Price: Decimal = Decimal('0.0')
    open: Decimal = Decimal('0.0')
    chat_id: Optional[int] = None
    _initialized: bool = False
    webapp_user_id: Optional[int] = None
    webapp_username: Optional[str] = None
    webapp_verified: bool = False
    webapp_last_seen: Optional[datetime] = None

    trailing_stop_active: bool = False
    trailing_stop_price: Decimal = Decimal('0.0')
    trailing_take_profit: Decimal = Decimal('0.0')
    on_track_runs: int = 0
    on_stand_runs: int = 0
    has_open_long: bool = False
    has_open_short: bool = False
    trailing_stop_entry: Decimal = Decimal('0.0')
    trailing_stop_side: str = ""

    last_kronecker_m: int = 0
    last_kronecker_n: int = 0
    last_kronecker_h: int = -1
    fvg_anchor_map: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    _raw_price_missing: bool = False

    signal_history: List[Dict[str, Any]] = field(default_factory=list)
    max_signal_history: int = 100
    last_signal_at: Optional[str] = None
    bar_close_count: int = 0

# ============================================================================
# MODULE-LEVEL INDICATOR HELPERS — MQL4 PARITY
# ============================================================================
def sma(data: List[Decimal], period: int) -> Decimal:
    if len(data) < period or period <= 0:
        return Decimal('0.0')
    total = sum(data[-period:], Decimal('0.0'))
    return total / Decimal(period)

def ema(data: List[Decimal], period: int) -> Decimal:
    if len(data) < period or period <= 0:
        return sma(data, period)
    alpha = Decimal('2.0') / (Decimal(period) + Decimal('1.0'))
    if len(data) > 1:
        return alpha * data[-1] + (Decimal('1.0') - alpha) * ema(data[:-1], period)
    return data[-1]

def rsi(data: List[Decimal], period: int = 14) -> Decimal:
    if len(data) < period + 1 or period <= 0:
        return Decimal('50.0')
    gains = Decimal('0.0')
    losses = Decimal('0.0')
    for i in range(1, period + 1):
        diff = data[-i] - data[-i - 1]
        if diff >= Decimal('0.0'):
            gains += diff
        else:
            losses -= diff
    avg_gain = gains / Decimal(period)
    avg_loss = losses / Decimal(period)
    if avg_loss == Decimal('0.0'):
        return Decimal('100.0')
    rs = avg_gain / avg_loss
    return Decimal('100.0') - (Decimal('100.0') / (Decimal('1.0') + rs))

def stochastic(high, low, close, k_period=14, d_period=3):
    if len(close) < k_period or k_period <= 0:
        return Decimal('50.0'), Decimal('50.0')
    highest = max(high[-k_period:])
    lowest = min(low[-k_period:])
    range_val = highest - lowest
    if range_val == Decimal('0.0'):
        k = Decimal('50.0')
    else:
        k = Decimal('100.0') * (close[-1] - lowest) / range_val
    k_series = []
    for i in range(d_period):
        if len(close) < k_period + i:
            k_series.append(k)
            continue
        h_i = max(high[-(k_period + i):-i]) if i > 0 else max(high[-k_period:])
        l_i = min(low[-(k_period + i):-i]) if i > 0 else min(low[-k_period:])
        r_i = h_i - l_i
        if r_i == Decimal('0.0'):
            k_series.append(Decimal('50.0'))
        else:
            c_i = close[-1 - i]
            k_series.append(Decimal('100.0') * (c_i - l_i) / r_i)
    d = sum(k_series) / Decimal(len(k_series)) if k_series else k
    return k, d

def bollinger_bands(close, period=20, dev=Decimal('2.0')):
    if len(close) < period or period <= 0:
        return Decimal('0.0'), Decimal('0.0'), Decimal('0.0')
    mid = sma(close, period)
    variance = sum((x - mid) ** 2 for x in close[-period:]) / Decimal(period)
    std = Decimal(str(math.sqrt(float(variance)))) if variance > Decimal('0.0') else Decimal('0.0')
    upper = mid + dev * std
    lower = mid - dev * std
    return upper, mid, lower

def true_range(high, low, close, i):
    if i + 1 >= len(close):
        return high[i] - low[i]
    tr1 = high[i] - low[i]
    tr2 = abs(high[i] - close[i + 1])
    tr3 = abs(low[i] - close[i + 1])
    return max(tr1, tr2, tr3)

def atr(high, low, close, period=14):
    if len(close) < period + 1 or period <= 0:
        return Decimal('0.0')
    trs = []
    for i in range(period):
        trs.append(true_range(high, low, close, i))
    return sum(trs) / Decimal(period)

def stddev(data, period):
    if len(data) < period or period <= 0:
        return Decimal('0.0')
    mean = sum(data[-period:]) / Decimal(period)
    variance = sum((x - mean) ** 2 for x in data[-period:]) / Decimal(period)
    return Decimal(str(math.sqrt(float(variance)))) if variance > Decimal('0.0') else Decimal('0.0')

def ichimoku(high, low, close, t_period: int, k_period: int, j_period: int):
    if len(close) < j_period or j_period <= 0 or k_period <= 0 or t_period <= 0:
        return {"tenkan": Decimal('50.0'), "kijun": Decimal('50.0'),
                "senkou_a": Decimal('50.0'), "senkou_b": Decimal('50.0')}
    tenkan = (max(high[-t_period:]) + min(low[-t_period:])) / Decimal('2.0')
    kijun = (max(high[-k_period:]) + min(low[-k_period:])) / Decimal('2.0')
    senkou_a = (tenkan + kijun) / Decimal('2.0')
    senkou_b = (max(high[-j_period:]) + min(low[-j_period:])) / Decimal('2.0')
    return {"tenkan": tenkan, "kijun": kijun, "senkou_a": senkou_a, "senkou_b": senkou_b}

def to_decimal(value):
    try:
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value))
    except Exception:
        return Decimal('0.0')

def symbol_point(symbol: str) -> Decimal:
    try:
        digits = int(_symbol_digits(symbol))
    except Exception:
        digits = 2
    return Decimal(10) ** Decimal(-digits)

def _symbol_digits(symbol: str) -> int:
    try:
        import MetaTrader5 as _mt5
        info = _mt5.symbol_info(symbol)
        if info is not None and hasattr(info, "digits"):
            return int(info.digits)
    except Exception:
        pass
    return 2

# ============================================================================
# TELEGRAM WEB APP AUTHENTICATION
# ============================================================================
def verify_telegram_init_data(init_data: str, bot_token: str, max_age_seconds: int = 86400) -> Optional[Dict[str, Any]]:
    if not init_data or not bot_token:
        return None
    try:
        parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception:
        return None
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        return None
    auth_date_raw = parsed.get("auth_date")
    if auth_date_raw is not None:
        try:
            auth_age = time.time() - int(auth_date_raw)
            if auth_age > max_age_seconds or auth_age < -300:
                return None
        except (ValueError, TypeError):
            return None
    user_json = parsed.get("user")
    user_obj: Optional[Dict[str, Any]] = None
    if user_json:
        try:
            user_obj = json.loads(user_json)
        except Exception:
            user_obj = None
    return {
        "user": user_obj,
        "auth_date": int(auth_date_raw) if auth_date_raw else None,
        "raw": parsed,
    }

def _extract_auth_headers(handler: "BridgeHandler") -> Tuple[Optional[int], Optional[str], bool]:
    raw_init = handler.headers.get("X-Telegram-Init-Data", "").strip()
    if not raw_init:
        auth_hdr = handler.headers.get("Authorization", "").strip()
        if auth_hdr.lower().startswith("tma "):
            raw_init = auth_hdr[4:].strip()
    if not raw_init:
        return (None, None, False)
    verified = verify_telegram_init_data(raw_init, TELEGRAM_BOT_TOKEN_ENV)
    if not verified or not verified.get("user"):
        return (None, None, False)
    u = verified["user"] or {}
    return (u.get("id"), u.get("username"), True)

# ============================================================================
# FEED CLIENT — CLOUDFLARE WORKER RELAY
# ============================================================================
class FeedClient:
    def __init__(self, symbol: str = "BTC-USD"):
        self.symbol = symbol
        chain = SYMBOL_FALLBACKS.get(symbol)
        if chain is None:
            if symbol.endswith("-USD"):
                base = symbol[:-4]
                chain = [symbol, f"{base}USD=X"]
            else:
                chain = [symbol]
        self._chain: List[str] = list(chain)
        self._chain_index: int = 0
        self._last_update: Optional[datetime] = None
        self._failure_count: int = 0
        self._fallback_count: int = 0

    def active_symbol(self) -> str:
        return self._chain[self._chain_index]

    def _advance_symbol_chain(self) -> None:
        if len(self._chain) <= 1:
            return
        self._chain_index = (self._chain_index + 1) % len(self._chain)
        logger.warning(f"🔄 FeedClient: rotating symbol chain to '{self.active_symbol()}'")
        self._fallback_count = 0
        self._failure_count = 0

    def _rebuild_ticker(self) -> None:
        logger.info("🔄 FeedClient: rebuild requested (no-op; Worker handles upstream)")

    def _get(self, kind: str, **params) -> Optional[Any]:
        if not RELAY_URL:
            logger.error("❌ RELAY_URL not set — cannot fetch price")
            return None
        params["symbol"] = self.active_symbol()
        params["kind"] = kind
        qs = urllib.parse.urlencode(params)
        url = f"{RELAY_URL}/?{qs}"
        last_error = None
        for attempt in range(RELAY_MAX_RETRIES):
            try:
                req_headers = {
                    "Accept": "application/json",
                    "User-Agent": "AEI-Bridge/v4.1.0",
                    "Cache-Control": "no-cache",
                }
                if RELAY_KEY:
                    req_headers["X-Relay-Key"] = RELAY_KEY
                req = urllib.request.Request(url, headers=req_headers)
                with urllib.request.urlopen(req, timeout=RELAY_TIMEOUT) as r:
                    raw = r.read().decode("utf-8")
                    payload = json.loads(raw)
                    if isinstance(payload, dict) and payload.get("error"):
                        logger.warning(f"Relay returned error for {self.active_symbol()}: {payload.get('error')}")
                        self._failure_count += 1
                        self._fallback_count += 1
                        if self._fallback_count >= 5:
                            self._advance_symbol_chain()
                        return None
                    self._failure_count = 0
                    self._fallback_count = 0
                    self._last_update = datetime.now()
                    return payload
            except urllib.error.HTTPError as e:
                try:
                    error_body = e.read().decode('utf-8', errors='ignore')
                except Exception:
                    error_body = '<unreadable>'
                last_error = f"HTTP {e.code}: {error_body[:200]}"
                logger.warning(f"Relay HTTP Error {e.code} for {self.active_symbol()} (attempt {attempt+1}/{RELAY_MAX_RETRIES}): {error_body[:200]}")
                if e.code in (401, 403, 429) and attempt < RELAY_MAX_RETRIES - 1:
                    time.sleep(1 + attempt * 2)
                    continue
                break
            except urllib.error.URLError as e:
                last_error = f"URLError: {e.reason}"
                logger.warning(f"Relay URLError for {self.active_symbol()} (attempt {attempt+1}/{RELAY_MAX_RETRIES}): {e.reason}")
                if attempt < RELAY_MAX_RETRIES - 1:
                    time.sleep(1 + attempt * 2)
                    continue
                break
            except json.JSONDecodeError as e:
                last_error = f"JSONDecodeError: {e}"
                logger.warning(f"Relay returned invalid JSON for {self.active_symbol()}: {e}")
                break
            except Exception as e:
                last_error = f"{type(e).__name__}: {e}"
                logger.warning(f"Relay error ({kind}) for {self.active_symbol()} (attempt {attempt+1}/{RELAY_MAX_RETRIES}): {e}")
                if attempt < RELAY_MAX_RETRIES - 1:
                    time.sleep(1 + attempt * 2)
                    continue
                break
        self._failure_count += 1
        self._fallback_count += 1
        if self._fallback_count >= 5:
            self._advance_symbol_chain()
        if last_error:
            logger.warning(f"Relay exhausted retries for {kind}: {last_error}")
        return None

    def get_current_price(self) -> Tuple[Decimal, Decimal]:
        d = self._get("price")
        if not d or "close" not in d or d.get("close") is None:
            return Decimal('0.0'), Decimal('0.0')
        try:
            c = Decimal(str(d["close"]))
            if c <= Decimal('0.0'):
                logger.warning(f"Relay returned non-positive price: {c}")
                return Decimal('0.0'), Decimal('0.0')
            bid = Decimal(str(d.get("bid") or d["close"]))
            ask = Decimal(str(d.get("ask") or d["close"]))
            return bid, ask
        except Exception as e:
            logger.warning(f"Failed to parse relay price: {e}")
            return Decimal('0.0'), Decimal('0.0')

    def get_historical_klines(self, limit: int = 200, interval: str = "1m") -> List[Dict[str, Any]]:
        d = self._get("history", limit=limit, interval=interval)
        if not d or not isinstance(d, list):
            return []
        out = []
        for row in d:
            try:
                if row.get("close") is None:
                    continue
                c = Decimal(str(row["close"]))
                if c <= Decimal('0.0'):
                    continue
                ts_raw = row.get("timestamp")
                ts = datetime.now()
                if ts_raw:
                    try:
                        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).replace(tzinfo=None)
                    except Exception:
                        pass
                out.append({
                    "open": Decimal(str(row["open"])),
                    "high": Decimal(str(row["high"])),
                    "low": Decimal(str(row["low"])),
                    "close": c,
                    "volume": Decimal(str(row.get("volume") or 0)),
                    "timestamp": ts,
                })
            except Exception:
                continue
        return out

    def get_intraday(self, interval: str = "1m") -> Dict[str, Any]:
        d = self._get("intraday", interval=interval)
        if not d or d.get("close") is None:
            return {}
        try:
            c = Decimal(str(d["close"]))
            if c <= Decimal('0.0'):
                logger.warning(f"Relay returned non-positive intraday close: {c}")
                return {}
            ts_raw = d.get("timestamp")
            ts = datetime.now()
            if ts_raw:
                try:
                    ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).replace(tzinfo=None)
                except Exception:
                    pass
            return {
                "open": Decimal(str(d["open"])),
                "high": Decimal(str(d["high"])),
                "low": Decimal(str(d["low"])),
                "close": c,
                "volume": Decimal(str(d.get("volume") or 0)),
                "timestamp": ts,
            }
        except Exception as e:
            logger.warning(f"Failed to parse intraday: {e}")
            return {}

    def get_info(self) -> Dict[str, Any]:
        return {"name": self.active_symbol(), "currency": "USD"}

    def probe(self) -> Dict[str, Any]:
        d = self._get("price")
        return {
            "active_symbol": self.active_symbol(),
            "primary_symbol": self.symbol,
            "chain": list(self._chain),
            "chain_index": self._chain_index,
            "empty": (d is None or d.get("close") is None),
            "failure_count": self._failure_count,
            "fallback_count": self._fallback_count,
            "last_update": self._last_update.isoformat() if self._last_update else None,
            "relay_url": RELAY_URL,
        }

# ============================================================================
# CORE ÆEA ENGINE — Faithful Port of æea.mq4
# ============================================================================
class AEEA_Engine:
    def __init__(self):
        self.state = AEI_CoreState()
        self.price_history: List[PriceData] = []
        self.ohlcv_history: List[Dict[str, Any]] = []
        self.feed = FeedClient(SYMBOL)
        self._last_price_update: Optional[datetime] = None
        self._bar_open: bool = True
        self._bar_index: int = 0
        self._running: bool = False
        self.chat_id: Optional[int] = None
        self.application = None
        self._last_signal_time: Optional[datetime] = None
        self._signal_cooldown: int = 60
        self._initialization_attempted: bool = False
        self._tick_log_counter: int = 0
        self._price_update_counter: int = 0
        self._bridge_publish_callback = None
        self._last_relay_warn: Optional[datetime] = None
        self._consecutive_zero_prices: int = 0
        self._indicator_populate_count: int = 0
        self._imbalance_fire_count: int = 0
        self._active_trailing_stop: Decimal = Decimal('0.0')
        self._active_trailing_tp: Decimal = Decimal('0.0')
        self._last_kronecker_bar: int = -1
        self._sSL: Decimal = Decimal('0.0')
        self._bSL: Decimal = Decimal('0.0')
        self._sTP: Decimal = Decimal('0.0')
        self._bTP: Decimal = Decimal('0.0')
        self._point_size: Decimal = symbol_point(SYMBOL)
        self.orders: List[Order] = []
        self._next_ticket: int = 1

    def OnInit(self) -> None:
        logger.info("⚡ OnInit(): EA engine lifecycle beginning")
        self.OnReInit()
        logger.info("🟢 OnInit(): state reset to baseline")

    def OnReInit(self) -> None:
        st = self.state
        saved_ohlcv = self.ohlcv_history.copy()
        saved_price = st.price
        saved_Price = st.Price
        saved_iH = st.iH
        saved_iL = st.iL
        saved_tick = st.tick
        saved_on_track = st.on_track_runs
        saved_on_stand = st.on_stand_runs
        saved_signal_history = list(st.signal_history)
        saved_chat_id = st.chat_id
        saved_webapp_uid = st.webapp_user_id
        saved_webapp_uname = st.webapp_username
        saved_webapp_verified = st.webapp_verified

        st.KC = st.invert
        size = X_PERIOD - Y_START
        for i in range(13):
            st.cA[i] = [Decimal('0.0')] * size
            st.iA[i] = [Decimal('0.0')] * size
            st.kA[i] = [Decimal('0.0')] * size
            st.lA[i] = [Decimal('0.0')] * size
        st.IHKk = []
        st.IHKt = []
        st.RSI = []
        st.CCI = []
        st.MOM = []
        st.AD = []
        st.OBV = []
        st.Force = []
        st.MFI = []
        st.DeM = []
        st.RVIm = []
        st.AC = []
        st.StdDev = []
        st.ATR = []
        st.ADX = []
        st.Regime = ["sRange"] * size
        st.Premium = [Decimal('0.0')] * size
        st.Discount = [Decimal('0.0')] * size
        st.HH = [Decimal('0.0')] * size
        st.LL = [Decimal('0.0')] * size
        st.k = [False] * size
        st.l = [False] * size
        st.U = []
        st.R = True
        st.D = Decimal('0.0')
        st.E = Decimal('0.0')
        st.K = False
        st.Z = Y_START + 1
        st.z = Y_START + 1
        st.O = Y_START + 1
        st.o = Y_START + 1
        st.r = 0
        st.W = Y_START + 1
        st.w = Y_START + 1
        st.I = 0
        st.iI = 0
        st.J = 0
        st.iJ = 0
        st.ij = 0
        st.toll = 0
        st.tally = "   "
        st.tick_tock = False
        st.iZ = Y_START + 1
        st.iz = Y_START + 1
        st.iW = Y_START + 1
        st.iw = Y_START + 1
        st.iO = Y_START + 1
        st.io = Y_START + 1
        st.ir = 0
        st.S = X_PERIOD
        st.T = X_PERIOD
        st.X_scan = Y_START
        st.Y_scan = Y_START
        st.FG = False
        st.signature = False
        st.signal = Decimal('0.0')
        st.FVG = -1
        st.BL = []
        st.BL_type = []
        st.bottomLine = "   "
        st.bL = "   "
        st.count = 0
        st.fvg_anchor_map = {}
        st.m_now = 0
        st.n_now = 0
        st.lPass = Decimal('0.0')
        st.ilPass = Decimal('0.0')
        st.kPass = Decimal('0.0')
        st.ikPass = Decimal('0.0')
        self.ohlcv_history = saved_ohlcv
        st.price = saved_price
        st.Price = saved_Price
        st.iH = saved_iH
        st.iL = saved_iL
        st.tick = saved_tick
        st.on_track_runs = saved_on_track
        st.on_stand_runs = saved_on_stand
        st.signal_history = saved_signal_history
        st.chat_id = saved_chat_id
        st.webapp_user_id = saved_webapp_uid
        st.webapp_username = saved_webapp_uname
        st.webapp_verified = saved_webapp_verified
        logger.info(f"🔄 OnReInit() completed — Tick preserved: {st.tick}, Signals preserved: {len(saved_signal_history)}")

    def _unify(self, j: int) -> Tuple[Decimal, Decimal]:
        st = self.state
        if j < 1 or len(self.ohlcv_history) < j + 1:
            st.iATR = Decimal('50.0')
            st.iStdDev = Decimal('50.0')
            return st.iATR, st.iStdDev
        end = len(self.ohlcv_history)
        start = end - (j + 1)
        window = self.ohlcv_history[start:end]
        high_prices = [d["high"] for d in window]
        low_prices = [d["low"] for d in window]
        close_prices = [d["close"] for d in window]

        atr_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            atr_list.append(atr(sub_high, sub_low, sub_close, j))
        maxATR = max(atr_list) if atr_list else Decimal('0.0')
        minATR = min(atr_list) if atr_list else Decimal('0.0')
        rangeATR = maxATR - minATR
        if rangeATR != Decimal('0.0'):
            st.iATR = Decimal('100.0') * ((atr_list[0] - minATR) / rangeATR)
        else:
            st.iATR = Decimal('50.0')
        if len(st.ATR) <= j:
            st.ATR.extend([Decimal('0.0')] * (j + 1 - len(st.ATR)))
        st.ATR[j] = atr_list[0] if atr_list else Decimal('0.0')

        sd_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            sd_list.append(stddev(sub_close, j))
        maxSD = max(sd_list) if sd_list else Decimal('0.0')
        minSD = min(sd_list) if sd_list else Decimal('0.0')
        rangeSD = maxSD - minSD
        if rangeSD != Decimal('0.0'):
            st.iStdDev = Decimal('100.0') * ((sd_list[0] - minSD) / rangeSD)
        else:
            st.iStdDev = Decimal('50.0')
        if len(st.StdDev) <= j:
            st.StdDev.extend([Decimal('0.0')] * (j + 1 - len(st.StdDev)))
        st.StdDev[j] = sd_list[0] if sd_list else Decimal('0.0')
        return st.iATR, st.iStdDev

    def _normalize(self, j: int) -> None:
        st = self.state
        y = st.y
        if j < 1 or len(self.ohlcv_history) < j + 1:
            return
        end = len(self.ohlcv_history)
        window = self.ohlcv_history[end - (j + 1):end]
        close_prices = [d["close"] for d in window]
        high_prices = [d["high"] for d in window]
        low_prices = [d["low"] for d in window]
        volume_data = [d.get("volume", Decimal('0.0')) for d in window]

        if len(close_prices) >= j:
            upper, _, lower = bollinger_bands(close_prices, j, Decimal('2.0'))
            st.Suply = upper
            st.Demand = lower
        if len(close_prices) >= 2:
            upper_prev, _, lower_prev = bollinger_bands(close_prices[:-1], j, Decimal('2.0'))
            st.iSuply = upper_prev
            st.iDemand = lower_prev

        col_i = j - (y + 1)
        col_c = col_i
        if col_i < 0 or col_i >= len(st.iA[0]):
            return
        if col_c < 0 or col_c >= len(st.cA[0]):
            col_c = col_i

        adx_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            adx_list.append(self._compute_adx(sub_high, sub_low, sub_close, j))
        if adx_list:
            maxADX = max(adx_list)
            minADX = min(adx_list)
            rangeADX = maxADX - minADX
            if rangeADX != Decimal('0.0'):
                iADX_val = abs(Decimal('100.0') * ((adx_list[0] - minADX) / rangeADX))
                cADX_val = abs(Decimal('100.0') * ((adx_list[1] - minADX) / rangeADX)) if len(adx_list) > 1 else iADX_val
                st.iA[0][col_i] = iADX_val
                st.cA[0][col_c] = cADX_val

        k_stoch, d_stoch = stochastic(high_prices, low_prices, close_prices, j, 3)
        st.iA[1][col_i] = (k_stoch + d_stoch) / Decimal('2.0')
        if len(close_prices) > 1:
            k_p, d_p = stochastic(high_prices[:-1], low_prices[:-1], close_prices[:-1], j, 3)
            st.cA[1][col_c] = (k_p + d_p) / Decimal('2.0')

        rvi_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            rvi_list.append(self._compute_rvi(sub_close, j))
        if rvi_list:
            maxRVI = max(rvi_list)
            minRVI = min(rvi_list)
            rangeRVI = maxRVI - minRVI
            if rangeRVI != Decimal('0.0'):
                st.iA[2][col_i] = Decimal('100.0') * ((rvi_list[0] - minRVI) / rangeRVI)
                st.cA[2][col_c] = Decimal('100.0') * ((rvi_list[1] - minRVI) / rangeRVI) if len(rvi_list) > 1 else st.iA[2][col_i]

        ac_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            ac_list.append(abs(self._compute_ac(sub_high, sub_low, sub_close, j)))
        if ac_list:
            maxAC = max(ac_list)
            minAC = min(ac_list)
            rangeAC = maxAC - minAC
            if rangeAC != Decimal('0.0'):
                st.iA[3][col_i] = abs(Decimal('100.0') * ((ac_list[0] - minAC) / rangeAC))
                st.cA[3][col_c] = abs(Decimal('100.0') * ((ac_list[1] - minAC) / rangeAC)) if len(ac_list) > 1 else st.iA[3][col_i]

        force_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            sub_vol = volume_data[:len(volume_data) - i] if i > 0 else volume_data
            force_list.append(self._compute_force(sub_close, sub_vol, j))
        if force_list:
            maxForce = max(force_list)
            minForce = min(force_list)
            rangeForce = maxForce - minForce
            if rangeForce != Decimal('0.0'):
                st.iA[4][col_i] = Decimal('100.0') * ((force_list[0] - minForce) / rangeForce)
                st.cA[4][col_c] = Decimal('100.0') * ((force_list[1] - minForce) / rangeForce) if len(force_list) > 1 else st.iA[4][col_i]

        obv_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            sub_vol = volume_data[:len(volume_data) - i] if i > 0 else volume_data
            obv_list.append(self._compute_obv(sub_close, sub_vol, j))
        if obv_list:
            maxOBV = max(obv_list)
            minOBV = min(obv_list)
            rangeOBV = maxOBV - minOBV
            if rangeOBV != Decimal('0.0'):
                st.iA[5][col_i] = Decimal('100.0') * ((obv_list[0] - minOBV) / rangeOBV)
                st.cA[5][col_c] = Decimal('100.0') * ((obv_list[1] - minOBV) / rangeOBV) if len(obv_list) > 1 else st.iA[5][col_i]

        ad_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            sub_vol = volume_data[:len(volume_data) - i] if i > 0 else volume_data
            ad_list.append(self._compute_ad(sub_high, sub_low, sub_close, sub_vol, j))
        if ad_list:
            maxAD = max(ad_list)
            minAD = min(ad_list)
            rangeAD = maxAD - minAD
            if rangeAD != Decimal('0.0'):
                st.iA[6][col_i] = Decimal('100.0') * ((ad_list[0] - minAD) / rangeAD)
                st.cA[6][col_c] = Decimal('100.0') * ((ad_list[1] - minAD) / rangeAD) if len(ad_list) > 1 else st.iA[6][col_i]

        mfi_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            sub_vol = volume_data[:len(volume_data) - i] if i > 0 else volume_data
            mfi_list.append(self._compute_mfi(sub_high, sub_low, sub_close, sub_vol, j))
        if mfi_list:
            maxMFI = max(mfi_list)
            minMFI = min(mfi_list)
            rangeMFI = maxMFI - minMFI
            if rangeMFI != Decimal('0.0'):
                st.iA[7][col_i] = Decimal('100.0') * ((mfi_list[0] - minMFI) / rangeMFI)
                st.cA[7][col_c] = Decimal('100.0') * ((mfi_list[1] - minMFI) / rangeMFI) if len(mfi_list) > 1 else st.iA[7][col_i]

        mom_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            mom_list.append(self._compute_momentum(sub_close, j))
        if mom_list:
            maxMOM = max(mom_list)
            minMOM = min(mom_list)
            rangeMOM = maxMOM - minMOM
            if rangeMOM != Decimal('0.0'):
                st.iA[8][col_i] = Decimal('100.0') * ((mom_list[0] - minMOM) / rangeMOM)
                st.cA[8][col_c] = Decimal('100.0') * ((mom_list[1] - minMOM) / rangeMOM) if len(mom_list) > 1 else st.iA[8][col_i]

        dem_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            dem_list.append(self._compute_demarker(sub_high, sub_low, j))
        if dem_list:
            maxDM = max(dem_list)
            minDM = min(dem_list)
            rangeDM = maxDM - minDM
            if rangeDM != Decimal('0.0'):
                st.iA[9][col_i] = Decimal('100.0') * ((dem_list[0] - minDM) / rangeDM)
                st.cA[9][col_c] = Decimal('100.0') * ((dem_list[1] - minDM) / rangeDM) if len(dem_list) > 1 else st.iA[9][col_i]

        wpr_now = self._compute_wpr(high_prices, low_prices, close_prices, j) + Decimal('100.0')
        st.iA[10][col_i] = wpr_now
        if len(close_prices) > 1:
            wpr_prev = self._compute_wpr(high_prices[:-1], low_prices[:-1], close_prices[:-1], j) + Decimal('100.0')
            st.cA[10][col_c] = wpr_prev

        cci_list: List[Decimal] = []
        for i in range(j + 1):
            sub_high = high_prices[:len(high_prices) - i] if i > 0 else high_prices
            sub_low = low_prices[:len(low_prices) - i] if i > 0 else low_prices
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            cci_list.append(self._compute_cci(sub_high, sub_low, sub_close, j))
        if cci_list:
            maxCCI = max(cci_list)
            minCCI = min(cci_list)
            rangeCCI = maxCCI - minCCI
            if rangeCCI != Decimal('0.0'):
                st.iA[11][col_i] = Decimal('100.0') * ((cci_list[0] - minCCI) / rangeCCI)
                st.cA[11][col_c] = Decimal('100.0') * ((cci_list[1] - minCCI) / rangeCCI) if len(cci_list) > 1 else st.iA[11][col_i]

        rsi_list: List[Decimal] = []
        for i in range(j + 1):
            sub_close = close_prices[:len(close_prices) - i] if i > 0 else close_prices
            rsi_list.append(rsi(sub_close, j))
        if rsi_list:
            maxRSI = max(rsi_list)
            minRSI = min(rsi_list)
            rangeRSI = maxRSI - minRSI
            if rangeRSI != Decimal('0.0'):
                st.iA[12][col_i] = Decimal('100.0') * ((rsi_list[0] - minRSI) / rangeRSI)
                st.cA[12][col_c] = Decimal('100.0') * ((rsi_list[1] - minRSI) / rangeRSI) if len(rsi_list) > 1 else st.iA[12][col_i]

        kIHK = int(round(j / 2.0))
        tIHK = int(round((kIHK + 1.0) / 3.0))
        if kIHK < 1:
            kIHK = 1
        if tIHK < 1:
            tIHK = 1
        ihk = ichimoku(high_prices, low_prices, close_prices, tIHK, kIHK, j)
        st.iIHKk = ihk["kijun"]
        st.iIHKt = ihk["tenkan"]

    def _compute_adx(self, high, low, close, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('50.0')
        trs, plus_dm, minus_dm = [], [], []
        for i in range(1, period + 1):
            tr = max(high[-i] - low[-i], abs(high[-i] - close[-i - 1]), abs(low[-i] - close[-i - 1]))
            trs.append(tr)
            up_move = high[-i] - high[-i - 1]
            dn_move = low[-i - 1] - low[-i]
            plus_dm.append(up_move if up_move > dn_move and up_move > 0 else Decimal('0.0'))
            minus_dm.append(dn_move if dn_move > up_move and dn_move > 0 else Decimal('0.0'))
        if len(trs) < period:
            return Decimal('50.0')
        dx_series = []
        atr_k = Decimal('0.0')
        plus_di = Decimal('0.0')
        minus_di = Decimal('0.0')
        for k in range(period):
            if k == 0:
                atr_k = sum(trs[:period]) / Decimal(period)
                plus_di = Decimal('100.0') * (sum(plus_dm[:period]) / Decimal(period)) / atr_k if atr_k != Decimal('0.0') else Decimal('0.0')
                minus_di = Decimal('100.0') * (sum(minus_dm[:period]) / Decimal(period)) / atr_k if atr_k != Decimal('0.0') else Decimal('0.0')
            else:
                atr_k = (atr_k * Decimal(period - 1) + trs[period - k - 1]) / Decimal(period)
                smoothed_plus = (plus_di * Decimal(period - 1) + plus_dm[period - k - 1]) / Decimal(period)
                smoothed_minus = (minus_di * Decimal(period - 1) + minus_dm[period - k - 1]) / Decimal(period)
                plus_di = Decimal('100.0') * smoothed_plus / atr_k if atr_k != Decimal('0.0') else Decimal('0.0')
                minus_di = Decimal('100.0') * smoothed_minus / atr_k if atr_k != Decimal('0.0') else Decimal('0.0')
            di_sum = plus_di + minus_di
            if di_sum == Decimal('0.0'):
                dx_series.append(Decimal('0.0'))
            else:
                dx_series.append(Decimal('100.0') * abs(plus_di - minus_di) / di_sum)
        if not dx_series:
            return Decimal('50.0')
        if len(dx_series) < period:
            return dx_series[-1]
        adx_val = sum(dx_series[:period]) / Decimal(period)
        for k in range(period, len(dx_series)):
            adx_val = (adx_val * Decimal(period - 1) + dx_series[k]) / Decimal(period)
        return adx_val

    def _compute_rvi(self, close, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('50.0')
        numerator = Decimal('0.0')
        denominator = Decimal('0.0')
        for i in range(1, period + 1):
            diff = close[-i] - close[-i - 1]
            if diff > Decimal('0.0'):
                numerator += diff            elif diff < Decimal('0.0'):
                denominator += abs(diff)
        if denominator == Decimal('0.0'):
            if numerator == Decimal('0.0'):
                return Decimal('50.0')
            return Decimal('100.0')
        ratio = numerator / denominator
        return Decimal('100.0') * ratio / (Decimal('1.0') + ratio)

    def _compute_ac(self, high, low, close, period: int) -> Decimal:
        if len(close) < 40 or period <= 0:
            return Decimal('0.0')
        median = [(high[-i] + low[-i]) / Decimal('2.0') for i in range(len(close))]
        median.reverse()
        def sma_local(data, p):
            if len(data) < p or p <= 0:
                return Decimal('0.0')
            return sum(data[-p:]) / Decimal(p)
        ao_now = sma_local(median, 5) - sma_local(median, 34)
        if len(median) < 5:
            return Decimal('0.0')
        ao_series = []
        for i in range(min(5, len(median))):
            sub = median[:len(median) - i] if i > 0 else median
            ao_series.append(sma_local(sub, 5) - sma_local(sub, 34))
        ac = ao_now - sma_local(ao_series, 5)
        return ac

    def _compute_force(self, close, volume, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('0.0')
        forces = []
        for i in range(1, period + 1):
            forces.append(volume[-i] * (close[-i] - close[-i - 1]))
        return sum(forces) / Decimal(period)

    def _compute_obv(self, close, volume, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('0.0')
        obv = Decimal('0.0')
        for i in range(period, 0, -1):
            if i >= len(close):
                continue
            if close[-i] > close[-i - 1]:
                obv += volume[-i]
            elif close[-i] < close[-i - 1]:
                obv -= volume[-i]
        return obv

    def _compute_ad(self, high, low, close, volume, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('0.0')
        ad = Decimal('0.0')
        for i in range(period, 0, -1):
            if i >= len(close):
                continue
            hl = high[-i] - low[-i]
            if hl > Decimal('0.0'):
                mfv = ((close[-i] - low[-i]) - (high[-i] - close[-i])) / hl * volume[-i]
                ad += mfv
        return ad

    def _compute_mfi(self, high, low, close, volume, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('50.0')
        pos_flow, neg_flow = Decimal('0.0'), Decimal('0.0')
        for i in range(1, period + 1):
            tp = (high[-i] + low[-i] + close[-i]) / Decimal('3.0')
            tp_prev = (high[-i - 1] + low[-i - 1] + close[-i - 1]) / Decimal('3.0')
            mf = tp * volume[-i]
            if tp > tp_prev:
                pos_flow += mf
            elif tp < tp_prev:
                neg_flow += mf
        if neg_flow == Decimal('0.0'):
            if pos_flow == Decimal('0.0'):
                return Decimal('50.0')
            return Decimal('100.0')
        mr = pos_flow / neg_flow
        return Decimal('100.0') - (Decimal('100.0') / (Decimal('1.0') + mr))

    def _compute_momentum(self, close, period: int) -> Decimal:
        if len(close) < period + 1 or period <= 0:
            return Decimal('0.0')
        return close[-1] - close[-period - 1]

    def _compute_demarker(self, high, low, period: int) -> Decimal:
        if len(high) < period + 1 or period <= 0:
            return Decimal('50.0')
        demax, demin = Decimal('0.0'), Decimal('0.0')
        for i in range(1, period + 1):
            if high[-i] > high[-i - 1]:
                demax += high[-i] - high[-i - 1]
            if low[-i] < low[-i - 1]:
                demin += low[-i - 1] - low[-i]
        total = demax + demin
        if total == Decimal('0.0'):
            return Decimal('50.0')
        return Decimal('100.0') * demax / total

    def _compute_wpr(self, high, low, close, period: int) -> Decimal:
        if len(close) < period or period <= 0:
            return Decimal('0.0')
        hh = max(high[-period:])
        ll = min(low[-period:])
        rng = hh - ll
        if rng == Decimal('0.0'):
            return Decimal('0.0')
        return Decimal('-100.0') * (hh - close[-1]) / rng

    def _compute_cci(self, high, low, close, period: int) -> Decimal:
        if len(close) < period or period <= 0:
            return Decimal('0.0')
        tp = [(high[-i] + low[-i] + close[-i]) / Decimal('3.0') for i in range(1, period + 1)]
        sma_tp = sum(tp) / Decimal(period)
        mad = sum(abs(x - sma_tp) for x in tp) / Decimal(period)
        if mad == Decimal('0.0'):
            return Decimal('0.0')
        return (tp[0] - sma_tp) / (Decimal('0.015') * mad)

    def _count_imbalance(self, j: int) -> Tuple[int, int]:
        st = self.state
        y = st.y
        m = 0
        n = 0
        idx_i = j - (y + 1)
        if idx_i < 0 or idx_i >= len(st.iA[0]):
            return (0, 0)
        idx_c = idx_i
        if idx_c < 0 or idx_c >= len(st.cA[0]):
            idx_c = idx_i
        f_plus_gf = F_THRESHOLD_D + GF_TOLERANCE_D
        g_minus_gf = G_THRESHOLD_D - GF_TOLERANCE_D
        hh_val = st.HH[idx_i] if idx_i < len(st.HH) else Decimal('0.0')
        ll_val = st.LL[idx_i] if idx_i < len(st.LL) else Decimal('0.0')
        for i in range(13):
            iA_val = st.iA[i][idx_i]
            cA_val = st.cA[i][idx_c]
            kA_val = st.kA[i][idx_c]
            lA_val = st.lA[i][idx_c]
            if st.Price > hh_val:
                if iA_val > f_plus_gf or cA_val < kA_val:
                    m += 1
            elif st.price > hh_val:
                if iA_val > f_plus_gf or iA_val < kA_val:
                    m += 1
            else:
                if iA_val > f_plus_gf:
                    m += 1
            if st.Price < ll_val:
                if iA_val < g_minus_gf or cA_val > lA_val:
                    n += 1
            elif st.price < ll_val:
                if iA_val < g_minus_gf or iA_val > lA_val:
                    n += 1
            else:
                if iA_val < g_minus_gf:
                    n += 1
        adx_val = st.iA[0][idx_i]
        if adx_val > f_plus_gf or adx_val < g_minus_gf:
            m += 1
        if st.iIHKt > f_plus_gf and st.iIHKk > f_plus_gf:
            m += 1
        if st.iIHKt < g_minus_gf and st.iIHKk < g_minus_gf:
            n += 1
        return (m, n)

    def _M(self, j: int) -> int:
        st = self.state
        y = st.y
        m = 0
        idx_i = j - (y + 1)
        idx_c = idx_i
        if idx_i < 0 or idx_i >= len(st.iA[0]):
            return 0
        if idx_c < 0 or idx_c >= len(st.cA[0]):
            idx_c = idx_i
        f_plus_gf = F_THRESHOLD_D + GF_TOLERANCE_D
        g_minus_gf = G_THRESHOLD_D - GF_TOLERANCE_D
        hh_val = st.HH[idx_i] if idx_i < len(st.HH) else Decimal('0.0')
        for i in range(13):
            iA_val = st.iA[i][idx_i]
            cA_val = st.cA[i][idx_c]
            kA_val = st.kA[i][idx_c]
            if st.Price > hh_val:
                if iA_val > f_plus_gf or cA_val < kA_val:
                    m += 1
                continue
            if st.price > hh_val:
                if iA_val > f_plus_gf or iA_val < kA_val:
                    m += 1
                continue
            if iA_val > f_plus_gf:
                m += 1
        adx_val = st.iA[0][idx_i]
        if adx_val > f_plus_gf or adx_val < g_minus_gf:
            m += 1
        if st.iIHKt > f_plus_gf and st.iIHKk > f_plus_gf:
            m += 1
        if st.Price > hh_val:
            for i in range(13):
                st.kA[i][idx_c] = st.cA[i][idx_c]
            if idx_i < len(st.HH):
                st.HH[idx_i] = st.Price
        return m

    def _N(self, j: int) -> int:
        st = self.state
        y = st.y
        n = 0
        idx_i = j - (y + 1)
        idx_c = idx_i
        if idx_i < 0 or idx_i >= len(st.iA[0]):
            return 0
        if idx_c < 0 or idx_c >= len(st.cA[0]):
            idx_c = idx_i
        f_plus_gf = F_THRESHOLD_D + GF_TOLERANCE_D
        g_minus_gf = G_THRESHOLD_D - GF_TOLERANCE_D
        ll_val = st.LL[idx_i] if idx_i < len(st.LL) else Decimal('0.0')
        for i in range(13):
            iA_val = st.iA[i][idx_i]
            cA_val = st.cA[i][idx_c]
            lA_val = st.lA[i][idx_c]
            if st.Price < ll_val:
                if iA_val < g_minus_gf or cA_val > lA_val:
                    n += 1
                continue
            if st.price < ll_val:
                if iA_val < g_minus_gf or iA_val > lA_val:
                    n += 1
                continue
            if iA_val < g_minus_gf:
                n += 1
        adx_val = st.iA[0][idx_i]
        if adx_val > f_plus_gf or adx_val < g_minus_gf:
            n += 1
        if st.iIHKt < g_minus_gf and st.iIHKk < g_minus_gf:
            n += 1
        if st.Price < ll_val:
            for i in range(13):
                st.lA[i][idx_c] = st.cA[i][idx_c]
            if idx_i < len(st.LL):
                st.LL[idx_i] = st.Price
        return n

    def _H(self, j: int) -> None:
        st = self.state
        idx = j - (st.y + 1)
        if idx < 0 or idx >= len(st.k):
            return
        m = self._M(j)
        st.m = m
        st.k[idx] = (m >= 12)
        st.last_kronecker_m = m
        st.last_kronecker_h = j
        st.m = 0
        if st.k[idx]:
            logger.info(f"🔺 H() set k[{idx}] = True (m={m} >= 12) at bar j={j}")

    def _L(self, j: int) -> None:
        st = self.state
        idx = j - (st.y + 1)
        if idx < 0 or idx >= len(st.l):
            return
        n = self._N(j)
        st.n = n
        st.l[idx] = (n >= 12)
        st.last_kronecker_n = n
        st.last_kronecker_h = j
        st.n = 0
        if st.l[idx]:
            logger.info(f"🔻 L() set l[{idx}] = True (n={n} >= 12) at bar j={j}")

    def _F(self, j: int, iH: Decimal, iL: Decimal) -> None:
        st = self.state
        y = st.y
        idx = j - (y + 1)
        if idx < 0 or idx >= len(st.k):
            return
        self._normalize(j)
        st.k[idx] = False
        st.l[idx] = False
        st.HH[idx] = iH
        st.LL[idx] = iL
        st.Premium[idx] = iH
        st.Discount[idx] = iL
        idx_c = idx
        if idx_c < 0 or idx_c >= len(st.cA[0]):
            idx_c = idx
        for i in range(13):
            if idx_c < len(st.kA[i]) and idx_c < len(st.cA[i]):
                st.kA[i][idx_c] = st.cA[i][idx_c]
                st.lA[i][idx_c] = st.cA[i][idx_c]
        if st.R and st.FG:
            target_size = X_PERIOD - Y_START
            while len(st.U) < target_size:
                st.U.append(False)
            if idx < len(st.U):
                st.U[idx] = True
            V = 0
            for i in range(y + 1, X_PERIOD):
                ui = i - (y + 1)
                if 0 <= ui < len(st.U) and st.U[ui]:
                    V += 1
            if V == target_size:
                st.R = False

    def _G(self) -> None:
        st = self.state
        y = st.y
        if len(self.ohlcv_history) < 2:
            return
        H = self.ohlcv_history[-2]["high"]
        L = self.ohlcv_history[-2]["low"]
        for j in range(y + 1, st.h + 1):
            if j == X_PERIOD:
                break
            idx = j - (y + 1)
            if idx < 0 or idx >= len(st.k):
                continue
            st.k[idx] = False
            st.l[idx] = False
            st.HH[idx] = H
            st.LL[idx] = L
            st.Premium[idx] = H
            st.Discount[idx] = L
            idx_c = idx
            if idx_c < 0 or idx_c >= len(st.cA[0]):
                idx_c = idx
            for i in range(13):
                if idx_c < len(st.kA[i]) and idx_c < len(st.cA[i]):
                    st.kA[i][idx_c] = st.cA[i][idx_c]
                    st.lA[i][idx_c] = st.cA[i][idx_c]

    def _J(self) -> None:
        st = self.state
        if st.I == st.iZ:
            st.J = st.iW
        elif st.I == st.iW:
            st.J = st.iZ
        if st.iI == st.iz:
            st.iJ = st.iw
        elif st.iI == st.iw:
            st.iJ = st.iz

    def _O(self, inp: int, inp0: int, inp1: int, which: str = "C") -> None:
        st = self.state
        regime_idx = inp0 - (st.y + 1)
        if regime_idx < 0 or regime_idx >= len(st.Regime):
            return
        regime = st.Regime[regime_idx]
        if which == "C":
            ref = st.Cc
        elif which == "c":
            ref = st.cC
        else:
            return
        if (inp < inp1) and (regime == "sRange" or regime == "tRange"):
            new_val = ref
        elif regime != "sRange" and regime != "tRange":
            new_val = not ref
        else:
            new_val = not ref
        if which == "C":
            st.C = new_val
        else:
            st.c = new_val

    def _R(self, j: int) -> None:
        st = self.state
        if j <= st.J:
            st.O = j
            st.iO = j
        if (j > st.J) and (j < st.r):
            st.O = j
            st.iO = j
            st.r = j
        elif j > st.J:
            st.r = j
        if j <= st.iJ:
            st.o = j
            st.io = j
        if (j > st.iJ) and (j < st.ir):
            st.o = j
            st.io = j
            st.ir = j
        elif j > st.iJ:
            st.ir = j

    def _KC(self) -> None:
        st = self.state
        if st.E != Decimal('0.0') and (not st.A) and (not st.B) and st.v and st.signal < st.E:
            st.invert = not st.KC
        if st.D != Decimal('0.0') and (not st.B) and (not st.A) and st.u and st.signal > st.D:
            st.invert = not st.KC

    def _on_hold(self, inp: int, inp0: str, inp1: str) -> bool:
        st = self.state
        idx = inp - (st.y + 1)
        if idx < 0 or idx >= len(st.Regime):
            return False
        return st.Regime[idx] == inp0 or st.Regime[idx] == inp1

    def _on_fire(self, inp: int, inp0: str, inp1: str) -> bool:
        st = self.state
        idx = inp - (st.y + 1)
        if idx < 0 or idx >= len(st.Regime):
            return False
        return st.Regime[idx] != inp0 and st.Regime[idx] != inp1

    def _on_point(self) -> None:
        st = self.state
        y = st.y
        for j in range(y + 1, X_PERIOD):
            idx = j - (y + 1)
            if idx < 0 or idx >= len(st.Regime):
                break
            self._unify(j)
            self._normalize(j)
            if st.iStdDev < Decimal('50.0') and st.iATR > Decimal('50.0'):
                if st.Regime[idx] != "Stable":
                    self._H(j)
                    self._L(j)
                    if self._on_fire(j, "sVolatile", "tVolatile"):
                        st.Regime[idx] = "sVolatile"
            elif st.iStdDev < Decimal('50.0') and st.iATR < Decimal('50.0'):
                if st.Regime[idx] != "Stable":
                    self._R(j)
                    self._H(j)
                    self._L(j)
                    if self._on_fire(j, "sRange", "tRange"):
                        st.Regime[idx] = "sRange"
            elif self._on_fire(j, "sTrend", "tTrend"):
                st.Regime[idx] = "sTrend"

    def _on_bar(self) -> None:
        st = self.state
        y = st.y
        for j in range(y + 1, X_PERIOD):
            idx = j - (y + 1)
            if idx < 0 or idx >= len(st.Regime):
                break
            self._unify(j)
            self._normalize(j)
            if st.iStdDev < Decimal('50.0') and st.iATR > Decimal('50.0'):
                if st.Regime[idx] != "Stable":
                    if st.Regime[idx] != "tVolatile":
                        self._F(j, st.iH, st.iL)
                        self._H(j)
                        self._L(j)
                        st.Regime[idx] = "tVolatile"
            elif st.iStdDev < Decimal('50.0') and st.iATR < Decimal('50.0'):
                if st.Regime[idx] != "Stable":
                    self._R(j)
                    self._H(j)
                    self._L(j)
                    if st.Regime[idx] != "tRange":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tRange"
            elif (st.Regime[idx] != "tTrend" and st.Regime[idx] != "sTrend"
                  and idx < len(st.LL) and idx < len(st.Discount)
                  and idx < len(st.HH) and idx < len(st.Premium)
                  and st.LL[idx] < st.Discount[idx]
                  and st.HH[idx] > st.Premium[idx]):
                st.Regime[idx] = "Stable"
            else:
                if st.Regime[idx] != "tTrend":
                    self._F(j, st.iH, st.iL)
                    st.Regime[idx] = "tTrend"

        if len(self.ohlcv_history) >= y + 1:
            close_prices = [d["close"] for d in self.ohlcv_history[-y - 1:]]
            st.Stock, _, st.Sale = bollinger_bands(close_prices, y)
            if len(close_prices) > 1:
                st.iStock, _, st.iSale = bollinger_bands(close_prices[:-1], y)
            else:
                st.iStock = st.Stock
                st.iSale = st.Sale

        if len(self.ohlcv_history) >= 3:
            st.iopen = self.ohlcv_history[-3]["open"]
            st.iPrice = self.ohlcv_history[-3]["close"]
        elif len(self.ohlcv_history) >= 2:
            st.iopen = self.ohlcv_history[-2]["open"]
            st.iPrice = self.ohlcv_history[-2]["close"]
        elif len(self.ohlcv_history) >= 1:
            st.iopen = self.ohlcv_history[-1]["open"]
            st.iPrice = self.ohlcv_history[-1]["close"]

        st.lPass = st.Price if st.Price < st.open else st.open
        st.ilPass = st.iPrice if st.iPrice < st.iopen else st.iopen
        st.kPass = st.Price if st.Price > st.open else st.open
        st.ikPass = st.iPrice if st.iPrice > st.iopen else st.iopen

    def _on_call(self) -> None:
        st = self.state
        y = st.y
        for j in range(y + 1, st.X_scan + 2):
            idx = j - (y + 1)
            if idx < 0 or idx >= len(st.Regime):
                break
            self._unify(j)
            self._normalize(j)
            if st.Suply <= st.price or st.iSuply <= st.price or st.iSuply <= st.iH:
                i = j
                st.I = st.iW
                st.iZ = i
                st.Z = i
                if st.iw != 0 and st.jC == st.Cc:
                    st.h = st.I
                st.iC = st.C
                st.jC = not st.C
                if self._on_hold(j, "sTrend", "tTrend"):
                    st.iz = i
                    st.z = i
                    st.iI = st.iw
                    self._H(j)
                if st.X_scan != X_PERIOD - 1:
                    st.X_scan += 1
            if st.Demand >= st.price or st.iDemand >= st.price or st.iDemand >= st.iL:
                i = j
                st.I = st.iZ
                st.iW = i
                st.W = i
                if st.iz != 0 and st.iC == st.Cc:
                    st.h = st.I
                st.jC = st.C
                st.iC = not st.C
                if self._on_hold(j, "sTrend", "tTrend"):
                    st.iw = i
                    st.w = i
                    st.iI = st.iz
                    self._L(j)
                if st.X_scan != X_PERIOD - 1:
                    st.X_scan += 1
        st.X_scan = y

    def _on_track(self) -> None:
        st = self.state
        st.on_track_runs += 1
        y = st.y
        st.S = X_PERIOD
        st.T = X_PERIOD
        st.X_scan = y
        st.Y_scan = y
        is_now = self.ohlcv_history[-1]["timestamp"] if self.ohlcv_history else datetime.now()
        scan_limit = 4 * MAX_PERIOD
        s = X_PERIOD - 1
        while s < st.S:
            if s == scan_limit:
                break
            if s < 0:
                s += 1
                continue
            idx = s - (y + 1)
            if idx < 0:
                s += 1
                continue
            if idx >= len(st.Regime):
                ext = idx - len(st.Regime) + 1
                st.Regime.extend(["sRange"] * ext)
                st.k.extend([False] * ext)
                st.l.extend([False] * ext)
                st.HH.extend([Decimal('0.0')] * ext)
                st.LL.extend([Decimal('0.0')] * ext)
                st.Premium.extend([Decimal('0.0')] * ext)
                st.Discount.extend([Decimal('0.0')] * ext)
            j = s
            self._normalize(j)
            self._unify(j)
            if st.Suply <= st.price or st.iSuply <= st.price or st.iSuply <= st.iH:
                i = s
                st.I = st.iW
                st.Z = MAX_PERIOD
                st.iZ = i
                st.T += 1
                st.iC = st.C
                if st.iw != 0 and st.jC == st.Cc:
                    st.h = st.I
                st.jC = not st.C
                if st.iStdDev > Decimal('50.0'):
                    st.S += 1
                    st.iz = i
                    st.iI = st.iw
                    self._H(j)
                elif st.iATR < Decimal('50.0'):
                    st.S += 1
                    st.iO = i
                    st.io = i
                    self._H(j)
                else:
                    self._H(j)
                    if is_now != st.t:
                        if self._on_fire(j, "Stable", "tVolatile"):
                            self._F(j, st.iH, st.iL)
                            st.Regime[idx] = "tVolatile"
                        else:
                            st.Regime[idx] = "sVolatile"
                    st.S += 1
            if st.Demand >= st.price or st.iDemand >= st.price or st.iDemand >= st.iL:
                i = s
                st.I = st.iZ
                st.W = MAX_PERIOD
                st.iW = i
                st.T += 1
                st.jC = st.C
                if st.iz != 0 and st.iC == st.Cc:
                    st.h = st.I
                st.iC = not st.C
                if st.iStdDev > Decimal('50.0'):
                    st.S += 1
                    st.iw = i
                    st.iI = st.iz
                    self._L(j)
                elif st.iATR < Decimal('50.0'):
                    st.S += 1
                    st.iO = i
                    st.io = i
                    self._L(j)
                else:
                    self._L(j)
                    if is_now != st.t:
                        if self._on_fire(j, "Stable", "tVolatile"):
                            self._F(j, st.iH, st.iL)
                            st.Regime[idx] = "tVolatile"
                        else:
                            st.Regime[idx] = "sVolatile"
                    st.S += 1
            s += 1
        s = X_PERIOD - 1
        while s < st.S:
            idx = s - (y + 1)
            if idx < 0:
                s += 1
                continue
            j = s
            self._normalize(j)
            self._unify(j)
            if st.iStdDev < Decimal('50.0') and st.iATR < Decimal('50.0'):
                self._R(j)
                self._L(j)
                self._H(j)
            s += 1
        st.S = X_PERIOD
        st.T = X_PERIOD
        if st.Z != scan_limit and st.Z >= st.z:
            j = MAX_PERIOD - 1
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        elif st.Z != scan_limit and st.Z < st.z:
            j = MAX_PERIOD
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        else:
            j = X_PERIOD - 1
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        if st.W != scan_limit and st.W >= st.w:
            j = MAX_PERIOD - 1
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        elif st.W != scan_limit and st.W < st.w:
            j = MAX_PERIOD
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        else:
            j = X_PERIOD - 1
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"

    def _on_stand(self) -> None:
        st = self.state
        st.on_stand_runs += 1
        y = st.y
        st.S = X_PERIOD
        st.T = X_PERIOD
        st.X_scan = y
        st.Y_scan = y
        is_now = self.ohlcv_history[-1]["timestamp"] if self.ohlcv_history else datetime.now()
        s = y + 1
        while s > st.Y_scan:
            if s == 1:
                break
            if s < 0:
                break
            idx = s - (y + 1)
            if idx < 0:
                s -= 1
                continue
            if idx >= len(st.Regime):
                ext = idx - len(st.Regime) + 1
                st.Regime.extend(["sRange"] * ext)
                st.k.extend([False] * ext)
                st.l.extend([False] * ext)
                st.HH.extend([Decimal('0.0')] * ext)
                st.LL.extend([Decimal('0.0')] * ext)
                st.Premium.extend([Decimal('0.0')] * ext)
                st.Discount.extend([Decimal('0.0')] * ext)
            j = s
            st.ir = 0
            st.ij = 0
            self._normalize(j)
            self._unify(j)
            if st.Suply <= st.price or st.iSuply <= st.price or st.iSuply <= st.iH:
                i = s
                st.I = st.iW
                st.Z = MIN_PERIOD + 1
                st.iZ = i
                st.T -= 1
                st.iC = st.C
                if st.iw != 0 and st.jC == st.Cc:
                    st.h = st.I
                st.jC = not st.C
                if st.X_scan != st.Y_scan and st.iz == 0 and st.iStdDev > Decimal('50.0'):
                    st.ij = i
                    st.iz = i
                    st.iI = st.iw
                    self._H(j)
                    if st.ir == 0 and st.Y_scan != 2:
                        st.Y_scan -= 1
                elif st.X_scan != st.Y_scan and st.iO == 0 and st.iATR < Decimal('50.0'):
                    st.iO = i
                    st.ir = i
                    self._H(j)
                    if st.ij == 0 and st.Y_scan != 2:
                        st.Y_scan -= 1
                elif st.X_scan == st.Y_scan:
                    self._H(j)
                    if is_now != st.t:
                        if self._on_fire(j, "Stable", "tVolatile"):
                            self._F(j, st.iH, st.iL)
                            st.Regime[idx] = "tVolatile"
                        else:
                            st.Regime[idx] = "sVolatile"
                    if st.Y_scan != 2 and st.X_scan != 2:
                        st.Y_scan -= 1
                        st.X_scan -= 1
            if st.Demand >= st.price or st.iDemand >= st.price or st.iDemand >= st.iL:
                i = s
                st.I = st.iZ
                st.W = MIN_PERIOD + 1
                st.iW = i
                st.T -= 1
                st.jC = st.C
                if st.iz != 0 and st.iC == st.Cc:
                    st.h = st.I
                st.iC = not st.C
                if st.X_scan != st.Y_scan and st.iw == 0 and st.iStdDev > Decimal('50.0'):
                    st.ij = i
                    st.iw = i
                    st.iI = st.iz
                    self._L(j)
                    if st.ir == 0 and st.Y_scan != 2:
                        st.Y_scan -= 1
                elif st.X_scan != st.Y_scan and st.iO == 0 and st.iATR < Decimal('50.0'):
                    st.iO = i
                    st.io = i
                    st.ir = 0
                    self._L(j)
                    if st.ij == 0 and st.Y_scan != 2:
                        st.Y_scan -= 1
                elif st.X_scan == st.Y_scan:
                    self._L(j)
                    if is_now != st.t:
                        if self._on_fire(j, "Stable", "tVolatile"):
                            self._F(j, st.iH, st.iL)
                            st.Regime[idx] = "tVolatile"
                        else:
                            st.Regime[idx] = "sVolatile"
                    if st.Y_scan != 2 and st.X_scan != 2:
                        st.Y_scan -= 1
                        st.X_scan -= 1
            else:
                if st.Y_scan != 2 and st.X_scan != 2:
                    st.Y_scan -= 1
                    st.X_scan -= 1
            s -= 1
        s = st.Y_scan + 1
        while s < y + 1:
            idx = s - (y + 1)
            if idx < 0:
                s += 1
                continue
            j = s
            self._normalize(j)
            self._unify(j)
            if st.iStdDev < Decimal('50.0') and st.iATR < Decimal('50.0'):
                self._R(j)
                self._L(j)
                self._H(j)
            s += 1
        st.X_scan = y
        st.Y_scan = y
        if st.Z != 2 and st.Z >= st.z:
            j = MIN_PERIOD
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        elif st.Z != 2 and st.Z < st.z:
            j = MIN_PERIOD + 1
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        else:
            j = y + 1
            st.z = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        if st.W != 2 and st.W >= st.w:
            j = MIN_PERIOD
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        elif st.W != 2 and st.W < st.w:
            j = MIN_PERIOD + 1
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"
        else:
            j = y + 1
            st.w = j
            idx = j - (y + 1)
            if 0 <= idx < len(st.Regime):
                if is_now != st.t:
                    if st.Regime[idx] != "tTrend":
                        self._F(j, st.iH, st.iL)
                        st.Regime[idx] = "tTrend"
                    else:
                        st.Regime[idx] = "sTrend"

    def _on_goe(self) -> None:
        st = self.state
        if st.signal != Decimal('0.0'):
            return
        if self._on_gaurd(0) and st.KC:
            if ((st.h == st.io and st.z > st.o) or (st.h == st.iO and st.Z > st.O) or (st.h == st.iz and st.Z > st.z) or (st.h == st.iZ and st.Z < st.z)):
                if (not st.C) and (not st.c):
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sign. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
                else:
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sig. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
            elif (st.h == st.io) or (st.h == st.iZ) or (st.h == st.iz) or (st.h == st.iO):
                if (not st.C) and (not st.c):
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sig. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
                else:
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sign. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
        elif self._on_gaurd(0) != st.KC:
            if ((st.h == st.io and st.z > st.o) or (st.h == st.iO and st.Z > st.O) or (st.h == st.iz and st.Z > st.z) or (st.h == st.iZ and st.Z < st.z)):
                if (not st.C) or (not st.c):
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sign. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
                else:
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sig. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
            elif (st.h == st.io) or (st.h == st.iZ) or (st.h == st.iz) or (st.h == st.iO):
                if (not st.C) or (not st.c):
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sig. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
                else:
                    st.prime = 1
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 1
                    logger.info(f"🟥 Sign. (Goe) price={st.price} h={st.h} Z={st.iZ} z={st.iz} O={st.iO} o={st.io}")
            self._KC()

    def _on_toe(self) -> None:
        st = self.state
        if st.signal != Decimal('0.0'):
            return
        if self._on_gaurd(0) and st.KC:
            if ((st.h == st.io and st.w > st.o) or (st.h == st.iO and st.W > st.O) or (st.h == st.iw and st.W > st.w) or (st.h == st.iW and st.W < st.w)):
                if (not st.C) and (not st.c):
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sig. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
                else:
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sign. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
            elif (st.h == st.io) or (st.h == st.iW) or (st.h == st.iw) or (st.h == st.iO):
                if (not st.C) and (not st.c):
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sign. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
                else:
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sig. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
        elif self._on_gaurd(0) != st.KC:
            if ((st.h == st.io and st.w > st.o) or (st.h == st.iO and st.W > st.O) or (st.h == st.iw and st.W > st.w) or (st.h == st.iW and st.W < st.w)):
                if (not st.C) or (not st.c):
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sig. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
                else:
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sign. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
            elif (st.h == st.io) or (st.h == st.iW) or (st.h == st.iw) or (st.h == st.iO):
                if (not st.C) or (not st.c):
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sign. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
                else:
                    st.prime = 0
                    self._G()
                    self._signal()
                    st.tick_tock = True
                    st.tag = 0
                    logger.info(f"🟩 Sig. (Toe) price={st.price} h={st.h} W={st.iW} w={st.iw} O={st.iO} o={st.io}")
            self._KC()

    def _signal(self) -> None:
        st = self.state
        if st.price <= Decimal('0.0'):
            return
        st.ab = not st.ba
        st.count = 0
        st.toll = 0
        st.tally = " "
        st.signal = st.price

        m_local, n_local = self._count_imbalance(st.h)

        st.last_kronecker_m = m_local
        st.last_kronecker_n = n_local
        st.last_kronecker_h = st.h
        self._last_kronecker_bar = st.h
        self._imbalance_fire_count += 1
        self._last_signal_time = datetime.now()

        if m_local >= 12:
            signal_type = "BUY"
        elif n_local >= 12:
            signal_type = "SELL"
        else:
            signal_type = "NEUTRAL"

        regime_idx = st.h - (st.y + 1)
        regime = st.Regime[regime_idx] if 0 <= regime_idx < len(st.Regime) else "Unknown"
        bar_timestamp = None
        if self.ohlcv_history:
            bar_timestamp = self.ohlcv_history[-1]["timestamp"]
            if isinstance(bar_timestamp, datetime):
                bar_timestamp = bar_timestamp.isoformat()
        signal_record = {
            "timestamp": datetime.now().isoformat(),
            "bar_timestamp": bar_timestamp,
            "type": signal_type,
            "price": float(st.price),
            "signal_level": float(st.signal),
            "regime": regime,
            "m_count": int(m_local),
            "n_count": int(n_local),
            "tick": int(st.tick),
            "h_bar": int(st.h),
            "source": "Goe" if st.prime == 1 else ("Toe" if st.prime == 0 else "Kronecker"),
        }
        st.signal_history.append(signal_record)
        if len(st.signal_history) > st.max_signal_history:
            st.signal_history = st.signal_history[-st.max_signal_history:]
        st.last_signal_at = signal_record["timestamp"]

        st.signature = True
        st.GF = True

        logger.info(f"🎯 SIGNAL #{self._imbalance_fire_count}: type={signal_type} @ {st.price}, tick={st.tick}, h={st.h}, m={m_local}, n={n_local}, regime={regime}")

    def _on_gaurd(self, inp: int) -> bool:
        st = self.state
        if st.price > st.E and st.E != Decimal('0.0'):
            if st.signature and inp != -1:
                st.dime = 0
            return True
        else:
            if st.signature and inp != -1:
                st.dime = 1
            return False

    def _A(self, price: Decimal) -> None:
        st = self.state
        if st.v and st.lOrder_id != -1:
            logger.info(f"🔴 A(): Close long #{st.lOrder_id} at {price}")
            self._close_order(st.lOrder_id, price)
            st.lOrder_id = -1
            st.has_open_long = False
        elif st.v and st.kOrder_id != -1:
            logger.info(f"🔴 A(): Close short #{st.kOrder_id} at {price}")
            self._close_order(st.kOrder_id, price)
            st.kOrder_id = -1
            st.has_open_short = False
        st.E = Decimal('0.0')
        st.A = True
        st.B = False
        st.K = False
        st.Buy = -1
        st.trailing_stop_active = False
        st.trailing_stop_price = Decimal('0.0')
        st.trailing_take_profit = Decimal('0.0')

    def _B(self, price: Decimal) -> None:
        st = self.state
        if st.u and st.kOrder_id != -1:
            logger.info(f"🔵 B(): Close short #{st.kOrder_id} at {price}")
            self._close_order(st.kOrder_id, price)
            st.kOrder_id = -1
            st.has_open_short = False
        elif st.u and st.lOrder_id != -1:
            logger.info(f"🔵 B(): Close long #{st.lOrder_id} at {price}")
            self._close_order(st.lOrder_id, price)
            st.lOrder_id = -1
            st.has_open_long = False
        st.D = Decimal('0.0')
        st.A = False
        st.B = True
        st.K = False
        st.Sell = -1
        st.trailing_stop_active = False
        st.trailing_stop_price = Decimal('0.0')
        st.trailing_take_profit = Decimal('0.0')

    def _open_order(self, side: str, price: Decimal, sl: Decimal, tp: Decimal, lot: Decimal) -> int:
        ticket = self._next_ticket
        self._next_ticket += 1
        order = Order(ticket=ticket, side=side, entry=price, sl=sl, tp=tp, lot=lot)
        self.orders.append(order)
        return ticket

    def _close_order(self, ticket: int, price: Decimal) -> bool:
        for o in self.orders:
            if o.ticket == ticket and o.closed_at is None:
                o.closed_at = datetime.now()
                o.close_price = price
                return True
        return False

    def _P(self, price: Decimal) -> None:
        st = self.state
        self._S()
        ask_price = self.price_history[-1].ask if self.price_history else price
        bid_price = self.price_history[-1].bid if self.price_history else price
        target = self._get_next_topological_target("BUY", ask_price)
        if target > Decimal('0.0') and self._will_pass_spread_in_pnl(ask_price, target, "BUY"):
            if st.Buy >= 0 and (st.A or not st.B) and (st.u or not st.v):
                if st.C:
                    ticket = self._open_order("BUY", ask_price, self._bSL, self._bTP, LOT_SIZE)
                    st.lOrder_id = ticket
                    st.has_open_long = True
                    st.trailing_stop_entry = ask_price
                    st.trailing_stop_side = "LONG"
                    st.Buy = 0 if st.Buy == -1 else st.Buy + 1
                    logger.info(f"🟢 P(): BUY executed #{ticket} at {ask_price}, target={target}")
        else:
            self._A(price)
            logger.info("⚠️ P(): BUY rejected — projected PnL <= spread friction")

        target = self._get_next_topological_target("SELL", bid_price)
        if target > Decimal('0.0') and self._will_pass_spread_in_pnl(bid_price, target, "SELL"):
            if st.Sell >= 0 and (not st.A or st.B) and (not st.u or st.v):
                if not st.C:
                    ticket = self._open_order("SELL", bid_price, self._sSL, self._sTP, LOT_SIZE)
                    st.lOrder_id = ticket
                    st.has_open_short = True
                    st.trailing_stop_entry = bid_price
                    st.trailing_stop_side = "SHORT"
                    st.Sell = 0 if st.Sell == -1 else st.Sell + 1
                    logger.info(f"🔴 P(): SELL executed #{ticket} at {bid_price}, target={target}")
        else:
            self._B(price)
            logger.info("⚠️ P(): SELL rejected — projected PnL <= spread friction")

    def _Q(self, price: Decimal) -> None:
        st = self.state
        self._S()
        ask_price = self.price_history[-1].ask if self.price_history else price
        bid_price = self.price_history[-1].bid if self.price_history else price
        target = self._get_next_topological_target("SELL", bid_price)
        if target > Decimal('0.0') and self._will_pass_spread_in_pnl(bid_price, target, "SELL"):
            if st.Sell >= 0 and (not st.A or st.B) and (not st.u or st.v):
                if st.C:
                    ticket = self._open_order("SELL", bid_price, self._sSL, self._sTP, LOT_SIZE)
                    st.kOrder_id = ticket
                    st.has_open_short = True
                    st.trailing_stop_entry = bid_price
                    st.trailing_stop_side = "SHORT"
                    st.Sell = 0 if st.Sell == -1 else st.Sell + 1
                    logger.info(f"🔴 Q(): SELL executed #{ticket} at {bid_price}, target={target}")
        else:
            self._B(price)
            logger.info("⚠️ Q(): SELL rejected — projected PnL <= spread friction")

        target = self._get_next_topological_target("BUY", ask_price)
        if target > Decimal('0.0') and self._will_pass_spread_in_pnl(ask_price, target, "BUY"):
            if st.Buy >= 0 and (st.A or not st.B) and (st.u or not st.v):
                if not st.C:
                    ticket = self._open_order("BUY", ask_price, self._bSL, self._bTP, LOT_SIZE)
                    st.kOrder_id = ticket
                    st.has_open_long = True
                    st.trailing_stop_entry = ask_price
                    st.trailing_stop_side = "LONG"
                    st.Buy = 0 if st.Buy == -1 else st.Buy + 1
                    logger.info(f"🟢 Q(): BUY executed #{ticket} at {ask_price}, target={target}")
        else:
            self._A(price)
            logger.info("⚠️ Q(): BUY rejected — projected PnL <= spread friction")

    def _S(self) -> None:
        st = self.state
        if STOP_LOSS != Decimal('0.0'):
            self._sSL = st.price + STOP_LOSS - COMMISSION
            self._bSL = st.price - STOP_LOSS + COMMISSION
        if TAKE_PROFIT != Decimal('0.0'):
            self._sTP = st.price - TAKE_PROFIT
            self._bTP = st.price + TAKE_PROFIT

    def _execute_trailing_stop(self) -> None:
        st = self.state
        has_long = st.has_open_long
        has_short = st.has_open_short
        if not (has_long or has_short):
            if st.trailing_stop_active:
                logger.info("📉 Trailing stop deactivated — no open orders")
                st.trailing_stop_active = False
                st.trailing_stop_price = Decimal('0.0')
                st.trailing_take_profit = Decimal('0.0')
                st.trailing_stop_entry = Decimal('0.0')
                st.trailing_stop_side = ""
            return
        regime_idx = st.y + 1
        if 0 <= regime_idx < len(st.Regime):
            regime = st.Regime[regime_idx]
            if regime in ("tStable", "tCoherent", "Stable"):
                return
        if st.price <= Decimal('0.0'):
            return
        if not st.trailing_stop_active:
            st.trailing_stop_active = True
            st.trailing_stop_entry = st.price
            st.trailing_stop_price = st.price
            st.trailing_stop_side = "LONG" if has_long else "SHORT"
            if has_long:
                st.trailing_take_profit = st.price * Decimal('1.02')
            else:
                st.trailing_take_profit = st.price * Decimal('0.98')
            logger.info(f"🎯 Trailing stop ACTIVATED at {st.trailing_stop_price}, TP={st.trailing_take_profit}, direction={st.trailing_stop_side}")
            return
        if len(self.price_history) > 0:
            last = self.price_history[-1]
            current_spread = last.ask - last.bid
        else:
            current_spread = Decimal('0.0')
        commission_abs = abs(COMMISSION)
        point_size = self._point_size if self._point_size > Decimal('0.0') else Decimal('0.00001')
        friction_points = (current_spread + commission_abs) / point_size
        safety_buffer = Decimal('1.0')
        min_trail_threshold = (friction_points + safety_buffer) * point_size
        if has_long:
            pnl_points = (st.price - st.trailing_stop_entry) / point_size
        else:
            pnl_points = (st.trailing_stop_entry - st.price) / point_size
        if pnl_points <= (friction_points + safety_buffer):
            return
        trail_step = max(min_trail_threshold, pnl_points * point_size * Decimal('0.3'))
        new_sl = st.trailing_stop_price
        topological_target = Decimal('0.0')
        if has_long:
            for ji in range(st.y + 1, X_PERIOD):
                jidx = ji - (st.y + 1)
                if jidx < len(st.Premium) and st.Premium[jidx] > st.price and st.Premium[jidx] != Decimal('0.0'):
                    topological_target = st.Premium[jidx]
                    break
            slDistance = max(trail_step, STOP_LOSS * point_size)
            proposedSL = st.price - slDistance
            if ((proposedSL > st.trailing_stop_price or st.trailing_stop_price == Decimal('0.0')) and (topological_target == Decimal('0.0') or proposedSL < (topological_target - min_trail_threshold))):
                new_sl = proposedSL
            tpDistance = Decimal('0.0')
            if topological_target > Decimal('0.0'):
                tpDistance = max(topological_target - st.price, TAKE_PROFIT * point_size)
            else:
                tpDistance = max(trail_step * Decimal('2.0'), TAKE_PROFIT * point_size)
            proposedTP = st.price + tpDistance
            if proposedTP > (st.price + min_trail_threshold):
                st.trailing_take_profit = proposedTP
        else:
            for ji in range(st.y + 1, X_PERIOD):
                jidx = ji - (st.y + 1)
                if jidx < len(st.Discount) and st.Discount[jidx] < st.price and st.Discount[jidx] != Decimal('0.0'):
                    topological_target = st.Discount[jidx]
                    break
            slDistance = max(trail_step, STOP_LOSS * point_size)
            proposedSL = st.price + slDistance
            if ((st.trailing_stop_price == Decimal('0.0') or proposedSL < st.trailing_stop_price) and (topological_target == Decimal('0.0') or proposedSL > (topological_target + min_trail_threshold))):
                new_sl = proposedSL
            tpDistance = Decimal('0.0')
            if topological_target > Decimal('0.0'):
                tpDistance = max(st.price - topological_target, TAKE_PROFIT * point_size)
            else:
                tpDistance = max(trail_step * Decimal('2.0'), TAKE_PROFIT * point_size)
            proposedTP = st.price - tpDistance
            if proposedTP < (st.price - min_trail_threshold):
                st.trailing_take_profit = proposedTP
        if new_sl != st.trailing_stop_price:
            st.trailing_stop_price = new_sl
            logger.info(f"📈 Trailing stop updated to {st.trailing_stop_price} (PnL={pnl_points}pts, friction={friction_points}pts)")
        if has_long and st.price >= st.trailing_take_profit:
            logger.info(f"✅ TP hit (LONG) at {st.price} / TP={st.trailing_take_profit}")
            if st.lOrder_id != -1:
                self._close_order(st.lOrder_id, st.price)
            st.trailing_stop_active = False
            st.trailing_stop_price = Decimal('0.0')
            st.trailing_take_profit = Decimal('0.0')
            st.trailing_stop_entry = Decimal('0.0')
            st.trailing_stop_side = ""
            st.has_open_long = False
            st.lOrder_id = -1
        elif has_short and st.price <= st.trailing_take_profit:
            logger.info(f"✅ TP hit (SHORT) at {st.price} / TP={st.trailing_take_profit}")
            if st.kOrder_id != -1:
                self._close_order(st.kOrder_id, st.price)
            st.trailing_stop_active = False
            st.trailing_stop_price = Decimal('0.0')
            st.trailing_take_profit = Decimal('0.0')
            st.trailing_stop_entry = Decimal('0.0')
            st.trailing_stop_side = ""
            st.has_open_short = False
            st.kOrder_id = -1

    def _get_next_topological_target(self, side: str, current_price: Decimal) -> Decimal:
        st = self.state
        for ji in range(st.y + 1, X_PERIOD):
            jidx = ji - (st.y + 1)
            if side == "BUY":
                if jidx < len(st.Premium) and st.Premium[jidx] > current_price and st.Premium[jidx] != Decimal('0.0'):
                    return st.Premium[jidx]
            elif side == "SELL":
                if jidx < len(st.Discount) and st.Discount[jidx] < current_price and st.Discount[jidx] != Decimal('0.0'):
                    return st.Discount[jidx]
        if side == "BUY" and st.Sale > current_price:
            return st.Sale
        if side == "SELL" and st.Stock < current_price:
            return st.Stock
        return Decimal('0.0')

    def _will_pass_spread_in_pnl(self, entry_price: Decimal, target_price: Decimal, side: str) -> bool:
        if len(self.price_history) > 0:
            last = self.price_history[-1]
            current_spread = last.ask - last.bid
        else:
            current_spread = Decimal('0.0')
        point_size = self._point_size if self._point_size > Decimal('0.0') else Decimal('0.00001')
        friction_points = (current_spread + abs(COMMISSION)) / point_size
        projected_distance = abs(target_price - entry_price)
        projected_pnl_points = projected_distance / point_size
        safety_buffer = Decimal('1.0')
        if side == "BUY":
            if target_price <= entry_price:
                return False
            return projected_pnl_points > (friction_points + safety_buffer)
        if side == "SELL":
            if target_price >= entry_price:
                return False
            return projected_pnl_points > (friction_points + safety_buffer)
        return False

    def _Top(self) -> None:
        st = self.state
        price_str = f"{st.price:.5f}"
        if not any(abs(p - st.price) < Decimal('0.00001') for p in st.BL):
            st.BL.append(st.price)
            st.BL_type.append("top")
            st.FVG += 1
            st.bL = price_str
            logger.info(f"▲ Top(): Blue FVG line at {price_str}, FVG={st.FVG}")
            if self._bridge_publish_callback:
                try:
                    self._bridge_publish_callback("top", price_str)
                except Exception as e:
                    logger.warning(f"_bridge_publish_callback failed: {e}")

    def _Bott(self) -> None:
        st = self.state
        price_str = f"{st.price:.5f}"
        if not any(abs(p - st.price) < Decimal('0.00001') for p in st.BL):
            st.BL.append(st.price)
            st.BL_type.append("bott")
            st.FVG += 1
            st.bL = price_str
            logger.info(f"▼ Bott(): Red FVG line at {price_str}, FVG={st.FVG}")
            if self._bridge_publish_callback:
                try:
                    self._bridge_publish_callback("bott", price_str)
                except Exception as e:
                    logger.warning(f"_bridge_publish_callback failed: {e}")

    def _populate_indicator_matrix(self) -> None:
        st = self.state
        if len(self.ohlcv_history) < MIN_HISTORY_WINDOW:
            return
        size = X_PERIOD - Y_START
        if size <= 0:
            return
        end = len(self.ohlcv_history)
        for j in range(Y_START + 1, X_PERIOD + 1):
            idx = j - (Y_START + 1)
            if idx < 0 or idx >= size:
                continue
            bars_back = X_PERIOD - j
            bar_end = end - bars_back
            if bar_end < MIN_HISTORY_WINDOW:
                for i in range(13):
                    if i < len(st.iA) and idx < len(st.iA[i]):
                        st.iA[i][idx] = Decimal('50.0')
                        st.cA[i][idx] = Decimal('50.0')
                        st.kA[i][idx] = Decimal('50.0')
                        st.lA[i][idx] = Decimal('50.0')
                continue
            self._normalize(j)
            self._unify(j)
            self._indicator_populate_count += 13

    def _force_initialization(self) -> None:
        st = self.state
        if st.FG:
            return
        if st.price <= Decimal('0.0'):
            logger.warning("⏳ Cannot force-init: price not yet available")
            return
        logger.info("🚀 First valid tick detected. Forcing engine initialization...")
        if not st.signature:
            st.D = st.price
            st.E = st.price
        size = X_PERIOD - st.y
        if size <= 0:
            size = X_PERIOD - Y_START
        st.X_scan = st.y
        st.Y_scan = st.y
        if len(st.k) != size:
            st.k = [False] * size
            st.l = [False] * size
            st.HH = [Decimal('0.0')] * size
            st.LL = [Decimal('0.0')] * size
            st.Premium = [Decimal('0.0')] * size
            st.Discount = [Decimal('0.0')] * size
            st.Regime = ["sRange"] * size
        iH = self.ohlcv_history[-1]["high"] if self.ohlcv_history else st.price
        iL = self.ohlcv_history[-1]["low"] if self.ohlcv_history else st.price
        for j in range(st.y + 1, X_PERIOD):
            self._F(j, iH, iL)
        st.FG = True
        st._initialized = True
        logger.info(f"✅ Engine initialized on first tick at price={st.price}")

    def _on_tick(self, price_data: PriceData) -> None:
        st = self.state
        st.tick += 1
        self._tick_log_counter += 1
        if self._tick_log_counter >= 100:
            self._tick_log_counter = 0
            idx = st.Z - (st.y + 1)
            regime = st.Regime[idx] if 0 <= idx < len(st.Regime) else "?"
            logger.info(f"⚡ Tick #{st.tick}: Price={st.price}, Signal={st.signal}, FG={st.FG}, Regime={regime}, X_scan={st.X_scan}, Y_scan={st.Y_scan}, bars={st.bar_close_count}, signals={len(st.signal_history)}")

        st.price = price_data.bid
        st.Price = price_data.close
        if len(self.ohlcv_history) >= 2:
            st.iPrice = self.ohlcv_history[-2]["close"]
            st.open = self.ohlcv_history[-2]["open"]
            st.iH = self.ohlcv_history[-2]["high"]
            st.iL = self.ohlcv_history[-2]["low"]
        else:
            st.iPrice = st.price
            st.open = st.price
            st.iH = st.price
            st.iL = st.price

        if st.price <= Decimal('0.0'):
            logger.warning(f"⚠️ Tick #{st.tick} with non-positive price. Skipping state machine.")
            return

        is_now = self.ohlcv_history[-1]["timestamp"] if self.ohlcv_history else datetime.now()

        self._maintain_fvg_lines()

        if not st.FG:
            self._force_initialization()

        st.m_now, st.n_now = self._count_imbalance(st.h) if st.FG else (0, 0)

        self._execute_trailing_stop()

        self._on_point()
        self._O(st.iO, st.O, st.J, "C")
        self._O(st.io, st.o, st.iJ, "c")
        self._on_call()
        self._J()

        if is_now != st.t:
            self._on_bar()
            self._O(st.iO, st.O, st.J, "C")
            self._O(st.io, st.o, st.iJ, "c")

        if st.J == st.y + 1 and st.J != 2:
            self._on_stand()
            self._J()
            self._O(st.iO, st.O, st.J, "C")
            self._O(st.io, st.o, st.iJ, "c")
            if st.iO != 2:
                if st.J >= st.iO:
                    j = MIN_PERIOD
                    st.O = j
                    idx_j = j - (st.y + 1)
                    if 0 <= idx_j < len(st.Regime):
                        if is_now != st.t:
                            if self._on_fire(j, "Stable", "tRange"):
                                self._F(j, st.iH, st.iL)
                                st.Regime[idx_j] = "tRange"
                            else:
                                st.Regime[idx_j] = "sRange"
                        else:
                            st.Regime[idx_j] = "sRange"
                else:
                    j = MIN_PERIOD + 1
                    st.O = j
                    idx_j = j - (st.y + 1)
                    if 0 <= idx_j < len(st.Regime):
                        if is_now != st.t:
                            if self._on_fire(j, "Stable", "tRange"):
                                self._F(j, st.iH, st.iL)
                                st.Regime[idx_j] = "tRange"
                            else:
                                st.Regime[idx_j] = "sRange"
                        else:
                            st.Regime[idx_j] = "sRange"
            else:
                st.O = 2
            if st.io != 2:
                if st.iJ >= st.io:
                    st.o = MIN_PERIOD
                else:
                    st.o = MIN_PERIOD + 1
            else:
                st.o = 2

        if st.J == X_PERIOD - 1:
            self._on_track()
            self._J()
            self._O(st.iO, st.O, st.J, "C")
            self._O(st.io, st.o, st.iJ, "c")
            if st.iO != 4 * MAX_PERIOD:
                if st.J >= st.iO:
                    j = MAX_PERIOD - 1
                    st.O = j
                    idx_j = j - (st.y + 1)
                    if 0 <= idx_j < len(st.Regime):
                        if is_now != st.t:
                            if self._on_fire(j, "Stable", "tRange"):
                                self._F(j, st.iH, st.iL)
                                st.Regime[idx_j] = "tRange"
                            else:
                                st.Regime[idx_j] = "sRange"
                        else:
                            st.Regime[idx_j] = "sRange"
                else:
                    j = MAX_PERIOD
                    st.O = j
                    idx_j = j - (st.y + 1)
                    if 0 <= idx_j < len(st.Regime):
                        if is_now != st.t:
                            if self._on_fire(j, "Stable", "tRange"):
                                self._F(j, st.iH, st.iL)
                                st.Regime[idx_j] = "tRange"
                            else:
                                st.Regime[idx_j] = "sRange"
                        else:
                            st.Regime[idx_j] = "sRange"
            else:
                st.O = X_PERIOD - 1
            if st.io != 4 * MAX_PERIOD:
                if st.iJ >= st.io:
                    st.o = MAX_PERIOD - 1
                else:
                    st.o = MAX_PERIOD
            else:
                st.o = X_PERIOD - 1

        st.t = is_now

        if st.Z != X_PERIOD - 1:
            h_idx = st.iZ - (st.y + 1)
            if st.Z != st.y + 1 and 0 <= h_idx < len(st.k) and st.k[h_idx]:
                st.h = st.iZ
                self._on_goe()
            else:
                h_idx = st.iz - (st.y + 1)
                if (0 <= h_idx < len(st.k) and st.k[h_idx] and st.z != st.y + 1 and st.z != X_PERIOD - 1):
                    st.h = st.iz
                    self._on_goe()
                else:
                    h_idx = st.io - (st.y + 1)
                    if (0 <= h_idx < len(st.k) and st.k[h_idx] and st.o != st.y + 1 and st.o != X_PERIOD - 1):
                        st.h = st.io
                        self._on_goe()
                    else:
                        h_idx = st.iO - (st.y + 1)
                        if (0 <= h_idx < len(st.k) and st.k[h_idx] and st.O != st.y + 1 and st.O != X_PERIOD - 1):
                            st.h = st.iO
                            self._on_goe()

        if st.W != X_PERIOD - 1:
            h_idx = st.iW - (st.y + 1)
            if st.W != st.y + 1 and 0 <= h_idx < len(st.l) and st.l[h_idx]:
                st.h = st.iW
                self._on_toe()
            else:
                h_idx = st.iw - (st.y + 1)
                if (0 <= h_idx < len(st.l) and st.l[h_idx] and st.w != st.y + 1 and st.w != X_PERIOD - 1):
                    st.h = st.iw
                    self._on_toe()
                else:
                    h_idx = st.io - (st.y + 1)
                    if (0 <= h_idx < len(st.l) and st.l[h_idx] and st.o != st.y + 1 and st.o != X_PERIOD - 1):
                        st.h = st.io
                        self._on_toe()
                    else:
                        h_idx = st.iO - (st.y + 1)
                        if (0 <= h_idx < len(st.l) and st.l[h_idx] and st.O != st.y + 1 and st.O != X_PERIOD - 1):
                            st.h = st.iO
                            self._on_toe()

        if st.GF:
            self.OnReInit()
            st.GF = False

        if st.signature and st.chat_id:
            self._send_signal_alert()

        if st.ab != st.ba:
            st.ab = st.ba
        st.tick_tock = False

    def _maintain_fvg_lines(self) -> None:
        st = self.state
        if st.FVG < 0:
            return
        price = st.price
        i = 0
        while i < len(st.BL):
            price_line = st.BL[i]
            line_type = st.BL_type[i] if i < len(st.BL_type) else "top"
            if price_line <= Decimal('0.0'):
                i += 1
                continue
            if line_type == "top" and (st.A or not st.B) and price_line <= price and st.E != Decimal('0.0'):
                logger.info(f"🔵 FVG maintenance: remove blue @ {price_line}")
                st.BL.pop(i)
                if i < len(st.BL_type):
                    st.BL_type.pop(i)
                st.FVG -= 1
                continue
            if line_type == "bott" and (st.B or not st.A) and price_line >= price and st.D != Decimal('0.0'):
                logger.info(f"🔴 FVG maintenance: remove red @ {price_line}")
                st.BL.pop(i)
                if i < len(st.BL_type):
                    st.BL_type.pop(i)
                st.FVG -= 1
                continue
            i += 1

    def update_price_from_feed(self) -> None:
        data = self.feed.get_intraday()
        if not data:
            self._consecutive_zero_prices += 1
            now = datetime.now()
            if self._last_relay_warn is None or (now - self._last_relay_warn).seconds >= 60:
                self._last_relay_warn = now
                logger.warning(f"⚠️ No data from relay for {self.feed.active_symbol()} (consecutive={self._consecutive_zero_prices})")
            return
        bid = data["close"]
        ask = data["close"]
        if bid <= Decimal('0.0'):
            self._consecutive_zero_prices += 1
            return
        volume = data.get("volume", Decimal('0.0'))
        timestamp = data.get("timestamp", datetime.now())
        self._consecutive_zero_prices = 0
        self.update_price(bid, ask, volume, timestamp)

    def update_price(self, bid: Decimal, ask: Decimal, volume: Decimal = Decimal('0.0'), timestamp: Optional[datetime] = None) -> None:
        if timestamp is None:
            timestamp = datetime.now()
        if bid <= Decimal('0.0'):
            logger.warning(f"update_price rejected non-positive bid: {bid}")
            return
        self.state.price = bid
        self.state.Price = (bid + ask) / Decimal('2.0')
        self._price_update_counter += 1
        price_data = PriceData(
            bid=bid, ask=ask, close=(bid + ask) / Decimal('2.0'),
            open=bid, high=max(bid, ask), low=min(bid, ask),
            volume=volume, timestamp=timestamp,
        )
        self.price_history.append(price_data)
        if len(self.price_history) > 1000:
            self.price_history = self.price_history[-1000:]

        bar_closed = False
        if self._last_price_update is None:
            bar_closed = True
        else:
            current_min = timestamp.replace(second=0, microsecond=0)
            prev_min = self._last_price_update.replace(second=0, microsecond=0)
            if current_min != prev_min:
                bar_closed = True

        if bar_closed:
            self._bar_open = True
            self._last_price_update = timestamp
            self._bar_index += 1
            self.state.bar_close_count += 1
            self.ohlcv_history.append({
                "open": price_data.open, "high": price_data.high,
                "low": price_data.low, "close": price_data.close,
                "volume": price_data.volume, "timestamp": timestamp,
            })
            if len(self.ohlcv_history) > 200:
                self.ohlcv_history = self.ohlcv_history[-200:]
            logger.info(f"📊 BAR CLOSE #{self.state.bar_close_count} at {timestamp.isoformat()} close={price_data.close} (ohlcv={len(self.ohlcv_history)})")
        else:
            self._bar_open = False
            if self.ohlcv_history:
                self.ohlcv_history[-1]["high"] = max(self.ohlcv_history[-1]["high"], price_data.high)
                self.ohlcv_history[-1]["low"] = min(self.ohlcv_history[-1]["low"], price_data.low)
                self.ohlcv_history[-1]["close"] = price_data.close
                self.ohlcv_history[-1]["volume"] += price_data.volume

        if bar_closed and len(self.ohlcv_history) >= MIN_HISTORY_WINDOW:
            self._populate_indicator_matrix()

        self._on_tick(price_data)

    def _send_signal_alert(self) -> None:
        st = self.state
        target_chat = st.chat_id
        if target_chat is None and st.webapp_user_id is not None:
            target_chat = st.webapp_user_id
        if not target_chat or not self.application:
            return
        if self._last_signal_time:
            elapsed = (datetime.now() - self._last_signal_time).seconds
            if elapsed < self._signal_cooldown:
                return
        direction = "📈 BUY" if st.price > st.signal else "📉 SELL"
        m_local = st.last_kronecker_m
        n_local = st.last_kronecker_n
        h_idx = st.h - (st.y + 1)
        m_at_h = 1 if (0 <= h_idx < len(st.k) and st.k[h_idx]) else 0
        n_at_h = 1 if (0 <= h_idx < len(st.l) and st.l[h_idx]) else 0
        condition_met = (m_local >= 12) or (n_local >= 12)
        idx = st.Z - (st.y + 1)
        regime = st.Regime[idx] if 0 <= idx < len(st.Regime) else "Unknown"
        msg = (
            f"🎯 *ÆEA SIGNAL ALERT*\n"
            f"📊 *Direction:* {direction}\n"
            f"🎯 *Signal Level:* {st.signal}\n"
            f"💰 *Current Price:* {st.price}\n"
            f"📊 *Regime:* {regime}\n"
            f"⚖️ *Imbalance @ h={st.h}:* m={m_at_h}, n={n_at_h}\n"
            f"⚖️ *Local m/n:* {m_local}/{n_local}\n"
            f"✅ *δ(m-n-2)=1 (MQL4 gate):* {'✅ MET' if condition_met else '❌ NOT MET'}\n"
            f"🔄 *Tick Count:* {st.tick}\n"
            f"💎 Natalia Tanyatia"
        )
        try:
            self.application.bot.send_message(chat_id=target_chat, text=msg, parse_mode="Markdown")
            logger.info(f"📡 Signal alert sent to {target_chat}")
            self._last_signal_time = datetime.now()
        except Exception as e:
            logger.error(f"❌ Failed to send signal alert: {e}")

    def get_signal_status(self) -> Dict[str, Any]:
        st = self.state
        h_idx = st.h - (st.y + 1)
        m_at_h = 1 if (0 <= h_idx < len(st.k) and st.k[h_idx]) else 0
        n_at_h = 1 if (0 <= h_idx < len(st.l) and st.l[h_idx]) else 0
        m_local = st.m_now if st.FG else 0
        n_local = st.n_now if st.FG else 0
        condition_met = (m_local >= 12) or (n_local >= 12)
        idx = st.Z - (st.y + 1)
        regime = st.Regime[idx] if 0 <= idx < len(st.Regime) and st.Regime[idx] else "Unknown"
        return {
            "signal": float(st.signal),
            "price": float(st.price),
            "signature": st.signature,
            "KC": bool(st.KC),
            "prime": int(st.prime),
            "dime": int(st.dime),
            "mem": int(st.mem),
            "tag": int(st.tag),
            "invert": bool(st.invert),
            "safety": bool(st.safety),
            "m_count": m_local,
            "n_count": n_local,
            "m_at_h": m_at_h,
            "n_at_h": n_at_h,
            "h_bar": int(st.h),
            "condition_met": condition_met,
            "regime": regime,
            "symbol": SYMBOL,
            "tick": st.tick,
            "timestamp": datetime.now().isoformat(),
            "engine_initialized": st.FG,
            "indicator_populate_count": int(self._indicator_populate_count),
            "imbalance_fire_count": int(self._imbalance_fire_count),
            "trailing_stop_active": st.trailing_stop_active,
            "trailing_stop_price": str(st.trailing_stop_price),
            "trailing_take_profit": str(st.trailing_take_profit),
            "trailing_stop_entry": str(st.trailing_stop_entry),
            "trailing_stop_side": st.trailing_stop_side,
            "has_open_long": bool(st.has_open_long),
            "has_open_short": bool(st.has_open_short),
            "lOrder_id": int(st.lOrder_id),
            "kOrder_id": int(st.kOrder_id),
            "on_track_runs": int(st.on_track_runs),
            "on_stand_runs": int(st.on_stand_runs),
            "last_kronecker_bar": int(self._last_kronecker_bar),
            "last_kronecker_m": int(st.last_kronecker_m),
            "last_kronecker_n": int(st.last_kronecker_n),
            "last_kronecker_h": int(st.last_kronecker_h),
            "X_scan": int(st.X_scan),
            "Y_scan": int(st.Y_scan),
            "S": int(st.S),
            "T": int(st.T),
            "r": int(st.r),
            "ir": int(st.ir),
            "iATR": float(st.iATR),
            "iStdDev": float(st.iStdDev),
            "iIHKk": float(st.iIHKk),
            "iIHKt": float(st.iIHKt),
            "signal_count": len(st.signal_history),
            "last_signal_at": st.last_signal_at,
            "bar_close_count": int(st.bar_close_count),
            "ohlcv_count": len(self.ohlcv_history),
            "market_m": int(st.m_now),
            "market_n": int(st.n_now),
            "market_imbalance": int(st.m_now) - int(st.n_now) - 2,
            "market_regime": "BULLISH" if (int(st.m_now) - int(st.n_now) - 2) > 2 else ("BEARISH" if (int(st.m_now) - int(st.n_now) - 2) < -2 else "NEUTRAL"),
            "A": bool(st.A),
            "B": bool(st.B),
            "C": bool(st.C),
            "c": bool(st.c),
            "tick_tock": bool(st.tick_tock),
            "Z": int(st.Z),
            "z": int(st.z),
            "O": int(st.O),
            "o": int(st.o),
            "W": int(st.W),
            "w": int(st.w),
            "I": int(st.I),
            "iI": int(st.iI),
            "J": int(st.J),
            "iJ": int(st.iJ),
            "iZ": int(st.iZ),
            "iz": int(st.iz),
            "iW": int(st.iW),
            "iw": int(st.iw),
            "iO": int(st.iO),
            "io": int(st.io),
            "lPass": str(st.lPass),
            "ilPass": str(st.ilPass),
            "kPass": str(st.kPass),
            "ikPass": str(st.ikPass),
        }

    def get_regime_map(self) -> List[Dict[str, Any]]:
        st = self.state
        out = []
        for i, regime in enumerate(st.Regime):
            prem = st.Premium[i] if i < len(st.Premium) else Decimal('0.0')
            disc = st.Discount[i] if i < len(st.Discount) else Decimal('0.0')
            hh = st.HH[i] if i < len(st.HH) else Decimal('0.0')
            ll = st.LL[i] if i < len(st.LL) else Decimal('0.0')
            k_flag = st.k[i] if i < len(st.k) else False
            l_flag = st.l[i] if i < len(st.l) else False
            out.append({
                "index": i,
                "regime": regime,
                "k": bool(k_flag),
                "l": bool(l_flag),
                "premium": float(prem),
                "discount": float(disc),
                "hh": float(hh),
                "ll": float(ll),
            })
        return out

    def get_indicator_series(self, name: str, count: int = 80) -> List[float]:
        st = self.state
        idx = INDICATOR_NAMES.index(name) if name in INDICATOR_NAMES else -1
        if idx < 0:
            if name == "IchimokuK":
                return [float(v) for v in st.IHKk[-count:]]
            if name == "IchimokuT":
                return [float(v) for v in st.IHKt[-count:]]
            if name == "ATR":
                return [float(v) for v in st.ATR[-count:]]
            if name == "StdDev":
                return [float(v) for v in st.StdDev[-count:]]
            return []
        row = st.iA[idx] if idx < len(st.iA) else []
        return [float(v) for v in row[-count:]]

    def place_order(self, side: str, lot: Decimal, sl: Decimal, tp: Decimal) -> Dict[str, Any]:
        st = self.state
        if st.price <= Decimal('0.0'):
            return {"error": "no_price"}
        if side not in ("BUY", "SELL"):
            return {"error": "invalid_side"}
        if lot <= Decimal('0.0'):
            return {"error": "invalid_lot"}
        entry = st.price
        if sl <= Decimal('0.0'):
            sl = Decimal('0.0')
        if tp <= Decimal('0.0'):
            tp = Decimal('0.0')
        ticket = self._open_order(side, entry, sl, tp, lot)
        if side == "BUY":
            st.has_open_long = True
            st.lOrder_id = ticket
            st.trailing_stop_entry = entry
            st.trailing_stop_side = "LONG"
        else:
            st.has_open_short = True
            st.kOrder_id = ticket
            st.trailing_stop_entry = entry
            st.trailing_stop_side = "SHORT"
        logger.info(f"📝 place_order: {side} #{ticket} @ {entry}, lot={lot}, sl={sl}, tp={tp}")
        return {"ok": True, "ticket": ticket, "side": side, "entry": float(entry), "sl": float(sl), "tp": float(tp)}

    def close_order(self, ticket: int = None, all: bool = False) -> Dict[str, Any]:
        st = self.state
        closed = []
        if all:
            for o in self.orders:
                if o.closed_at is None:
                    o.closed_at = datetime.now()
                    o.close_price = st.price
                    closed.append(o.ticket)
            st.has_open_long = False
            st.has_open_short = False
            st.lOrder_id = -1
            st.kOrder_id = -1
            st.trailing_stop_active = False
            st.trailing_stop_price = Decimal('0.0')
            st.trailing_take_profit = Decimal('0.0')
            st.trailing_stop_entry = Decimal('0.0')
            st.trailing_stop_side = ""
        else:
            if ticket is None:
                return {"error": "no_ticket"}
            for o in self.orders:
                if o.ticket == ticket and o.closed_at is None:
                    o.closed_at = datetime.now()
                    o.close_price = st.price
                    closed.append(o.ticket)
                    if o.side == "BUY":
                        st.has_open_long = False
                        st.lOrder_id = -1
                    else:
                        st.has_open_short = False
                        st.kOrder_id = -1
                    break
        logger.info(f"📝 close_order: closed={closed}")
        return {"ok": True, "closed": closed}

    def list_orders(self) -> List[Dict[str, Any]]:
        st = self.state
        out = []
        for o in self.orders:
            if o.closed_at is not None:
                continue
            pnl = o.pnl(st.price) if st.price > Decimal('0.0') else Decimal('0.0')
            out.append({
                "ticket": o.ticket,
                "side": o.side,
                "entry": float(o.entry),
                "sl": float(o.sl),
                "tp": float(o.tp),
                "lot": float(o.lot),
                "pnl": float(pnl),
                "opened_at": o.opened_at.isoformat(),
            })
        return out

    def apply_settings(self, s: Dict[str, Any]) -> Dict[str, Any]:
        global MAX_PERIOD, MIN_PERIOD, X_PERIOD, Y_START, COMMISSION, STOP_LOSS, TAKE_PROFIT, LOT_SIZE, SLIPPAGE
        st = self.state
        try:
            if "max" in s and int(s["max"]) > 0:
                MAX_PERIOD = int(s["max"])
            if "min" in s and int(s["min"]) > 0:
                MIN_PERIOD = int(s["min"])
            X_PERIOD = MAX_PERIOD + 2
            Y_START = MIN_PERIOD - 2
            st.y = Y_START
            if "Cc" in s: st.Cc = bool(s["Cc"])
            if "cC" in s: st.cC = bool(s["cC"])
            if "Memory" in s: st.mem = int(s["Memory"])
            if "safetyOffSwitch" in s: st.safety = bool(s["safetyOffSwitch"])
            if "StopLoss" in s: STOP_LOSS = Decimal(str(s["StopLoss"]))
            if "TakeProfit" in s: TAKE_PROFIT = Decimal(str(s["TakeProfit"]))
            if "lot" in s: LOT_SIZE = Decimal(str(s["lot"]))
            if "slip" in s: SLIPPAGE = int(s["slip"])
            if "Commssion" in s: COMMISSION = Decimal(str(s["Commssion"]))
            self.OnReInit()
            logger.info(f"⚙️ Settings applied: max={MAX_PERIOD}, min={MIN_PERIOD}, Cc={st.Cc}, cC={st.cC}, mem={st.mem}, safety={st.safety}")
            return {"ok": True}
        except Exception as e:
            logger.error(f"apply_settings failed: {e}")
            return {"error": str(e)}

    def change_symbol(self, new_symbol: str) -> Dict[str, Any]:
        global SYMBOL
        try:
            if not new_symbol or not isinstance(new_symbol, str):
                return {"error": "invalid_symbol", "detail": "Symbol must be a non-empty string"}
            yahoo_symbol = SYMBOL_MAP.get(new_symbol.upper(), new_symbol.upper())
            test_feed = FeedClient(yahoo_symbol)
            bid, _ = test_feed.get_current_price()
            if bid <= Decimal('0.0'):
                return {
                    "error": "no_price_for_symbol",
                    "symbol": yahoo_symbol,
                    "detail": f"Relay returned no price for '{yahoo_symbol}'. Check RELAY_URL and symbol validity.",
                }
            prev_chat = self.state.chat_id
            prev_on_track = self.state.on_track_runs
            prev_on_stand = self.state.on_stand_runs
            prev_signals = self.state.signal_history
            SYMBOL = yahoo_symbol
            self.feed = FeedClient(yahoo_symbol)
            self._point_size = symbol_point(yahoo_symbol)
            self.OnReInit()
            self.state.chat_id = prev_chat
            self.state.on_track_runs = prev_on_track
            self.state.on_stand_runs = prev_on_stand
            self.state.signal_history = prev_signals
            historical = self.feed.get_historical_klines(limit=200)
            if historical:
                self.ohlcv_history = historical
                self._populate_indicator_matrix()
                self._force_initialization()
            logger.info(f"📈 Symbol changed to {yahoo_symbol}")
            return {"ok": True, "symbol": yahoo_symbol}
        except Exception as e:
            logger.exception("change_symbol failed")
            return {"error": "change_symbol_exception", "detail": str(e), "symbol": new_symbol}

# ============================================================================
# INDICATOR NAME CONSTANT
# ============================================================================
INDICATOR_NAMES = [
    "ADX", "Stochastic", "RVI", "AC", "Force", "OBV", "AD",
    "MFI", "Momentum", "DeMarker", "WPR", "CCI", "RSI"
]

# ============================================================================
# BRIDGE STATE
# ============================================================================
class BridgeState:
    def __init__(self):
        self._lock = threading.Lock()
        self._snapshot: Dict[str, Any] = {
            "symbol": SYMBOL, "price": "0.0", "ask": "0.0", "bid": "0.0",
            "signal": "0.0", "regime": "Unknown", "tick": 0,
            "m_count": 0, "n_count": 0,
            "timestamp": datetime.now().isoformat(), "endpoint": None,
            "webapp_user_id": None, "webapp_username": None,
            "last_price_update": None, "engine_initialized": False,
            "consecutive_zero_prices": 0,
            "relay_url": RELAY_URL, "relay_healthy": True,
            "indicator_populate_count": 0, "imbalance_fire_count": 0,
            "trailing_stop_active": False, "trailing_stop_price": "0.0",
            "trailing_take_profit": "0.0", "trailing_stop_entry": "0.0",
            "trailing_stop_side": "", "has_open_long": False, "has_open_short": False,
            "lOrder_id": -1, "kOrder_id": -1, "KC": True, "prime": -1,
            "dime": -1, "mem": -1, "tag": -1, "invert": True,
            "safety": False,
            "m_at_h": 0, "n_at_h": 0, "h_bar": 0,
            "on_track_runs": 0, "on_stand_runs": 0,
            "last_kronecker_bar": -1, "last_kronecker_m": 0,
            "last_kronecker_n": 0, "last_kronecker_h": -1,
            "X_scan": Y_START, "Y_scan": Y_START,
            "S": X_PERIOD, "T": X_PERIOD, "r": 0, "ir": 0,
            "iATR": 50.0, "iStdDev": 50.0, "iIHKk": 50.0, "iIHKt": 50.0,
            "market_m": 0, "market_n": 0, "market_imbalance": -2, "market_regime": "NEUTRAL",
            "ohlcv_count": 0, "signal_count": 0, "last_signal_at": None,
            "bar_close_count": 0,
            "A": True, "B": True, "C": True, "c": True,
            "tick_tock": False, "signature": False,
            "Z": Y_START + 1, "z": Y_START + 1, "O": Y_START + 1, "o": Y_START + 1,
            "W": Y_START + 1, "w": Y_START + 1, "I": 0, "iI": 0, "J": 0, "iJ": 0,
            "iZ": Y_START + 1, "iz": Y_START + 1, "iW": Y_START + 1, "iw": Y_START + 1,
            "iO": Y_START + 1, "io": Y_START + 1,
            "lPass": "0.0", "ilPass": "0.0", "kPass": "0.0", "ikPass": "0.0",
        }
        self._fvgs: Dict[int, Dict[str, Any]] = {}
        self._next_fvg_idx = 0
        self._webapp_sessions: Dict[int, Dict[str, Any]] = {}
        self._handshake_lock = threading.Lock()

    def publish(self, snapshot: Dict[str, Any]) -> None:
        with self._lock:
            if "price" in snapshot and snapshot["price"] != "0.0":
                snapshot["last_price_update"] = datetime.now().isoformat()
            self._snapshot = dict(snapshot)
            if snapshot.get("tick", 0) % 50 == 0:
                logger.info(f"🌉 BRIDGE_SNAPSHOT: price={snapshot.get('price')} tick={snapshot.get('tick')} "
                            f"ohlcv={snapshot.get('ohlcv_count')} signals={snapshot.get('signal_count')} "
                            f"bars={snapshot.get('bar_close_count')}")

    def get_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._snapshot)

    def register_webapp_session(self, user_id: int, username: Optional[str], chat_id: Optional[int] = None) -> bool:
        with self._handshake_lock:
            self._webapp_sessions[user_id] = {
                "user_id": user_id, "username": username, "chat_id": chat_id,
                "first_seen": self._webapp_sessions.get(user_id, {}).get("first_seen", datetime.now().isoformat()),
                "last_seen": datetime.now().isoformat(),
            }
        with self._lock:
            self._snapshot["webapp_user_id"] = user_id
            self._snapshot["webapp_username"] = username
        engine = BRIDGE_ENGINE_REF.get("engine")
        if engine is not None:
            try:
                engine.state.webapp_user_id = user_id
                engine.state.webapp_username = username
                engine.state.webapp_verified = True
                engine.state.webapp_last_seen = datetime.now()
                if chat_id is not None:
                    engine.state.chat_id = chat_id
            except Exception as e:
                logger.warning(f"register_webapp_session → engine map failed: {e}")
        logger.info(f"🔗 Web App session registered: user_id={user_id}, username={username}")
        return True

    def add_fvg(self, fvg_type: str, price_str: str, user_id: Optional[int] = None, requested_idx: Optional[int] = None) -> int:
        if fvg_type not in ("top", "bott"):
            raise ValueError("fvg_type must be 'top' or 'bott'")
        try:
            price_dec = Decimal(str(price_str))
        except Exception:
            raise ValueError("price must be a decimal string")
        if price_dec <= Decimal('0.0'):
            raise ValueError("price must be > 0")
        with self._lock:
            if requested_idx is not None and isinstance(requested_idx, int) and requested_idx >= 0:
                idx = requested_idx
                if idx >= self._next_fvg_idx:
                    self._next_fvg_idx = idx + 1
            else:
                idx = self._next_fvg_idx
                self._next_fvg_idx += 1
            self._fvgs[idx] = {
                "type": fvg_type, "price": str(price_dec), "idx": idx,
                "created": datetime.now().isoformat(), "user_id": user_id,
            }
        engine = BRIDGE_ENGINE_REF.get("engine")
        if engine is not None:
            engine.state.fvg_anchor_map[idx] = {
                "idx": idx, "type": fvg_type, "price": str(price_dec),
                "created": datetime.now().isoformat(),
            }
        return idx

    def remove_fvg(self, idx: int) -> bool:
        with self._lock:
            if idx in self._fvgs:
                del self._fvgs[idx]
                removed = True
            else:
                removed = False
        engine = BRIDGE_ENGINE_REF.get("engine")
        if engine is not None:
            engine.state.fvg_anchor_map.pop(idx, None)
        return removed

    def list_fvgs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._fvgs.values())

BRIDGE_STATE = BridgeState()
BRIDGE_ENGINE_REF: Dict[str, Any] = {"engine": None, "bot": None, "public_url": None}

# ============================================================================
# BRIDGE AUTH DEPENDENCY
# ============================================================================
def _require_auth(handler: "BridgeHandler") -> bool:
    if not REQUIRE_AUTH or not TELEGRAM_BOT_TOKEN_ENV:
        return True
    raw_init = handler.headers.get("X-Telegram-Init-Data", "").strip()
    if not raw_init:
        auth_hdr = handler.headers.get("Authorization", "").strip()
        if auth_hdr.lower().startswith("tma "):
            raw_init = auth_hdr[4:].strip()
    if not raw_init:
        return False
    verified = verify_telegram_init_data(raw_init, TELEGRAM_BOT_TOKEN_ENV)
    return bool(verified and verified.get("user"))

# ============================================================================
# TUNNEL MANAGER
# ============================================================================
class TunnelManager:
    URL_RE_CLOUDFLARED = _re_bridge.compile(r"https://[a-z0-9\-]+\.trycloudflare\.com")
    URL_RE_NGROK = _re_bridge.compile(r"https://[a-z0-9\-]+\.ngrok(?:-free)?\.app")
    URL_RE_SERVEO = _re_bridge.compile(r"https://[a-z0-9\-]+\.serveo\.net")

    def __init__(self, port: int, prefer: str = "cloudflared", timeout: int = 45):
        self.port = port
        self.prefer = prefer
        self.timeout = timeout
        self.process: Optional[subprocess.Popen] = None
        self.public_url: Optional[str] = None
        self.provider: Optional[str] = None

    def _which(self, name: str) -> Optional[str]:
        from shutil import which
        return which(name)

    def _spawn(self, cmd: List[str]) -> subprocess.Popen:
        logger.info(f"🌐 Spawning tunnel: {' '.join(cmd)}")
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1, universal_newlines=True)

    def _scan_for_url(self, proc: subprocess.Popen, regex: "_re_bridge.Pattern[str]", deadline: float) -> Optional[str]:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if line:
                logger.debug(f"[tunnel] {line}")
            m = regex.search(line)
            if m:
                return m.group(0)
            if time.time() > deadline:
                return None
        return None

    def _try_cloudflared(self) -> Optional[str]:
        if not self._which("cloudflared"):
            return None
        try:
            proc = self._spawn(["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{self.port}", "--no-autoupdate"])
        except Exception as e:
            logger.warning(f"cloudflared spawn failed: {e}")
            return None
        deadline = time.time() + self.timeout
        url = self._scan_for_url(proc, self.URL_RE_CLOUDFLARED, deadline)
        if url:
            self.process = proc
            self.public_url = url
            self.provider = "cloudflared"
            return url
        try:
            proc.terminate()
        except Exception:
            pass
        return None

    def _try_ngrok(self) -> Optional[str]:
        if not self._which("ngrok"):
            return None
        try:
            proc = self._spawn(["ngrok", "http", str(self.port), "--log=stdout"])
        except Exception as e:
            logger.warning(f"ngrok spawn failed: {e}")
            return None
        deadline = time.time() + self.timeout
        url = self._scan_for_url(proc, self.URL_RE_NGROK, deadline)
        if url:
            self.process = proc
            self.public_url = url
            self.provider = "ngrok"
            return url
        try:
            proc.terminate()
        except Exception:
            pass
        return None

    def _try_serveo(self) -> Optional[str]:
        if not self._which("ssh"):
            return None
        try:
            proc = self._spawn(["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "-R", f"80:127.0.0.1:{self.port}", "serveo.net"])
        except Exception as e:
            logger.warning(f"serveo spawn failed: {e}")
            return None
        deadline = time.time() + self.timeout
        url = self._scan_for_url(proc, self.URL_RE_SERVEO, deadline)
        if url:
            self.process = proc
            self.public_url = url
            self.provider = "serveo"
            return url
        try:
            proc.terminate()
        except Exception:
            pass
        return None

    def start(self) -> Optional[str]:
        if TELEGRAM_WEBAPP_URL:
            self.public_url = TELEGRAM_WEBAPP_URL
            self.provider = "explicit"
            BRIDGE_ENGINE_REF["public_url"] = self.public_url
            logger.info(f"🌐 Using explicit TELEGRAM_WEBAPP_URL: {self.public_url}")
            return self.public_url
        order = [self.prefer] + [p for p in ("cloudflared", "ngrok", "serveo") if p != self.prefer]
        for provider in order:
            method = getattr(self, f"_try_{provider}", None)
            if method is None:
                continue
            try:
                url = method()
            except Exception as e:
                logger.warning(f"Tunnel provider {provider} raised: {e}")
                url = None
            if url:
                BRIDGE_ENGINE_REF["public_url"] = url
                logger.info(f"🌐 Tunnel established via {provider}: {url}")
                return url
        logger.warning("⚠️ No tunnel available. Telegram Mini App will require manual TELEGRAM_WEBAPP_URL.")
        return None

    def stop(self) -> None:
        if self.process is None:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass
        self.process = None
        logger.info("🌐 Tunnel stopped")

# ============================================================================
# BRIDGE HANDLER
# ============================================================================
class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "AEI-Bridge/4.1.0"

    def log_message(self, fmt, *args):
        return

    def _set_cors(self) -> None:
        origin = CORS_ORIGIN
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Telegram-Init-Data, X-Relay-Key, X-Limit, X-Since")
        self.send_header("Access-Control-Max-Age", "86400")
        if origin != "*":
            self.send_header("Vary", "Origin")

    def _send_json(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._set_cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code: int, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._set_cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self) -> Dict[str, Any]:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._set_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        query = dict(parse_qsl(urlparse(self.path).query))

        if path == "/health":
            snap = BRIDGE_STATE.get_snapshot()
            last = snap.get("last_price_update")
            stale = True
            age_seconds = None
            if last:
                try:
                    last_dt = datetime.fromisoformat(last)
                    if last_dt.tzinfo is None:
                        last_dt = last_dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
                    age_seconds = (datetime.now().astimezone() - last_dt).total_seconds()
                    stale = age_seconds > 60
                except Exception:
                    pass
            self._send_json(200, {
                "ok": not stale, "service": "aei-bridge", "version": "4.1.0",
                "last_price_update": last,
                "age_seconds": age_seconds, "stale": stale,
                "engine_initialized": snap.get("engine_initialized", False),
                "indicator_populate_count": snap.get("indicator_populate_count", 0),
                "imbalance_fire_count": snap.get("imbalance_fire_count", 0),
                "ohlcv_count": snap.get("ohlcv_count", 0),
                "signal_count": snap.get("signal_count", 0),
                "bar_close_count": snap.get("bar_close_count", 0),
                "relay_healthy": snap.get("relay_healthy", True),
            })
            return

        if not _require_auth(self):
            self._send_json(401, {"error": "unauthorized", "detail": "Missing or invalid X-Telegram-Init-Data"})
            return

        if path == "/config":
            self._send_json(200, {
                "public_url": BRIDGE_ENGINE_REF.get("public_url"), "tls": BRIDGE_USE_TLS,
                "port": BRIDGE_PORT, "host": BRIDGE_HOST, "symbol": SYMBOL,
                "webapp_enabled": True, "cors_origin": CORS_ORIGIN,
                "relay_url": RELAY_URL, "relay_gated": bool(RELAY_KEY),
                "x_period_constant": X_PERIOD, "y_start_constant": Y_START,
                "require_auth": REQUIRE_AUTH,
            })
            return

        if path == "/state":
            snap = BRIDGE_STATE.get_snapshot()
            public = BRIDGE_ENGINE_REF.get("public_url")
            if public:
                snap["endpoint"] = public
            else:
                host = self.headers.get("Host", f"{BRIDGE_HOST}:{BRIDGE_PORT}")
                scheme = "https" if BRIDGE_USE_TLS else "http"
                snap["endpoint"] = f"{scheme}://{host}"
            snap["relay_url"] = RELAY_URL
            self._send_json(200, snap)
            return

        if path == "/miniapp-state":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready", "detail": "Engine hasn't started. Use /start_feed in the bot."})
                return
            st = engine.state
            idx = st.Z - (st.y + 1)
            regime = st.Regime[idx] if 0 <= idx < len(st.Regime) else "Unknown"
            fvg_anchors = []
            for idx_i, p in enumerate(st.Premium):
                if p > Decimal('0.0'):
                    fvg_anchors.append({"idx": idx_i, "type": "top", "price": str(p)})
            for idx_i, p in enumerate(st.Discount):
                if p > Decimal('0.0'):
                    fvg_anchors.append({"idx": idx_i, "type": "bottom", "price": str(p)})
            for bridge_idx, rec in BRIDGE_STATE._fvgs.items():
                fvg_anchors.append({
                    "idx": bridge_idx,
                    "type": "top" if rec["type"] == "top" else "bottom",
                    "price": rec["price"],
                })
            h_idx = st.h - (st.y + 1)
            m_at_h = 1 if (0 <= h_idx < len(st.k) and st.k[h_idx]) else 0
            n_at_h = 1 if (0 <= h_idx < len(st.l) and st.l[h_idx]) else 0
            market_m = int(st.m_now)
            market_n = int(st.n_now)
            market_imbalance = market_m - market_n - 2
            if market_imbalance > 2:
                market_regime = "BULLISH"
            elif market_imbalance < -2:
                market_regime = "BEARISH"
            else:
                market_regime = "NEUTRAL"
            premium_series = [str(p) for p in st.Premium]
            discount_series = [str(p) for p in st.Discount]
            payload = {
                "symbol": SYMBOL,
                "price": str(st.price),
                "regime": regime,
                "tick": int(st.tick),
                "m_count": market_m,
                "n_count": market_n,
                "m_at_h": m_at_h,
                "n_at_h": n_at_h,
                "h_bar": int(st.h),
                "market_m": market_m,
                "market_n": market_n,
                "market_imbalance": market_imbalance,
                "market_regime": market_regime,
                "last_price_update": datetime.now().isoformat(),
                "relay_healthy": (engine.feed._failure_count < 3),
                "X_PERIOD": X_PERIOD,
                "Y_START": Y_START,
                "fvg_anchors": fvg_anchors,
                "premium_series": premium_series,
                "discount_series": discount_series,
                "recent_signals": st.signal_history[-20:],
                "ohlcv_count": len(engine.ohlcv_history),
                "signal_count": len(st.signal_history),
                "last_signal_at": st.last_signal_at,
                "bar_close_count": int(st.bar_close_count),
                "engine_initialized": bool(st.FG),
                "KC": bool(st.KC),
                "invert": bool(st.invert),
                "tag": int(st.tag),
                "prime": int(st.prime),
                "dime": int(st.dime),
                "mem": int(st.mem),
                "A": bool(st.A),
                "B": bool(st.B),
                "C": bool(st.C),
                "c": bool(st.c),
                "tick_tock": bool(st.tick_tock),
                "signature": bool(st.signature),
                "safety": bool(st.safety),
                "trailing_stop_active": bool(st.trailing_stop_active),
                "trailing_stop_price": str(st.trailing_stop_price),
                "trailing_take_profit": str(st.trailing_take_profit),
                "trailing_stop_entry": str(st.trailing_stop_entry),
                "trailing_stop_side": st.trailing_stop_side,
                "has_open_long": bool(st.has_open_long),
                "has_open_short": bool(st.has_open_short),
                "lOrder_id": int(st.lOrder_id),
                "kOrder_id": int(st.kOrder_id),
                "on_track_runs": int(st.on_track_runs),
                "on_stand_runs": int(st.on_stand_runs),
                "last_kronecker_bar": int(engine._last_kronecker_bar),
                "last_kronecker_m": int(st.last_kronecker_m),
                "last_kronecker_n": int(st.last_kronecker_n),
                "last_kronecker_h": int(st.last_kronecker_h),
                "X_scan": int(st.X_scan),
                "Y_scan": int(st.Y_scan),
                "S": int(st.S),
                "T": int(st.T),
                "r": int(st.r),
                "ir": int(st.ir),
                "Z": int(st.Z),
                "z": int(st.z),
                "O": int(st.O),
                "o": int(st.o),
                "W": int(st.W),
                "w": int(st.w),
                "I": int(st.I),
                "iI": int(st.iI),
                "J": int(st.J),
                "iJ": int(st.iJ),
                "iZ": int(st.iZ),
                "iz": int(st.iz),
                "iW": int(st.iW),
                "iw": int(st.iw),
                "iO": int(st.iO),
                "io": int(st.io),
                "iATR": float(st.iATR),
                "iStdDev": float(st.iStdDev),
                "iIHKk": float(st.iIHKk),
                "iIHKt": float(st.iIHKt),
                "indicator_populate_count": int(engine._indicator_populate_count),
                "imbalance_fire_count": int(engine._imbalance_fire_count),
                "lPass": str(st.lPass),
                "ilPass": str(st.ilPass),
                "kPass": str(st.kPass),
                "ikPass": str(st.ikPass),
            }
            self._send_json(200, payload)
            return

        if path == "/ohlcv":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            limit = 200
            try:
                limit = int(self.headers.get("X-Limit", query.get("limit", "200")))
            except Exception:
                pass
            bars = engine.ohlcv_history[-limit:]
            ohlcv_data = []
            last_ts = None
            for bar in bars:
                ts = bar["timestamp"]
                if isinstance(ts, datetime):
                    ts_str = ts.isoformat()
                else:
                    ts_str = str(ts)
                last_ts = ts_str
                ohlcv_data.append({
                    "timestamp": ts_str,
                    "open": float(bar["open"]),
                    "high": float(bar["high"]),
                    "low": float(bar["low"]),
                    "close": float(bar["close"]),
                    "volume": float(bar.get("volume", 0)),
                })
            self._send_json(200, {
                "symbol": SYMBOL,
                "bars": ohlcv_data,
                "count": len(ohlcv_data),
                "last_bar_timestamp": last_ts,
                "signal_count": len(engine.state.signal_history),
            })
            return

        if path == "/signals":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            limit = 50
            try:
                limit = int(self.headers.get("X-Limit", query.get("limit", "50")))
            except Exception:
                pass
            since = self.headers.get("X-Since", query.get("since", ""))
            all_signals = engine.state.signal_history
            if since:
                all_signals = [s for s in all_signals if s.get("timestamp", "") > since]
            signals = all_signals[-limit:]
            self._send_json(200, {
                "symbol": SYMBOL,
                "signals": signals,
                "count": len(signals),
                "last_signal_at": engine.state.last_signal_at,
            })
            return

        if path == "/fvg":
            self._send_json(200, {"fvgs": BRIDGE_STATE.list_fvgs()})
            return

        if path == "/probe":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            probe_data = engine.feed.probe()
            try:
                probe_data["signal_status"] = engine.get_signal_status()
                probe_data["relay_healthy"] = (engine.feed._failure_count < 3)
            except Exception:
                pass
            self._send_json(200, probe_data)
            return

        if path == "/diagnostics":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            try:
                diag = engine.get_signal_status()
                diag["ohlcv_history_depth"] = len(engine.ohlcv_history)
                diag["indicator_sample_col0"] = [str(engine.state.iA[i][0]) for i in range(13)]
                diag["indicator_sample_col1"] = [str(engine.state.iA[i][1]) for i in range(13)] if len(engine.state.iA[0]) > 1 else []
                diag["x_period_constant"] = X_PERIOD
                diag["y_start_constant"] = Y_START
                diag["consecutive_zero_prices"] = engine._consecutive_zero_prices
                diag["relay_healthy"] = (engine.feed._failure_count < 3)
                diag["active_symbol"] = engine.feed.active_symbol()
                diag["last_bar_close"] = engine.state.bar_close_count
                diag["recent_signals"] = engine.state.signal_history[-10:]
                self._send_json(200, diag)
            except Exception as e:
                self._send_json(500, {"error": "diagnostics_failed", "detail": str(e)})
            return

        if path == "/orders":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            self._send_json(200, {"orders": engine.list_orders()})
            return

        if path == "/regime-map":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            self._send_json(200, {
                "regime_map": engine.get_regime_map(),
                "size": len(engine.state.Regime),
            })
            return

        if path == "/indicators":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            name = query.get("name", "RSI")
            try:
                count = int(query.get("count", "80"))
            except Exception:
                count = 80
            series = engine.get_indicator_series(name, count)
            self._send_json(200, {"name": name, "series": series, "count": len(series)})
            return

        if path == "/log":
            try:
                limit = int(query.get("limit", "50"))
            except Exception:
                limit = 50
            with _LOG_LOCK:
                logs = list(_LOG_BUFFER)[-limit:]
            self._send_json(200, {"logs": logs, "count": len(logs)})
            return

        if path == "/" or path == "/index.html":
            try:
                base = os.path.dirname(os.path.abspath(__file__))
                html_path = os.path.join(base, "index.html")
                if os.path.isfile(html_path):
                    with open(html_path, "r", encoding="utf-8") as f:
                        self._send_html(200, f.read())
                else:
                    self._send_html(200, "<!DOCTYPE html><html><body style='font-family:monospace;background:#050510;color:#aaccff;padding:40px;'><h2>⚡ ÆEA Mini App Bridge Online</h2><p>index.html not found in <code>" + base + "</code>.</p></body></html>")
            except Exception as e:
                self._send_json(500, {"error": "read_index_failed", "detail": str(e)})
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/handshake":
            try:
                data = self._read_json()
                init_data = data.get("initData", "").strip()
                chat_id = data.get("chat_id")
                if not init_data:
                    self._send_json(400, {"error": "missing_init_data", "detail": "Provide initData from Telegram.WebApp.initData"})
                    return
                verified = verify_telegram_init_data(init_data, TELEGRAM_BOT_TOKEN_ENV)
                if not verified or not verified.get("user"):
                    logger.warning("🚫 Handshake rejected: initData verification failed")
                    self._send_json(403, {"error": "invalid_init_data", "detail": "Telegram initData HMAC verification failed. Ensure TELEGRAM_BOT_TOKEN matches the bot that issued initData."})
                    return
                u = verified["user"] or {}
                user_id = u.get("id")
                username = u.get("username")
                BRIDGE_STATE.register_webapp_session(user_id, username, chat_id=chat_id)
                logger.info(f"🤝 Handshake OK: user_id={user_id}, username={username}, chat_id={chat_id}")
                self._send_json(200, {
                    "ok": True, "user_id": user_id, "username": username,
                    "public_url": BRIDGE_ENGINE_REF.get("public_url"),
                })
            except Exception as e:
                logger.error(f"Handshake error: {e}")
                self._send_json(500, {"error": "internal", "detail": str(e)})
            return

        if not _require_auth(self):
            self._send_json(401, {"error": "unauthorized", "detail": "Missing or invalid X-Telegram-Init-Data"})
            return

        if path == "/fvg":
            user_id, username, verified = _extract_auth_headers(self)
            try:
                data = self._read_json()
                fvg_type = data.get("type")
                price_str = data.get("price")
                num = data.get("num")
                den = data.get("den")
                requested_idx = data.get("idx")
                if fvg_type is None:
                    self._send_json(400, {"error": "missing_fields", "need": ["type", "price"]})
                    return
                try:
                    requested_idx_int = int(requested_idx) if requested_idx is not None else None
                except (TypeError, ValueError):
                    requested_idx_int = None
                if num is not None and den is not None:
                    price_label = f"{int(num)}/{int(den)}"
                    price_dec = Decimal(int(num)) / Decimal(int(den))
                elif price_str is not None:
                    price_label = str(price_str)
                    price_dec = Decimal(str(price_str))
                else:
                    self._send_json(400, {"error": "missing_fields", "need": ["type", "price"]})
                    return
                idx = BRIDGE_STATE.add_fvg(fvg_type, str(price_dec), user_id=user_id, requested_idx=requested_idx_int)
                anchor_info = {}
                engine = BRIDGE_ENGINE_REF.get("engine")
                if engine is not None and idx in engine.state.fvg_anchor_map:
                    anchor_info = engine.state.fvg_anchor_map[idx]
                logger.info(f"📐 FVG committed: type={fvg_type} price={price_label} idx={idx} verified={verified} user={username}")
                self._send_json(201, {"ok": True, "idx": idx, "type": fvg_type, "price": price_label, "verified": verified, "anchor": anchor_info})
            except ValueError as ve:
                logger.warning(f"FVG rejected: {ve}")
                self._send_json(422, {"error": "validation", "detail": str(ve)})
            except Exception as e:
                logger.error(f"FVG POST error: {e}")
                self._send_json(500, {"error": "internal", "detail": str(e)})
            return

        if path == "/reset":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            try:
                engine.feed._rebuild_ticker()
                engine.feed._fallback_count = 0
                engine._consecutive_zero_prices = 0
                engine.OnReInit()
                logger.info("🔄 Manual reset requested via /reset")
                self._send_json(200, {"ok": True, "active_symbol": engine.feed.active_symbol()})
            except Exception as e:
                logger.error(f"/reset error: {e}")
                self._send_json(500, {"error": "internal", "detail": str(e)})
            return

        if path == "/settings":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            data = self._read_json()
            result = engine.apply_settings(data)
            code = 200 if result.get("ok") else 400
            self._send_json(code, result)
            return

        if path == "/symbol":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            data = self._read_json()
            sym = data.get("symbol")
            if not sym:
                self._send_json(400, {"error": "missing_symbol", "detail": "Provide 'symbol' in JSON body"})
                return
            result = engine.change_symbol(sym)
            code = 200 if result.get("ok") else 400
            self._send_json(code, result)
            return

        if path == "/order":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            data = self._read_json()
            side = (data.get("side") or "").upper()
            try:
                lot = Decimal(str(data.get("lot", "0.01")))
                sl = Decimal(str(data.get("sl", "0")))
                tp = Decimal(str(data.get("tp", "0")))
            except Exception:
                self._send_json(400, {"error": "invalid_numbers"})
                return
            result = engine.place_order(side, lot, sl, tp)
            code = 200 if result.get("ok") else 400
            self._send_json(code, result)
            return

        if path == "/order/close":
            engine = BRIDGE_ENGINE_REF.get("engine")
            if engine is None:
                self._send_json(503, {"error": "engine_not_ready"})
                return
            data = self._read_json()
            if data.get("all"):
                result = engine.close_order(all=True)
            else:
                ticket = data.get("ticket")
                if ticket is None:
                    self._send_json(400, {"error": "missing_ticket"})
                    return
                try:
                    ticket = int(ticket)
                except Exception:
                    self._send_json(400, {"error": "invalid_ticket"})
                    return
                result = engine.close_order(ticket=ticket)
            code = 200 if result.get("ok") else 400
            self._send_json(code, result)
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if not _require_auth(self):
            self._send_json(401, {"error": "unauthorized", "detail": "Missing or invalid X-Telegram-Init-Data"})
            return
        m = _re_bridge.match(r"^/fvg/(\d+)$", path)
        if m:
            idx = int(m.group(1))
            ok = BRIDGE_STATE.remove_fvg(idx)
            if ok:
                logger.info(f"🔻 FVG removed: idx={idx}")
                self._send_json(200, {"ok": True, "idx": idx})
            else:
                self._send_json(404, {"error": "fvg_not_found", "idx": idx})
            return
        self._send_json(404, {"error": "not_found", "path": path})

# ============================================================================
# BRIDGE SERVER
# ============================================================================
class BridgeServer:
    def __init__(self, host: str = BRIDGE_HOST, port: int = BRIDGE_PORT):
        self.host = host
        self.port = int(port)
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._tunnel: Optional[TunnelManager] = None
        self._ssl_context: Optional[ssl.SSLContext] = None

    def _build_ssl_context(self) -> Optional[ssl.SSLContext]:
        if not BRIDGE_USE_TLS:
            return None
        if not BRIDGE_TLS_CERT or not BRIDGE_TLS_KEY:
            logger.warning("⚠️ BRIDGE_USE_TLS=1 but cert/key paths missing — falling back to HTTP")
            return None
        if not (os.path.isfile(BRIDGE_TLS_CERT) and os.path.isfile(BRIDGE_TLS_KEY)):
            logger.warning("⚠️ TLS cert or key file not found — falling back to HTTP")
            return None
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=BRIDGE_TLS_CERT, keyfile=BRIDGE_TLS_KEY)
            logger.info(f"🔒 TLS enabled: cert={BRIDGE_TLS_CERT}")
            return ctx
        except Exception as e:
            logger.error(f"❌ Failed to load TLS context: {e}")
            return None

    def start(self) -> None:
        if self._thread is not None:
            return
        try:
            self._httpd = ThreadingHTTPServer((self.host, self.port), BridgeHandler)
            self._httpd.daemon_threads = True
            self._ssl_context = self._build_ssl_context()
            if self._ssl_context is not None:
                self._httpd.socket = self._ssl_context.wrap_socket(self._httpd.socket, server_side=True)
        except OSError as e:
            logger.error(f"🔥 Bridge server bind failed on {self.host}:{self.port}: {e}")
            return
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="aei-bridge", daemon=True)
        self._thread.start()
        scheme = "https" if self._ssl_context else "http"
        logger.info(f"🌐 ÆEA Mini App Bridge listening on {scheme}://{self.host}:{self.port}")
        self._tunnel = TunnelManager(self.port, prefer=BRIDGE_TUNNEL, timeout=BRIDGE_PUBLIC_TIMEOUT)
        threading.Thread(target=self._tunnel.start, name="aei-tunnel", daemon=True).start()

    def stop(self) -> None:
        if self._tunnel is not None:
            try:
                self._tunnel.stop()
            except Exception:
                pass
            self._tunnel = None
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:
                pass
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        logger.info("🌐 ÆEA Mini App Bridge stopped")

# ============================================================================
# BRIDGE ATTACHMENT
# ============================================================================
def _bridge_attach_to_engine(engine: "AEEA_Engine") -> None:
    if getattr(engine, "_bridge_attached", False):
        return
    original_on_tick = engine._on_tick
    def wrapped_on_tick(price_data: PriceData) -> None:
        original_on_tick(price_data)
        try:
            st = engine.state
            idx = st.Z - (st.y + 1)
            regime = st.Regime[idx] if 0 <= idx < len(st.Regime) else "Unknown"
            h_idx = st.h - (st.y + 1)
            m_at_h = 1 if (0 <= h_idx < len(st.k) and st.k[h_idx]) else 0
            n_at_h = 1 if (0 <= h_idx < len(st.l) and st.l[h_idx]) else 0
            market_m = int(st.m_now)
            market_n = int(st.n_now)
            market_imbalance = market_m - market_n - 2
            if market_imbalance > 2:
                market_regime = "BULLISH"
            elif market_imbalance < -2:
                market_regime = "BEARISH"
            else:
                market_regime = "NEUTRAL"
            snapshot = {
                "symbol": SYMBOL, "price": str(st.price),
                "bid": str(price_data.bid), "ask": str(price_data.ask),
                "signal": str(st.signal), "regime": regime,
                "tick": int(st.tick),
                "m_count": market_m, "n_count": market_n,
                "m_at_h": int(m_at_h), "n_at_h": int(n_at_h), "h_bar": int(st.h),
                "timestamp": datetime.now().isoformat(),
                "endpoint": BRIDGE_ENGINE_REF.get("public_url"),
                "webapp_user_id": st.webapp_user_id, "webapp_username": st.webapp_username,
                "last_price_update": datetime.now().isoformat(),
                "engine_initialized": bool(st.FG),
                "consecutive_zero_prices": int(getattr(engine, "_consecutive_zero_prices", 0)),
                "relay_url": RELAY_URL,
                "relay_healthy": (engine.feed._failure_count < 3),
                "indicator_populate_count": int(engine._indicator_populate_count),
                "imbalance_fire_count": int(engine._imbalance_fire_count),
                "trailing_stop_active": bool(st.trailing_stop_active),
                "trailing_stop_price": str(st.trailing_stop_price),
                "trailing_take_profit": str(st.trailing_take_profit),
                "trailing_stop_entry": str(st.trailing_stop_entry),
                "trailing_stop_side": st.trailing_stop_side,
                "has_open_long": bool(st.has_open_long),
                "has_open_short": bool(st.has_open_short),
                "lOrder_id": int(st.lOrder_id), "kOrder_id": int(st.kOrder_id),
                "KC": bool(st.KC), "prime": int(st.prime),
                "dime": int(st.dime), "mem": int(st.mem), "tag": int(st.tag),
                "invert": bool(st.invert),
                "safety": bool(st.safety),
                "on_track_runs": int(st.on_track_runs),
                "on_stand_runs": int(st.on_stand_runs),
                "last_kronecker_bar": int(engine._last_kronecker_bar),
                "last_kronecker_m": int(st.last_kronecker_m),
                "last_kronecker_n": int(st.last_kronecker_n),
                "last_kronecker_h": int(st.last_kronecker_h),
                "X_scan": int(st.X_scan), "Y_scan": int(st.Y_scan),
                "S": int(st.S), "T": int(st.T), "r": int(st.r), "ir": int(st.ir),
                "iATR": float(st.iATR), "iStdDev": float(st.iStdDev),
                "iIHKk": float(st.iIHKk), "iIHKt": float(st.iIHKt),
                "market_m": market_m,
                "market_n": market_n,
                "market_imbalance": market_imbalance,
                "market_regime": market_regime,
                "ohlcv_count": len(engine.ohlcv_history),
                "signal_count": len(st.signal_history),
                "last_signal_at": st.last_signal_at,
                "bar_close_count": int(st.bar_close_count),
                "A": bool(st.A), "B": bool(st.B), "C": bool(st.C), "c": bool(st.c),
                "tick_tock": bool(st.tick_tock), "signature": bool(st.signature),
                "Z": int(st.Z), "z": int(st.z), "O": int(st.O), "o": int(st.o),
                "W": int(st.W), "w": int(st.w), "I": int(st.I), "iI": int(st.iI),
                "J": int(st.J), "iJ": int(st.iJ),
                "iZ": int(st.iZ), "iz": int(st.iz), "iW": int(st.iW), "iw": int(st.iw),
                "iO": int(st.iO), "io": int(st.io),
                "lPass": str(st.lPass), "ilPass": str(st.ilPass),
                "kPass": str(st.kPass), "ikPass": str(st.ikPass),
            }
            BRIDGE_STATE.publish(snapshot)
        except Exception as e:
            logger.warning(f"Bridge publish failed: {e}")
    engine._on_tick = wrapped_on_tick
    engine._bridge_attached = True
    logger.info("🔗 Bridge attached to AEEA_Engine")

def _bridge_attach_to_bot(bot: "AEI_Bot") -> None:
    if getattr(bot, "_bridge_attached", False):
        return
    original_run = bot.run
    def wrapped_run(self):
        BRIDGE_ENGINE_REF["engine"] = self.engine
        BRIDGE_ENGINE_REF["bot"] = self
        _bridge_attach_to_engine(self.engine)
        server = BridgeServer()
        server.start()
        self._bridge_server = server
        try:
            original_run(self)
        finally:
            server.stop()
    bot.run = wrapped_run
    bot._bridge_attached = True
    logger.info("🔗 Bridge attached to AEI_Bot.run()")

# ============================================================================
# TELEGRAM BOT
# ============================================================================
class AEI_Bot:
    def __init__(self, token: str, bot_name: str = "UpscaleTradeBot"):
        self.token = token
        self.bot_name = bot_name
        self.engine = AEEA_Engine()
        self.application = None
        self._running = False
        self._price_task: Optional[asyncio.Task] = None
        self._bridge_server: Optional[BridgeServer] = None
        self._webapp_url: Optional[str] = None

    def _resolve_webapp_url(self) -> Optional[str]:
        return TELEGRAM_WEBAPP_URL or BRIDGE_ENGINE_REF.get("public_url")

    async def price_feed_loop(self):
        logger.info("🔄 Price feed loop entered")
        iteration = 0
        while self._running:
            iteration += 1
            try:
                self.engine.update_price_from_feed()
                st = self.engine.state
                idx = st.Z - (st.y + 1)
                regime = st.Regime[idx] if 0 <= idx < len(st.Regime) else "Unknown"
                logger.info(f"📊 itr#{iteration} price={st.price} tick={st.tick} FG={st.FG} regime={regime} bars={st.bar_close_count} signals={len(st.signal_history)} ohlcv={len(self.engine.ohlcv_history)}")
            except Exception:
                logger.exception(f"❌ Feed iteration #{iteration} failed")
            await asyncio.sleep(UPDATE_INTERVAL)
        logger.info("🔄 Price feed loop exited")

    def _build_main_keyboard(self) -> InlineKeyboardMarkup:
        webapp_url = self._resolve_webapp_url()
        rows = [
            [InlineKeyboardButton("📊 Status", callback_data="status"), InlineKeyboardButton("📈 Signal", callback_data="signal")],
            [InlineKeyboardButton("📊 Regime", callback_data="regime"), InlineKeyboardButton("📉 Indicators", callback_data="indicators")],
            [InlineKeyboardButton("🔄 Start Feed", callback_data="start_feed"), InlineKeyboardButton("⏹️ Stop Feed", callback_data="stop_feed")],
            [InlineKeyboardButton("📈 Info", callback_data="info"), InlineKeyboardButton("🔄 Reset", callback_data="reset")],
            [InlineKeyboardButton("🔬 Probe Relay", callback_data="probe"), InlineKeyboardButton("♻️ Rebuild Relay", callback_data="rebuild_yf")],
            [InlineKeyboardButton("🔬 Diagnostics", callback_data="diagnostics")],
            [InlineKeyboardButton("📊 Chart", callback_data="chart")],
        ]
        if webapp_url:
            rows.append([InlineKeyboardButton("⚡ Open ÆEA Mini App", web_app=WebAppInfo(url=webapp_url))])
        else:
            rows.append([InlineKeyboardButton("⏳ Mini App (tunnel pending…)", callback_data="webapp_pending")])
        return InlineKeyboardMarkup(rows)

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat_id = update.effective_chat.id
        self.engine.state.chat_id = chat_id
        self.engine.application = self.application
        engine_status = "✅ Initialized" if self.engine.state.FG else "⏳ Waiting for data"
        feed_status = "Active" if self._running else "Inactive"
        welcome = (
            "🔷 *ÆEA Quantum-Financial Topology Bot*\n"
            "Welcome to @UpscaleTradeBot. This bot implements the Non-Hermitian\n"
            "Stochastic Geometry of Supply-Demand Imbalance.\n\n"
            "📊 *Available Commands:*\n"
            "`/status` - Current market state & regime\n"
            "`/regime` - Detailed regime classification\n"
            "`/signal` - Current trading signal\n"
            "`/indicators` - 13D Hilbert Space projection\n"
            "`/fvg` - Fair Value Gap tracking\n"
            "`/chart` - Recent signals summary\n"
            "`/diagnostics` - Full engine diagnostic snapshot\n"
            "`/reset` - Reset topological branch\n"
            "`/start_feed` - Start price feed\n"
            "`/stop_feed` - Stop price feed\n"
            "`/symbol <PAIR>` - Change trading symbol\n"
            "`/info` - Ticker information\n"
            "`/probe` - Relay diagnostics\n"
            "`/rebuild_yf` - Force relay reset\n"
            "`/webapp` - Launch Telegram Mini App\n"
            "`/webgui` - Show bridge URL\n"
            "`/help` - Show this message\n\n"
            f"*Current Symbol:* `{SYMBOL}`\n"
            f"🔄 *Feed Status:* {feed_status}\n"
            f"🧠 *Engine Status:* {engine_status}\n"
            f"📊 *Bar Closes:* {self.engine.state.bar_close_count}  |  *Signals:* {len(self.engine.state.signal_history)}\n"
            "💎 Natalia Tanyatia"
        )
        await update.message.reply_text(welcome, parse_mode="Markdown", reply_markup=self._build_main_keyboard())

    async def help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.start(update, context)

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not self.engine.state.FG:
            logger.info("⚠️ Engine not initialized, attempting to force...")
            self.engine._force_initialization()
        if not self.engine.state.FG:
            await update.message.reply_text("⏳ *Engine not initialized*\nThe engine will initialize on the first price tick after starting the feed.\nPlease use `/start_feed` to start the price feed.\nIf the feed is already running, try `/reset` to reinitialize.", parse_mode="Markdown")
            return
        state = self.engine.state
        idx = state.Z - (state.y + 1)
        regime = state.Regime[idx] if 0 <= idx < len(state.Regime) and state.Regime[idx] else "Unknown"
        bid, ask = self.engine.feed.get_current_price()
        price_display = f"{bid:.5f}" if bid > Decimal('0.0') else f"{state.price:.5f}"
        feed_mark = "✅" if self._running else "⏹️"
        init_mark = "✅ Initialized" if state.FG else "⏳ Initializing"
        m_local = state.m_now if state.FG else 0
        n_local = state.n_now if state.FG else 0
        h_idx = state.h - (state.y + 1)
        m_at_h = 1 if (0 <= h_idx < len(state.k) and state.k[h_idx]) else 0
        n_at_h = 1 if (0 <= h_idx < len(state.l) and state.l[h_idx]) else 0
        trail_status = "🟢 Active" if state.trailing_stop_active else "⚪ Inactive"
        order_presence = []
        if state.has_open_long:
            order_presence.append(f"LONG(id={state.lOrder_id})")
        if state.has_open_short:
            order_presence.append(f"SHORT(id={state.kOrder_id})")
        order_str = ", ".join(order_presence) if order_presence else "none"
        response = (
            "🔷 *ÆEA STATUS*\n"
            f"📈 *Symbol:* {SYMBOL}\n"
            f"💰 *Price:* {price_display}\n"
            f"📊 *Regime:* {regime}\n"
            f"🎯 *Signal Level:* {state.signal:.5f}\n"
            f"📋 *Signature:* {'Active' if state.signature else 'Idle'}\n"
            f"🔄 *Tick:* {state.tick}\n"
            f"🧠 *Engine State:* {init_mark}\n"
            f"⚖️ *Imbalance @ h={state.h}:* m={m_at_h}, n={n_at_h}\n"
            f"⚖️ *Local m/n:* {m_local}/{n_local}\n"
            f"📈 *Indicator Passes:* {self.engine._indicator_populate_count}\n"
            f"📡 *Signal Fires:* {self.engine._imbalance_fire_count}\n"
            f"📊 *Bar Closes:* {state.bar_close_count}\n"
            f"📈 *OHLCV Bars:* {len(self.engine.ohlcv_history)}\n"
            f"🎯 *Signal History:* {len(state.signal_history)}\n"
            f"📡 *Feed Active:* {feed_mark}\n"
            f"🔀 *KC:* {state.KC}  |  *Prime:* {state.prime}  |  *Dime:* {state.dime}\n"
            f"🔀 *Invert:* {state.invert}  |  *Mem:* {state.mem}  |  *Tag:* {state.tag}\n"
            f"🔀 *A:* {state.A}  |  *B:* {state.B}  |  *C:* {state.C}  |  *c:* {state.c}\n"
            f"🔀 *tick_tock:* {state.tick_tock}  |  *safety:* {state.safety}\n"
            f"📊 *Orders:* {order_str}\n"
            f"🛑 *Trailing Stop:* {trail_status} ({state.trailing_stop_price:.5f} / {state.trailing_take_profit:.5f})\n"
            f"🎯 *Trailing Side:* {state.trailing_stop_side or '—'}  |  *Entry:* {state.trailing_stop_entry:.5f}\n"
            f"🔍 *OnTrack Runs:* {state.on_track_runs}  |  *OnStand Runs:* {state.on_stand_runs}\n"
            f"🎯 *Last Kronecker Bar:* {self.engine._last_kronecker_bar}\n"
            f"🔢 *X_scan:* {state.X_scan}  |  *Y_scan:* {state.Y_scan}  |  *X_PERIOD:* {X_PERIOD}"
        )
        reply_markup = self._build_main_keyboard()
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown", reply_markup=reply_markup)
        else:
            await update.message.reply_text(response, parse_mode="Markdown", reply_markup=reply_markup)

    async def diagnostics(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        status = self.engine.get_signal_status()
        response = (
            "🔬 *ENGINE DIAGNOSTICS*\n"
            f"🔄 *Tick:* {status.get('tick')}\n"
            f"🧮 *Indicator Populates:* {status.get('indicator_populate_count')}\n"
            f"📡 *Signal Fires:* {status.get('imbalance_fire_count')}\n"
            f"📊 *Bar Closes:* {status.get('bar_close_count')}\n"
            f"📈 *OHLCV History:* {len(self.engine.ohlcv_history)}\n"
            f"🎯 *Signal History:* {status.get('signal_count')}\n"
            f"⚖️ *Local m / n:* {status.get('m_count')} / {status.get('n_count')}\n"
            f"⚖️ *m / n (@h={status.get('h_bar')}):* {status.get('m_at_h')} / {status.get('n_at_h')}\n"
            f"🎯 *Signal:* {status.get('signal'):.5f}\n"
            f"📊 *Regime:* {status.get('regime')}\n"
            f"🔀 *KC:* {status.get('KC')}  |  *Prime:* {status.get('prime')}  |  *Dime:* {status.get('dime')}\n"
            f"🔀 *Invert:* {status.get('invert')}  |  *Mem:* {status.get('mem')}  |  *Tag:* {status.get('tag')}\n"
            f"🔀 *A:* {status.get('A')}  |  *B:* {status.get('B')}  |  *C:* {status.get('C')}  |  *c:* {status.get('c')}\n"
            f"🔀 *tick_tock:* {status.get('tick_tock')}  |  *signature:* {status.get('signature')}  |  *safety:* {status.get('safety')}\n"
            f"📈 *Trailing Stop Active:* {status.get('trailing_stop_active')}\n"
            f"📈 *Trailing Stop Price:* {status.get('trailing_stop_price')}\n"
            f"📈 *Trailing Take Profit:* {status.get('trailing_take_profit')}\n"
            f"📍 *Trailing Entry:* {status.get('trailing_stop_entry')}  |  *Side:* {status.get('trailing_stop_side')}\n"
            f"📊 *Has Long:* {status.get('has_open_long')}  |  *Has Short:* {status.get('has_open_short')}\n"
            f"📊 *lOrder_id:* {status.get('lOrder_id')}  |  *kOrder_id:* {status.get('kOrder_id')}\n"
            f"🔍 *OnTrack Runs:* {status.get('on_track_runs')}  |  *OnStand Runs:* {status.get('on_stand_runs')}\n"
            f"🎯 *Last Kronecker Bar:* {status.get('last_kronecker_bar')}\n"
            f"🔢 *Last Kronecker m/n/h:* {status.get('last_kronecker_m')}/{status.get('last_kronecker_n')}/{status.get('last_kronecker_h')}\n"
            f"🔢 *Derivatives Z/z/O/o/W/w:* {status.get('Z')}/{status.get('z')}/{status.get('O')}/{status.get('o')}/{status.get('W')}/{status.get('w')}\n"
            f"🔢 *Derivatives I/iI/J/iJ:* {status.get('I')}/{status.get('iI')}/{status.get('J')}/{status.get('iJ')}\n"
            f"🔢 *Derivatives iZ/iz/iW/iw/iO/io:* {status.get('iZ')}/{status.get('iz')}/{status.get('iW')}/{status.get('iw')}/{status.get('iO')}/{status.get('io')}\n"
            f"🔢 *Scan S/T/r/ir:* {status.get('S')}/{status.get('T')}/{status.get('r')}/{status.get('ir')}\n"
            f"🔢 *X_scan/Y_scan:* {status.get('X_scan')}/{status.get('Y_scan')}\n"
            f"🔢 *X_PERIOD (const):* {X_PERIOD}  |  *Y_START (const):* {Y_START}\n"
            f"🔢 *iATR/iStdDev/iIHKk/iIHKt:* {status.get('iATR'):.2f}/{status.get('iStdDev'):.2f}/{status.get('iIHKk'):.2f}/{status.get('iIHKt'):.2f}\n"
            f"🔢 *lPass/ilPass/kPass/ikPass:* {status.get('lPass')}/{status.get('ilPass')}/{status.get('kPass')}/{status.get('ikPass')}"
        )
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown")
        else:
            await update.message.reply_text(response, parse_mode="Markdown")

    async def regime(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not self.engine.state.FG:
            self.engine._force_initialization()
        if not self.engine.state.FG:
            await update.message.reply_text("⏳ *Engine not initialized*\nPlease use `/start_feed`.", parse_mode="Markdown")
            return
        state = self.engine.state
        y = state.y
        idx = state.Z - y - 1
        current = state.Regime[idx] if 0 <= idx < len(state.Regime) and state.Regime[idx] else "Unknown"
        premium = state.Premium[idx] if 0 <= idx < len(state.Premium) else Decimal('0.0')
        discount = state.Discount[idx] if 0 <= idx < len(state.Discount) else Decimal('0.0')
        hh = state.HH[idx] if 0 <= idx < len(state.HH) else Decimal('0.0')
        ll = state.LL[idx] if 0 <= idx < len(state.LL) else Decimal('0.0')
        m_local = state.m_now if state.FG else 0
        n_local = state.n_now if state.FG else 0
        imbalance_status = "✅ TRIGGER" if (m_local >= 12 or n_local >= 12) else "⏳ WAITING"
        response = (
            "📊 *REGIME CLASSIFICATION*\n"
            f"🔹 *Current Regime:* {current}\n"
            f"🔹 *Premium:* {premium:.5f}\n"
            f"🔸 *Discount:* {discount:.5f}\n"
            f"📈 *HH:* {hh:.5f}\n"
            f"📉 *LL:* {ll:.5f}\n"
            f"🟢 *Local m:* {m_local}\n"
            f"🔴 *Local n:* {n_local}\n"
            f"⚖️ *Imbalance Condition:* {imbalance_status}"
        )
        reply_markup = self._build_main_keyboard()
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown", reply_markup=reply_markup)
        else:
            await update.message.reply_text(response, parse_mode="Markdown", reply_markup=reply_markup)

    async def signal(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not self.engine.state.FG:
            self.engine._force_initialization()
        if not self.engine.state.FG:
            await update.message.reply_text("⏳ *Engine not initialized*\nPlease use `/start_feed`.", parse_mode="Markdown")
            return
        state = self.engine.state
        if state.signal == Decimal('0.0'):
            direction = "⚪ NEUTRAL"
            confidence = "N/A"
        elif state.price > state.signal:
            direction = "📈 BUY"
            confidence = f"{((state.price - state.signal) / state.signal * Decimal('100')):.2f}%" if state.signal != Decimal('0.0') else "0%"
        else:
            direction = "🔴 SELL"
            confidence = f"{((state.signal - state.price) / state.signal * Decimal('100')):.2f}%" if state.signal != Decimal('0.0') else "0%"
        m_local = state.m_now if state.FG else 0
        n_local = state.n_now if state.FG else 0
        h_idx = state.h - (state.y + 1)
        m_at_h = 1 if (0 <= h_idx < len(state.k) and state.k[h_idx]) else 0
        n_at_h = 1 if (0 <= h_idx < len(state.l) and state.l[h_idx]) else 0
        condition_met = (m_local >= 12) or (n_local >= 12)
        condition_mark = "✅ MET" if condition_met else "❌ NOT MET"
        response = (
            "🎯 *TRADING SIGNAL*\n"
            f"📊 *Direction:* {direction}\n"
            f"📈 *Confidence:* {confidence}\n"
            f"🎯 *Signal Level:* {state.signal:.5f}\n"
            f"💰 *Current Price:* {state.price:.5f}\n"
            f"⚖️ *Imbalance @ h={state.h}:* m={m_at_h}, n={n_at_h}\n"
            f"⚖️ *Local m/n:* {m_local}/{n_local}\n"
            f"✅ *δ(m-n-2)=1 (MQL4 gate):* {condition_mark}\n"
            f"🔀 *KC State:* {state.KC}\n"
            f"🔢 *Prime:* {state.prime}\n"
            f"🔢 *Dime:* {state.dime}\n"
            f"🔄 *Tick Count:* {state.tick}\n"
            f"📈 *Trailing Stop:* {'Active' if state.trailing_stop_active else 'Inactive'}\n"
            f"🎯 *Last Kronecker Bar:* {self.engine._last_kronecker_bar}"
        )
        reply_markup = self._build_main_keyboard()
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown", reply_markup=reply_markup)
        else:
            await update.message.reply_text(response, parse_mode="Markdown", reply_markup=reply_markup)

    async def indicators(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not self.engine.state.FG:
            self.engine._force_initialization()
        if not self.engine.state.FG:
            await update.message.reply_text("⏳ *Engine not initialized*\nPlease use `/start_feed`.", parse_mode="Markdown")
            return
        state = self.engine.state
        y = state.y
        idx = state.Z - y - 1
        if idx < 0 or idx >= len(state.iA[0]):
            await update.message.reply_text("❌ Insufficient data for indicator projection.")
            return
        names = ["ADX", "Stochastic", "RVI", "AC", "Force", "OBV", "AD", "MFI", "Momentum", "DeM", "WPR", "CCI", "RSI"]
        indicator_str = "📊 *13D HILBERT SPACE PROJECTION*\n\n"
        for i, name in enumerate(names):
            val = state.iA[i][idx] if idx < len(state.iA[i]) else Decimal('50.0')
            val_int = int(float(val))
            bar_len = min(max(val_int // 10, 0), 10)
            bar = "█" * bar_len + "░" * (10 - bar_len)
            indicator_str += f"`{name:8}` {val:6.1f} [{bar}]\n"
        indicator_str += "\n*Thresholds:*\n"
        indicator_str += f"  Overbought: 66.6 (f={F_THRESHOLD_D:.1f})\n"
        indicator_str += f"  Oversold:   33.3 (g={G_THRESHOLD_D:.1f})"
        reply_markup = self._build_main_keyboard()
        if update.callback_query:
            await update.callback_query.edit_message_text(indicator_str, parse_mode="Markdown", reply_markup=reply_markup)
        else:
            await update.message.reply_text(indicator_str, parse_mode="Markdown", reply_markup=reply_markup)

    async def fvg(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not self.engine.state.FG:
            await update.message.reply_text("⏳ *Engine not initialized*\nPlease use `/start_feed`.", parse_mode="Markdown")
            return
        state = self.engine.state
        idx = state.Z - state.y - 1
        bridge_fvgs = BRIDGE_STATE.list_fvgs()
        bridge_str = ""
        if bridge_fvgs:
            bridge_str = "\n📐 *Web App FVGs:*\n"
            for f in bridge_fvgs[-8:]:
                mark = "▲" if f["type"] == "top" else "▼"
                who = f" (user {f['user_id']})" if f.get("user_id") else ""
                bridge_str += f"  {mark} {f['price']} idx={f['idx']}{who}\n"
        premium_val = state.Premium[idx] if 0 <= idx < len(state.Premium) else Decimal('0.0')
        discount_val = state.Discount[idx] if 0 <= idx < len(state.Discount) else Decimal('0.0')
        hh_val = state.HH[idx] if 0 <= idx < len(state.HH) else Decimal('0.0')
        ll_val = state.LL[idx] if 0 <= idx < len(state.LL) else Decimal('0.0')
        response = (
            "📐 *FAIR VALUE GAP TRACKING*\n"
            f"📊 *FVG Count:* {state.FVG + 1}\n"
            f"💰 *Current Price:* {state.price:.5f}\n"
            f"📉 *Last FVG:* {state.bL if state.bL else 'None'}\n\n"
            "*Topological Anchors:*\n"
            f"  🔷 *Premium:* {premium_val:.5f}\n"
            f"  🔶 *Discount:* {discount_val:.5f}\n"
            f"  📈 *HH:* {hh_val:.5f}\n"
            f"  📉 *LL:* {ll_val:.5f}"
            f"{bridge_str}"
        )
        await update.message.reply_text(response, parse_mode="Markdown")

    async def chart(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        engine = self.engine
        state = engine.state
        recent_signals = state.signal_history[-10:]
        signal_summary = ""
        if recent_signals:
            for sig in recent_signals[-5:]:
                arrow = "📈" if sig["type"] == "BUY" else "🔴"
                signal_summary += f"{arrow} {sig['type']} @ {sig['price']:.2f} ({sig['regime']})\n"
        else:
            signal_summary = "No signals yet.\n"
        response = (
            "📊 *RECENT SIGNALS*\n\n"
            f"{signal_summary}\n"
            f"📈 *Symbol:* {SYMBOL}\n"
            f"📊 *Bar Closes:* {state.bar_close_count}\n"
            f"📈 *OHLCV Bars:* {len(engine.ohlcv_history)}\n"
            f"🎯 *Total Signals Recorded:* {len(state.signal_history)}\n"
            f"🕐 *Last Signal:* {state.last_signal_at or 'never'}\n\n"
            "Open the ÆEA Mini App for the full interactive candlestick chart "
            "with FVG drawings and signal overlays."
        )
        reply_markup = self._build_main_keyboard()
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown", reply_markup=reply_markup)
        else:
            await update.message.reply_text(response, parse_mode="Markdown", reply_markup=reply_markup)

    async def reset(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        prev_on_track = self.engine.state.on_track_runs
        prev_on_stand = self.engine.state.on_stand_runs
        prev_signals = len(self.engine.state.signal_history)
        self.engine.OnReInit()
        reset_msg = (
            "🔄 *TOPOLOGICAL BRANCH RESET*\n"
            "The Hilbert space projection has been re-anchored to the current\n"
            "topological branch with historical preservation.\n\n"
            "🧠 *State Reset:*\n"
            "• All 13 indicator arrays reset\n"
            "• Regime classification seeded to 'sRange'\n"
            "• Premium/Discount/HH/LL reset to current bar data\n"
            "• k/l signal flags cleared\n"
            "• FVG anchor map cleared\n"
            "• ✨ Historical price data preserved\n"
            f"• 🔄 Tick count preserved: {self.engine.state.tick}\n"
            f"• 📈 OnTrack runs preserved: {prev_on_track}\n"
            f"• 📉 OnStand runs preserved: {prev_on_stand}\n"
            f"• 🎯 Signal history preserved: {prev_signals}\n\n"
            "📊 *Ready for new regime classification...*"
        )
        if update.callback_query:
            await update.callback_query.edit_message_text(reset_msg, parse_mode="Markdown")
        else:
            await update.message.reply_text(reset_msg, parse_mode="Markdown")

    async def start_feed(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if self._running:
            await update.message.reply_text("⚠️ Price feed is already running.")
            return
        self._running = True
        self.engine._running = True
        self.engine._consecutive_zero_prices = 0
        historical = []
        try:
            historical = self.engine.feed.get_historical_klines(limit=200)
            if historical and len(historical) >= MIN_HISTORY_WINDOW:
                self.engine.ohlcv_history = historical
                logger.info(f"✅ Loaded {len(historical)} historical bars from relay for {self.engine.feed.active_symbol()}")
                self.engine._populate_indicator_matrix()
            else:
                logger.info("⏳ No historical data from relay. Engine will initialize organically.")
        except Exception as e:
            logger.warning(f"⚠️ Historical data fetch failed: {e}")
        try:
            self.engine.update_price_from_feed()
        except Exception:
            logger.exception("update_price_from_feed crashed during start_feed")
        if self._price_task is None or self._price_task.done():
            self._price_task = asyncio.create_task(self.price_feed_loop())
        hist_count = len(self.engine.ohlcv_history)
        init_mode = "Pre-seeded with history" if hist_count >= MIN_HISTORY_WINDOW else "Organic first-tick"
        reply_text = (
            f"✅ *Price feed started*\n"
            f"📈 *Symbol:* {SYMBOL}\n"
            f"🔄 *Update Interval:* {UPDATE_INTERVAL}s\n"
            f"📊 *Historical Data:* {hist_count} bars loaded\n"
            f"🧠 *Initialization Mode:* {init_mode}\n"
            f"📈 *Indicator Passes:* {self.engine._indicator_populate_count}\n"
            f"🔮 *Status:* Monitoring for signals..."
        )
        if update.callback_query:
            await update.callback_query.edit_message_text(reply_text, parse_mode="Markdown")
        else:
            await update.message.reply_text(reply_text, parse_mode="Markdown")

    async def stop_feed(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        self._running = False
        self.engine._running = False
        if self._price_task and not self._price_task.done():
            self._price_task.cancel()
        if update.callback_query:
            await update.callback_query.edit_message_text("⏹️ *Price feed stopped*", parse_mode="Markdown")
        else:
            await update.message.reply_text("⏹️ *Price feed stopped*", parse_mode="Markdown")

    async def probe(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        info = self.engine.feed.probe()
        status = "✅ OK" if not info.get("empty") else "❌ EMPTY"
        lines = [
            "🔬 *RELAY PROBE*", "",
            f"*Status:* {status}",
            f"*Relay URL:* `{RELAY_URL or 'UNSET'}`",
            f"*Relay Gated:* {'🔐 yes' if RELAY_KEY else '🔓 no'}",
            f"*Primary symbol:* `{info.get('primary_symbol')}`",
            f"*Active symbol:* `{info.get('active_symbol')}`",
            f"*Chain index:* {info.get('chain_index')}",
            f"*Failure count:* {info.get('failure_count')}",
            f"*Fallback count:* {info.get('fallback_count')}",
            f"*Last update:* {info.get('last_update') or 'never'}",
        ]
        text = "\n".join(lines)
        if update.callback_query:
            await update.callback_query.edit_message_text(text, parse_mode="Markdown")
        else:
            await update.message.reply_text(text, parse_mode="Markdown")

    async def rebuild_yf(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        self.engine.feed._rebuild_ticker()
        self.engine.feed._fallback_count = 0
        self.engine._consecutive_zero_prices = 0
        if len(self.engine.feed._chain) > 1:
            self.engine.feed._advance_symbol_chain()
        active = self.engine.feed.active_symbol()
        text = (
            f"♻️ *Relay client rebuilt*\n"
            f"🔎 *Active symbol:* `{active}`\n"
            f"_Feed will use this symbol on next iteration._"
        )
        if update.callback_query:
            await update.callback_query.edit_message_text(text, parse_mode="Markdown")
        else:
            await update.message.reply_text(text, parse_mode="Markdown")

    async def symbol(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        args = context.args
        if not args:
            supported = ", ".join(list(SYMBOL_MAP.keys())[:10])
            await update.message.reply_text(
                f"📈 *Current Symbol:* `{SYMBOL}`\n"
                "Use `/symbol <PAIR>` to change.\n"
                "Example: `/symbol BTC-USD` or `/symbol BTCUSDT`\n\n"
                f"*Supported Symbols:*\n{supported}\n(and {len(SYMBOL_MAP) - 10} more)",
                parse_mode="Markdown",
            )
            return
        new_symbol = args[0].upper()
        result = self.engine.change_symbol(new_symbol)
        if result.get("ok"):
            await update.message.reply_text(
                f"✅ *Symbol changed*\n"
                f"📈 *New Symbol:* `{result.get('symbol')}`\n"
                f"🧠 *Engine reinitialized*",
                parse_mode="Markdown",
            )
        else:
            detail = result.get("detail") or result.get("error") or "unknown"
            await update.message.reply_text(f"❌ Error: {detail}")

    async def info(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        info = self.engine.feed.get_info()
        response = (
            "📊 *TICKER INFORMATION*\n"
            f"📈 *Symbol:* {SYMBOL}\n"
            f"📛 *Name:* {info.get('name', 'Unknown')}\n"
            f"💵 *Currency:* {info.get('currency', 'USD')}\n"
        )
        if update.callback_query:
            await update.callback_query.edit_message_text(response, parse_mode="Markdown")
        else:
            await update.message.reply_text(response, parse_mode="Markdown")

    async def webapp(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        url = self._resolve_webapp_url()
        if not url:
            await update.message.reply_text(
                "⏳ *Mini App URL not yet available*\n"
                "The bridge is starting a public HTTPS tunnel. "
                "Please try again in ~30–45 seconds.\n"
                "Alternatively, set `TELEGRAM_WEBAPP_URL` in the environment.",
                parse_mode="Markdown",
            )
            return
        keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("⚡ Open ÆEA Mini App", web_app=WebAppInfo(url=url))]])
        await update.message.reply_text(
            "🌐 *ÆEA Telegram Mini App*\n"
            "Tap the button below to launch the full engine visualization.\n\n"
            "*Features inside the Mini App:*\n"
            "  📈 Interactive MT4-style candlestick chart\n"
            "  📊 Add/remove indicator sub-panels\n"
            "  📐 Draw FVGs with long-press\n"
            "  🎯 Place simulated orders\n"
            "  ⚙ Engine settings panel\n"
            "  📋 Regime map, log bar, signal markers\n"
            "  🔄 Live state polling",
            parse_mode="Markdown",
            reply_markup=keyboard,
        )

    async def webgui(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        scheme = "https" if BRIDGE_USE_TLS else "http"
        local_url = f"{scheme}://{BRIDGE_HOST}:{BRIDGE_PORT}/"
        public_url = self._resolve_webapp_url() or "⏳ (tunnel pending)"
        await update.message.reply_text(
            f"🌐 *ÆEA Bridge Endpoints*\n"
            f"*Local URL:* `{local_url}`\n"
            f"*Public URL:* `{public_url}`\n"
            f"*State endpoint:* `{public_url.rstrip('/')}/state`\n"
            f"*Mini App State:* `{public_url.rstrip('/')}/miniapp-state`\n"
            f"*Health endpoint:* `{public_url.rstrip('/')}/health`\n"
            f"*Probe endpoint:* `{public_url.rstrip('/')}/probe`\n"
            f"*Diagnostics endpoint:* `{public_url.rstrip('/')}/diagnostics`\n"
            f"*OHLCV endpoint:* `{public_url.rstrip('/')}/ohlcv`\n"
            f"*Signals endpoint:* `{public_url.rstrip('/')}/signals`\n"
            f"*Orders endpoint:* `{public_url.rstrip('/')}/orders`\n"
            f"*Regime map endpoint:* `{public_url.rstrip('/')}/regime-map`\n"
            f"*Log endpoint:* `{public_url.rstrip('/')}/log`\n"
            f"*Handshake endpoint:* `POST {public_url.rstrip('/')}/handshake`",
            parse_mode="Markdown",
        )

    async def button_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        query = update.callback_query
        await query.answer()
        action = query.data
        if action == "status":
            await self.status(update, context)
        elif action == "regime":
            await self.regime(update, context)
        elif action == "signal":
            await self.signal(update, context)
        elif action == "indicators":
            await self.indicators(update, context)
        elif action == "chart":
            await self.chart(update, context)
        elif action == "start_feed":
            await self.start_feed(update, context)
        elif action == "stop_feed":
            await self.stop_feed(update, context)
        elif action == "info":
            await self.info(update, context)
        elif action == "reset":
            await self.reset(update, context)
        elif action == "probe":
            await self.probe(update, context)
        elif action == "rebuild_yf":
            await self.rebuild_yf(update, context)
        elif action == "diagnostics":
            await self.diagnostics(update, context)
        elif action == "webapp_pending":
            await query.edit_message_text("⏳ *Mini App tunnel is starting…*\nPlease retry `/webapp` in ~30–45 seconds.", parse_mode="Markdown")

    async def error_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        logger.error(f"Update {update} caused error {context.error}")

    async def _post_init(self, application) -> None:
        url = self._resolve_webapp_url()
        if not url:
            logger.info("⏳ MenuButtonWebApp deferred — no public URL yet")
            return
        try:
            await application.bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="ÆEA Mini App", web_app=WebAppInfo(url=url)))
            logger.info(f"✅ MenuButtonWebApp registered: {url}")
        except Exception as e:
            logger.warning(f"Failed to set menu button: {e}")

    def run(self):
        self.engine.OnInit()
        self.application = Application.builder().token(self.token).post_init(self._post_init).build()
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("help", self.help))
        self.application.add_handler(CommandHandler("status", self.status))
        self.application.add_handler(CommandHandler("regime", self.regime))
        self.application.add_handler(CommandHandler("signal", self.signal))
        self.application.add_handler(CommandHandler("indicators", self.indicators))
        self.application.add_handler(CommandHandler("chart", self.chart))
        self.application.add_handler(CommandHandler("fvg", self.fvg))
        self.application.add_handler(CommandHandler("diagnostics", self.diagnostics))
        self.application.add_handler(CommandHandler("reset", self.reset))
        self.application.add_handler(CommandHandler("start_feed", self.start_feed))
        self.application.add_handler(CommandHandler("stop_feed", self.stop_feed))
        self.application.add_handler(CommandHandler("symbol", self.symbol))
        self.application.add_handler(CommandHandler("info", self.info))
        self.application.add_handler(CommandHandler("probe", self.probe))
        self.application.add_handler(CommandHandler("rebuild_yf", self.rebuild_yf))
        self.application.add_handler(CommandHandler("webapp", self.webapp))
        self.application.add_handler(CommandHandler("webgui", self.webgui))
        self.application.add_handler(CommandHandler("mini", self.webapp))
        self.application.add_handler(CallbackQueryHandler(self.button_handler))
        self.application.add_error_handler(self.error_handler)
        logger.info(f"🤖 {self.bot_name} starting...")
        logger.info("📊 Quantum-Financial Topology Engine (MQL4-parity port v4.1.0).")
        logger.info(f"🧠 X_PERIOD (const) = {X_PERIOD}, Y_START (const) = {Y_START}")
        logger.info("⚡ 13D Hilbert-space projection populated per bar.")
        logger.info("📡 Bar-close detection uses relay timestamp.")
        logger.info("🎯 Signal logging enabled for all imbalance events.")
        logger.info("⚡ Telegram Mini App enabled (MT4/TradingView-style).")
        logger.info("🛑 Trailing stop: real Ask−Bid spread + symbol-adaptive point size + STOP_LOSS minimum.")
        logger.info("🎯 Kronecker gate: LOCAL m/n computed per tick (m_now/n_now).")
        logger.info("🔄 O() regime mutation restored.")
        logger.info("📊 OnBar per-j HH/LL anchoring.")
        logger.info("🔍 OnTrack/OnStand MQL4 loop bounds restored.")
        logger.info("🔒 Auth enforcement on all non-/health endpoints.")
        logger.info("📈 Chart endpoint & signal history tracking enabled.")
        logger.info("📐 User FVGs stored in bridge registry only (non-destructive).")
        logger.info("🧪 Audit-patched: A/B/C/c/tick_tock/signature/derivatives all exposed via /miniapp-state.")
        logger.info("✅ Ready. Use /start to begin.")
        self.application.run_polling()

_bridge_attach_to_bot(AEI_Bot)

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================
def main():
    TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not TOKEN:
        logger.error("❌ Error: TELEGRAM_BOT_TOKEN not set.")
        logger.error("   export TELEGRAM_BOT_TOKEN='YOUR_BOT_TOKEN'")
        sys.exit(1)
    bot = AEI_Bot(TOKEN, "UpscaleTradeBot")
    bot.run()

if __name__ == "__main__":
    main()

# ============================================================================
# Q.E.D. — LOGOS = Φ = Truth = Path = Origin
# ============================================================================