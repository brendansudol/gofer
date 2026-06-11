#!/usr/bin/env node
/* =============================================================================
 * gofer.js — Gofer: a text-to-buy agent for Amazon, driven over Telegram.
 *
 * One process, one file. Sections:
 *   CONFIG    .env loading + runtime config
 *   LOG       single-line JSON logging to stdout
 *   STATE     persisted state machine (data/state.json) + orders.jsonl
 *   TELEGRAM  raw Bot API via fetch (getUpdates long polling, no framework)
 *   CLAUDE    raw Anthropic API via fetch (intent / extraction / ranking)
 *   AMAZON    Playwright search + HTML hygiene (the LLM never drives the browser)
 *   CHECKOUT  deterministic Buy Now → Place Order (no LLM in the loop)
 *   HANDLERS  Telegram update routing, commands, proposal flow
 *   MAIN      boot, crash recovery, --login, poll loop
 * ============================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/* =============================================================================
 * CONFIG
 * ============================================================================= */

export function parseEnvText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const parsed = parseEnvText(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile();

export const cfg = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  allowedChatId: Number(process.env.ALLOWED_CHAT_ID),
  priceCap: Number(process.env.PRICE_CAP_USD || 75),
  dryRun: (process.env.DRY_RUN ?? 'true') !== 'false', // ships defaulted ON
  profileDir: process.env.PROFILE_DIR || './chrome-profile',
  dataDir: process.env.DATA_DIR || './data',
  modelFast: process.env.MODEL_FAST || 'claude-haiku-4-5-20251001',
  modelSmart: process.env.MODEL_SMART || 'claude-sonnet-4-6',
};

function requireConfig() {
  const missing = [];
  if (!cfg.token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!cfg.anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (!Number.isFinite(cfg.allowedChatId)) missing.push('ALLOWED_CHAT_ID');
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')} (see .env.example)`);
    process.exit(1);
  }
}

/* =============================================================================
 * LOG
 * ============================================================================= */

export function log(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GoferError extends Error {
  constructor(kind, message, screenshot = null) {
    super(message);
    this.kind = kind; // 'LOGIN' | 'CAPTCHA' | 'CHECKOUT'
    this.screenshot = screenshot;
  }
}

/* =============================================================================
 * STATE
 *
 * IDLE → SEARCHING → PROPOSED → ORDERING → IDLE
 * PROPOSED → SEARCHING (refinement) ; PROPOSED → IDLE (cancel / exhausted)
 * ORDERING → NEEDS_HUMAN (captcha / unexpected page / crash recovery)
 * NEEDS_HUMAN clears only via /cancel.
 * ============================================================================= */

export const state = {
  state: 'IDLE',
  request: null, // { raw, query, constraints: { maxPrice, mustBePrime, notes } }
  candidates: [],
  proposedIndex: 0,
  capOverride: null,
  updatedAt: null,
};

const statePath = () => path.join(cfg.dataDir, 'state.json');

export function loadState() {
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(statePath(), 'utf8')));
  } catch {
    /* first boot or corrupt state — start IDLE */
  }
}

export function saveState() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function setState(next, patch = {}) {
  Object.assign(state, patch, { state: next, updatedAt: new Date().toISOString() });
  saveState();
  log('info', 'state', { state: next });
}

export function effectiveCap() {
  return state.capOverride ?? cfg.priceCap;
}

export function appendOrder(entry) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.appendFileSync(path.join(cfg.dataDir, 'orders.jsonl'), JSON.stringify(entry) + '\n');
}

export function pruneScreenshots(maxAgeDays = 30) {
  const dir = path.join(cfg.dataDir, 'screenshots');
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  let pruned = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.unlinkSync(p);
        pruned++;
      }
    } catch { /* file vanished — ignore */ }
  }
  if (pruned) log('info', 'pruned_screenshots', { pruned });
  return pruned;
}

/* =============================================================================
 * TELEGRAM
 * ============================================================================= */

