const assert = require("assert");
const express = require("express");
const http = require("http");

const { createFiveMinEngine, alignBucketStart, FIVE_MIN_MS } = require("../five_min_engine");
const { createSignal5mRouter } = require("../signal_5m_routes");

function mkSnapshotTick(source, symbol, price, volume, oi, ts) {
  return {
    source,
    symbol,
    price,
    volume,
    oi,
    ts,
    receivedAt: ts,
    raw: {}
  };
}

function mkContext(market, tick, snapshots) {
  return {
    market,
    tick,
    feeds: {
      global: snapshots.global.latest,
      futures: snapshots.futures.latest,
      etf: snapshots.etf.latest
    },
    snapshots
  };
}

function reqJson(server, path) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ method: "GET", host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function buildSnapshots(baseTs, globalPx, futPx, futOi, etfPx, futVol, etfVol) {
  return {
    global: {
      previous: mkSnapshotTick("global", "SLVONUSD", globalPx - 0.2, null, null, baseTs - 1000),
      latest: mkSnapshotTick("global", "SLVONUSD", globalPx, null, null, baseTs)
    },
    futures: {
      previous: mkSnapshotTick("shoonya", "MCX|466029", futPx - 10, futVol - 5, futOi - 20, baseTs - 1000),
      latest: mkSnapshotTick("shoonya", "MCX|466029", futPx, futVol, futOi, baseTs)
    },
    etf: {
      previous: mkSnapshotTick("NSE", "SILVERBEES", etfPx - 0.2, etfVol - 3, null, baseTs - 1000),
      latest: mkSnapshotTick("NSE", "SILVERBEES", etfPx, etfVol, null, baseTs)
    }
  };
}

