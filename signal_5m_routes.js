const express = require("express");

function now() {
  return Date.now();
}

function createSignal5mRouter(engine) {
  const router = express.Router();

  router.get("/signals/5m", (req, res) => {
    const signal5m = engine.getLatestSignal();

    if (!signal5m) {
      res.status(503).json({
        ok: false,
        message: "No closed 5-minute bar yet",
        signal5m: null,
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      signal5m,
      ts: now()
    });
  });

  router.get("/signals/5m/history", (req, res) => {
    const bars = engine.getClosedBars(req.query.limit || 10);

    if (bars.length === 0) {
      res.status(503).json({
        ok: false,
        message: "No closed 5-minute bars yet",
        bars: [],
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      bars,
      ts: now()
    });
  });

  router.get("/signals/5m/current", (req, res) => {
    const currentBucket = engine.getCurrentBucketPreview();

    if (!currentBucket) {
      res.status(503).json({
        ok: false,
        message: "Current 5-minute bucket not started",
        currentBucket: null,
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      currentBucket,
      ts: now()
    });
  });

  router.get("/debug/5m", (req, res) => {
    const debug = engine.getDebugState();

    res.json({
      ok: true,
      currentBucket: debug.currentBucket,
      lastClosedBar: debug.lastClosedBar,
      recentBars: debug.recentBars,
      ts: now()
    });
  });

  return router;
}

module.exports = {
  createSignal5mRouter
};