export const tg = {
  async call(method, params = {}) {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  },

  send(text, extra = {}) {
    return tg.call('sendMessage', { chat_id: cfg.allowedChatId, text, ...extra });
  },

  sendPhoto(photoUrl, caption, replyMarkup) {
    return tg.call('sendPhoto', {
      chat_id: cfg.allowedChatId,
      photo: photoUrl,
      caption,
      reply_markup: replyMarkup,
    });
  },

  // Local-file variant (screenshots) — multipart upload.
  async sendPhotoFile(filePath, caption) {
    const form = new FormData();
    form.append('chat_id', String(cfg.allowedChatId));
    if (caption) form.append('caption', caption);
    form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram sendPhoto(file) failed: ${data.description || res.status}`);
    return data.result;
  },
};

let pollOffset = 0;

async function pollLoop() {
  log('info', 'polling_started', {});
  for (;;) {
    try {
      const updates = await tg.call('getUpdates', {
        timeout: 50,
        offset: pollOffset,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const update of updates) {
        pollOffset = update.update_id + 1;
        await handleUpdate(update).catch((err) =>
          log('error', 'handle_update_failed', { error: String(err?.stack || err) }),
        );
      }
    } catch (err) {
      log('error', 'poll_failed', { error: String(err) });
      await sleep(5000);
    }
  }
}

/* =============================================================================
 * CLAUDE — raw fetch against /v1/messages. The LLM makes judgment calls only:
 * it never drives the browser and never decides to spend money.
 * ============================================================================= */

export function parseJSONLoose(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!(t.startsWith('{') || t.startsWith('['))) {
    const m = t.match(/[\{\[][\s\S]*[\}\]]/);
    if (m) t = m[0];
  }
  return JSON.parse(t);
}

async function claudeText(model, system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function claudeJSON(model, system, user, maxTokens = 1024) {
  const sys = system + '\nRespond with ONLY a JSON value, no markdown fences, no preamble.';
  let text = await claudeText(model, sys, user, maxTokens);
  try {
    return parseJSONLoose(text);
  } catch {
    log('warn', 'claude_json_retry', { model });
    text = await claudeText(
      model,
      sys + '\nYour previous reply was not valid JSON. Reply with strictly valid JSON only.',
      user,
      maxTokens,
    );
    return parseJSONLoose(text);
  }
}

export const claude = {
  parseIntent(text, prevRequest) {
    const system = `You parse messages sent to "Gofer", a personal Amazon purchasing agent.
Decide whether the message is a purchase request (or a refinement of a pending one) and produce an Amazon-optimized search query.
Output JSON with exactly these fields:
{"isPurchaseRequest": boolean, "searchQuery": string, "constraints": {"maxPrice": number|null, "mustBePrime": boolean, "notes": string[]}, "newSearch": boolean, "reply": string|null}
- searchQuery: an Amazon search query optimized for finding the right product, not the user's raw words.
- constraints.notes: short phrases capturing requirements (size, color, material, use case).
- If the message is NOT a purchase request (small talk, a question), set isPurchaseRequest=false and put one short friendly sentence in "reply"; leave searchQuery as "".
- newSearch: when refining a previous request, true if a fresh Amazon search is needed, false if the existing result set can simply be re-ranked (e.g. "cheaper", "the higher rated one"). For brand-new requests always true.`;
    const user = prevRequest
      ? `Previous request: ${JSON.stringify(prevRequest)}\nNew message from user: ${text}\nReturn the MERGED request (previous constraints updated by the new message).`
      : `Message from user: ${text}`;
    return claudeJSON(cfg.modelFast, system, user, 1024);
  },

  extractProducts(html) {
    const system = `You extract product data from the HTML of an Amazon search results page.
Return a JSON array of up to 12 organic-leaning results:
[{"asin": "B0XXXXXXXX", "title": string, "price": number|null, "rating": number|null, "reviewCount": number|null, "badges": [string], "prime": boolean, "sponsored": boolean, "imageUrl": string|null, "deliveryEstimate": string|null}]
- asin must match ^B0[A-Z0-9]{8}$ (found in data-asin attributes or /dp/ links).
- price: the main offer price in USD as a plain number.
- badges: e.g. "Amazon's Choice", "Overall Pick", "Best Seller".
- Prefer organic results over sponsored ones; mark sponsored listings "sponsored": true.
- imageUrl: the main product image URL.
- deliveryEstimate: e.g. "Tomorrow" or "Thu, Jun 11" if shown.`;
    return claudeJSON(cfg.modelFast, system, `HTML:\n${html}`, 4096);
  },

  rank(candidates, request, cap) {
    const system = `You rank Amazon product candidates for a purchasing agent.
Output JSON: {"ranked": ["ASIN", ...], "topPick": {"asin": string, "rationale": string}, "warnings": [string]}
- Prefer high rating × high review count, "Overall Pick" / "Amazon's Choice" badges, Prime, non-sponsored.
- Respect every stated constraint in the request.
- rationale: ONE user-facing sentence explaining why the top pick fits this request.
- warnings: flag if nothing under the $${cap} cap fits the request well. Empty array otherwise.`;
    const user = `Request: ${JSON.stringify(request)}\nPrice cap: $${cap}\nCandidates:\n${JSON.stringify(candidates)}`;
    return claudeJSON(cfg.modelSmart, system, user, 1024);
  },
};

export function validateProducts(arr) {
  if (!Array.isArray(arr)) return [];
  const numOrNull = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[$,]/g, ''));
      if (v.trim() && Number.isFinite(n)) return n;
    }
    return null;
  };
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    if (!p || typeof p.asin !== 'string' || !/^B0[A-Z0-9]{8}$/.test(p.asin)) continue;
    if (seen.has(p.asin)) continue;
    seen.add(p.asin);
    out.push({
      asin: p.asin,
      title: String(p.title || '').slice(0, 300),
      price: numOrNull(p.price),
      rating: numOrNull(p.rating),
      reviewCount: numOrNull(p.reviewCount),
      badges: Array.isArray(p.badges) ? p.badges.map(String) : [],
      prime: !!p.prime,
      sponsored: !!p.sponsored,
      imageUrl: typeof p.imageUrl === 'string' && p.imageUrl.startsWith('http') ? p.imageUrl : null,
      deliveryEstimate: p.deliveryEstimate ? String(p.deliveryEstimate) : null,
    });
    if (out.length >= 12) break;
  }
  return out;
}

/* =============================================================================
 * AMAZON — Playwright drives a persistent, headed, real-Chrome profile.
 * HTML→JSON goes through Claude (immune to selector rot); checkout does not.
 * ============================================================================= */

export function cleanHtml(html, maxBytes = 300_000) {
  const h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/data:[a-z/+.;=-]+base64,[A-Za-z0-9+/=]+/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ');
  return h.length > maxBytes ? h.slice(0, maxBytes) : h;
}

async function screenshot(page, step) {
  const dir = path.join(cfg.dataDir, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${step}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function firstText(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const text = ((await loc.textContent()) || '').trim();
        if (text) return text;
      }
    } catch { /* try next selector */ }
  }
  return null;
}

let browserCtx = null;

export const amazon = {
  async context() {
    if (browserCtx) return browserCtx;
    log('info', 'launching_browser', { profile: cfg.profileDir });
    browserCtx = await chromium.launchPersistentContext(cfg.profileDir, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1366, height: 900 },
    });
    browserCtx.on('close', () => {
      log('warn', 'browser_closed', {});
      browserCtx = null; // relaunch on next use
    });
    return browserCtx;
  },

  async page() {
    const ctx = await amazon.context();
    return ctx.pages()[0] || (await ctx.newPage());
  },

  async search(query) {
    const page = await amazon.page();
    await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const url = page.url();
    const html = await page.content();
    if (url.includes('/ap/signin') || /id="ap_email"|name="signIn"/.test(html)) {
      throw new GoferError('LOGIN', 'Amazon session expired. Run `node gofer.js --login` on the Mini.');
    }
    if (/Type the characters|\/errors\/validateCaptcha/.test(html)) {
      const shot = await screenshot(page, 'captcha');
      throw new GoferError('CAPTCHA', 'Amazon is showing a CAPTCHA — solve it in the Chrome window on the Mini, then /cancel and retry.', shot);
    }
    // The full page runs ~1MB cleaned; truncating it from the top loses most of the
    // result grid. Send only the per-product result blocks, which hold exactly the
    // ASIN/title/price/rating markup the extractor needs.
    const blocks = await page
      .$$eval('div[data-component-type="s-search-result"]', (els) => {
        const SPONSORED =
          '.puis-sponsored-label-text, .s-sponsored-label-text, ' +
          '[data-component-type="sp-sponsored-result"], a[aria-label*="Sponsored" i]';
        const isAd = (el) => el.querySelector(SPONSORED) || /\bSponsored\b/.test(el.innerText);
        const organic = els.filter((el) => !isAd(el));
        // If somehow every result is an ad, keep them rather than return nothing —
        // the extractor still tags sponsored:true and the ranker deprioritizes.
        return (organic.length ? organic : els).slice(0, 20).map((el) => el.outerHTML);
      })
      .catch(() => []);
    if (blocks.length) {
      return blocks.map((b) => cleanHtml(b, 12_000)).join('\n');
    }
    log('warn', 'search_result_blocks_missed', { query });
    return cleanHtml(html);
  },
};

/* =============================================================================
 * CHECKOUT — deterministic Playwright, hardcoded selectors, quantity always 1.
 * Triggered only by an order:<asin> button tap matching the proposed ASIN.
 * ============================================================================= */

export function parsePrice(text) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

export function verifyPriceOk(proposedPrice, actualPrice, cap) {
  if (actualPrice == null) return { ok: false, reason: 'could not read the current buybox price' };
  if (actualPrice > cap) return { ok: false, reason: `current price $${actualPrice} exceeds the $${cap} cap` };
  if (proposedPrice != null && actualPrice > proposedPrice * 1.1) {
    return { ok: false, reason: `price jumped more than 10% — proposed $${proposedPrice}, now $${actualPrice}` };
  }
  return { ok: true };
}

const PRICE_SELECTORS = [
  '#corePrice_feature_div .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .a-offscreen',
  '#price_inside_buybox',
  '#newBuyBoxPrice',
  '.a-price .a-offscreen',
];

async function checkout(candidate) {
  const cap = effectiveCap();
  setState('ORDERING');
  await tg.send('🛒 Placing order…');
  const page = await amazon.page();
  try {
    // 1. Product page
    await page.goto(`https://www.amazon.com/dp/${candidate.asin}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await screenshot(page, 'product');

    // 2. Re-verify price from the buybox (third enforcement point for the cap)
    const actual = parsePrice(await firstText(page, PRICE_SELECTORS));
    const check = verifyPriceOk(candidate.price, actual, cap);
    if (!check.ok) {
      await screenshot(page, 'price-abort');
      setState('PROPOSED');
      await tg.send(
        `⚠️ Order aborted at price check: ${check.reason}. Proposed $${candidate.price}, current ${actual == null ? 'unknown' : '$' + actual}. Still proposed — refine, /cap, or ❌ Cancel.`,
      );
      return;
    }

    // 3. Buy Now, then handle turbo-iframe vs full checkout page
    await page.click('#buy-now-button', { timeout: 10_000 });
    await page.waitForSelector('#turbo-checkout-iframe, [name="placeOrder"], #placeOrder', {
      timeout: 20_000,
    });
    await screenshot(page, 'buy-now');

    let clickPlaceOrder;
    if (await page.locator('#turbo-checkout-iframe').count()) {
      const frame = page.frameLocator('#turbo-checkout-iframe');
      await frame.locator('#turbo-checkout-pyo').waitFor({ timeout: 15_000 });
      clickPlaceOrder = () => frame.locator('#turbo-checkout-pyo').click();
    } else {
      const sel = '[name="placeOrder"], #placeOrder';
      await page.locator(sel).first().waitFor({ timeout: 15_000 });
      clickPlaceOrder = () => page.locator(sel).first().click();
    }
    const reviewShot = await screenshot(page, 'review');

    // 4. Dry run stops BEFORE the place-order click
    if (cfg.dryRun) {
      appendOrder({
        ts: new Date().toISOString(),
        asin: candidate.asin,
        title: candidate.title,
        price: actual,
        orderNumber: null,
        dryRun: true,
        requestText: state.request?.raw ?? null,
      });
      setState('IDLE', { request: null, candidates: [], proposedIndex: 0, capOverride: null });
      await tg.sendPhotoFile(reviewShot, '🧪 Dry run — would have ordered here.');
      return;
    }

    // 5. Place the order and confirm the thank-you page
    await clickPlaceOrder();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const confShot = await screenshot(page, 'confirmation');
    const content = await page.content();
    const confirmed =
      /Order placed|Thank you, your order has been placed/i.test(content) ||
      (await page.locator('#widget-purchaseConfirmationStatus').count()) > 0;
    if (!confirmed) {
      throw new GoferError('CHECKOUT', 'Clicked Place Order but could not confirm the thank-you page', confShot);
    }
    const orderNumber = (content.match(/\d{3}-\d{7}-\d{7}/) || [null])[0];

    // 6. Append-only order log
    appendOrder({
      ts: new Date().toISOString(),
      asin: candidate.asin,
      title: candidate.title,
      price: actual,
      orderNumber,
      dryRun: false,
      requestText: state.request?.raw ?? null,
    });

    // 7. Notify
    setState('IDLE', { request: null, candidates: [], proposedIndex: 0, capOverride: null });
    await tg.send(
      `✅ Ordered!${orderNumber ? ` #${orderNumber} —` : ''} $${actual}${candidate.deliveryEstimate ? `, arriving ${candidate.deliveryEstimate}` : ''}.`,
    );
  } catch (err) {
    // Never retry the Place Order click. Screenshot, tell the human, stop.
    log('error', 'checkout_failed', { asin: candidate.asin, error: String(err?.stack || err) });
    const shot = err.screenshot || (await screenshot(page, 'checkout-error').catch(() => null));
    setState('NEEDS_HUMAN');
    const msg = `⚠️ Checkout stopped at an unexpected step: ${err.message}. Check your Amazon orders, then /cancel to reset me.`;
    if (shot) await tg.sendPhotoFile(shot, msg).catch(() => tg.send(msg).catch(() => {}));
    else await tg.send(msg).catch(() => {});
  }
}

