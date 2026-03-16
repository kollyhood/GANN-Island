const { buildGannLadder } = require("./gann_ladder");
const { createGannRetestConfig } = require("./gann_retest_config");
const { computeTolerance, buildTradeFromSetup, updateOpenTrade } = require("./gann_retest_trade");

const SETUP_STATES = {
  IDLE: "IDLE",
  BROKEN: "BROKEN",
  WAIT_RETEST: "WAIT_RETEST",
  RETEST_SEEN: "RETEST_SEEN",
  CONFIRMED: "CONFIRMED",
  IN_TRADE: "IN_TRADE",
  COMPLETE: "COMPLETE"
};

function candleToEvent(candle) {
  return {
    ts: candle.ts,
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
    barIndex: candle.barIndex
  };
}

function toSessionKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function makeSetup(level, side, candle, config) {
  return {
    levelPrice: level.price,
    levelIndex: level.index,
    levelKind: level.kind,
    side,
    state: SETUP_STATES.WAIT_RETEST,
    breakBarIndex: candle.barIndex,
    breakTs: candle.ts,
    retestSeen: false,
    retestBarIndex: null,
    retestTs: null,
    retestHigh: null,
    retestLow: null,
    expiresAfterBar: candle.barIndex + config.retestWindowBars,
    used: false,
    completed: false
  };
}

