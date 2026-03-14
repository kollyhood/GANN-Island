# SILVERBEES Stack Assessment (Repo Investigation)

## Scope checked
- Backend service implementation (`server.js`, `brokers/`, `engine/`, `lib/`).
- API docs (`REST_ENDPOINTS.md`, `SERVER_SPEC.md`).
- Presence/absence of WordPress card HTML/CSS/JS templates in-repo.

## Verdict
- **Market-data backend exists and is mostly read-oriented for UI consumers** via `GET` status/debug endpoints.
- **Backend is not strictly read-only overall** because it includes `POST /broker/login` and broker order methods (`buy`/`sell`) behind a `liveEnabled` gate.
- **WordPress Custom HTML card stack is not present in this repository**; only backend CORS/docs explicitly target WordPress as an external consumer.
- **SILVERBEES focus is present** in broker config (`tradingsymbol: SILVERBEES-EQ`) and quote handling comments/examples.

## Evidence found
1. Backend API endpoints for read/poll use-cases (`/health`, `/broker/status`, `/debug/parsed`, `/debug/vwap`, `/debug/candle`, `/signals`).
2. CORS allows `https://investingkriya.in`, indicating intended WordPress integration.
3. Daily login action exists (`POST /broker/login`) and is documented as required for websocket ticks.
4. Trading path exists but is safety-gated:
   - `liveEnabled: false` in runtime config.
   - broker `buy`/`sell` are ignored in paper-gated mode and only place orders when `liveEnabled=true` and login constraints pass.
5. No WordPress plugin/theme assets or Custom HTML card files found in this repo.

## Practical interpretation for your question
- If your requirement is **"read-only market-data backend"** for a WordPress dashboard, this repo can serve that role now (polling read endpoints).
- If your requirement is **strictly no state-changing actions exposed**, you should hard-disable/remove `POST /broker/login` and any order routes/method wiring in production deployment.
- If your requirement includes a **"WordPress Custom HTML card stack" inside this repo**, that part is currently missing and appears to live separately in the WordPress site/editor.

## Suggested next steps (optional)
1. Add a `READ_ONLY_MODE=true` switch that:
   - disables `/broker/login`,
   - blocks any future order endpoints,
   - and returns explicit `readOnly:true` in `/health`.
2. Add a `wordpress/` folder with versioned Custom HTML/CSS/JS card snippets so UI and backend evolve together.
3. Add an endpoint contract doc specifically for the SILVERBEES card data model (fields, types, polling intervals, stale data behavior).