/* =============================================================================
 * HANDLERS
 * ============================================================================= */

let busy = false; // in-memory mutex: one purchase flow at a time

export async function handleUpdate(update) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (chatId !== cfg.allowedChatId) {
    const preview = (update.message?.text || update.callback_query?.data || '').slice(0, 50);
    log('warn', 'unauthorized_update', { chatId: chatId ?? null, preview });
    return; // never reply to strangers
  }
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

async function handleMessage(msg) {
  if (msg.voice || msg.audio || msg.video_note) return tg.send('Text only for now.');
  const text = (msg.text || '').trim();
  if (!text) return;
  if (text.startsWith('/')) return handleCommand(text);
  if (busy) return tg.send('Finish or /cancel the current one first.');
  if (state.state === 'NEEDS_HUMAN') {
    return tg.send('⚠️ I\'m paused pending a human check. Look at Amazon, then /cancel to reset me.');
  }
  if (state.state === 'PROPOSED') return refine(text);
  return newRequest(text);
}

async function handleCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case '/start':
      return tg.send(
        '👋 I\'m Gofer. Text me something to buy (e.g. "get a tiny glasses screwdriver") and I\'ll find it on Amazon and ask before ordering.',
      );
    case '/status': {
      const c = state.candidates?.[state.proposedIndex];
      const lines = [`State: ${state.state}`];
      if (state.state === 'PROPOSED' && c) {
        lines.push(`Proposal ${state.proposedIndex + 1}/${state.candidates.length}: ${c.title} — $${c.price}`);
      }
      if (state.state === 'ORDERING') lines.push('Order in flight.');
      lines.push(
        `Price cap: $${effectiveCap()}${state.capOverride != null ? ` (one-order override; default $${cfg.priceCap})` : ''}`,
      );
      lines.push(`Dry run: ${cfg.dryRun ? 'on' : 'off'}`);
      return tg.send(lines.join('\n'));
    }
    case '/cancel':
      return doCancel();
    case '/cap': {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n <= 0) return tg.send('Usage: /cap 150');
      state.capOverride = n;
      saveState();
      return tg.send(`Cap set to $${n} for the next order only (default $${cfg.priceCap}).`);
    }
    case '/dryrun': {
      const v = (rest[0] || '').toLowerCase();
      if (v !== 'on' && v !== 'off') return tg.send('Usage: /dryrun on|off');
      cfg.dryRun = v === 'on';
      log('info', 'dryrun_toggled', { dryRun: cfg.dryRun });
      return tg.send(
        `Dry run ${v}. ${cfg.dryRun ? 'Orders stop at the review page.' : '⚠️ Live ordering enabled.'}`,
      );
    }
    default:
      return tg.send('Commands: /status /cancel /cap <usd> /dryrun on|off');
  }
}

