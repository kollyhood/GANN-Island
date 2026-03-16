function createGannRetestConfig(overrides = {}) {
  const defaults = {
    enabled: true,
    mode: "observe",
    timeframe: "5m",
    step: null,
    levelCount: 8,
    includeOpenHighLow: true,
    priceScale: null,
    tickSize: null,
    epsilon: 1e-6,
    retestWindowBars: 6,
    toleranceMode: "absolute",
    toleranceValue: 0.2,
    stopBufferMode: "absolute",
    stopBufferValue: 0.1,
    session: {
      type: "utc_day",
      firstBarMode: "first_closed_bar"
    },
    oneTradePerLevel: true,
    allowLong: true,
    allowShort: true,
    maxEvents: 1000
  };

  return {
    ...defaults,
    ...overrides,
    session: {
      ...defaults.session,
      ...(overrides.session || {})
    }
  };
}

module.exports = {
  createGannRetestConfig
};
