# TradingKriya Service — Supported Endpoints

Base URL (prod example): `https://tradingkriya-production.up.railway.app`

This document describes the HTTP endpoints exposed by the TradingKriya service (Railway-hosted Node + Express), and which ones require the **daily broker login act**.

---

## Concepts & Parameters

### `tk` (token)
Many endpoints accept `?tk=<TOKEN>` (example: `8080`). This is the broker “token / instrument id” you subscribed to.

### `ts` (cache-buster)
Your UI appends `?ts=<epoch_ms>` to avoid caching. The server can ignore it.

### CORS
The server is intended to be called from your WordPress domain (e.g. `https://investingkriya.in`).  
CORS preflight must allow:
- Methods: `GET, POST, OPTIONS`
- Headers: `Content-Type, X-IK-Key` (if you use key auth)

### Optional API Key (recommended)
Sensitive actions like `/broker/login` should be protected by an API key header:
- Header: `X-IK-Key: <your_key>`
- Server env: `IK_KEY=<your_key>`

> ⚠️ Never commit secrets (keys, broker creds, TOTP secrets) to GitHub.

---

## Login Behavior Summary

There are three categories of endpoints:

### 1) Always responds (no broker login needed)
These are service liveness + introspection endpoints. They should respond even before login.

### 2) Responds but returns “empty / not-ready” before login
These depend on **live ticks** (websocket + subscription). Until the daily login is done, they return placeholders like:
- `hasQuote:false`
- `hasVwap:false`
- `current:null`, `lastClosed:null`

### 3) Requires login act (POST)
`/broker/login` triggers TOTP generation + broker login + websocket subscribe.

---

## Endpoint Catalog

| Method | Path | Needs Broker Login? | Needs X-IK-Key? | Purpose |
|---|---|---:|---:|---|
| GET | `/` | No | No | Basic liveness (“OK”) |
| GET | `/health` | No | No | Healthcheck for Railway / uptime |
| GET | `/status` | No | No | Alias of `/health` (compat) |
| GET | `/broker/status` | No | No | Broker state: logged in today? WS connected? errors? |
| GET | `/global/silver` | No | No | Global silver quote from Delta Exchange market-data provider |
| POST | `/broker/login` | **Yes (performs it)** | **Recommended** | Daily login act (TOTP server-side), ensures WS + subscribe |
| GET | `/debug/parsed?tk=...` | Live data needed | No | Latest quote parsed into UI-friendly fields |
| GET | `/debug/vwap?tk=...` | Live data needed | No | Rolling “VWAP” + 1σ bands (currently mean/stdev) |
| GET | `/debug/candle?tk=...` | Live data needed | No | Current + last-closed 5m candle from ticks |
| GET | `/paper/status?tk=...` | Maybe* | No | Paper trading status (if enabled) |
| GET | `/paper/trades?limit=10` | Maybe* | No | Recent paper trades (if enabled) |

\*Paper endpoints can work without broker login if your paper engine is independent of live ticks. If paper uses live prices, it will show “idle” until login.

---

## Endpoint Details

## `GET /global/silver`
Returns latest cached global silver market quote sourced from Delta Exchange public ticker feed.

Query params:
- `refresh=1` (optional): force a synchronous ticker refresh before returning.

Example response:
```json
{
  "ok": true,
  "hasQuote": true,
  "provider": "delta",
  "symbol": "SILVERUSD",
  "ltp": 32.91,
  "tsMs": 1738751702000,
  "receivedAtMs": 1738751702100,
  "health": {
    "enabled": true,
    "running": true,
    "pollMs": 5000,
    "ageSec": 1
  }
}
```

## `GET /`
## Multi-source Silver Market Engine Endpoints

These endpoints normalize and combine three feeds in-memory for day-trading analysis:
- Global silver (`source: global`, symbol `XAGUSD` or configured symbol)
- MCX current month silver futures (`source: shoonya`, token symbol)
- SILVERBEES ETF (`source: NSE`, symbol `SILVERBEES`)