async function doCancel() {
  setState('IDLE', { request: null, candidates: [], proposedIndex: 0, capOverride: null });
  return tg.send('Cancelled. What next?');
}

async function handleCallback(cb) {
  await tg.call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  const data = cb.data || '';
  if (data === 'cancel') return doCancel();
  if (state.state !== 'PROPOSED') return tg.send('No active proposal. Send me something to buy.');

  if (data === 'next') {
    const next = state.proposedIndex + 1;
    if (next >= state.candidates.length || next >= 10) {
      setState('IDLE', { request: null, candidates: [], proposedIndex: 0 });
      return tg.send("That's everything I found. Try rephrasing the request.");
    }
    setState('PROPOSED', { proposedIndex: next });
    return propose();
  }

  if (data.startsWith('order:')) {
    const asin = data.slice('order:'.length);
    const current = state.candidates[state.proposedIndex];
    if (!current || current.asin !== asin) {
      return tg.send('That button is stale — it doesn\'t match the current proposal. Order the option shown, or /cancel.');
    }
    if (busy) return tg.send('Finish or /cancel the current one first.');
    busy = true;
    try {
      await checkout(current);
    } finally {
      busy = false;
    }
  }
}

async function newRequest(text) {
  busy = true;
  try {
    const intent = await claude.parseIntent(text, null);
    if (!intent.isPurchaseRequest) {
      return await tg.send(intent.reply || "I'm a shopping bot — tell me something to buy.");
    }
    await runSearch(buildRequest(text, intent));
  } catch (err) {
    await handleFlowError(err);
  } finally {
    busy = false;
  }
}