function createGannRetestEngine(userConfig = {}) {
  const config = createGannRetestConfig(userConfig);

  const state = {
    barIndex: -1,
    prevClose: null,
    sessionKey: null,
    anchors: null,
    ladder: [],
    activeSetups: {},
    usedLevels: {},
    openTrade: null,
    lastCompletedTrade: null,
    events: [],
    lastEvent: null
  };

  function pushEvent(type, payload = {}) {
    const event = {
      type,
      ts: payload.ts || Date.now(),
      ...payload
    };

    state.events.push(event);
    const maxEvents = Number(config.maxEvents || 1000);
    if (state.events.length > maxEvents) {
      state.events.shift();
    }

    state.lastEvent = event;
    return event;
  }

  function resetSessionIfNeeded(candle) {
    const key = toSessionKey(candle.ts);
    if (state.sessionKey === key) {
      return false;
    }

    state.sessionKey = key;
    state.anchors = {
      high: candle.h,
      low: candle.l,
      ts: candle.ts,
      barIndex: candle.barIndex
    };

    state.ladder = buildGannLadder(candle.h, candle.l, config);
    state.activeSetups = {};
    state.openTrade = null;
    state.usedLevels = {};

    pushEvent("session_reset", {
      ts: candle.ts,
      sessionKey: state.sessionKey,
      anchors: state.anchors,
      candle: candleToEvent(candle)
    });

    pushEvent("ladder_built", {
      ts: candle.ts,
      sessionKey: state.sessionKey,
      anchorHigh: candle.h,
      anchorLow: candle.l,
      levelCount: state.ladder.length
    });

    return true;
  }

  function keyFor(levelIndex, side) {
    return String(levelIndex) + ":" + side;
  }

  function levelZoneHit(candle, levelPrice) {
    const tol = computeTolerance(config, levelPrice);
    const lo = levelPrice - tol;
    const hi = levelPrice + tol;

    if (candle.h < lo) {
      return false;
    }

    if (candle.l > hi) {
      return false;
    }

    return true;
  }

  function cancelSetup(setupKey, setup, reason, candle) {
    setup.state = SETUP_STATES.COMPLETE;
    setup.completed = true;
    state.activeSetups[setupKey] = setup;

    pushEvent("setup_cancelled", {
      ts: candle.ts,
      reason,
      level: setup.levelPrice,
      levelIndex: setup.levelIndex,
      side: setup.side,
      candle: candleToEvent(candle)
    });

    delete state.activeSetups[setupKey];
  }

  function updateTrade(candle) {
    if (!state.openTrade) {
      return;
    }

    const updated = updateOpenTrade(state.openTrade, candle);
    state.openTrade = updated;

    if (updated.exit !== null) {
      state.lastCompletedTrade = updated;
      state.openTrade = null;

      pushEvent("trade_exited", {
        ts: candle.ts,
        side: updated.side,
        entry: updated.entry,
        exit: updated.exit,
        stop: updated.stop,
        target: updated.target,
        level: updated.levelOrigin.price,
        reason: updated.exitReason,
        candle: candleToEvent(candle)
      });
    }
  }

  function updateSetups(candle) {
    const entries = Object.entries(state.activeSetups);

    for (const [setupKey, setup] of entries) {
      if (setup.state === SETUP_STATES.WAIT_RETEST) {
        if (candle.barIndex > setup.expiresAfterBar) {
          pushEvent("setup_expired", {
            ts: candle.ts,
            side: setup.side,
            level: setup.levelPrice,
            levelIndex: setup.levelIndex,
            candle: candleToEvent(candle)
          });
          delete state.activeSetups[setupKey];
          continue;
        }

        if (candle.barIndex <= setup.breakBarIndex) {
          continue;
        }

        if (levelZoneHit(candle, setup.levelPrice)) {
          setup.state = SETUP_STATES.RETEST_SEEN;
          setup.retestSeen = true;
          setup.retestBarIndex = candle.barIndex;
          setup.retestTs = candle.ts;
          setup.retestHigh = candle.h;
          setup.retestLow = candle.l;

          pushEvent("retest_seen", {
            ts: candle.ts,
            side: setup.side,
            level: setup.levelPrice,
            levelIndex: setup.levelIndex,
            candle: candleToEvent(candle)
          });
        }

        continue;
      }

      if (setup.state === SETUP_STATES.RETEST_SEEN) {
        if (candle.barIndex <= setup.retestBarIndex) {
          continue;
        }

        let confirmed = false;
        if (setup.side === "LONG") {
          if (candle.c > setup.levelPrice) {
            confirmed = true;
          }
        } else if (candle.c < setup.levelPrice) {
          confirmed = true;
        }

        if (!confirmed) {
          continue;
        }

        setup.state = SETUP_STATES.CONFIRMED;
        pushEvent("confirmation_seen", {
          ts: candle.ts,
          side: setup.side,
          level: setup.levelPrice,
          levelIndex: setup.levelIndex,
          candle: candleToEvent(candle)
        });

        if (state.openTrade) {
          continue;
        }

        const trade = buildTradeFromSetup(setup, candle, state.ladder, config);
        if (!trade) {
          cancelSetup(setupKey, setup, "missing_target_level", candle);
          continue;
        }

        if (config.mode === "observe") {
          setup.state = SETUP_STATES.COMPLETE;
          setup.completed = true;
          setup.used = true;
          state.usedLevels[keyFor(setup.levelIndex, setup.side)] = {
            ts: candle.ts,
            reason: "observe_mode"
          };
          pushEvent("trade_entered", {
            ts: candle.ts,
            observeOnly: true,
            side: trade.side,
            entry: trade.entry,
            stop: trade.stop,
            target: trade.target,
            level: trade.levelOrigin.price,
            levelIndex: trade.levelOrigin.index,
            candle: candleToEvent(candle)
          });
          pushEvent("trade_exited", {
            ts: candle.ts,
            observeOnly: true,
            side: trade.side,
            entry: trade.entry,
            exit: trade.entry,
            reason: "observe_mode_no_execution",
            stop: trade.stop,
            target: trade.target,
            level: trade.levelOrigin.price,
            candle: candleToEvent(candle)
          });
          state.lastCompletedTrade = {
            ...trade,
            exit: trade.entry,
            exitReason: "observe_mode_no_execution",
            exitBarIndex: candle.barIndex,
            exitTs: candle.ts
          };
          delete state.activeSetups[setupKey];
          continue;
        }

        state.openTrade = trade;
        state.usedLevels[keyFor(setup.levelIndex, setup.side)] = {
          ts: candle.ts,
          reason: "trade_entered"
        };
        setup.state = SETUP_STATES.IN_TRADE;
        setup.used = true;

        pushEvent("trade_entered", {
          ts: candle.ts,
          observeOnly: false,
          side: trade.side,
          entry: trade.entry,
          stop: trade.stop,
          target: trade.target,
          level: trade.levelOrigin.price,
          levelIndex: trade.levelOrigin.index,
          candle: candleToEvent(candle)
        });

        delete state.activeSetups[setupKey];
      }
    }
  }

  function scanFreshBreaks(candle) {
    if (state.prevClose === null) {
      return;
    }

    for (const level of state.ladder) {
      const longKey = keyFor(level.index, "LONG");
      const shortKey = keyFor(level.index, "SHORT");

      const oneTradePerLevel = config.oneTradePerLevel === true;

      let canLong = config.allowLong === true;
      if (canLong) {
        if (oneTradePerLevel) {
        if (state.usedLevels[longKey]) {
          canLong = false;
        }
        }
      }

      let canShort = config.allowShort === true;
      if (canShort) {
        if (oneTradePerLevel) {
        if (state.usedLevels[shortKey]) {
          canShort = false;
        }
        }
      }

      let crossedAbove = false;
      if (state.prevClose <= level.price) {
        if (candle.c > level.price) {
          crossedAbove = true;
        }
      }
      let crossedBelow = false;
      if (state.prevClose >= level.price) {
        if (candle.c < level.price) {
          crossedBelow = true;
        }
      }

      if (canLong) {
        if (crossedAbove) {
          if (!state.activeSetups[longKey]) {
          const existingOpp = state.activeSetups[shortKey];
          if (existingOpp) {
            cancelSetup(shortKey, existingOpp, "opposite_break", candle);
          }

          state.activeSetups[longKey] = makeSetup(level, "LONG", candle, config);
            pushEvent("level_broken", {
            ts: candle.ts,
            side: "LONG",
            level: level.price,
            levelIndex: level.index,
            levelKind: level.kind,
            candle: candleToEvent(candle)
            });
          }
        }
      }

      if (canShort) {
        if (crossedBelow) {
          if (!state.activeSetups[shortKey]) {
          const existingOpp = state.activeSetups[longKey];
          if (existingOpp) {
            cancelSetup(longKey, existingOpp, "opposite_break", candle);
          }

          state.activeSetups[shortKey] = makeSetup(level, "SHORT", candle, config);
              pushEvent("level_broken", {
              ts: candle.ts,
              side: "SHORT",
              level: level.price,
              levelIndex: level.index,
              levelKind: level.kind,
              candle: candleToEvent(candle)
            });
          }
        }
      }
    }
  }

  function onCandleClose(candleInput) {
    if (!config.enabled) {
      return { ok: false, message: "gann_retest_disabled" };
    }

    const candle = {
      ts: Number(candleInput.ts),
      o: Number(candleInput.o),
      h: Number(candleInput.h),
      l: Number(candleInput.l),
      c: Number(candleInput.c),
      barIndex: state.barIndex + 1
    };

    if (!Number.isFinite(candle.ts) || !Number.isFinite(candle.c)) {
      return { ok: false, message: "invalid_candle" };
    }

    state.barIndex = candle.barIndex;
    resetSessionIfNeeded(candle);

    if (!Array.isArray(state.ladder) || state.ladder.length === 0) {
      state.prevClose = candle.c;
      return { ok: false, message: "ladder_not_ready" };
    }

    updateTrade(candle);
    updateSetups(candle);
    scanFreshBreaks(candle);

    state.prevClose = candle.c;

    return {
      ok: true,
      sessionKey: state.sessionKey,
      openTrade: state.openTrade,
      activeSetupCount: Object.keys(state.activeSetups).length,
      lastEvent: state.lastEvent
    };
  }

  function getStatus() {
    return {
      ok: true,
      config,
      session: {
        sessionKey: state.sessionKey,
        anchors: state.anchors
      },
      ladder: state.ladder,
      activeSetups: Object.values(state.activeSetups),
      usedLevels: state.usedLevels,
      openTrade: state.openTrade,
      lastCompletedTrade: state.lastCompletedTrade,
      lastEvent: state.lastEvent
    };
  }

  function getEvents(limit = 100) {
    const parsed = Number(limit);
    const max = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 100;
    return state.events.slice(-max);
  }

  return {
    SETUP_STATES,
    onCandleClose,
    resetSessionIfNeeded,
    getStatus,
    getEvents,
    state,
    config
  };
}

module.exports = {
  createGannRetestEngine,
  SETUP_STATES
};
