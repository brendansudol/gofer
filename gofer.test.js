/* Offline test suite for gofer.js — no network, no real browser.
 * Telegram + Anthropic are exercised through a stubbed global fetch;
 * Playwright is exercised through a fake page object injected via the
 * exported `amazon` seam. Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gofer-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ALLOWED_CHAT_ID = '12345';
process.env.DRY_RUN = 'true';

const g = await import('./gofer.js');

/* ---------------------------------------------------------------- helpers */

let fetchCalls = [];
let anthropicQueue = [];

function stubFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts };
    fetchCalls.push(call);
    let body;
    if (call.url.includes('api.anthropic.com')) {
      const payload = anthropicQueue.shift();
      assert.ok(payload !== undefined, 'anthropic called more times than queued');
      body = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } else {
      body = { ok: true, result: {} };
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const tgCalls = (method) => fetchCalls.filter((c) => c.url.includes(`api.telegram.org`) && c.url.endsWith(`/${method}`));
const tgBody = (call) => JSON.parse(call.opts.body);

function resetState() {
  g.setState('IDLE', { request: null, candidates: [], proposedIndex: 0, capOverride: null });
  g.cfg.dryRun = true;
}

function makeCandidate(over = {}) {
  return {
    asin: 'B01GIJBCKW',
    title: 'Mudder 11-Piece Eyeglass Repair Kit',
    price: 6.99,
    rating: 4.6,
    reviewCount: 14203,
    badges: ["Amazon's Choice"],
    prime: true,
    sponsored: false,
    imageUrl: 'https://img.example.com/x.jpg',
    deliveryEstimate: 'Tomorrow',
    ...over,
  };
}

function fakePage({ priceText = '$6.99', turbo = false, html = '', confirmWidget = false } = {}) {
  const clicks = [];
  const makeLocator = (sel) => ({
    first() { return this; },
    async count() {
      if (sel.includes('turbo-checkout-iframe')) return turbo ? 1 : 0;
      if (sel.includes('purchaseConfirmationStatus')) return confirmWidget ? 1 : 0;
      return 1;
    },
    async waitFor() {},
    async click() { clicks.push(sel); },
    async textContent() { return priceText; },
    async innerText() { return priceText; },
  });
  return {
    clicks,
    async goto() {},
    url: () => 'https://www.amazon.com/dp/TEST',
    async content() { return html; },
    async screenshot({ path: p } = {}) { if (p) fs.writeFileSync(p, 'png-bytes'); },
    locator: makeLocator,
    frameLocator: () => ({ locator: makeLocator }),
    async waitForLoadState() {},
    async waitForSelector() {},
    async click(sel) { clicks.push(sel); },
  };
}

const ordersFile = path.join(DATA_DIR, 'orders.jsonl');
const readOrders = () =>
  fs.existsSync(ordersFile)
    ? fs.readFileSync(ordersFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

/* ----------------------------------------------------------- pure helpers */

test('parseEnvText parses keys, quotes, and comments', () => {
  const parsed = g.parseEnvText('# comment\nFOO=bar\nQUOTED="a b"\nSINGLE=\'x\'\nEMPTY=\nNOEQ\nSPACED = hi \n');
  assert.deepEqual(parsed, { FOO: 'bar', QUOTED: 'a b', SINGLE: 'x', EMPTY: '', SPACED: 'hi' });
});

test('parseJSONLoose handles plain, fenced, and preambled JSON', () => {
  assert.deepEqual(g.parseJSONLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(g.parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(g.parseJSONLoose('Here you go:\n[{"a":1}]'), [{ a: 1 }]);
  assert.throws(() => g.parseJSONLoose('not json at all'));
});

test('cleanHtml strips scripts/styles/svg/data-uris and truncates', () => {
  const html = '<html><script>evil()</script><style>.x{}</style><svg><path/></svg>' +
    '<div style="color:red" src="data:image/png;base64,AAAA">  hello   world </div></html>';
  const out = g.cleanHtml(html);
  assert.ok(!out.includes('evil'));
  assert.ok(!out.includes('.x{}'));
  assert.ok(!out.includes('<svg'));
  assert.ok(!out.includes('style='));
  assert.ok(!out.includes('base64,AAAA'));
  assert.ok(out.includes('hello world'));
  assert.equal(g.cleanHtml('a'.repeat(200_000), 150_000).length, 150_000);
});

test('parsePrice handles currency formats', () => {
  assert.equal(g.parsePrice('$6.99'), 6.99);
  assert.equal(g.parsePrice('$1,234.56'), 1234.56);
  assert.equal(g.parsePrice('  $24 '), 24);
  assert.equal(g.parsePrice('no price here'), null);
  assert.equal(g.parsePrice(null), null);
});

test('validateProducts enforces ASIN shape, dedupes, coerces types', () => {
  const out = g.validateProducts([
    makeCandidate(),
    makeCandidate(), // duplicate asin — dropped
    { asin: 'NOTANASIN1', title: 'bad' },
    { asin: 'B0SHORTY' }, // 8 chars total after B0? no — too short, dropped
    { asin: 'B07ABCDEFG', title: 'Driver', price: '$4.49', rating: '4.2', reviewCount: '120', prime: 0, imageUrl: 'notaurl' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].asin, 'B01GIJBCKW');
  assert.deepEqual(
    { price: out[1].price, rating: out[1].rating, reviewCount: out[1].reviewCount, prime: out[1].prime, imageUrl: out[1].imageUrl },
    { price: 4.49, rating: 4.2, reviewCount: 120, prime: false, imageUrl: null },
  );
});

test('verifyPriceOk: cap breach, >10% jump, unknown price, ok', () => {
  assert.equal(g.verifyPriceOk(6.99, 80, 75).ok, false); // over cap
  assert.equal(g.verifyPriceOk(6.99, 8.5, 75).ok, false); // jumped >10%
  assert.equal(g.verifyPriceOk(6.99, null, 75).ok, false); // unreadable
  assert.equal(g.verifyPriceOk(6.99, 7.5, 75).ok, true); // within 10%
  assert.equal(g.verifyPriceOk(null, 20, 75).ok, true); // no proposed price, under cap
});

test('pruneScreenshots removes only files older than 30 days', () => {
  const dir = path.join(DATA_DIR, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const oldFile = path.join(dir, 'old.png');
  const newFile = path.join(dir, 'new.png');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'x');
  const old = new Date(Date.now() - 40 * 86400e3);
  fs.utimesSync(oldFile, old, old);
  const pruned = g.pruneScreenshots(30);
  assert.equal(pruned, 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
});

/* ---------------------------------------------------- auth + basic routing */

test('updates from a different chat id are dropped with no reply (AC7)', async () => {
  stubFetch();
  resetState();
  await g.handleUpdate({ update_id: 1, message: { chat: { id: 99999 }, text: 'buy me things' } });
  assert.equal(fetchCalls.filter((c) => c.url.includes('api.telegram.org')).length, 0);
});

test('voice notes get "Text only for now."', async () => {
  stubFetch();
  resetState();
  await g.handleUpdate({ update_id: 2, message: { chat: { id: 12345 }, voice: { duration: 3 } } });
  const sends = tgCalls('sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(tgBody(sends[0]).text, 'Text only for now.');
});

/* ----------------------------------------------------------------- commands */

test('/cap sets a one-order override and /status reflects it (AC10)', async () => {
  stubFetch();
  resetState();
  await g.handleUpdate({ update_id: 3, message: { chat: { id: 12345 }, text: '/cap 150' } });
  assert.equal(g.state.capOverride, 150);
  assert.equal(g.effectiveCap(), 150);

  await g.handleUpdate({ update_id: 4, message: { chat: { id: 12345 }, text: '/status' } });
  const status = tgBody(tgCalls('sendMessage').at(-1)).text;
  assert.match(status, /State: IDLE/);
  assert.match(status, /\$150 \(one-order override/);
  assert.match(status, /Dry run: on/);
});

test('/dryrun toggles at runtime (AC10)', async () => {
  stubFetch();
  resetState();
  await g.handleUpdate({ update_id: 5, message: { chat: { id: 12345 }, text: '/dryrun off' } });
  assert.equal(g.cfg.dryRun, false);
  await g.handleUpdate({ update_id: 6, message: { chat: { id: 12345 }, text: '/dryrun on' } });
  assert.equal(g.cfg.dryRun, true);
  await g.handleUpdate({ update_id: 7, message: { chat: { id: 12345 }, text: '/dryrun maybe' } });
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /Usage/);
});

test('/cancel clears state and the cap override (AC10)', async () => {
  stubFetch();
  resetState();
  g.setState('PROPOSED', { candidates: [makeCandidate()], proposedIndex: 0, capOverride: 200 });
  await g.handleUpdate({ update_id: 8, message: { chat: { id: 12345 }, text: '/cancel' } });
  assert.equal(g.state.state, 'IDLE');
  assert.equal(g.state.capOverride, null);
  assert.equal(g.state.candidates.length, 0);
});

/* ------------------------------------------------------------ crash recovery */

test('boot with persisted ORDERING state goes to NEEDS_HUMAN, never resumes (AC8)', async () => {
  stubFetch();
  resetState();
  g.setState('ORDERING');
  await g.bootRecovery();
  assert.equal(g.state.state, 'NEEDS_HUMAN');
  const sends = tgCalls('sendMessage');
  assert.match(tgBody(sends.at(-1)).text, /crashed mid-checkout/);

  // NEEDS_HUMAN blocks new requests until /cancel
  await g.handleUpdate({ update_id: 9, message: { chat: { id: 12345 }, text: 'buy socks' } });
  assert.equal(g.state.state, 'NEEDS_HUMAN');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /paused pending a human check/);

  await g.handleUpdate({ update_id: 10, message: { chat: { id: 12345 }, text: '/cancel' } });
  assert.equal(g.state.state, 'IDLE');
});

/* ----------------------------------------------- search → propose pipeline */

test('purchase request runs intent → extract → rank → photo proposal (AC2 logic)', async () => {
  stubFetch();
  resetState();
  g.amazon.search = async () => '<cleaned html>';
  anthropicQueue = [
    {
      isPurchaseRequest: true,
      searchQuery: 'precision eyeglass screwdriver',
      constraints: { maxPrice: null, mustBePrime: false, notes: ['tiny', 'for glasses'] },
      newSearch: true,
      reply: null,
    },
    [
      makeCandidate(),
      makeCandidate({ asin: 'B07ABCDEFG', title: 'Single Precision Flathead Driver', price: 4.49, rating: 4.4, reviewCount: 800, badges: [], deliveryEstimate: null }),
    ],
    {
      ranked: ['B01GIJBCKW', 'B07ABCDEFG'],
      topPick: { asin: 'B01GIJBCKW', rationale: 'Highest-rated dedicated eyeglass kit under your cap.' },
      warnings: [],
    },
  ];

  await g.handleUpdate({ update_id: 11, message: { chat: { id: 12345 }, text: 'get a tiny glasses screwdriver' } });

  assert.equal(g.state.state, 'PROPOSED');
  assert.equal(g.state.candidates.length, 2);
  assert.equal(g.state.proposedIndex, 0);
  assert.equal(anthropicQueue.length, 0, 'all three Claude calls consumed');

  // "Searching" status message went out
  assert.match(tgBody(tgCalls('sendMessage')[0]).text, /🔍 Searching Amazon for: precision eyeglass screwdriver/);

  // proposal sent as a photo with caption + three buttons
  const photos = tgCalls('sendPhoto');
  assert.equal(photos.length, 1);
  const body = tgBody(photos[0]);
  assert.equal(body.photo, 'https://img.example.com/x.jpg');
  assert.match(body.caption, /Mudder 11-Piece Eyeglass Repair Kit — \$6\.99 ✅ Prime/);
  assert.match(body.caption, /⭐ 4\.6 \(14,203 reviews\) · Amazon's Choice/);
  assert.match(body.caption, /Why: Highest-rated/);
  assert.match(body.caption, /Arrives: Tomorrow/);
  const buttons = body.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  assert.deepEqual(buttons, ['order:B01GIJBCKW', 'next', 'cancel']);
});

test('non-purchase chat replies conversationally without searching', async () => {
  stubFetch();
  resetState();
  let searched = false;
  g.amazon.search = async () => { searched = true; return ''; };
  anthropicQueue = [
    { isPurchaseRequest: false, searchQuery: '', constraints: { maxPrice: null, mustBePrime: false, notes: [] }, newSearch: false, reply: 'All good here! Tell me what to buy.' },
  ];
  await g.handleUpdate({ update_id: 12, message: { chat: { id: 12345 }, text: 'how are you?' } });
  assert.equal(searched, false);
  assert.equal(g.state.state, 'IDLE');
  assert.equal(tgBody(tgCalls('sendMessage').at(-1)).text, 'All good here! Tell me what to buy.');
});

test('refinement while PROPOSED re-ranks without a new search when newSearch=false (AC3)', async () => {
  stubFetch();
  resetState();
  let searched = false;
  g.amazon.search = async () => { searched = true; return ''; };
  g.setState('PROPOSED', {
    request: { raw: 'get a screwdriver kit', query: 'precision screwdriver kit', constraints: { maxPrice: null, mustBePrime: false, notes: [] } },
    candidates: [
      makeCandidate({ asin: 'B0EXPENSIV', title: 'iFixit Kit', price: 24.99 }),
      makeCandidate({ asin: 'B07ABCDEFG', title: 'Single Flathead', price: 4.49, imageUrl: null }),
    ],
    proposedIndex: 0,
  });
  anthropicQueue = [
    {
      isPurchaseRequest: true,
      searchQuery: 'precision screwdriver kit',
      constraints: { maxPrice: 5, mustBePrime: false, notes: ['just one tiny flathead'] },
      newSearch: false,
      reply: null,
    },
    { ranked: ['B07ABCDEFG'], topPick: { asin: 'B07ABCDEFG', rationale: 'Cheapest single flathead that fits.' }, warnings: [] },
  ];

  await g.handleUpdate({ update_id: 13, message: { chat: { id: 12345 }, text: 'too expensive, just need one tiny flathead' } });

  assert.equal(searched, false, 'no new Amazon page load on re-rank');
  assert.equal(g.state.state, 'PROPOSED');
  const proposed = g.state.candidates[g.state.proposedIndex];
  assert.equal(proposed.asin, 'B07ABCDEFG');
  assert.equal(g.state.candidates.length, 1, 'over-budget candidate filtered by merged maxPrice');
});

test('Next option cycles candidates with no Amazon load, then exhausts to IDLE (AC4)', async () => {
  stubFetch();
  resetState();
  let searched = false;
  g.amazon.search = async () => { searched = true; return ''; };
  g.setState('PROPOSED', {
    candidates: [makeCandidate(), makeCandidate({ asin: 'B07ABCDEFG', title: 'Second Option', imageUrl: null })],
    proposedIndex: 0,
  });

  await g.handleUpdate({ update_id: 14, callback_query: { id: 'cb1', data: 'next', message: { chat: { id: 12345 } } } });
  assert.equal(g.state.proposedIndex, 1);
  assert.equal(g.state.state, 'PROPOSED');
  assert.equal(tgCalls('answerCallbackQuery').length, 1, 'spinner cleared');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /Second Option/);

  await g.handleUpdate({ update_id: 15, callback_query: { id: 'cb2', data: 'next', message: { chat: { id: 12345 } } } });
  assert.equal(g.state.state, 'IDLE');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /That's everything I found/);
  assert.equal(searched, false);
});

test('order button with a stale ASIN is rejected (safety rail 1)', async () => {
  stubFetch();
  resetState();
  g.setState('PROPOSED', { candidates: [makeCandidate()], proposedIndex: 0 });
  await g.handleUpdate({ update_id: 16, callback_query: { id: 'cb3', data: 'order:B0DIFFERNT', message: { chat: { id: 12345 } } } });
  assert.equal(g.state.state, 'PROPOSED', 'no checkout started');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /stale/);
});

/* ------------------------------------------------------------------ checkout */

test('dry-run order: stops before place-order click, screenshots, logs dryRun:true (AC5)', async () => {
  stubFetch();
  resetState();
  g.cfg.dryRun = true;
  const page = fakePage({ priceText: '$6.99', turbo: false });
  g.amazon.page = async () => page;
  g.setState('PROPOSED', {
    request: { raw: 'get a tiny glasses screwdriver', query: 'x', constraints: { maxPrice: null, mustBePrime: false, notes: [] } },
    candidates: [makeCandidate()],
    proposedIndex: 0,
  });

  await g.handleUpdate({ update_id: 17, callback_query: { id: 'cb4', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'IDLE');
  assert.ok(page.clicks.includes('#buy-now-button'));
  assert.ok(!page.clicks.some((c) => c.includes('placeOrder') || c.includes('turbo-checkout-pyo')), 'place order never clicked');

  const order = readOrders().at(-1);
  assert.equal(order.dryRun, true);
  assert.equal(order.asin, 'B01GIJBCKW');
  assert.equal(order.orderNumber, null);
  assert.equal(order.requestText, 'get a tiny glasses screwdriver');

  // review-page screenshot delivered via multipart sendPhoto
  const photoUploads = fetchCalls.filter((c) => c.url.endsWith('/sendPhoto') && c.opts.body instanceof FormData);
  assert.equal(photoUploads.length, 1);
  assert.equal(photoUploads[0].opts.body.get('caption'), '🧪 Dry run — would have ordered here.');
});

test('checkout aborts at price re-verification when price exceeds cap (AC9)', async () => {
  stubFetch();
  resetState();
  g.cfg.dryRun = true;
  const page = fakePage({ priceText: '$89.99' }); // over the $75 default cap
  g.amazon.page = async () => page;
  g.setState('PROPOSED', { request: { raw: 'x' }, candidates: [makeCandidate({ price: 70 })], proposedIndex: 0 });

  await g.handleUpdate({ update_id: 18, callback_query: { id: 'cb5', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'PROPOSED', 'returns to PROPOSED after abort');
  assert.ok(!page.clicks.includes('#buy-now-button'), 'never reached Buy Now');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /aborted at price check.*exceeds the \$75 cap/);
});

test('checkout aborts when the price jumped >10% over the proposal (AC9)', async () => {
  stubFetch();
  resetState();
  const page = fakePage({ priceText: '$9.99' }); // proposed 6.99 → +43%
  g.amazon.page = async () => page;
  g.setState('PROPOSED', { request: { raw: 'x' }, candidates: [makeCandidate({ price: 6.99 })], proposedIndex: 0 });

  await g.handleUpdate({ update_id: 19, callback_query: { id: 'cb6', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'PROPOSED');
  assert.match(tgBody(tgCalls('sendMessage').at(-1)).text, /jumped more than 10%/);
});

test('live order (dry-run off): clicks place order, confirms, extracts order number (AC6 logic)', async () => {
  stubFetch();
  resetState();
  g.cfg.dryRun = false;
  const page = fakePage({
    priceText: '$6.99',
    turbo: true,
    html: '<html>Thank you, your order has been placed. Order #112-4729104-7741034</html>',
  });
  g.amazon.page = async () => page;
  g.setState('PROPOSED', {
    request: { raw: 'get a tiny glasses screwdriver', query: 'x', constraints: { maxPrice: null, mustBePrime: false, notes: [] } },
    candidates: [makeCandidate()],
    proposedIndex: 0,
  });

  await g.handleUpdate({ update_id: 20, callback_query: { id: 'cb7', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'IDLE');
  assert.ok(page.clicks.includes('#turbo-checkout-pyo'), 'turbo place-order clicked');
  const order = readOrders().at(-1);
  assert.equal(order.dryRun, false);
  assert.equal(order.orderNumber, '112-4729104-7741034');
  const done = tgBody(tgCalls('sendMessage').at(-1)).text;
  assert.match(done, /✅ Ordered! #112-4729104-7741034 — \$6\.99, arriving Tomorrow\./);
  g.cfg.dryRun = true;
});

test('cap override is consumed by an order and reverts to default', async () => {
  stubFetch();
  resetState();
  g.cfg.dryRun = true;
  g.state.capOverride = 150;
  g.saveState();
  const page = fakePage({ priceText: '$99.99' }); // over default 75, under override 150
  g.amazon.page = async () => page;
  g.setState('PROPOSED', { request: { raw: 'x' }, candidates: [makeCandidate({ price: 99 })], proposedIndex: 0 });

  await g.handleUpdate({ update_id: 21, callback_query: { id: 'cb8', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'IDLE', 'order went through under the override');
  assert.equal(g.state.capOverride, null, 'override reverted after the order');
  assert.equal(g.effectiveCap(), 75);
});

test('unexpected checkout failure goes to NEEDS_HUMAN with a screenshot, no retry', async () => {
  stubFetch();
  resetState();
  g.cfg.dryRun = false;
  const page = fakePage({ priceText: '$6.99', turbo: false, html: '<html>Choose a delivery address</html>' });
  g.amazon.page = async () => page;
  g.setState('PROPOSED', { request: { raw: 'x' }, candidates: [makeCandidate()], proposedIndex: 0 });

  await g.handleUpdate({ update_id: 22, callback_query: { id: 'cb9', data: 'order:B01GIJBCKW', message: { chat: { id: 12345 } } } });

  assert.equal(g.state.state, 'NEEDS_HUMAN');
  const placeOrderClicks = page.clicks.filter((c) => c.includes('placeOrder'));
  assert.equal(placeOrderClicks.length, 1, 'place order clicked exactly once — never retried');
  const photoUploads = fetchCalls.filter((c) => c.url.endsWith('/sendPhoto') && c.opts.body instanceof FormData);
  assert.ok(photoUploads.length >= 1, 'screenshot sent to user');
  assert.match(String(photoUploads.at(-1).opts.body.get('caption')), /Checkout stopped at an unexpected step/);
  g.cfg.dryRun = true;
});

test('messages while a flow is busy get the mutex message (safety rail 9)', async () => {
  stubFetch();
  resetState();
  g.amazon.search = async () => {
    // While the search is in flight, a second message arrives.
    await g.handleUpdate({ update_id: 24, message: { chat: { id: 12345 }, text: 'also buy a hammer' } });
    return '';
  };
  anthropicQueue = [
    { isPurchaseRequest: true, searchQuery: 'usb c cable', constraints: { maxPrice: null, mustBePrime: false, notes: [] }, newSearch: true, reply: null },
    [makeCandidate()],
    { ranked: ['B01GIJBCKW'], topPick: { asin: 'B01GIJBCKW', rationale: 'Fits.' }, warnings: [] },
  ];
  await g.handleUpdate({ update_id: 23, message: { chat: { id: 12345 }, text: 'buy a usb c cable' } });
  const texts = tgCalls('sendMessage').map((c) => tgBody(c).text);
  assert.ok(texts.includes('Finish or /cancel the current one first.'));
  assert.equal(g.state.state, 'PROPOSED');
});