async function refine(text) {
  busy = true;
  try {
    const intent = await claude.parseIntent(text, state.request);
    if (!intent.isPurchaseRequest) {
      return await tg.send(intent.reply || 'Noted. The current proposal still stands — refine it, or tap a button.');
    }
    const request = buildRequest(state.request?.raw || text, intent);
    if (intent.newSearch === false && state.candidates.length) {
      await rankAndPropose(state.candidates, request); // re-rank, no new page load
    } else {
      await runSearch(request);
    }
  } catch (err) {
    await handleFlowError(err);
  } finally {
    busy = false;
  }
}

function buildRequest(rawText, intent) {
  return {
    raw: rawText,
    query: intent.searchQuery,
    constraints: {
      maxPrice: intent.constraints?.maxPrice ?? null,
      mustBePrime: !!intent.constraints?.mustBePrime,
      notes: Array.isArray(intent.constraints?.notes) ? intent.constraints.notes : [],
    },
  };
}

async function runSearch(request) {
  setState('SEARCHING', { request });
  await tg.send(`🔍 Searching Amazon for: ${request.query}…`);
  const html = await amazon.search(request.query);
  const extracted = await claude.extractProducts(html);
  if (state.state !== 'SEARCHING') return; // user cancelled mid-search
  const products = validateProducts(extracted);
  if (!products.length) {
    setState('IDLE');
    return tg.send('I couldn\'t pull usable results for that. Try rephrasing.');
  }
  await rankAndPropose(products, request);
}

