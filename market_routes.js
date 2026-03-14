const express = require("express");
const {
  computeOiLatest,
  classifyOiState,
  classifyDivergence,
  buildLeader,
  buildComposite
} = require("./signal_engine");

function now() {
  return Date.now();
}

function missingMarkets(engine) {
  const required = ["global", "futures", "etf"];
  const missing = [];

  for (const market of required) {
    const snapshots = engine.getMarketSnapshots(market);
    if (!snapshots || !snapshots.latest) {
      missing.push(market);
    }
  }

  return missing;
}

function createMarketRouter(engine) {
  const router = express.Router();

  router.get("/feeds/latest", (req, res) => {
    res.json({
      ok: true,
      feeds: engine.getFeedsLatest(),
      ts: now()
    });
  });

  router.get("/oi/latest", (req, res) => {
    const futures = engine.getMarketSnapshots("futures");
    const oi = computeOiLatest(futures);

    if (!oi) {
      res.status(503).json({
        ok: false,
        message: "Futures OI not ready",
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      oi
    });
  });

  router.get("/oi/state", (req, res) => {
    const futures = engine.getMarketSnapshots("futures");
    const oiState = classifyOiState(futures);

    if (!oiState) {
      res.status(503).json({
        ok: false,
        message: "Need at least two futures ticks with OI",
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      state: oiState.state,
      inputs: oiState.inputs,
      ts: oiState.ts
    });
  });

  router.get("/signals/leader", (req, res) => {
    const missing = missingMarkets(engine);
    if (missing.length > 0) {
      res.status(503).json({
        ok: false,
        message: "Feeds not ready: " + missing.join(", "),
        ts: now()
      });
      return;
    }

    const leader = buildLeader(
      engine.getMarketSnapshots("global"),
      engine.getMarketSnapshots("futures"),
      engine.getMarketSnapshots("etf")
    );

    res.json({
      ok: true,
      leader,
      ts: now()
    });
  });

  router.get("/signals/divergence", (req, res) => {
    const missing = missingMarkets(engine);
    if (missing.length > 0) {
      res.status(503).json({
        ok: false,
        message: "Feeds not ready: " + missing.join(", "),
        ts: now()
      });
      return;
    }

    const divergence = classifyDivergence(
      engine.getMarketSnapshots("global"),
      engine.getMarketSnapshots("futures"),
      engine.getMarketSnapshots("etf")
    );

    res.json({
      ok: true,
      divergence,
      ts: now()
    });
  });

  router.get("/signals/composite", (req, res) => {
    const missing = missingMarkets(engine);
    if (missing.length > 0) {
      res.status(503).json({
        ok: false,
        message: "Feeds not ready: " + missing.join(", "),
        ts: now()
      });
      return;
    }

    const composite = buildComposite(
      engine.getMarketSnapshots("global"),
      engine.getMarketSnapshots("futures"),
      engine.getMarketSnapshots("etf")
    );

    res.json({
      ok: true,
      composite,
      ts: now()
    });
  });

  router.get("/debug/market", (req, res) => {
    res.json({
      ok: true,
      market: engine.getDebugState(),
      ts: now()
    });
  });

  return router;
}

module.exports = {
  createMarketRouter
};
