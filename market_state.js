function toFiniteNumber(value) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return num;
  }
  return null;
}

function cloneTick(tick) {
  if (!tick) {
    return null;
  }

  return {
    source: tick.source,
    venue: tick.venue,
    symbol: tick.symbol,
    price: tick.price,
    volume: tick.volume,
    oi: tick.oi,
    ts: tick.ts,
    receivedAt: tick.receivedAt,
    raw: tick.raw
  };
}

function createMarketState(options) {
  const settings = {
    globalSymbol: String(options.globalSymbol || "XAGUSD").toUpperCase(),
    futuresSymbol: String(options.futuresSymbol || "MCX|466029").toUpperCase(),
    etfSymbol: String(options.etfSymbol || "NSE|SILVERBEES").toUpperCase(),
    etfName: String(options.etfName || "SILVERBEES")
  };

  const state = {
    settings,
    feeds: {
      global: {
        latest: null,
        previous: null
      },
      futures: {
        latest: null,
        previous: null
      },
      etf: {
        latest: null,
        previous: null
      }
    },
    lastUpdateTs: null
  };

  function resolveMarket(tick) {
    if (!tick) {
      return null;
    }

    const source = String(tick.source || "").toLowerCase();
    const symbol = String(tick.symbol || "").toUpperCase();

    if (source === "delta" || source === "global") {
      if (symbol === settings.globalSymbol || settings.globalSymbol.length === 0) {
        return "global";
      }
    }

    if (source === "shoonya") {
      if (symbol === settings.futuresSymbol) {
        return "futures";
      }

      if (symbol === settings.etfSymbol) {
        return "etf";
      }
    }

    if (source === "nse") {
      if (symbol === "SILVERBEES" || symbol === settings.etfName.toUpperCase()) {
        return "etf";
      }
    }

    return null;
  }

  function normalizeMarketTick(market, tick) {
    const base = cloneTick(tick);
    if (!base) {
      return null;
    }

    if (market === "global") {
      base.source = "global";
      base.symbol = settings.globalSymbol;
    }

    if (market === "futures") {
      base.source = "shoonya";
      base.symbol = settings.futuresSymbol;
      base.oi = toFiniteNumber(base.oi);
    }

    if (market === "etf") {
      base.source = "NSE";
      base.symbol = settings.etfName;
    }

    return base;
  }

  function ingestTick(tick) {
    const market = resolveMarket(tick);
    if (market === null) {
      return null;
    }

    const normalized = normalizeMarketTick(market, tick);
    if (normalized === null) {
      return null;
    }

    const bucket = state.feeds[market];
    bucket.previous = bucket.latest;
    bucket.latest = normalized;
    state.lastUpdateTs = Date.now();

    return {
      market,
      tick: normalized
    };
  }

  function getMarketSnapshots(market) {
    if (!Object.prototype.hasOwnProperty.call(state.feeds, market)) {
      return null;
    }

    return state.feeds[market];
  }

  function getFeedsLatest() {
    return {
      global: state.feeds.global.latest,
      futures: state.feeds.futures.latest,
      etf: state.feeds.etf.latest
    };
  }

  function getDebugState() {
    return {
      settings: state.settings,
      feeds: state.feeds,
      lastUpdateTs: state.lastUpdateTs
    };
  }

  return {
    ingestTick,
    getMarketSnapshots,
    getFeedsLatest,
    getDebugState,
    state
  };
}

module.exports = {
  createMarketState,
  toFiniteNumber
};
