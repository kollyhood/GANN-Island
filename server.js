const express = require("express");
const EventEmitter = require("events");
const cors = require("cors");
const Api = require("./lib/RestApi");
const getAuthParams  = require("./cred.js");

//const { createDeltaTicker } = require("./ticker.js");
const createDeltaTicker = require("./ticker.js");
const generateTotp = require("./totpgenerator");
const { createMarketState } = require("./market_state");
const { createMarketRouter } = require("./market_routes");
const { createFiveMinEngine } = require("./five_min_engine");
const { createSignal5mRouter } = require("./signal_5m_routes");

const app = express();
const bus = new EventEmitter();
const api = new Api({});

const PORT = Number(process.env.PORT || 3000);
const TOTP_SECRET = process.env.TOTP_SECRET || 'LRYDI6VPT5336HX44RYO4P4QQ75W4LNZ';

const runtime = {
  startedAt: Date.now(),
  nseConnected: false,
  deltaStarted: false,
  shoonyaLoggedIn: false,
  lastError: null,
  latestBySource: {
    delta: null,
    nse: null,
    shoonya: null
  },
  pooledTicks: [],
  maxPoolSize: 200
};

const marketState = createMarketState({
  globalSymbol: process.env.GLOBAL_SILVER_SYMBOL || "SLVONUSD",
  futuresSymbol: process.env.MCX_SILVER_SYMBOL || "MCX|466029",
  etfSymbol: process.env.SILVERBEES_SYMBOL || "NSE|8080",
  etfName: process.env.SILVERBEES_NAME || "SILVERBEES"
});

const fiveMinEngine = createFiveMinEngine({ maxBars: 50 });

function nowMs() {
  return Date.now();
}

function toNum(x) {
  const n = Number(x);
  if (Number.isFinite(n)) return n;
  return null;
}

function pushUnifiedTick(tick) {
  runtime.pooledTicks.push(tick);

  if (runtime.pooledTicks.length > runtime.maxPoolSize) {
    runtime.pooledTicks.shift();
  }

  if (tick.source === "delta") {
    runtime.latestBySource.delta = tick;
  }

  if (tick.source === "nse") {
    runtime.latestBySource.nse = tick;
  }

  if (tick.source === "shoonya") {
    runtime.latestBySource.shoonya = tick;
  }

  const ingestion = marketState.ingestTick(tick);

  if (ingestion) {
    fiveMinEngine.ingestTick({
      market: ingestion.market,
      tick: ingestion.tick,
      feeds: marketState.getFeedsLatest(),
      snapshots: {
        global: marketState.getMarketSnapshots("global"),
        futures: marketState.getMarketSnapshots("futures"),
        etf: marketState.getMarketSnapshots("etf")
      }
    });
  }

  bus.emit("unified-tick", tick);
}

function normalizeDeltaTick(data) {
  return {
    source: "delta",
    venue: "DELTA",
    symbol: String(data.symbol || "").toUpperCase(),
    price: toNum(data.price),
    volume: toNum(data.volume),
    ts: toNum(data.ts) || nowMs(),
    receivedAt: nowMs(),
    raw: data
  };
}

const shoonyaState = Object.create(null);

function buildShoonyaKey(data) {
  const exchange = String(data.e || "UNKNOWN").toUpperCase();

  if (data.ts) {
    return exchange + "|" + String(data.ts).toUpperCase();
  }

  if (data.tk) {
    return exchange + "|" + String(data.tk);
  }

  if (data.token) {
    return exchange + "|" + String(data.token);
  }

  return exchange + "|UNKNOWN";
}

function normalizeShoonyaQuote(data) {
  const exchange = String(data.e || "UNKNOWN").toUpperCase();
  const key = buildShoonyaKey(data);

  if (!shoonyaState[key]) {
    shoonyaState[key] = {
      source: "shoonya",
      venue: exchange,
      symbol: key,
      price: null,
      volume: null,
      oi: null,
      ts: null,
      receivedAt: null,
      raw: {}
    };
  }

  const prev = shoonyaState[key];

  let price = toNum(data.lp);
  if (price === null) price = toNum(data.ltp);
  if (price === null) price = toNum(data.c);
  if (price === null) price = toNum(data.close);
  if (price === null) price = prev.price;

  let volume = toNum(data.v);
  if (volume === null) volume = toNum(data.volume);
  if (volume === null) volume = toNum(data.toi);
  if (volume === null) volume = prev.volume;

  let ts = prev.ts;
  if (data.ft != null) {
    const ftNum = Number(data.ft);
    if (Number.isFinite(ftNum)) {
      ts = ftNum * 1000;
    }
  }
  if (ts === null) {
    ts = Date.now();
  }

  let oi = toNum(data.oi);
  if (oi === null) oi = toNum(data.openi);
  if (oi === null) oi = toNum(data.poi);
  if (oi === null) oi = prev.oi;

  const mergedRaw = {
    ...prev.raw,
    ...data
  };

  const tick = {
    source: "shoonya",
    venue: exchange,
    symbol: key,
    price,
    volume,
    oi,
    ts,
    receivedAt: Date.now(),
    raw: mergedRaw
  };

  shoonyaState[key] = tick;
  return tick;
}

