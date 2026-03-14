function round(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function getDirection(latest, previous) {
  if (latest === null || previous === null) {
    return "NEUTRAL";
  }

  if (latest > previous) {
    return "BULLISH";
  }

  if (latest < previous) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function computeDelta(latest, previous) {
  if (latest === null || previous === null) {
    return {
      delta: null,
      deltaPct: null
    };
  }

  const delta = latest - previous;
  let deltaPct = null;
  if (previous !== 0) {
    deltaPct = (delta / previous) * 100;
  }

  return {
    delta: round(delta, 6),
    deltaPct: deltaPct === null ? null : round(deltaPct, 6)
  };
}

function safeNumber(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return null;
}

function getLatestValue(snapshot, field) {
  if (!snapshot || !snapshot.latest) {
    return null;
  }
  return snapshot.latest[field];
}

function getPreviousValue(snapshot, field) {
  if (!snapshot || !snapshot.previous) {
    return null;
  }
  return snapshot.previous[field];
}

function computeOiLatest(futuresSnapshot) {
  if (!futuresSnapshot || !futuresSnapshot.latest) {
    return null;
  }

  const latest = futuresSnapshot.latest;
  const previous = futuresSnapshot.previous;

  const currentOi = safeNumber(latest.oi);
  const previousOi = previous ? safeNumber(previous.oi) : null;

  if (currentOi === null) {
    return null;
  }

  const deltas = computeDelta(currentOi, previousOi);

  return {
    symbol: latest.symbol,
    current: currentOi,
    previous: previousOi,
    delta: deltas.delta,
    deltaPct: deltas.deltaPct,
    ts: latest.ts
  };
}

function classifyOiState(futuresSnapshot) {
  if (!futuresSnapshot || !futuresSnapshot.latest || !futuresSnapshot.previous) {
    return null;
  }

  const latest = futuresSnapshot.latest;
  const previous = futuresSnapshot.previous;

  const priceLatest = safeNumber(latest.price);
  const pricePrevious = safeNumber(previous.price);
  const oiLatest = safeNumber(latest.oi);
  const oiPrevious = safeNumber(previous.oi);

  if (priceLatest === null || pricePrevious === null || oiLatest === null || oiPrevious === null) {
    return {
      state: "NEUTRAL",
      inputs: {
        priceDelta: null,
        priceDeltaPct: null,
        oiDelta: null,
        oiDeltaPct: null
      },
      ts: latest.ts
    };
  }

  const priceMove = computeDelta(priceLatest, pricePrevious);
  const oiMove = computeDelta(oiLatest, oiPrevious);

  let state = "NEUTRAL";

  if (priceMove.delta > 0) {
    if (oiMove.delta > 0) {
      state = "LONG_BUILDUP";
    } else if (oiMove.delta < 0) {
      state = "SHORT_COVERING";
    }
  } else if (priceMove.delta < 0) {
    if (oiMove.delta > 0) {
      state = "SHORT_BUILDUP";
    } else if (oiMove.delta < 0) {
      state = "LONG_UNWINDING";
    }
  }

  return {
    state,
    inputs: {
      priceDelta: priceMove.delta,
      priceDeltaPct: priceMove.deltaPct,
      oiDelta: oiMove.delta,
      oiDeltaPct: oiMove.deltaPct
    },
    ts: latest.ts
  };
}

function classifyDivergence(globalSnapshot, futuresSnapshot, etfSnapshot) {
  const globalMove = computeDelta(
    getLatestValue(globalSnapshot, "price"),
    getPreviousValue(globalSnapshot, "price")
  );
  const mcxMove = computeDelta(
    getLatestValue(futuresSnapshot, "price"),
    getPreviousValue(futuresSnapshot, "price")
  );
  const etfMove = computeDelta(
    getLatestValue(etfSnapshot, "price"),
    getPreviousValue(etfSnapshot, "price")
  );

  let globalVsMcx = "ALIGNED";
  if (globalMove.delta !== null && mcxMove.delta !== null) {
    if (globalMove.delta > 0 && mcxMove.delta < 0) {
      globalVsMcx = "OPPOSITE";
    } else if (globalMove.delta < 0 && mcxMove.delta > 0) {
      globalVsMcx = "OPPOSITE";
    }
  }

  let mcxVsEtf = "ALIGNED";
  const mcxThreshold = 0.1;
  const etfThreshold = 0.05;

  if (mcxMove.delta !== null && etfMove.delta !== null) {
    if (mcxMove.delta > mcxThreshold && etfMove.delta <= etfThreshold) {
      mcxVsEtf = "ETF_LAGGING_UP";
    } else if (mcxMove.delta < -mcxThreshold && etfMove.delta >= -etfThreshold) {
      mcxVsEtf = "ETF_LAGGING_DOWN";
    }
  }

  let strength = 0.5;
  if (globalVsMcx === "ALIGNED") {
    strength += 0.2;
  }
  if (mcxVsEtf !== "ALIGNED") {
    strength += 0.1;
  }

  strength = round(Math.min(1, strength), 2);

  return {
    globalVsMcx,
    mcxVsEtf,
    strength
  };
}

function buildLeader(globalSnapshot, futuresSnapshot, etfSnapshot) {
  const globalBias = getDirection(getLatestValue(globalSnapshot, "price"), getPreviousValue(globalSnapshot, "price"));
  const mcxBias = getDirection(getLatestValue(futuresSnapshot, "price"), getPreviousValue(futuresSnapshot, "price"));

  const oi = classifyOiState(futuresSnapshot);
  const divergence = classifyDivergence(globalSnapshot, futuresSnapshot, etfSnapshot);

  let etfLag = false;
  if (divergence.mcxVsEtf === "ETF_LAGGING_UP" || divergence.mcxVsEtf === "ETF_LAGGING_DOWN") {
    etfLag = true;
  }

  let note = "Insufficient movement for leader signal";

  if (globalBias === "BULLISH" && mcxBias === "BULLISH" && divergence.mcxVsEtf === "ETF_LAGGING_UP") {
    note = "Global and MCX are rising while ETF is lagging";
  } else if (globalBias === "BEARISH" && mcxBias === "BEARISH" && divergence.mcxVsEtf === "ETF_LAGGING_DOWN") {
    note = "Global and MCX are falling while ETF is lagging";
  } else if (globalBias === mcxBias && globalBias !== "NEUTRAL") {
    note = "Global and MCX are directionally aligned";
  }

  return {
    globalBias,
    mcxBias,
    oiState: oi ? oi.state : "NEUTRAL",
    etfLag,
    note
  };
}

function buildComposite(globalSnapshot, futuresSnapshot, etfSnapshot) {
  const leader = buildLeader(globalSnapshot, futuresSnapshot, etfSnapshot);
  const divergence = classifyDivergence(globalSnapshot, futuresSnapshot, etfSnapshot);

  let score = 0;
  const drivers = [];

  if (leader.globalBias === "BULLISH") {
    score += 1;
    drivers.push("Global silver up");
  } else if (leader.globalBias === "BEARISH") {
    score -= 1;
    drivers.push("Global silver down");
  }

  if (leader.mcxBias === "BULLISH") {
    score += 1;
    drivers.push("MCX futures up");
  } else if (leader.mcxBias === "BEARISH") {
    score -= 1;
    drivers.push("MCX futures down");
  }

  if (leader.oiState === "LONG_BUILDUP" || leader.oiState === "SHORT_COVERING") {
    score += 1;
    drivers.push("OI rising or covering supports upside");
  } else if (leader.oiState === "SHORT_BUILDUP" || leader.oiState === "LONG_UNWINDING") {
    score -= 1;
    drivers.push("OI supports downside move");
  }

  if (divergence.mcxVsEtf === "ETF_LAGGING_UP") {
    score += 0.5;
    drivers.push("ETF lagging behind futures");
  } else if (divergence.mcxVsEtf === "ETF_LAGGING_DOWN") {
    score -= 0.5;
    drivers.push("ETF lagging during downside futures move");
  }

  let bias = "NEUTRAL";
  if (score >= 1.5) {
    bias = "BULLISH";
  } else if (score <= -1.5) {
    bias = "BEARISH";
  }

  const confidence = round(Math.min(1, Math.abs(score) / 3.5), 2);

  return {
    bias,
    confidence,
    drivers
  };
}

module.exports = {
  computeOiLatest,
  classifyOiState,
  classifyDivergence,
  buildLeader,
  buildComposite,
  computeDelta,
  getDirection
};