async function rankAndPropose(products, request) {
  const cap = Math.min(effectiveCap(), request.constraints.maxPrice ?? Infinity);
  const eligible = products.filter((p) => p.price != null && p.price <= cap); // cap enforced pre-rank
  if (!eligible.length) {
    setState('IDLE', { request });
    return tg.send(`Nothing under $${cap} fit. Raise the cap with /cap, or refine the request.`);
  }
  const ranking = await claude.rank(eligible, request, cap);
  const byAsin = new Map(eligible.map((p) => [p.asin, p]));
  const ordered = (Array.isArray(ranking.ranked) ? ranking.ranked : [])
    .map((a) => byAsin.get(a))
    .filter(Boolean);
  for (const p of eligible) if (!ordered.includes(p)) ordered.push(p);
  if (ranking.topPick?.asin && ordered[0]?.asin !== ranking.topPick.asin) {
    const i = ordered.findIndex((p) => p.asin === ranking.topPick.asin);
    if (i > 0) ordered.unshift(ordered.splice(i, 1)[0]);
  }
  if (ranking.topPick?.rationale && ordered[0]) ordered[0].rationale = ranking.topPick.rationale;

  setState('PROPOSED', { request, candidates: ordered.slice(0, 10), proposedIndex: 0 });
  if (Array.isArray(ranking.warnings) && ranking.warnings.length) {
    await tg.send('⚠️ ' + ranking.warnings.join(' '));
  }
  await propose();
}

