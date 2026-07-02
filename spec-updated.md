# Gofer — Text-to-Buy Agent for Amazon

## Product & Technical Specification (v2 — TypeScript)

---

## 1. Overview

Gofer is a personal purchasing agent that runs on an always-on Mac Mini. The owner texts it a request via Telegram ("get a tiny glasses screwdriver"), it finds a good option on Amazon using the owner's logged-in account, proposes the product with image/price/rating, iterates based on feedback, and places the order only after explicit approval.

**Design philosophy:** single-file TypeScript service, minimal dependencies, no build step, deterministic code wherever money moves. The LLM makes _judgment calls_ (what does the user want, which product is best, what do these search results contain) — it never drives the browser and never decides to spend money.

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

While a proposal is pending, any plain-text message is treated as a refinement and triggers a re-rank or new search with merged constraints:

```
Gofer: [proposes $24.99 iFixit kit]
User:  too expensive, just need one tiny flathead
Gofer: [proposes $4.49 single precision flathead driver]
```

`🔄 Next option` shows the next-best candidate from the existing result set (no new page load).

### 2.3 Proposal lifecycle

- Proposals **expire after 6 hours**. Tapping a button on an expired proposal replies "That one's stale — ask me again" and returns to `IDLE`. (Prices and stock drift; a days-old ✅ shouldn't spend money.)
- Every proposal carries a random 6-char **nonce** embedded in its callback data. Button taps whose nonce doesn't match current state are ignored with a toast ("Stale button"). This makes double-taps and taps on _old_ proposal messages inert.
- After an order, cancel, or new proposal, the previous proposal message's buttons are removed via `editMessageReplyMarkup` so the chat never contains live money-spending buttons except on the current proposal.

### 2.4 Commands

| Command           | Behavior                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/start`          | Greeting + one-line usage hint                                                                                       |
| `/status`         | State, price caps, dry-run on/off, today's spend                                                                     |
| `/options`        | Compact list of top 5 remaining candidates ("1. $6.99 ⭐4.6 Mudder kit …"); replying with a number proposes that one |
| `/history`        | Last 5 entries from orders.jsonl                                                                                     |
| `/cancel`         | Abort current request, return to idle                                                                                |
| `/cap 150`        | Raise per-order cap **for the next order only**, then revert                                                         |
| `/dryrun on\|off` | Toggle dry-run at runtime                                                                                            |

Anything else is a purchase request (idle) or a refinement (proposal pending).

### 2.5 Voice notes (v1.1, not now)

Reply "Text only for now." Do not build transcription.

---

## 3. Architecture

One Node process running `gofer.ts` directly — **no build step** (see §3.2).

```
Telegram (long poll, raw fetch — no bot framework)
   │
   ▼
State machine (discriminated union, persisted to state.json)
   │
   ├─► Claude: intent parsing        (MODEL_FAST)
   ├─► Playwright: load search page  (persistent Chrome profile)
   ├─► Claude: HTML → product JSON   (MODEL_FAST)
   ├─► Claude: rank & choose         (MODEL_SMART)
   ├─► Telegram: proposal w/ buttons + nonce
   └─► Playwright: deterministic checkout (Buy Now → Place Order)
          │
          └─► orders.jsonl (append-only) + screenshots/
```

### 3.1 Dependencies

- **Runtime dep:** `playwright`. That's it.
- **Dev deps:** `typescript`, `@types/node` — for `tsc --noEmit` typechecking only. Playwright ships its own types.
- Telegram Bot API: raw `fetch` against `https://api.telegram.org/bot<TOKEN>/...`, `getUpdates` long polling (`timeout=50`). No webhook, no tunnel, no framework.
- Anthropic API: raw `fetch` against `https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`). No SDK.
- **No Zod / no schema library.** Claude's JSON outputs are validated with small hand-written type-guard functions (`isProduct(x): x is Product`) that check every field's type and shape. A failed guard = retry once with the validation error appended to the prompt, then give up gracefully with a user-facing message.

### 3.2 TypeScript without a build step

- Target **Node 24 LTS**, which runs `.ts` files directly via native type stripping: `node gofer.ts`.
- Consequence: **erasable syntax only** — no `enum`, no `namespace`, no constructor parameter properties. Use union string literals instead of enums (which is better anyway).
- `tsconfig.json`: `"strict": true`, `"erasableSyntaxOnly": true` (TS 5.8+; makes the compiler enforce the Node constraint), `"noEmit": true`, `"module": "nodenext"`, `"verbatimModuleSyntax": true`.
- `package.json` scripts: `"start": "node gofer.ts"`, `"check": "tsc --noEmit"`, `"login": "node gofer.ts --login"`.

