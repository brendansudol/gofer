# Gofer — Text-to-Buy Agent for Amazon

## Product & Technical Specification (v1)

---

## 1. Overview

Gofer is a personal purchasing agent that runs on an always-on Mac Mini. The owner texts it a request via Telegram ("get a tiny glasses screwdriver"), it finds a good option on Amazon using the owner's logged-in account, proposes the product with image/price/rating, iterates based on feedback, and places the order only after explicit approval.

**Design philosophy:** single-file Node.js service, minimal dependencies, deterministic code wherever money moves. The LLM makes _judgment calls_ (what does the user want, which product is best, what do these search results contain) — it never drives the browser and never decides to spend money.

**Single user, single Amazon account, single Telegram chat. Not multi-tenant. Ever.**

---

## 2. User Experience

### 2.1 Happy path

```
User:  get a tiny glasses screwdriver
Gofer: 🔍 Searching Amazon for: precision eyeglass screwdriver…
Gofer: [product photo]
       Mudder 11-Piece Eyeglass Repair Kit — $6.99 ✅ Prime
       ⭐ 4.6 (14,203 reviews) · Amazon's Choice
       Why: Highest-rated dedicated eyeglass kit under your cap;
       includes multiple driver sizes and spare screws.
       Arrives: tomorrow
       [✅ Order]  [🔄 Next option]  [❌ Cancel]
User:  taps ✅ Order
Gofer: 🛒 Placing order…
Gofer: ✅ Ordered! #112-4729104-7741034 — $6.99, arriving Thu Jun 11.
```

### 2.2 Refinement path

While a proposal is pending, any plain-text message is treated as a refinement and triggers a new search/re-rank with merged constraints:

```
Gofer: [proposes $24.99 iFixit kit]
User:  too expensive, just need one tiny flathead
Gofer: [proposes $4.49 single precision flathead driver]
```

`🔄 Next option` shows the next-best candidate from the existing result set (no new search).

### 2.3 Commands

| Command           | Behavior                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `/start`          | Greeting + one-line usage hint                                                               |
| `/status`         | Current state: pending proposal, in-flight order, or idle; current price cap; dry-run on/off |
| `/cancel`         | Abort the current request, return to idle                                                    |
| `/cap 150`        | Raise price cap **for the next order only**, then revert to default                          |
| `/dryrun on\|off` | Toggle dry-run mode at runtime                                                               |

Anything else is treated as a purchase request (idle) or a refinement (proposal pending).

### 2.4 Voice notes (nice-to-have, v1.1)

If a Telegram voice message arrives, reply: "Text only for now." Do not build transcription in v1.

---

## 3. Architecture

One Node.js process (`gofer.js`), long-running under `launchd`.

```
Telegram (long poll, raw fetch — no bot framework)
   │
   ▼
State machine (per-chat, persisted to state.json)
   │
   ├─► Claude: intent parsing        (Haiku)
   ├─► Playwright: load search page  (persistent Chrome profile)
   ├─► Claude: HTML → product JSON   (Haiku)
   ├─► Claude: rank & choose         (Sonnet)
   ├─► Telegram: proposal w/ buttons
   └─► Playwright: deterministic checkout (Buy Now → Place Order)
          │
          └─► orders.jsonl (append-only) + screenshots/
```

### 3.1 Dependencies

- `playwright` — the only npm dependency.
- Telegram Bot API: raw `fetch` against `https://api.telegram.org/bot<TOKEN>/...` using `getUpdates` long polling (timeout=50). No webhook, no tunnel, no framework.
- Anthropic API: raw `fetch` against `https://api.anthropic.com/v1/messages` (header `x-api-key`, `anthropic-version: 2023-06-01`). No SDK.

### 3.2 Models

- **Intent parsing & HTML extraction:** `claude-haiku-4-5-20251001` (cheap, fast, structured output).
- **Ranking/selection & refinement merging:** `claude-sonnet-4-6`.
- Verify current model strings against https://docs.claude.com/en/api/overview before pinning; expose both as env overrides (`MODEL_FAST`, `MODEL_SMART`).

All Claude calls instruct: _"Respond with ONLY a JSON object, no markdown fences, no preamble."_ Wrap parsing in a helper that strips ```json fences defensively and retries once on parse failure.

### 3.3 Configuration (env vars, loaded from `.env` by hand — no dotenv dep)

| Var                          | Default            | Notes                                  |
| ---------------------------- | ------------------ | -------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | —                  | required                               |
| `ANTHROPIC_API_KEY`          | —                  | required                               |
| `ALLOWED_CHAT_ID`            | —                  | required; integer                      |
| `PRICE_CAP_USD`              | `75`               | default per-order cap                  |
| `DRY_RUN`                    | `true`             | **ships defaulted ON**                 |
| `PROFILE_DIR`                | `./chrome-profile` | Playwright persistent context          |
| `DATA_DIR`                   | `./data`           | state.json, orders.jsonl, screenshots/ |
| `MODEL_FAST` / `MODEL_SMART` | per §3.2           |                                        |

---

## 4. State Machine

States (persisted to `data/state.json` after every transition):

```
IDLE → SEARCHING → PROPOSED → ORDERING → IDLE
                      │  ▲
                      ▼  │ (refinement text)
                   SEARCHING