function receiveQuote(data) {
  const type = String(data.t || "");

  if (type === "ms") {
    console.log("Market status ::", data);
    return;
  }

  const tick = normalizeShoonyaQuote(data);

  if (tick.price === null) {
    console.log("Shoonya partial update without price ::", tick.symbol, data);
    return;
  }

  pushUnifiedTick(tick);
  console.log("Shoonya Tick ::", tick);
}


function receiveOrders(data) {
  console.log("Order ::", data);
}

function onShoonyaSocketOpen() {
  runtime.nseConnected = true;

  const instruments = "MCX|457533#NSE|8080#MCX|466029";
  console.log("Subscribing to NSE ::", instruments);

  try {
    api.subscribe(instruments);
  } catch (err) {
    runtime.lastError = err.message || String(err);
    console.error("NSE subscribe failed:", err);
  }
}

bus.on("tick", (data) => {
  const tick = normalizeDeltaTick(data);
  pushUnifiedTick(tick);
  console.log("DELTA Tick ::", tick);
});

bus.on("candle-close", ({ symbol, tf, candle }) => {
  console.log(
    "DELTA candle close ::",
    symbol,
    tf,
    "O:", candle.o,
    "H:", candle.h,
    "L:", candle.l,
    "C:", candle.c
  );
});

bus.on("unified-tick", (tick) => {
  console.log("POOLED Tick ::", tick.source, tick.symbol, tick.price);
});

bus.on("error", (err) => {
  runtime.lastError = err.message || String(err);
  console.error("Bus error:", err);
});

const ticker = createDeltaTicker({
  bus,
  symbols: ["SLVONUSD"],
  wsUrl: "wss://socket.india.delta.exchange",
  useMarkPrice: true,
  candleTfs: ["1m", "5m"],
  vwapTf: "5m"
});

function startDelta() {
  try {
    ticker.start();
    runtime.deltaStarted = true;
    console.log("Delta ticker started");
  } catch (err) {
    runtime.lastError = err.message || String(err);
    console.error("Delta start failed:", err);
  }
}

async function startShoonya() {
  try {
    const twofa = generateTotp(TOTP_SECRET);
    const authparams = getAuthParams(twofa);

    const res = await api.login(authparams);
    console.log("Shoonya login response ::", res);

    if (!res || res.stat !== "Ok") {
      runtime.lastError = "Shoonya login failed";
      console.error("Shoonya login failed");
      return;
    }
    
    //const mcxRows = await findMcxSilver(api);

    

    runtime.shoonyaLoggedIn = true;

    api.start_websocket({
      socket_open: onShoonyaSocketOpen,
      quote: receiveQuote,
      order: receiveOrders
    });

    console.log("Shoonya websocket starting...");
  } catch (err) {
    runtime.lastError = err.message || String(err);
    console.error("Shoonya startup failed:", err);
  }
}

app.use(express.json({ limit: "64kb" }));

app.use(cors({
  origin: "https://investingkriya.in",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-IK-Key"]
}));

app.options("*", cors());

app.get("/health", (req, res) => {
  let deltaStatus = null;

  try {
    deltaStatus = ticker.status();
  } catch (err) {
    deltaStatus = { error: err.message || String(err) };
  }

  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    shoonyaLoggedIn: runtime.shoonyaLoggedIn,
    nseConnected: runtime.nseConnected,
    deltaStarted: runtime.deltaStarted,
    pooledCount: runtime.pooledTicks.length,
    lastError: runtime.lastError,
    latestBySource: runtime.latestBySource,
    deltaStatus
  });
});

app.get("/ticks", (req, res) => {
  res.json({
    ok: true,
    count: runtime.pooledTicks.length,
    ticks: runtime.pooledTicks
  });
});

app.get("/ticks/latest", (req, res) => {
  const market = String(req.query.market || "").toLowerCase();

  if (market === "global" || market === "futures" || market === "etf") {
    const snapshots = marketState.getMarketSnapshots(market);
    if (!snapshots || !snapshots.latest) {
      res.status(503).json({
        ok: false,
        message: market + " feed not ready",
        market,
        ts: nowMs()
      });
      return;
    }

    res.json({
      ok: true,
      market,
      latest: snapshots.latest,
      previous: snapshots.previous,
      ts: nowMs()
    });
    return;
  }

  const latest = runtime.pooledTicks.length
    ? runtime.pooledTicks[runtime.pooledTicks.length - 1]
    : null;

  res.json({
    ok: true,
    latest
  });
});

app.get("/ticks/by-source", (req, res) => {
  res.json({
    ok: true,
    latestBySource: runtime.latestBySource
  });
});

app.use(createMarketRouter(marketState));
app.use(createSignal5mRouter(fiveMinEngine));

function shutdown() {
  console.log("Shutdown started");

  try {
    ticker.stop();
  } catch (err) {
    console.error("Delta stop error:", err);
  }

  try {
    if (api && typeof api.close_websocket === "function") {
      api.close_websocket();
    }
  } catch (err) {
    console.error("Shoonya websocket close error:", err);
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen(PORT, async () => {
  console.log("[HTTP] listening on", PORT);
  startDelta();
  await startShoonya();
});
