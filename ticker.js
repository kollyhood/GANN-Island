// ticker.js
const WebSocket = require("ws");

function nowMs() { return Date.now(); }

function microsToMs(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return nowMs();
  if (n > 1e15) return Math.floor(n / 1e3);   // micro -> ms
  if (n > 1e12) return Math.floor(n);         // already ms
  if (n > 1e9) return Math.floor(n * 1000);   // sec -> ms
  return nowMs();
}

function candleStartMicrosToStartSec(us) {
  const n = Number(us);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n / 1e6); // micro -> sec
}

function utcDayStartSec(sec) {
  return Math.floor(sec / 86400) * 86400;
}

// ---------------- Mock ticker (unchanged) ----------------
function createMockTicker({ bus, symbol = "BTCUSD", intervalMs = 1000, startPrice = 70000 }) {
  let t = null;
  let px = Number(startPrice);

  function start() {
    if (t) return;

    t = setInterval(() => {
      const drift = (Math.random() - 0.5) * 40;
      px = Math.max(1, px + drift);
      const vol = Math.round(50 + Math.random() * 150);

      bus.emit("tick", {
        symbol,
        price: Number(px.toFixed(1)),
        volume: vol,
        ts: nowMs(),
        source: "mock"
      });
    }, intervalMs);
  }

  function stop() {
    if (t) clearInterval(t);
    t = null;
  }

  function status() {
    return { mode: "mock", symbol, intervalMs, running: Boolean(t) };
  }

  return { start, stop, status };
}