async function run() {
  const base = 1773380700000;
  assert.strictEqual(alignBucketStart(base + 65000), base, "alignment should floor to current 5m window");
  assert.strictEqual(alignBucketStart(base + FIVE_MIN_MS + 1), base + FIVE_MIN_MS, "alignment should move next window after boundary");

  const bull = createFiveMinEngine({ maxBars: 50 });
  for (let i = 0; i < 4; i += 1) {
    const ts = base + (i * 60000);
    const s = buildSnapshots(ts, 31 + i * 0.2, 90000 + i * 20, 50000 + i * 30, 89 + i * 0.1, 100 + i * 10, 200 + i * 6);
    bull.ingestTick(mkContext("futures", s.futures.latest, s));
  }
  const rolloverTs = base + FIVE_MIN_MS + 1000;
  const rolloverSnapshots = buildSnapshots(rolloverTs, 32.2, 90200, 50200, 89.9, 180, 250);
  bull.ingestTick(mkContext("futures", rolloverSnapshots.futures.latest, rolloverSnapshots));

  assert.ok(bull.state.lastClosedBar, "bar should close at rollover");
  assert.strictEqual(bull.state.lastClosedBar.tStart, base, "closed bar start should match aligned start");
  assert.strictEqual(bull.state.lastClosedBar.barState, "BULLISH", "rising market sample should classify bullish");
  assert.ok(bull.state.lastClosedBar.inputs.priceMove > 0, "priceMove should be positive");

  const bear = createFiveMinEngine({ maxBars: 50 });
  for (let i = 0; i < 4; i += 1) {
    const ts = base + (i * 60000);
    const s = {
      global: {
        previous: mkSnapshotTick("global", "SLVONUSD", 33 - i * 0.1, null, null, ts - 1000),
        latest: mkSnapshotTick("global", "SLVONUSD", 32.8 - i * 0.2, null, null, ts)
      },
      futures: {
        previous: mkSnapshotTick("shoonya", "MCX|466029", 90500 - i * 10, 200 + i * 2, 51000 + i * 15, ts - 1000),
        latest: mkSnapshotTick("shoonya", "MCX|466029", 90480 - i * 25, 210 + i * 2, 51020 + i * 20, ts)
      },
      etf: {
        previous: mkSnapshotTick("NSE", "SILVERBEES", 90.2 - i * 0.05, 300 + i * 2, null, ts - 1000),
        latest: mkSnapshotTick("NSE", "SILVERBEES", 90 - i * 0.12, 305 + i * 2, null, ts)
      }
    };
    bear.ingestTick(mkContext("futures", s.futures.latest, s));
  }
  const bearRolloverTs = base + FIVE_MIN_MS + 500;
  const bearRoll = {
    global: {
      previous: mkSnapshotTick("global", "SLVONUSD", 31.8, null, null, bearRolloverTs - 1000),
      latest: mkSnapshotTick("global", "SLVONUSD", 31.5, null, null, bearRolloverTs)
    },
    futures: {
      previous: mkSnapshotTick("shoonya", "MCX|466029", 90380, 220, 51100, bearRolloverTs - 1000),
      latest: mkSnapshotTick("shoonya", "MCX|466029", 90320, 224, 51140, bearRolloverTs)
    },
    etf: {
      previous: mkSnapshotTick("NSE", "SILVERBEES", 89.7, 312, null, bearRolloverTs - 1000),
      latest: mkSnapshotTick("NSE", "SILVERBEES", 89.5, 315, null, bearRolloverTs)
    }
  };
  bear.ingestTick(mkContext("futures", bearRoll.futures.latest, bearRoll));
  assert.strictEqual(bear.state.lastClosedBar.barState, "BEARISH", "falling market sample should classify bearish");

  const neutral = createFiveMinEngine({ maxBars: 50 });
  for (let i = 0; i < 3; i += 1) {
    const ts = base + (i * 70000);
    const s = {
      global: {
        previous: mkSnapshotTick("global", "SLVONUSD", 31.0, null, null, ts - 1000),
        latest: mkSnapshotTick("global", "SLVONUSD", 31.0, null, null, ts)
      },
      futures: {
        previous: mkSnapshotTick("shoonya", "MCX|466029", 90100, 100, 50500, ts - 1000),
        latest: mkSnapshotTick("shoonya", "MCX|466029", 90100, 102, 50500, ts)
      },
      etf: {
        previous: mkSnapshotTick("NSE", "SILVERBEES", 88.0, 100, null, ts - 1000),
        latest: mkSnapshotTick("NSE", "SILVERBEES", 88.0, 101, null, ts)
      }
    };
    neutral.ingestTick(mkContext("futures", s.futures.latest, s));
  }
  const neuRollTs = base + FIVE_MIN_MS + 700;
  const neuSnap = buildSnapshots(neuRollTs, 31, 90100, 50500, 88, 108, 104);
  neutral.ingestTick(mkContext("futures", neuSnap.futures.latest, neuSnap));
  assert.strictEqual(neutral.state.lastClosedBar.barState, "NEUTRAL", "flat sample should classify neutral");

  const apiEngine = createFiveMinEngine({ maxBars: 50 });
  const app = express();
  app.use(createSignal5mRouter(apiEngine));
  const server = app.listen(0);

  const before = await reqJson(server, "/signals/5m");
  assert.strictEqual(before.status, 503, "before first closed bar should return 503");
  assert.strictEqual(before.json.ok, false, "before first closed bar should be ok:false");

  for (let i = 0; i < 2; i += 1) {
    const ts = base + (i * 120000);
    const s = buildSnapshots(ts, 31.1 + i * 0.2, 90020 + i * 5, 50020 + i * 10, 88.9 + i * 0.05, 140 + i * 4, 210 + i * 3);
    apiEngine.ingestTick(mkContext("futures", s.futures.latest, s));
  }
  const closeTs = base + FIVE_MIN_MS + 10;
  const closeSnap = buildSnapshots(closeTs, 31.9, 90070, 50080, 89.1, 155, 219);
  apiEngine.ingestTick(mkContext("futures", closeSnap.futures.latest, closeSnap));

  const after = await reqJson(server, "/signals/5m");
  assert.strictEqual(after.status, 200, "after closed bar should return 200");
  assert.strictEqual(after.json.ok, true, "after closed bar should be ok:true");
  assert.ok(after.json.signal5m, "after closed bar should return signal payload");

  const history = await reqJson(server, "/signals/5m/history");
  assert.strictEqual(history.status, 200, "history should return 200 after bar close");
  assert.ok(Array.isArray(history.json.bars), "history bars should be array");

  server.close();
  console.log("five_min_engine tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