All responses are polling-safe JSON and include `ok` plus stable payload shapes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/feeds/latest` | Latest normalized tick for global/futures/etf |
| GET | `/ticks/latest?market=global|futures|etf` | Latest + previous snapshot for one market |
| GET | `/oi/latest` | Current/previous MCX OI and delta fields |
| GET | `/oi/state` | MCX OI regime (`LONG_BUILDUP`, etc.) |
| GET | `/signals/leader` | Leader-style directional summary |
| GET | `/signals/divergence` | Alignment and ETF lag/lead diagnostics |
| GET | `/signals/composite` | Explainable combined bias + confidence |
| GET | `/signals/5m` | Latest closed 5-minute bar signal + regime |
| GET | `/signals/5m/history?limit=10` | Recent closed 5-minute bars |
| GET | `/signals/5m/current` | In-progress current 5-minute bucket (non-final) |
| GET | `/debug/5m` | Current open bucket + last closed + recent closed bars |
| GET | `/debug/market` | Full in-memory market state snapshot |

### `GET /feeds/latest`
```json
{
  "ok": true,
  "feeds": {
    "global": {
      "source": "global",
      "symbol": "SLVONUSD",
      "price": 32.91,
      "ts": 1773379937000,
      "receivedAt": 1773379938225
    },
    "futures": {
      "source": "shoonya",
      "symbol": "MCX|466029",
      "price": 92125,
      "volume": 1234,
      "oi": 50533,
      "ts": 1773379937000,
      "receivedAt": 1773379938225
    },
    "etf": {
      "source": "NSE",
      "symbol": "SILVERBEES",
      "price": 89.42,
      "volume": 341223,
      "ts": 1773379937000,
      "receivedAt": 1773379938225
    }
  },
  "ts": 1773379938225
}
```

### `GET /oi/latest`
```json
{
  "ok": true,
  "oi": {
    "symbol": "MCX|466029",
    "current": 50533,
    "previous": 50480,
    "delta": 53,
    "deltaPct": 0.105,
    "ts": 1773379937000
  }
}
```

### `GET /signals/composite`
```json
{
  "ok": true,
  "composite": {
    "bias": "BULLISH",
    "confidence": 0.76,
    "drivers": [
      "Global silver up",
      "MCX futures up",
      "OI rising or covering supports upside",
      "ETF lagging behind futures"
    ]
  },
  "ts": 1773379937000
}
```

### `GET /signals/5m`
```json
{
  "ok": true,
  "signal5m": {
    "barState": "BULLISH",
    "regime": "STRENGTHENING_BULLISH",
    "score": 0.68,
    "regimeScore": 0.54,
    "inputs": {
      "priceMove": 84,
      "oiMove": 126,
      "bullTickPct": 0.64,
      "bearTickPct": 0.21,
      "closeLocation": 0.82,
      "tickCount": 142
    },
    "note": "MCX closed strong with rising OI and positive tick persistence",
    "tStart": 1773380700000,
    "tEnd": 1773380999999
  },
  "ts": 1773381000000
}
```

### `GET /signals/5m/history?limit=10`
```json
{
  "ok": true,
  "bars": [
    {
      "tStart": 1773380700000,
      "tEnd": 1773380999999,
      "barState": "BULLISH",
      "score": 0.68,
      "priceMove": 84,
      "oiMove": 126,
      "tickCount": 142
    }
  ],
  "ts": 1773381000000
}
```

### `GET /debug/5m`
```json
{
  "ok": true,
  "currentBucket": {
    "tStart": 1773381000000,
    "tEnd": 1773381299999,
    "tickCount": 27
  },
  "lastClosedBar": {
    "tStart": 1773380700000,
    "tEnd": 1773380999999,
    "barState": "BULLISH",
    "score": 0.68
  },
  "recentBars": [
    {
      "tStart": 1773380700000,
      "tEnd": 1773380999999,
      "barState": "BULLISH",
      "score": 0.68,
      "priceMove": 84,
      "oiMove": 126,
      "tickCount": 142
    }
  ],
  "ts": 1773381000000
}
```

If data is not yet ready, endpoints return `ok:false` with a useful `message` and HTTP `503`.

Simple liveness probe response:
```json
"OK"
```
