// lib/normalize_tick.cjs (CommonJS)

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
}

function normalizeShoonyaQuote(raw) {
  const receivedAtMs = Date.now();

  const token = String(pick(raw, ["tk", "token", "instrument_token"]) ?? "").trim() || null;
  const symbol = String(pick(raw, ["tsym", "sym", "symbol", "trading_symbol"]) ?? "").trim() || null;

  const ltp = num(pick(raw, ["lp", "ltp", "last_price", "price", "c"])) ?? null;

  let tsMs = num(pick(raw, ["ft", "ts", "time", "t", "exchFeedTime"])) ?? null;
  if (tsMs != null && tsMs < 2e10) tsMs = tsMs * 1000; // seconds → ms
  if (tsMs == null) tsMs = receivedAtMs;

  const cumQty = num(pick(raw, ["v", "vol", "volume", "cum_qty", "cqty", "tq"])) ?? null;
  const lastQty = num(pick(raw, ["ltq", "last_qty", "lq", "qty"])) ?? null;

  return {
    token,
    symbol,
    ltp,
    tsMs,
    receivedAtMs,
    cumQty,
    lastQty,
    raw,
  };
}

module.exports = { normalizeShoonyaQuote };