### 3.3 Models

- **Intent parsing & HTML extraction:** `claude-haiku-4-5-20251001` (cheap, fast, structured output).
- **Ranking/selection & refinement merging:** `claude-sonnet-4-6`.
- Verify current model strings against https://docs.claude.com/en/api/overview before pinning; expose as `MODEL_FAST` / `MODEL_SMART` env overrides.

All Claude calls instruct: _"Respond with ONLY a JSON object, no markdown fences, no preamble."_ One shared helper `askClaude<T>(model, system, user, guard: (x: unknown) => x is T): Promise<T>` that: strips ```json fences defensively, parses, runs the guard, retries once on parse/guard failure (appending the error), and implements retry with exponential backoff + jitter on HTTP 429/500/529 (3 attempts, 60s request timeout via `AbortSignal.timeout`).

### 3.4 Configuration (env vars, loaded from `.env` by a 10-line hand-rolled parser — no dotenv)

| Var                          | Default            | Notes                                                                        |
| ---------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | —                  | required                                                                     |
| `ANTHROPIC_API_KEY`          | —                  | required                                                                     |
| `ALLOWED_CHAT_ID`            | —                  | required; integer                                                            |
| `PRICE_CAP_USD`              | `75`               | per-order cap                                                                |
| `DAILY_CAP_USD`              | `200`              | rolling same-calendar-day total, computed from orders.jsonl (excl. dry runs) |
| `DRY_RUN`                    | `true`             | **ships defaulted ON**                                                       |
| `PROFILE_DIR`                | `./chrome-profile` | Playwright persistent context                                                |
| `DATA_DIR`                   | `./data`           | state.json, orders.jsonl, screenshots/                                       |
| `MODEL_FAST` / `MODEL_SMART` | per §3.3           |                                                                              |

Validate all required vars at boot; exit with a clear message listing what's missing.

---

## 4. Core Types & State Machine

Model the state as a **discriminated union** so illegal states are unrepresentable — e.g. `PROPOSED` _cannot exist_ without candidates and a nonce:

```ts
type Constraints = { maxPrice: number | null; mustBePrime: boolean; notes: string[] }
type Request = { rawText: string; searchQuery: string; constraints: Constraints }

type Product = {
  asin: string // must match /^B0[A-Z0-9]{8}$/
  title: string
  price: number // USD
  rating: number | null
  reviewCount: number | null
  badges: string[]
  prime: boolean
  sponsored: boolean
  imageUrl: string | null
  deliveryEstimate: string | null
}

type AppState =
  | { tag: "IDLE" }
  | { tag: "SEARCHING"; request: Request }
  | {
      tag: "PROPOSED"
      request: Request
      candidates: Product[]
      proposedIndex: number
      nonce: string
      proposalMsgId: number
      capOverride: number | null
      expiresAt: string
    }
  | { tag: "ORDERING"; request: Request; product: Product; capOverride: number | null }
  | { tag: "NEEDS_HUMAN"; reason: string }
```

Transitions:

```
IDLE → SEARCHING → PROPOSED → ORDERING → IDLE
                      │  ▲
                      ▼  │ (refinement text)
                   SEARCHING
