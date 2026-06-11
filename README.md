# Gofer

A personal text-to-buy agent for Amazon. Text it a request over Telegram ("get a tiny glasses screwdriver"), it finds a good option on your logged-in Amazon account, proposes it with photo/price/rating, iterates on feedback, and places the order only after you tap ✅ Order.

Single-file Node.js service (`gofer.js`), one npm dependency (`playwright`). The LLM makes judgment calls (intent, extraction, ranking) — deterministic code does everything where money moves. Single user, single Amazon account, single Telegram chat. **Not multi-tenant. Ever.**

## Setup

### 1. Create the Telegram bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the bot token.

### 2. Install

```sh
cd ~/Documents/code/gofer
npm install
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ALLOWED_CHAT_ID
```

Playwright uses your installed Google Chrome (`channel: 'chrome'`) — no browser download needed. To skip Playwright's bundled-browser download entirely: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`.

**Finding your chat id:** set the two tokens but leave `ALLOWED_CHAT_ID=0`, run `node gofer.js`, and send your bot any message. The log prints a single line like `{"event":"unauthorized_update","chatId":123456789,...}` — that number is your chat id. Put it in `.env` and restart. (Gofer silently drops and logs anything from other chats.)

### 3. Log in to Amazon

```sh
node gofer.js --login
```

A headed Chrome window opens at amazon.com using the persistent profile in `./chrome-profile`. Log in (including 2FA), tick **keep me signed in**, then press Enter in the terminal. The session persists across restarts.

### 4. Run it

```sh
node gofer.js
```

Text the bot. By default **`DRY_RUN=true`** — checkout walks all the way to the review page, screenshots it, sends it to you, and stops *before* clicking Place Order.

### 5. Install under launchd (always-on)

```sh
mkdir -p data && cp com.brendan.gofer.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.brendan.gofer.plist
```

Logs go to `data/gofer.log`. To stop: `launchctl unload ~/Library/LaunchAgents/com.brendan.gofer.plist`.

The Mac Mini needs a logged-in GUI session (Chrome runs headed). **Disable display sleep, not system sleep** — System Settings → Energy (or run `caffeinate -d`), and disable automatic system sleep so the poller keeps running.

## Flipping off dry-run

Two deliberate ways:

- Per session: send `/dryrun off` in Telegram (reverts to the `.env` value on restart).
- Permanently: set `DRY_RUN=false` in `.env` and restart.

## Commands

| Command | Behavior |
| --- | --- |
| `/start` | Greeting + usage hint |
| `/status` | State, pending proposal, price cap, dry-run on/off |
| `/cancel` | Abort current request (also clears the NEEDS_HUMAN safety lock) |
| `/cap 150` | Raise the price cap for the next order only, then revert |
| `/dryrun on\|off` | Toggle dry-run at runtime |

Anything else is a purchase request (when idle) or a refinement (while a proposal is pending). The 🔄 Next option button cycles through the already-fetched candidates without a new Amazon search.

## Safety rails

1. Orders happen **only** on an explicit ✅ Order tap matching the currently proposed ASIN.
2. Price cap enforced three times: rank-time filter, proposal display, checkout re-verification (aborts if the buybox price exceeds the cap or jumped >10% over the proposed price).
3. `/cap` overrides last for one order.
4. Quantity hardcoded to 1; default address and payment only — anything else counts as an unexpected page and stops.
5. `DRY_RUN=true` by default.
6. Single `ALLOWED_CHAT_ID`; everything else silently dropped and logged.
7. `data/orders.jsonl` is append-only.
8. A crash during checkout never auto-resumes — on restart Gofer enters NEEDS_HUMAN and tells you to check your Amazon orders. Only `/cancel` clears it.

## Files

```
gofer.js                  # the whole service
com.brendan.gofer.plist   # launchd job
data/                     # gitignored: state.json, orders.jsonl, screenshots/, gofer.log
chrome-profile/           # gitignored: persistent logged-in Chrome profile
```

Screenshots older than 30 days are pruned on boot.

## Tests

```sh
npm test
```

Runs the offline suite in `gofer.test.js` (node's built-in test runner): pure helpers, state machine transitions, auth dropping, command handling, the full search→propose pipeline against mocked Telegram/Anthropic APIs, and dry-run / price-jump / live-confirm checkout flows against a fake page. No network, no real browser.
