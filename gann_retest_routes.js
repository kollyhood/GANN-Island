const express = require("express");

function now() {
  return Date.now();
}

function createGannRetestRouter(engine) {
  const router = express.Router();

  router.get("/strategy/gann/status", (req, res) => {
    const status = engine.getStatus();

    if (!status.session.anchors) {
      res.status(503).json({
        ok: false,
        message: "Gann session not initialized yet",
        status,
        ts: now()
      });
      return;
    }

    res.json({
      ok: true,
      status,
      ts: now()
    });
  });

  router.get("/strategy/gann/events", (req, res) => {
    const events = engine.getEvents(req.query.limit || 100);

    res.json({
      ok: true,
      events,
      count: events.length,
      ts: now()
    });
  });

  return router;
}

module.exports = {
  createGannRetestRouter
};