PROPOSED → IDLE (cancel / expiry / candidates exhausted)
ORDERING → NEEDS_HUMAN (CAPTCHA / unexpected page / crash recovery)
```

- Persist to `data/state.json` after **every** transition, via write-temp-then-rename (atomic; a crash mid-write must not corrupt state).
- The state file includes `"version": 2` for future migrations; unknown version at boot → back up the file, start `IDLE`, tell the user.
- **Crash recovery rule:** on boot, if persisted state is `ORDERING`, do **not** resume automation. Transition to `NEEDS_HUMAN`, send: "⚠️ I crashed mid-checkout. Check your Amazon orders before asking me to retry." `NEEDS_HUMAN` clears only via `/cancel`.
- In-memory mutex: one flow at a time; concurrent requests get "Finish or /cancel the current one first."

---

## 5. Component Specs

### 5.1 Telegram listener

- Long poll `getUpdates` with `timeout=50`, track `offset`. On network error: log, sleep 5s, resume.
- **Auth:** drop any update whose chat id ≠ `ALLOWED_CHAT_ID`. Log the attempt (chat id + first 50 chars). Never reply to strangers.
- Handle `message` (text) and `callback_query`. Always `answerCallbackQuery` (used for "Stale button" toasts too).
- Proposals via `sendPhoto` (caption + `inline_keyboard`); fall back to `sendMessage` if no image. Record the returned `message_id` in state for later button removal.
- Callback data: `order:<asin>:<nonce>`, `next:<nonce>`, `cancel:<nonce>`.
- Define a minimal `TelegramUpdate` type covering only the fields used; don't type the whole Bot API.

### 5.2 Intent parsing (Claude, MODEL_FAST)

Input: user text (+ prior `Request` if refining). Output (guard-validated):

```ts
type Intent = {
  isPurchaseRequest: boolean
  searchQuery: string // Amazon-optimized, not raw text
  constraints: Constraints
  newSearch: boolean // refinements: fresh search vs re-rank existing candidates
  reply: string | null // set when isPurchaseRequest=false: one short conversational reply
}
```

"Cheaper" or "the second one" should re-rank (`newSearch: false`); "actually I want a torx set" needs a fresh search.

### 5.3 Amazon search (Playwright + Claude extraction)

- `chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: 'chrome' })`. Headed on the logged-in Mac Mini session; real Chrome channel. Reuse one browser across requests; relaunch on disconnect.
- Navigate `https://www.amazon.com/s?k=<encoded query>`, wait for `networkidle` or 10s.
- **Login check:** sign-in form / `ap/signin` URL → `NEEDS_HUMAN`: "Amazon session expired. Run `npm run login` on the Mini."
- **Challenge check:** captcha markers (`Type the characters`, `/errors/validateCaptcha`) → screenshot → `sendPhoto` → `NEEDS_HUMAN`.
- **Extraction:** `page.content()` → strip `<script>`, `<style>`, `<svg>`, inline `style=` attrs, base64 data URIs; collapse whitespace; truncate to ~150 KB → MODEL_FAST → `Product[]` (up to 12, organic-leaning), each validated by the `Product` guard including the ASIN regex.

**Why LLM extraction instead of selectors:** Amazon's search markup churns constantly (A/B tests, sponsored slots, badge variants). HTML→JSON via Claude is immune to selector rot. The _checkout_ flow uses hardcoded selectors because that DOM is stable and determinism matters where money moves.

### 5.4 Ranking (Claude, MODEL_SMART)

Input: `Product[]` + `Request`. Output:

```ts
type Ranking = {
  rankedAsins: string[]
  rationale: string // one sentence about the top pick, user-facing
  warnings: string[] // e.g. "nothing well-reviewed under your cap"
}
```

Prompt guidance: prefer high rating × high review count, "Overall Pick" / "Amazon's Choice", Prime, non-sponsored; respect every stated constraint. Filter candidates over the effective per-order cap _before_ ranking. Guard verifies every ranked ASIN exists in the candidate set.

### 5.5 Checkout (deterministic Playwright — no LLM in the loop)

Triggered only by an `order:<asin>:<nonce>` tap whose nonce matches state and whose proposal hasn't expired. Steps, with a full-page screenshot saved to `data/screenshots/<ts>-<step>.png` after each:

1. Navigate `https://www.amazon.com/dp/<asin>`.
2. **Re-verify price** from the buybox. If it exceeds the proposed price by >10%, or exceeds the effective per-order cap, or would push today's total over `DAILY_CAP_USD` → abort, notify with numbers, return to `PROPOSED`.
3. Click `#buy-now-button`. Handle both outcomes:
   - Turbo-checkout iframe (`#turbo-checkout-iframe`) → `#turbo-checkout-pyo`.
   - Full checkout page → `[name="placeOrder"]` / `#placeOrder`.
4. **If `DRY_RUN`:** stop _before_ the place-order click. Screenshot the review page, send it: "🧪 Dry run — would have ordered here." Log with `dryRun: true`, return to `IDLE`.
5. Confirm success: thank-you page (`#widget-purchaseConfirmationStatus` or "Order placed" text). Extract order number (`\d{3}-\d{7}-\d{7}`).
6. Append to `data/orders.jsonl`: `{ts, asin, title, price, orderNumber, dryRun, requestText}`.
7. Notify with order number, price, delivery estimate; strip buttons from the proposal message.