PROPOSED → IDLE (cancel / 10 candidates exhausted)
ORDERING → NEEDS_HUMAN (CAPTCHA / unexpected page / crash recovery)
```

State record:

```json
{
  "state": "PROPOSED",
  "request": {
    "query": "precision eyeglass screwdriver",
    "constraints": { "maxPrice": 75, "notes": [] }
  },
  "candidates": [
    /* ranked product list */
  ],
  "proposedIndex": 0,
  "capOverride": null,
  "updatedAt": "2026-06-10T14:03:22Z"
}
```

**Crash recovery rule:** on boot, if persisted state is `ORDERING`, do **not** resume automation. Transition to `NEEDS_HUMAN`, send: "⚠️ I crashed mid-checkout. Check your Amazon orders before asking me to retry." `NEEDS_HUMAN` clears only via `/cancel`.

---

## 5. Component Specs

### 5.1 Telegram listener

- Long poll `getUpdates` with `timeout=50`, track `offset`. On network error: log, sleep 5s, resume.
- **Auth:** drop any update whose chat id ≠ `ALLOWED_CHAT_ID`. Log the attempt (chat id + first 50 chars). Never reply to strangers.
- Handle `message` (text) and `callback_query` (buttons). Always `answerCallbackQuery` to clear the spinner.
- Proposals sent via `sendPhoto` (product image URL) with caption + `inline_keyboard`. If no image URL, fall back to `sendMessage`.
- Buttons carry callback data: `order:<asin>`, `next`, `cancel`.

### 5.2 Intent parsing (Claude, MODEL_FAST)

Input: user text (+ prior constraints if refining). Output:

```json
{
  "searchQuery": "precision eyeglass screwdriver",
  "constraints": { "maxPrice": null, "mustBePrime": true, "notes": ["tiny", "for glasses"] },
  "isPurchaseRequest": true
}
```

- `searchQuery` is an _Amazon-optimized_ query, not the raw text.
- If `isPurchaseRequest` is false (user is chatting/asking a question), reply conversationally with one short message; don't search.
- Refinements: pass previous request + new message; Claude returns the _merged_ request and whether a fresh search is needed (`"newSearch": true`) vs. re-ranking existing candidates (e.g. "cheaper" can often re-rank).

### 5.3 Amazon search (Playwright + Claude extraction)

- `chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: 'chrome' })`. Headed mode on the logged-in Mac Mini session; real Chrome channel. Reuse one browser across requests; relaunch on disconnect.
- Navigate `https://www.amazon.com/s?k=<encoded query>`, wait for `networkidle` or 10s.
- **Login check:** if page contains sign-in form / `ap/signin` URL → `NEEDS_HUMAN`, message: "Amazon session expired. Run `node gofer.js --login` on the Mini."
- **Challenge check:** if page contains captcha markers (`Type the characters`, `/errors/validateCaptcha`) → screenshot → `sendPhoto` to user → `NEEDS_HUMAN`.
- **Extraction:** take `page.content()`, strip `<script>`, `<style>`, `<svg>`, inline `style=` attrs, and base64 data URIs; collapse whitespace; truncate to ~150 KB. Send to MODEL_FAST:

```json
[
  {
    "asin": "B01GIJBCKW",
    "title": "...",
    "price": 6.99,
    "rating": 4.6,
    "reviewCount": 14203,
    "badges": ["Amazon's Choice"],
    "prime": true,
    "sponsored": false,
    "imageUrl": "https://...",
    "deliveryEstimate": "Tomorrow"
  }
]
```

Extract up to 12 organic-leaning results. ASIN must match `^B0[A-Z0-9]{8}$`.

**Why LLM extraction instead of selectors:** Amazon's search markup churns constantly (A/B tests, sponsored slots, badge variants). HTML→JSON via Claude is immune to selector rot. The _checkout_ flow uses hardcoded selectors because that DOM is stable and determinism matters where money moves.

### 5.4 Ranking (Claude, MODEL_SMART)

Input: candidate JSON + full request/constraints. Output:

```json
{
  "ranked": ["B01...", "B07...", "..."],
  "topPick": { "asin": "B01...", "rationale": "one sentence, user-facing" },
  "warnings": []
}
```

Ranking guidance in the prompt: prefer high rating × high review count, "Overall Pick" / "Amazon's Choice" badges, Prime, non-sponsored; respect every stated constraint; flag in `warnings` if nothing under the cap fits well. Filter out anything over the effective price cap _before_ ranking.

