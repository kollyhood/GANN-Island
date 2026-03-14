// config.js
export const DELTA_WS_URL   = process.env.DELTA_WS_URL   || "wss://socket.india.delta.exchange";
export const DELTA_API_BASE = process.env.DELTA_API_BASE || "https://api.india.delta.exchange";
export const DELTA_HISTORY_URL = process.env.DELTA_HISTORY_URL || "https://api.india.delta.exchange/v2/history/candles";

export const DELTA_API_KEY    = process.env.DELTA_API_KEY    || "KjHpEwTpbPLap9S7V18jwvqC9JF4NM";
export const DELTA_API_SECRET = process.env.DELTA_API_SECRET || "H2DDzDeBvsd0eaoKii9iUOEoUTDF9h4ue90UWfQBtMyUXhZnv2VTTXruWMxt";

export const SCALPER_FUTURE_SYMBOL = process.env.SYMBOL || "BTCUSD";
export const PRODUCT_ID = Number(process.env.PRODUCT_ID || 27);

export const PORT = Number(process.env.PORT || 8080);

// CORS
export const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";

export const VWAP_START_MIN = Number(process.env.VWAP_START_MIN || 480);  // 08:00 IST
export const VWAP_END_MIN   = Number(process.env.VWAP_END_MIN   || 1080); // 18:00 IST
