function toFinite(value) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  return null;
}

function computeOffset(mode, value, referencePrice, tickSize) {
  const val = toFinite(value);
  if (val === null || val < 0) {
    return 0;
  }

  if (mode === "ticks") {
    const tick = toFinite(tickSize);
    if (tick === null || tick <= 0) {
      return 0;
    }
    return val * tick;
  }

  if (mode === "percent") {
    const ref = toFinite(referencePrice);
    if (ref === null) {
      return 0;
    }
    return Math.abs(ref) * (val / 100);
  }

  return val;
}

function computeTolerance(config, levelPrice) {
  return computeOffset(config.toleranceMode, config.toleranceValue, levelPrice, config.tickSize);
}

function buildTradeFromSetup(setup, candle, ladder, config) {
  const levelPrice = setup.levelPrice;
  const buffer = computeOffset(config.stopBufferMode, config.stopBufferValue, levelPrice, config.tickSize);
  const tolerance = computeTolerance(config, levelPrice);

  let stop = null;
  if (setup.side === "LONG") {
    if (setup.retestLow !== null) {
      if (setup.retestLow !== undefined) {
      stop = setup.retestLow - buffer;
      } else {
        stop = levelPrice - tolerance;
      }
    } else {
      stop = levelPrice - tolerance;
    }
  } else {
    if (setup.retestHigh !== null) {
      if (setup.retestHigh !== undefined) {
      stop = setup.retestHigh + buffer;
      } else {
        stop = levelPrice + tolerance;
      }
    } else {
      stop = levelPrice + tolerance;
    }
  }

  const levelIdx = setup.levelIndex;
  const targetLevel = findNextLevel(ladder, levelIdx, setup.side);

  if (!targetLevel) {
    return null;
  }

  return {
    side: setup.side,
    entry: candle.c,
    stop,
    target: targetLevel.price,
    levelOrigin: {
      index: setup.levelIndex,
      kind: setup.levelKind,
      price: setup.levelPrice
    },
    entryBarIndex: candle.barIndex,
    entryTs: candle.ts,
    exit: null,
    exitReason: null,
    exitBarIndex: null,
    exitTs: null
  };
}

function findNextLevel(ladder, levelIndex, side) {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    return null;
  }

  const index = Number(levelIndex);
  if (!Number.isFinite(index)) {
    return null;
  }

  if (side === "LONG") {
    const targetIndex = index + 1;
    if (targetIndex >= ladder.length) {
      return null;
    }
    return ladder[targetIndex];
  }

  const targetIndex = index - 1;
  if (targetIndex < 0) {
    return null;
  }
  return ladder[targetIndex];
}

function updateOpenTrade(openTrade, candle) {
  if (!openTrade) {
    return null;
  }

  if (openTrade.side === "LONG") {
    if (candle.l <= openTrade.stop) {
      return {
        ...openTrade,
        exit: openTrade.stop,
        exitReason: "stop_loss",
        exitBarIndex: candle.barIndex,
        exitTs: candle.ts
      };
    }

    if (candle.h >= openTrade.target) {
      return {
        ...openTrade,
        exit: openTrade.target,
        exitReason: "target_hit",
        exitBarIndex: candle.barIndex,
        exitTs: candle.ts
      };
    }
  } else {
    if (candle.h >= openTrade.stop) {
      return {
        ...openTrade,
        exit: openTrade.stop,
        exitReason: "stop_loss",
        exitBarIndex: candle.barIndex,
        exitTs: candle.ts
      };
    }

    if (candle.l <= openTrade.target) {
      return {
        ...openTrade,
        exit: openTrade.target,
        exitReason: "target_hit",
        exitBarIndex: candle.barIndex,
        exitTs: candle.ts
      };
    }
  }

  return openTrade;
}

module.exports = {
  computeTolerance,
  buildTradeFromSetup,
  updateOpenTrade,
  findNextLevel
};