**Any** unexpected page, missing selector, or timeout during checkout: screenshot → send → `NEEDS_HUMAN`. Never retry the Place Order click automatically. Quantity always 1. Default address and payment only — address/payment selection screens count as "unexpected page."

### 5.6 Login bootstrap

`npm run login`: opens the persistent context headed at amazon.com, prints "Log in (incl. 2FA, tick 'keep me signed in'), then press Enter," waits on stdin, verifies `#nav-link-accountList` shows an account name, exits.

---

## 6. Safety Rails (non-negotiable)

1. Orders happen **only** on an explicit `order:` tap matching the current ASIN **and nonce**, before proposal expiry.
2. Price enforced at four points: rank-time filter, proposal display, checkout re-verification, daily-cap check.
3. `/cap` overrides apply to one order, then revert.
4. Quantity hardcoded to 1.
5. `DRY_RUN=true` by default; turning it off is deliberate.
6. Single `ALLOWED_CHAT_ID`; everything else silently dropped and logged.
7. Append-only `orders.jsonl`; never deleted by the app.
8. Crash during `ORDERING` → `NEEDS_HUMAN`, never auto-resume.
9. One purchase flow at a time (mutex).
10. Stale proposal buttons are always disarmed (nonce + expiry + button removal).

---

## 7. Operations

- **launchd:** `com.brendan.gofer.plist` (KeepAlive, RunAtLoad, stdout/stderr → `data/gofer.log`), install one-liner in README.
- **Graceful shutdown:** on SIGTERM/SIGINT, stop polling, persist state, close the browser, exit 0 — plays nice with `launchctl unload` and deploys.
- **Logging:** single-line JSON to stdout: `{ts, level, event, ...}` with a small closed set of `event` names (`msg_in`, `search`, `propose`, `order_ok`, `order_abort`, `needs_human`, `auth_reject`, `claude_retry`). No log framework.
- **Screenshots:** prune >30 days old on boot.
- Requires a logged-in macOS GUI session (headed Chrome). README: disable display sleep, not system sleep.

---

## 8. Project Layout

```
gofer/
├── gofer.ts          # everything (~800–1000 lines, banner-commented sections:
│                     #   CONFIG / TYPES / TELEGRAM / CLAUDE / AMAZON / CHECKOUT / STATE / MAIN)
├── tsconfig.json     # strict, erasableSyntaxOnly, noEmit, nodenext
├── package.json      # dep: playwright; devDeps: typescript, @types/node
├── .env.example
├── com.brendan.gofer.plist
├── README.md         # bot token via @BotFather, npm run login, launchd install, flipping DRY_RUN
└── data/             # gitignored: state.json, orders.jsonl, screenshots/, gofer.log
```

Single file is a hard requirement.

---

## 9. Acceptance Criteria

1. `npm run check` (`tsc --noEmit`, strict) passes clean; `node gofer.ts` starts with no build step on Node 24.
2. `npm run login` completes and a subsequent search runs against the logged-in session.
3. "get a tiny glasses screwdriver" → proposal with photo, price, rating, review count, rationale, working buttons, in under ~30s.
4. "too expensive" while proposed → new proposal respecting merged constraints without a full page reload when re-ranking suffices.
5. `🔄 Next option` cycles candidates; `/options` lists top 5 and accepts a number reply.
6. Tapping ✅ on an _old_ proposal message (after a newer one exists) does nothing but a "Stale button" toast; tapping ✅ after 6h expiry safely declines.
7. Dry-run order: review-page screenshot delivered, `orders.jsonl` entry with `dryRun: true`, no order placed.
8. Live order (caps respected): real order number returned, logged, and buttons stripped from the proposal message.
9. Message from a different chat id: no reply, one `auth_reject` log line.
10. `kill -9` during checkout, restart → `NEEDS_HUMAN` warning, no automated resume; state.json intact (atomic writes).
11. Price-jump simulation → checkout aborts at re-verification with both prices in the message.
12. An order that would exceed `DAILY_CAP_USD` aborts with today's running total in the message.
13. `/status`, `/history`, `/cancel`, `/cap`, `/dryrun` behave per §2.4.

## 10. Out of Scope (v1)

Multi-quantity, multiple users/accounts, returns/refunds, post-confirmation order tracking, non-Amazon retailers, voice transcription, iMessage transport.
