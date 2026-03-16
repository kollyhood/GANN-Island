function toFinite(value) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return num;
  }
  return null;
}

function quantize(price, tickSize) {
  if (tickSize === null || tickSize === undefined) {
    return price;
  }
  const step = Number(tickSize);
  if (!Number.isFinite(step) || step <= 0) {
    return price;
  }
  return Math.round(price / step) * step;
}

function dedupeAndSort(levels, epsilon) {
  const sorted = levels.slice().sort((a, b) => a.price - b.price);
  const out = [];

  for (const level of sorted) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (!prev) {
      out.push(level);
      continue;
    }

    const diff = Math.abs(level.price - prev.price);
    if (diff <= epsilon) {
      continue;
    }

    out.push(level);
  }

  return out.map((level, idx) => ({
    ...level,
    index: idx
  }));
}

function buildGannLadder(anchorHigh, anchorLow, options = {}) {
  const high = toFinite(anchorHigh);
  const low = toFinite(anchorLow);

  if (high === null || low === null) {
    throw new Error("Invalid anchors for Gann ladder");
  }

  const levelCountRaw = Number(options.levelCount);
  const levelCount = Number.isFinite(levelCountRaw) ? Math.max(1, Math.floor(levelCountRaw)) : 8;

  const span = Math.abs(high - low);
  let step = toFinite(options.step);
  if (step === null || step <= 0) {
    step = span;
  }
  if (step === 0) {
    step = 1;
  }

  const epsilon = toFinite(options.epsilon) || 1e-6;
  const includeOpen = options.includeOpenHighLow !== false;

  const levels = [];

  if (includeOpen) {
    levels.push({ price: quantize(high, options.tickSize), index: -1, kind: "openHigh" });
    levels.push({ price: quantize(low, options.tickSize), index: -1, kind: "openLow" });
  }

  for (let i = 1; i <= levelCount; i += 1) {
    levels.push({
      price: quantize(high + (step * i), options.tickSize),
      index: i,
      kind: "resistance"
    });

    levels.push({
      price: quantize(low - (step * i), options.tickSize),
      index: i,
      kind: "support"
    });
  }

  return dedupeAndSort(levels, epsilon);
}

module.exports = {
  buildGannLadder
};