### 5.5 Checkout (deterministic Playwright — no LLM in the loop)

Triggered only by an `order:<asin>` button tap. Steps, with a full-page screenshot saved to `data/screenshots/<ts>-<step>.png` after each:

1. Navigate `https://www.amazon.com/dp/<asin>`.
2. **Re-verify price** from the buybox. If it exceeds the proposed price by >10% or exceeds the effective cap → abort, notify with both prices, return to `PROPOSED`.
3. Click `#buy-now-button`. Handle both outcomes:
   - Turbo-checkout iframe (`#turbo-checkout-iframe`) → click `#turbo-checkout-pyo`.
   - Full checkout page → click `[name="placeOrder"]` / `#placeOrder`.
4. **If `DRY_RUN`:** stop _before_ the place-order click. Screenshot the review page, send it: "🧪 Dry run — would have ordered here." Return to `IDLE`, log to orders.jsonl with `"dryRun": true`.
5. Confirm success: thank-you page (`#widget-purchaseConfirmationStatus` or text "Order placed"). Extract order number (`\d{3}-\d{7}-\d{7}`).
6. Append to `data/orders.jsonl`: `{ts, asin, title, price, orderNumber, dryRun, requestText}`.
7. Notify user with order number, price, delivery estimate.

**Any** unexpected page, missing selector, or timeout during checkout: screenshot → send to user → `NEEDS_HUMAN`. Never retry the Place Order click automatically. Quantity is always 1. Default address and payment method only — address/payment selection screens count as "unexpected page."

### 5.6 Login bootstrap

`node gofer.js --login`: opens the persistent context headed at amazon.com, prints "Log in (incl. 2FA, tick 'keep me signed in'), then press Enter," waits for stdin, verifies an account element (`#nav-link-accountList` shows a name), saves, exits.

---

## 6. Safety Rails (non-negotiable)

1. Orders happen **only** on an explicit `order:<asin>` button tap matching the currently proposed ASIN.
2. Price cap enforced at three points: rank-time filter, proposal display, checkout re-verification.
3. `/cap` overrides apply to one order, then revert.
4. Quantity hardcoded to 1.
5. `DRY_RUN=true` by default; flipping it off is a deliberate act.
6. Single `ALLOWED_CHAT_ID`; everything else is silently dropped and logged.
7. Append-only `orders.jsonl`; never deleted by the app.
8. Crash during `ORDERING` → `NEEDS_HUMAN`, never auto-resume (§4).
9. In-memory mutex: one purchase flow at a time; concurrent requests get "Finish or /cancel the current one first."

---

## 7. Operations

- **launchd:** provide `com.brendan.gofer.plist` (KeepAlive, RunAtLoad, stdout/stderr → `data/gofer.log`). Include install one-liner in README.
- **Logging:** single-line JSON events to stdout `{ts, level, event, ...}`. No log framework.
- **Screenshots:** prune files older than 30 days on boot.
- Requires a logged-in macOS GUI session (headed Chrome). Note in README: disable display sleep, not system sleep (`caffeinate` or Energy settings).

---

## 8. Project Layout

```
gofer/
├── gofer.js          # everything (~600–800 lines, organized in clearly commented sections)
├── package.json      # dep: playwright
├── .env.example
├── com.brendan.gofer.plist
├── README.md         # setup: bot token via @BotFather, --login, launchd install, flipping DRY_RUN
└── data/             # gitignored: state.json, orders.jsonl, screenshots/, gofer.log
```

Single file is a hard requirement. Section it with banner comments: CONFIG / TELEGRAM / CLAUDE / AMAZON / CHECKOUT / STATE / MAIN.

---

## 9. Acceptance Criteria

1. `--login` flow completes and a subsequent search request runs against the logged-in session.
2. "get a tiny glasses screwdriver" → proposal with photo, price, rating, review count, rationale, and three working buttons, in under ~30s.
3. "too expensive" while proposed → new proposal respecting the merged constraint.
4. `🔄 Next option` cycles candidates without a new Amazon page load.
5. Dry-run order: review-page screenshot delivered, `orders.jsonl` entry with `dryRun: true`, no order placed.
6. Live order (cap respected): real order number returned and logged.
7. Message from a different chat id: no reply, one log line.
8. Kill -9 during checkout, restart → `NEEDS_HUMAN` warning message, no automated resume.
9. Price-jump simulation (propose, then cap set below price via state edit) → checkout aborts at re-verification.
10. `/status`, `/cancel`, `/cap`, `/dryrun` all behave per §2.3.

## 10. Out of Scope (v1)

Multi-quantity, multiple users/accounts, returns/refunds, order tracking after confirmation, non-Amazon retailers, voice transcription, iMessage transport.