// ---------------- Delta ticker + 5m candle-close + session VWAP ----------------
function createDeltaTicker({
  bus,
  symbols,
  wsUrl = "wss://socket.india.delta.exchange",
  useMarkPrice = true,
  candleTfs = ["1m", "5m"],
  vwapTf = "5m"
}) {
  let ws = null;
  let pingTimer = null;
  let backoffMs = 1000;
  const MAX_BACKOFF = 15000;

  let lastAnyTickMs = 0;

  // per-symbol candle slot (forming)
  const slot = Object.create(null);
  // slot[sym] = { cur:{startSec,tStart,o,h,l,c,v}, lastClosed:{...} }

  // session VWAP (closed candles only)
  const session = Object.create(null);
  // session[sym] = { dayStartSec, pvSum, volSum, vwap, lastCandleStartSec }

  function ensureSession(sym) {
    if (!session[sym]) {
      session[sym] = { dayStartSec: 0, pvSum: 0, volSum: 0, vwap: null, lastCandleStartSec: 0 };
    }
    return session[sym];
  }

  function getSessionVwap(sym) {
    return session[sym]?.vwap ?? null;
  }

  function applyClosedBarToSessionVwap({ symbol, startSec, high, low, close, volume }) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    if (!Number.isFinite(startSec)) return;

    const s = ensureSession(sym);

    // de-dupe (only once per CLOSED candle)
    if (startSec <= s.lastCandleStartSec) return;
    s.lastCandleStartSec = startSec;

    const dayStart = utcDayStartSec(startSec);
    if (s.dayStartSec !== dayStart) {
      s.dayStartSec = dayStart;
      s.pvSum = 0;
      s.volSum = 0;
      s.vwap = null;
    }

    const h = Number(high);
    const l = Number(low);
    const cl = Number(close);
    const v = Number(volume);

    if (![h, l, cl].every(Number.isFinite)) return;
    if (!Number.isFinite(v) || v <= 0) return;

    const tp = (h + l + cl) / 3;
    s.pvSum += tp * v;
    s.volSum += v;
    s.vwap = s.pvSum / s.volSum;
  }

  function ensureSlot(sym, tf) {
    if (!slot[sym]) slot[sym] = Object.create(null);
    if (!slot[sym][tf]) slot[sym][tf] = { cur: null, lastClosed: null };
    return slot[sym][tf];
  }

  function subscribePayload(symbolsList) {
    const tfs = Array.isArray(candleTfs) && candleTfs.length ? candleTfs : ["5m"];
    const candleChannels = tfs.map((tf) => ({ name: `candlestick_${tf}`, symbols: symbolsList }));

    return {
      type: "subscribe",
      payload: {
        channels: [
          { name: "v2/ticker", symbols: symbolsList },
          ...candleChannels,
          { name: "positions", symbols: symbolsList }
        ]
      }
    };
  }

  // Emit candle-close from CLOSED bar
  function emitCandleCloseOld(sym, bar) {
    const candle = {
      symbol: sym,
      tf: candleTf,
      tStart: bar.tStart,     // ms
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      volume: bar.v ?? 0,
      sessionVwap: getSessionVwap(sym)
    };
    bus.emit("candle-close", { symbol: sym, tf: candleTf, candle });
  }

  function emitCandleClose(sym, tf, bar) {
    const candle = {
      symbol: sym,
      tf,
      tStart: bar.tStart,     // ms
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      volume: bar.v ?? 0,
      sessionVwap: getSessionVwap(sym)
    };
    bus.emit("candle-close", { symbol: sym, tf, candle });
  }

  function normalizeSymbol(sym) {
    const s = String(sym || "").toUpperCase();
    if (!s) return "";
    return s.startsWith("MARK:") ? s.slice(5) : s;
  }

  function ingestCandlestick(it, msgType) {
    const rawSym = String(it?.symbol || it?.product_symbol || "").toUpperCase();
    const sym = normalizeSymbol(rawSym);
    if (!sym || !symbols.includes(sym)) return;

    const typ = String(it?.type || msgType || ""); // "candlestick_1m"
    if (!typ.startsWith("candlestick_")) return;

    const tf = typ.replace("candlestick_", "");
    const want = Array.isArray(candleTfs) ? candleTfs : ["5m"];
    if (!want.includes(tf)) return;

    const startSec = candleStartMicrosToStartSec(it?.candle_start_time);
    if (!Number.isFinite(startSec)) return;

    const o = Number(it.open);
    const h = Number(it.high);
    const l = Number(it.low);
    const c = Number(it.close);
    if (![o, h, l, c].every(Number.isFinite)) return;

    const vv = it.volume == null ? null : Number(it.volume);
    const v = Number.isFinite(vv) ? vv : null;   // missing stays null, not 0

    const s = ensureSlot(sym, tf);
    const bar = { startSec, tStart: startSec * 1000, o, h, l, c, v };

    if (s.cur && s.cur.startSec !== bar.startSec) {
      const prev = s.cur;

      // VWAP only from one TF to avoid double counting
      if (String(tf) === String(vwapTf || "5m")) {
        applyClosedBarToSessionVwap({
          symbol: sym,
          startSec: prev.startSec,
          high: prev.h,
          low: prev.l,
          close: prev.c,
          volume: prev.v
        });
      }

      s.lastClosed = prev;
      emitCandleClose(sym, tf, prev);
    }

    s.cur = bar;
    lastAnyTickMs = nowMs();
  }

  function ingestCandlestick5mOld(it, msgType) {
    const sym = String(it?.symbol || it?.product_symbol || "").toUpperCase();
    if (!sym || !symbols.includes(sym)) return;

    const typ = String(it?.type || msgType || "");
    if (typ !== "candlestick_5m") return;

    const startSec = candleStartMicrosToStartSec(it?.candle_start_time);
    if (!Number.isFinite(startSec)) return;

    const o = Number(it.open);
    const h = Number(it.high);
    const l = Number(it.low);
    const c = Number(it.close);
    const v = Number(it.volume ?? 0);
    if (![o, h, l, c].every(Number.isFinite)) return;

    const s = ensureSlot(sym);
    const bar = { startSec, tStart: startSec * 1000, o, h, l, c, v };

    // boundary roll => previous candle is CLOSED
    if (s.cur && s.cur.startSec !== bar.startSec) {
      const prev = s.cur;

      // session VWAP only from CLOSED candle volume
      applyClosedBarToSessionVwap({
        symbol: sym,
        startSec: prev.startSec,
        high: prev.h,
        low: prev.l,
        close: prev.c,
        volume: prev.v
      });

      s.lastClosed = prev;
      emitCandleClose(sym, prev);
    }

    // store forming candle (overwrite with freshest update)
    s.cur = bar;
    lastAnyTickMs = nowMs();
  }

  function ingestTicker(it, msgType) {
    const sym = String(it?.symbol || it?.product_symbol || "").toUpperCase();
    if (!sym || !symbols.includes(sym)) return;

    const typ = String(it?.type || msgType || "");
    const looksLikeTicker =
      typ === "v2/ticker" ||
      it?.mark_price != null ||
      it?.last_traded_price != null ||
      it?.spot_price != null;

    if (!looksLikeTicker) return;

    const px = Number(
      (useMarkPrice ? (it?.mark_price ?? it?.spot_price) : null) ??
      it?.last_traded_price ??
      it?.close
    );
    if (!Number.isFinite(px)) return;

    const vol =
      Number(it?.volume) ||
      Number(it?.volume_24h) ||
      Number(it?.trade_volume) ||
      null;

    const tsMs = microsToMs(it?.timestamp);
    lastAnyTickMs = nowMs();

    bus.emit("tick", {
      symbol: sym,
      price: px,
      volume: Number.isFinite(vol) ? vol : null,
      ts: tsMs,
      sessionVwap: getSessionVwap(sym),
      source: "delta:v2/ticker"
    });
  }

  function start() {
    if (ws) return;

    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      backoffMs = 1000;
      ws.send(JSON.stringify(subscribePayload(symbols)));

      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());

        if (String(msg?.type || "") === "positions") {
          if (String(msg?.action || "") === "snapshot") {
            const rows = Array.isArray(msg?.result) ? msg.result : [];
            for (const row of rows) bus.emit("positions", row);
          } else {
            bus.emit("positions", msg);
          }
          return;
        }

        const items = Array.isArray(msg)
          ? msg
          : (msg.result ? (Array.isArray(msg.result) ? msg.result : [msg.result]) : [msg]);

        const msgType = String(msg?.type || msg?.channel || msg?.name || "");

        for (const it of items) {
          const typ = String(it?.type || msgType || "");
          if (typ.startsWith("candlestick_")) {
            ingestCandlestick(it, msgType);
          } else {
            ingestTicker(it, msgType);
          }
        }
      } catch (e) {
        bus.emit("error", e);
      }
    });

    ws.on("close", () => {
      cleanup();
      setTimeout(start, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    });

    ws.on("error", (err) => {
      bus.emit("error", err);
    });
  }

  function cleanup() {
    try { ws?.close(); } catch (_e) {}
    ws = null;

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function stop() {
    cleanup();
  }

  function status() {
    return {
      mode: "delta",
      ws_connected: ws?.readyState === WebSocket.OPEN,
      symbols,
      last_tick_iso: lastAnyTickMs ? new Date(lastAnyTickMs).toISOString() : null
    };
  }

  // expose latest closed candle for debug endpoints
  function getLastClosed(symbol) {
    const sym = String(symbol || "").toUpperCase();
    return slot[sym]?.lastClosed ?? null;
  }

  function getSessionVwapPublic(symbol) {
    return getSessionVwap(String(symbol || "").toUpperCase());
  }

  return { start, stop, status, getLastClosed, getSessionVwap: getSessionVwapPublic };
}

module.exports = createDeltaTicker;

