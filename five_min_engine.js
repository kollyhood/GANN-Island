const { classifyOiState, classifyDivergence, getDirection } = require("./signal_engine");

const FIVE_MIN_MS = 5 * 60 * 1000;

function toFinite(value) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return num;
  }
  return null;
}

function round(value, digits = 4) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function alignBucketStart(tsMs) {
  return Math.floor(tsMs / FIVE_MIN_MS) * FIVE_MIN_MS;
}

function getSnapshotValue(snapshot, side, field) {
  if (!snapshot) {
    return null;
  }
  if (!snapshot[side]) {
    return null;
  }
  return toFinite(snapshot[side][field]);
}

function createFiveMinEngine(options = {}) {
  const maxBars = Number(options.maxBars || 50);
  const onBarClose = typeof options.onBarClose === "function" ? options.onBarClose : null;

  const state = {
    currentBucket: null,
    closedBars: [],
    lastClosedBar: null
  };

  function buildBucket(startMs, latestFeeds) {
    const endMs = startMs + FIVE_MIN_MS - 1;

    const globalLatest = latestFeeds.global;
    const futuresLatest = latestFeeds.futures;
    const etfLatest = latestFeeds.etf;

    return {
      tStart: startMs,
      tEnd: endMs,
      tickCount: 0,

      globalOpen: globalLatest ? toFinite(globalLatest.price) : null,
      globalClose: globalLatest ? toFinite(globalLatest.price) : null,

      mcxOpen: futuresLatest ? toFinite(futuresLatest.price) : null,
      mcxHigh: futuresLatest ? toFinite(futuresLatest.price) : null,
      mcxLow: futuresLatest ? toFinite(futuresLatest.price) : null,
      mcxClose: futuresLatest ? toFinite(futuresLatest.price) : null,
      futuresVolumeStart: futuresLatest ? toFinite(futuresLatest.volume) : null,
      futuresVolumeEnd: futuresLatest ? toFinite(futuresLatest.volume) : null,
      futuresVolumeDelta: 0,

      etfOpen: etfLatest ? toFinite(etfLatest.price) : null,
      etfClose: etfLatest ? toFinite(etfLatest.price) : null,
      etfVolumeStart: etfLatest ? toFinite(etfLatest.volume) : null,
      etfVolumeEnd: etfLatest ? toFinite(etfLatest.volume) : null,
      etfVolumeDelta: 0,

      oiOpen: futuresLatest ? toFinite(futuresLatest.oi) : null,
      oiClose: futuresLatest ? toFinite(futuresLatest.oi) : null,
      oiHigh: futuresLatest ? toFinite(futuresLatest.oi) : null,
      oiLow: futuresLatest ? toFinite(futuresLatest.oi) : null,
      oiDelta: 0,

      sumScore: 0,
      bullTicks: 0,
      bearTicks: 0,
      neutralTicks: 0,
      maxBullScore: 0,
      maxBearScore: 0,

      lastTickTs: null,
      lastDivergence: null
    };
  }

  function maybeUpdateLowHigh(bucket, fieldHigh, fieldLow, value) {
    if (value === null) {
      return;
    }

    if (bucket[fieldHigh] === null || value > bucket[fieldHigh]) {
      bucket[fieldHigh] = value;
    }

    if (bucket[fieldLow] === null || value < bucket[fieldLow]) {
      bucket[fieldLow] = value;
    }
  }

  function updateVolumeDelta(bucket, startField, endField, deltaField) {
    const start = bucket[startField];
    const end = bucket[endField];

    if (start === null || end === null) {
      bucket[deltaField] = null;
      return;
    }

    bucket[deltaField] = round(end - start, 4);
  }

  function scoreTick(snapshots) {
    let score = 0;

    const globalLatest = getSnapshotValue(snapshots.global, "latest", "price");
    const globalPrevious = getSnapshotValue(snapshots.global, "previous", "price");
    const futuresLatest = getSnapshotValue(snapshots.futures, "latest", "price");
    const futuresPrevious = getSnapshotValue(snapshots.futures, "previous", "price");

    const globalDir = getDirection(globalLatest, globalPrevious);
    const mcxDir = getDirection(futuresLatest, futuresPrevious);

    if (globalDir === "BULLISH") {
      score += 1;
    } else if (globalDir === "BEARISH") {
      score -= 1;
    }

    if (mcxDir === "BULLISH") {
      score += 2;
    } else if (mcxDir === "BEARISH") {
      score -= 2;
    }

    const oiState = classifyOiState(snapshots.futures);
    if (oiState) {
      if (oiState.state === "LONG_BUILDUP") {
        score += 2;
      } else if (oiState.state === "SHORT_BUILDUP") {
        score -= 2;
      }
    }

    const divergence = classifyDivergence(snapshots.global, snapshots.futures, snapshots.etf);
    if (divergence.mcxVsEtf === "ETF_LAGGING_UP") {
      score += 1;
    } else if (divergence.mcxVsEtf === "ETF_LAGGING_DOWN") {
      score -= 1;
    }

    return {
      score,
      divergence
    };
  }

  function classifyBar(features) {
    const bullishChecks = [
      features.mcxClose > features.mcxOpen,
      features.oiClose > features.oiOpen,
      features.avgScore > 0.5,
      features.bullTickPct > features.bearTickPct,
      features.closeLocation >= 0.5,
      features.globalDirection !== "BEARISH"
    ];

    let bearishOiCondition = false;
    if (features.oiClose > features.oiOpen) {
      if (features.priceMove < 0) {
        bearishOiCondition = true;
      }
    } else if (features.oiClose < features.oiOpen) {
      if (features.priceMove <= 0) {
        bearishOiCondition = true;
      }
    }

    const bearishChecks = [
      features.mcxClose < features.mcxOpen,
      bearishOiCondition,
      features.avgScore < -0.5,
      features.bearTickPct > features.bullTickPct,
      features.closeLocation <= 0.5,
      features.globalDirection !== "BULLISH"
    ];

    let bullishHit = 0;
    let bearishHit = 0;

    for (const passed of bullishChecks) {
      if (passed) {
        bullishHit += 1;
      }
    }

    for (const passed of bearishChecks) {
      if (passed) {
        bearishHit += 1;
      }
    }

    if (bullishHit >= 4) {
      return "BULLISH";
    }

    if (bearishHit >= 4) {
      return "BEARISH";
    }

    return "NEUTRAL";
  }

  function buildBar(bucket) {
    let priceMove = 0;
    if (bucket.mcxClose !== null) {
      if (bucket.mcxOpen !== null) {
      priceMove = bucket.mcxClose - bucket.mcxOpen;
      }
    }

    let oiMove = 0;
    if (bucket.oiClose !== null) {
      if (bucket.oiOpen !== null) {
      oiMove = bucket.oiClose - bucket.oiOpen;
      }
    }

    const tickCount = bucket.tickCount;
    const bullTickPct = tickCount > 0 ? bucket.bullTicks / tickCount : 0;
    const bearTickPct = tickCount > 0 ? bucket.bearTicks / tickCount : 0;
    const avgScore = tickCount > 0 ? bucket.sumScore / tickCount : 0;

    let barRange = 0;
    if (bucket.mcxHigh !== null) {
      if (bucket.mcxLow !== null) {
      barRange = bucket.mcxHigh - bucket.mcxLow;
      }
    }

    let closeLocation = 0.5;
    if (barRange > 0) {
      if (bucket.mcxClose !== null) {
        if (bucket.mcxLow !== null) {
        closeLocation = (bucket.mcxClose - bucket.mcxLow) / barRange;
        }
      }
    }

    const globalDirection = getDirection(bucket.globalClose, bucket.globalOpen);
    const etfDirection = getDirection(bucket.etfClose, bucket.etfOpen);
    let etfConfirmation = "UNKNOWN";
    if (etfDirection === "NEUTRAL") {
      etfConfirmation = "NEUTRAL";
    } else if (globalDirection === etfDirection) {
      etfConfirmation = "CONFIRMED";
    } else {
      etfConfirmation = "CONFLICT";
    }

    const normalizedTickScore = clamp(avgScore / 6, -1, 1);
    const normalizedPriceMove = clamp(priceMove / (Math.max(Math.abs(barRange), 1)), -1, 1);

    const oiOpenAbs = bucket.oiOpen === null ? 0 : Math.abs(bucket.oiOpen);
    const oiDenominator = Math.max(oiOpenAbs * 0.001, 1);
    const normalizedOiMove = clamp(oiMove / oiDenominator, -1, 1);

    const tickDominance = clamp(bullTickPct - bearTickPct, -1, 1);
    const closeLocationBias = clamp((closeLocation - 0.5) * 2, -1, 1);

    const barScore = round(
      (0.35 * normalizedTickScore) +
      (0.25 * normalizedPriceMove) +
      (0.20 * normalizedOiMove) +
      (0.10 * tickDominance) +
      (0.10 * closeLocationBias),
      4
    );

    const features = {
      priceMove: round(priceMove, 6),
      oiMove: round(oiMove, 6),
      bullTickPct: round(bullTickPct, 4),
      bearTickPct: round(bearTickPct, 4),
      avgScore: round(avgScore, 4),
      range: round(barRange, 6),
      closeLocation: round(closeLocation, 4),
      globalDirection,
      etfConfirmation,
      divergence: bucket.lastDivergence,
      tickCount
    };

    const barState = classifyBar({
      mcxOpen: bucket.mcxOpen,
      mcxClose: bucket.mcxClose,
      oiOpen: bucket.oiOpen,
      oiClose: bucket.oiClose,
      avgScore: features.avgScore,
      bullTickPct: features.bullTickPct,
      bearTickPct: features.bearTickPct,
      closeLocation: features.closeLocation,
      globalDirection,
      priceMove: features.priceMove
    });

    return {
      tStart: bucket.tStart,
      tEnd: bucket.tEnd,
      ohlc: {
        o: bucket.mcxOpen,
        h: bucket.mcxHigh,
        l: bucket.mcxLow,
        c: bucket.mcxClose
      },
      barState,
      score: barScore,
      inputs: {
        priceMove: features.priceMove,
        oiMove: features.oiMove,
        bullTickPct: features.bullTickPct,
        bearTickPct: features.bearTickPct,
        closeLocation: features.closeLocation,
        tickCount: features.tickCount
      },
      features,
      bucketSnapshot: {
        tickCount: bucket.tickCount,
        mcxOpen: bucket.mcxOpen,
        mcxHigh: bucket.mcxHigh,
        mcxLow: bucket.mcxLow,
        mcxClose: bucket.mcxClose,
        oiOpen: bucket.oiOpen,
        oiClose: bucket.oiClose,
        futuresVolumeDelta: bucket.futuresVolumeDelta,
        etfVolumeDelta: bucket.etfVolumeDelta,
        sumScore: bucket.sumScore
      }
    };
  }

  function buildRegime() {
    const total = state.closedBars.length;
    if (total === 0) {
      return {
        regime: "NEUTRAL",
        regimeScore: 0
      };
    }

    const latest = state.closedBars[total - 1].score;
    const prev = total > 1 ? state.closedBars[total - 2].score : 0;
    const prev2 = total > 2 ? state.closedBars[total - 3].score : 0;

    const regimeScore = round((latest * 0.5) + (prev * 0.3) + (prev2 * 0.2), 4);

    let regime = "NEUTRAL";
    if (regimeScore >= 0.5) {
      regime = "STRENGTHENING_BULLISH";
    } else if (regimeScore >= 0.2) {
      regime = "WEAK_BULLISH";
    } else if (regimeScore <= -0.5) {
      regime = "STRENGTHENING_BEARISH";
    } else if (regimeScore <= -0.2) {
      regime = "WEAK_BEARISH";
    }

    return {
      regime,
      regimeScore
    };
  }

  function closeCurrentBucket() {
    if (state.currentBucket === null) {
      return null;
    }

    if (state.currentBucket.tickCount === 0) {
      return null;
    }

    const bar = buildBar(state.currentBucket);
    state.closedBars.push(bar);

    if (state.closedBars.length > maxBars) {
      state.closedBars.shift();
    }

    state.lastClosedBar = bar;

    if (onBarClose) {
      onBarClose(bar);
    }

    console.log("[5M] Closed bar", {
      tStart: bar.tStart,
      tEnd: bar.tEnd,
      barState: bar.barState,
      score: bar.score,
      tickCount: bar.inputs.tickCount
    });

    return bar;
  }

  function ingestTick(context) {
    const tsCandidate = context.tick ? context.tick.ts : null;
    const ts = toFinite(tsCandidate) || Date.now();
    const bucketStart = alignBucketStart(ts);

    if (state.currentBucket === null) {
      state.currentBucket = buildBucket(bucketStart, context.feeds);
    }

    if (ts > state.currentBucket.tEnd) {
      closeCurrentBucket();
      state.currentBucket = buildBucket(bucketStart, context.feeds);
    }

    const bucket = state.currentBucket;
    bucket.tickCount += 1;
    bucket.lastTickTs = ts;

    const market = context.market;
    const tick = context.tick;

    if (market === "global") {
      const price = toFinite(tick.price);
      if (bucket.globalOpen === null) {
        bucket.globalOpen = price;
      }
      bucket.globalClose = price;
    }

    if (market === "futures") {
      const price = toFinite(tick.price);
      const oi = toFinite(tick.oi);
      const volume = toFinite(tick.volume);

      if (bucket.mcxOpen === null) {
        bucket.mcxOpen = price;
      }
      bucket.mcxClose = price;
      maybeUpdateLowHigh(bucket, "mcxHigh", "mcxLow", price);

      if (bucket.futuresVolumeStart === null) {
        bucket.futuresVolumeStart = volume;
      }
      bucket.futuresVolumeEnd = volume;
      updateVolumeDelta(bucket, "futuresVolumeStart", "futuresVolumeEnd", "futuresVolumeDelta");

      if (bucket.oiOpen === null) {
        bucket.oiOpen = oi;
      }
      bucket.oiClose = oi;
      maybeUpdateLowHigh(bucket, "oiHigh", "oiLow", oi);
      if (bucket.oiOpen !== null) {
        if (bucket.oiClose !== null) {
        bucket.oiDelta = round(bucket.oiClose - bucket.oiOpen, 4);
        }
      }
    }

    if (market === "etf") {
      const price = toFinite(tick.price);
      const volume = toFinite(tick.volume);
      if (bucket.etfOpen === null) {
        bucket.etfOpen = price;
      }
      bucket.etfClose = price;

      if (bucket.etfVolumeStart === null) {
        bucket.etfVolumeStart = volume;
      }
      bucket.etfVolumeEnd = volume;
      updateVolumeDelta(bucket, "etfVolumeStart", "etfVolumeEnd", "etfVolumeDelta");
    }

    const micro = scoreTick(context.snapshots);
    bucket.sumScore = round(bucket.sumScore + micro.score, 4);
    bucket.lastDivergence = micro.divergence;

    if (micro.score > 0) {
      bucket.bullTicks += 1;
    } else if (micro.score < 0) {
      bucket.bearTicks += 1;
    } else {
      bucket.neutralTicks += 1;
    }

    if (micro.score > bucket.maxBullScore) {
      bucket.maxBullScore = micro.score;
    }

    if (micro.score < bucket.maxBearScore) {
      bucket.maxBearScore = micro.score;
    }
  }

  function getLatestSignal() {
    if (!state.lastClosedBar) {
      return null;
    }

    const regimeInfo = buildRegime();
    const latest = state.lastClosedBar;

    let note = "Balanced close with mixed evidence";
    if (latest.barState === "BULLISH") {
      note = "MCX closed strong with rising OI and positive tick persistence";
    } else if (latest.barState === "BEARISH") {
      note = "MCX closed weak with bearish pressure and downside persistence";
    }

    return {
      barState: latest.barState,
      regime: regimeInfo.regime,
      score: latest.score,
      regimeScore: regimeInfo.regimeScore,
      inputs: latest.inputs,
      note,
      tStart: latest.tStart,
      tEnd: latest.tEnd
    };
  }

  function getClosedBars(limit = 10) {
    const parsedLimit = Number(limit);
    const max = Number.isFinite(parsedLimit) ? parsedLimit : 10;
    const count = clamp(max, 1, maxBars);

    return state.closedBars.slice(-count).map((bar) => {
      return {
        tStart: bar.tStart,
        tEnd: bar.tEnd,
        barState: bar.barState,
        score: bar.score,
        priceMove: bar.inputs.priceMove,
        oiMove: bar.inputs.oiMove,
        tickCount: bar.inputs.tickCount
      };
    });
  }

  function getCurrentBucketPreview() {
    if (!state.currentBucket) {
      return null;
    }

    return {
      ...state.currentBucket,
      isFinal: false,
      message: "Current 5-minute bucket is in-progress and non-final"
    };
  }

  function getDebugState() {
    return {
      currentBucket: state.currentBucket,
      lastClosedBar: state.lastClosedBar,
      recentBars: getClosedBars(10)
    };
  }

  return {
    ingestTick,
    getLatestSignal,
    getClosedBars,
    getCurrentBucketPreview,
    getDebugState,
    alignBucketStart,
    closeCurrentBucket,
    state
  };
}

module.exports = {
  createFiveMinEngine,
  FIVE_MIN_MS,
  alignBucketStart
};
