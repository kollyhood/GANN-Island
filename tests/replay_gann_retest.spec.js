const assert = require("assert");

const { buildGannLadder } = require("../gann_ladder");
const { createGannRetestEngine } = require("../gann_retest_engine");

function mk(ts, o, h, l, c) {
  return { ts, o, h, l, c };
}

function eventCount(engine, type) {
  return engine.getEvents(500).filter((evt) => evt.type === type).length;
}

function runLadderChecks() {
  const ladder = buildGannLadder(100, 90, {
    step: 2,
    levelCount: 3,
    includeOpenHighLow: true,
    epsilon: 1e-6
  });

  const prices = ladder.map((x) => x.price);
  assert.deepStrictEqual(prices, [84, 86, 88, 90, 100, 102, 104, 106], "ladder ordering should match deterministic rung generation");
}

function runLongScenario() {
  const engine = createGannRetestEngine({
    mode: "paper",
    step: 2,
    levelCount: 3,
    retestWindowBars: 3,
    toleranceMode: "absolute",
    toleranceValue: 0.25,
    stopBufferMode: "absolute",
    stopBufferValue: 0.1
  });

  const day1 = [
    mk(Date.UTC(2026, 0, 2, 9, 15), 95, 100, 90, 95),
    mk(Date.UTC(2026, 0, 2, 9, 20), 95, 101, 94, 100.5),
    mk(Date.UTC(2026, 0, 2, 9, 25), 100.2, 100.3, 99.85, 100.1),
    mk(Date.UTC(2026, 0, 2, 9, 30), 100.15, 102.5, 100.05, 101.3),
    mk(Date.UTC(2026, 0, 2, 9, 35), 101.3, 102.2, 101.0, 101.8)
  ];

  for (const candle of day1) {
    const out = engine.onCandleClose(candle);
    assert.strictEqual(out.ok, true, "engine should process candle");
  }

  const status = engine.getStatus();
  assert.strictEqual(eventCount(engine, "level_broken"), 1, "one break expected");
  assert.strictEqual(eventCount(engine, "retest_seen"), 1, "one retest expected");
  assert.strictEqual(eventCount(engine, "confirmation_seen"), 1, "one confirmation expected");
  assert.strictEqual(eventCount(engine, "trade_entered"), 1, "one trade entry expected");
  assert.strictEqual(eventCount(engine, "trade_exited"), 1, "one trade exit expected");
  assert.ok(status.lastCompletedTrade, "last completed trade should exist");
  assert.strictEqual(status.lastCompletedTrade.exitReason, "target_hit", "trade should hit target rung");
  assert.strictEqual(status.lastCompletedTrade.target, 102, "target should be next ladder rung");
  assert.ok(Math.abs(status.lastCompletedTrade.stop - 99.75) < 1e-6, "stop should use retest low minus buffer");

  return engine;
}

function runNoTouchEntryScenario() {
  const engine = createGannRetestEngine({
    mode: "paper",
    step: 2,
    levelCount: 3,
    retestWindowBars: 2,
    toleranceMode: "absolute",
    toleranceValue: 0.2
  });

  const candles = [
    mk(Date.UTC(2026, 0, 3, 9, 15), 95, 100, 90, 95),
    mk(Date.UTC(2026, 0, 3, 9, 20), 95, 100.2, 99.5, 99.9),
    mk(Date.UTC(2026, 0, 3, 9, 25), 99.9, 100.4, 99.2, 99.95)
  ];

  for (const candle of candles) {
    engine.onCandleClose(candle);
  }

  assert.strictEqual(eventCount(engine, "trade_entered"), 0, "touch-only behavior must not enter trade");
  assert.strictEqual(eventCount(engine, "level_broken"), 0, "touch-only behavior must not count as close-through break");
}

function runSetupExpiryScenario() {
  const engine = createGannRetestEngine({
    mode: "paper",
    step: 2,
    levelCount: 3,
    retestWindowBars: 1,
    toleranceMode: "absolute",
    toleranceValue: 0.1
  });

  const candles = [
    mk(Date.UTC(2026, 0, 4, 9, 15), 95, 100, 90, 95),
    mk(Date.UTC(2026, 0, 4, 9, 20), 95, 101.2, 95.0, 100.7),
    mk(Date.UTC(2026, 0, 4, 9, 25), 100.8, 101.5, 100.3, 101.2),
    mk(Date.UTC(2026, 0, 4, 9, 30), 101.2, 101.8, 101.0, 101.6)
  ];

  for (const candle of candles) {
    engine.onCandleClose(candle);
  }

  assert.strictEqual(eventCount(engine, "setup_expired"), 1, "setup must expire when retest window is missed");
  assert.strictEqual(eventCount(engine, "trade_entered"), 0, "expired setup must not trade");
}

function runObserveModeScenario() {
  const engine = createGannRetestEngine({
    mode: "observe",
    step: 2,
    levelCount: 3,
    retestWindowBars: 3,
    toleranceMode: "absolute",
    toleranceValue: 0.25,
    oneTradePerLevel: true
  });

  const candles = [
    mk(Date.UTC(2026, 0, 5, 9, 15), 95, 100, 90, 95),
    mk(Date.UTC(2026, 0, 5, 9, 20), 95, 101, 94, 100.5),
    mk(Date.UTC(2026, 0, 5, 9, 25), 100.2, 100.3, 99.85, 100.1),
    mk(Date.UTC(2026, 0, 5, 9, 30), 100.15, 101.2, 100.05, 100.9),
    mk(Date.UTC(2026, 0, 5, 9, 35), 100.9, 101.3, 99.9, 100.8),
    mk(Date.UTC(2026, 0, 5, 9, 40), 100.8, 101.4, 99.95, 100.9)
  ];

  for (const candle of candles) {
    engine.onCandleClose(candle);
  }

  assert.strictEqual(eventCount(engine, "trade_entered"), 1, "observe mode should journal single simulated entry");
  assert.strictEqual(eventCount(engine, "level_broken"), 1, "oneTradePerLevel should block duplicate stale structure retrigger");
}

function runSessionResetScenario() {
  const engine = runLongScenario();
  engine.onCandleClose(mk(Date.UTC(2026, 0, 3, 9, 15), 96, 101, 91, 96));
  const status = engine.getStatus();

  assert.strictEqual(status.session.sessionKey, "2026-01-03", "session key should reset by day");
  assert.strictEqual(status.openTrade, null, "open trade should be cleared on session reset");
  assert.ok(Array.isArray(status.ladder), "new session should rebuild ladder");
}

function run() {
  runLadderChecks();
  runLongScenario();
  runNoTouchEntryScenario();
  runSetupExpiryScenario();
  runObserveModeScenario();
  runSessionResetScenario();
  console.log("replay_gann_retest tests passed");
}

run();