async function propose() {
  const c = state.candidates[state.proposedIndex];
  const lines = [
    `${c.title} — $${c.price.toFixed(2)}${c.prime ? ' ✅ Prime' : ''}`,
    `⭐ ${c.rating ?? '?'} (${c.reviewCount != null ? c.reviewCount.toLocaleString('en-US') : '?'} reviews)${c.badges?.length ? ' · ' + c.badges.join(', ') : ''}`,
  ];
  if (c.rationale) lines.push(`Why: ${c.rationale}`);
  if (c.deliveryEstimate) lines.push(`Arrives: ${c.deliveryEstimate}`);
  const caption = lines.join('\n');
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Order', callback_data: `order:${c.asin}` },
      { text: '🔄 Next option', callback_data: 'next' },
      { text: '❌ Cancel', callback_data: 'cancel' },
    ]],
  };
  if (c.imageUrl) {
    try {
      return await tg.sendPhoto(c.imageUrl, caption, replyMarkup);
    } catch (err) {
      log('warn', 'send_photo_failed', { error: String(err) });
    }
  }
  return tg.send(caption, { reply_markup: replyMarkup });
}

async function handleFlowError(err) {
  log('error', 'flow_failed', { error: String(err?.stack || err) });
  if (err instanceof GoferError && (err.kind === 'LOGIN' || err.kind === 'CAPTCHA')) {
    setState('NEEDS_HUMAN');
    const msg = `⚠️ ${err.message}`;
    if (err.screenshot) await tg.sendPhotoFile(err.screenshot, msg).catch(() => tg.send(msg).catch(() => {}));
    else await tg.send(msg).catch(() => {});
  } else {
    setState('IDLE');
    await tg.send(`Something went wrong: ${err.message}. Try again, or /status.`).catch(() => {});
  }
}

/* =============================================================================
 * MAIN
 * ============================================================================= */

export async function bootRecovery() {
  loadState();
  if (state.state === 'ORDERING') {
    // Crash recovery rule: never resume automation mid-checkout.
    setState('NEEDS_HUMAN');
    await tg
      .send('⚠️ I crashed mid-checkout. Check your Amazon orders before asking me to retry.')
      .catch((err) => log('error', 'recovery_notify_failed', { error: String(err) }));
  } else if (state.state === 'SEARCHING') {
    setState('IDLE'); // a dropped search is harmless
  }
}

async function loginFlow() {
  const ctx = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.amazon.com');
  console.log("Log in (incl. 2FA, tick 'keep me signed in'), then press Enter.");
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); resolve(); });
  });
  const account = await page.locator('#nav-link-accountList').innerText().catch(() => '');
  if (!account.trim() || /sign in/i.test(account)) {
    console.error('That does not look signed in (nav still shows "Sign in"). Profile saved anyway — re-run --login if searches fail.');
  } else {
    console.log(`Signed in: ${account.split('\n')[0].trim()}. Profile saved.`);
  }
  await ctx.close();
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--login')) return loginFlow();
  requireConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  log('info', 'boot', { dryRun: cfg.dryRun, cap: cfg.priceCap, modelFast: cfg.modelFast, modelSmart: cfg.modelSmart });
  pruneScreenshots();
  await bootRecovery();
  await pollLoop();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log('error', 'fatal', { error: String(err?.stack || err) });
    process.exit(1);
  });
}
