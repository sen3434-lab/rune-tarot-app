require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { createLimiter } = require('./rate-limit');
const { registerBilling } = require('./billing');

const app = express();
// nginx sits in front and sets X-Forwarded-For; without this every visitor
// would look like 127.0.0.1 and share one rate-limit bucket.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const APP_KEY = 'rune-tarot';

app.use(express.json());

// Rune content lives in the SAME shared public.tarot_cards table
// color-tarot-app uses (card_type = '룬타로' vs '컬러타로') rather than a
// bundled file, so it's shared across every ozma app — see
// data/schema_migration_rune.sql for the column reuse/addition rationale.
// Cached in memory for RUNES_TTL_MS so a live edit in the Table Editor
// shows up without a server restart, but every request doesn't pay for a
// DB round trip.
const RUNES_TTL_MS = 10 * 60 * 1000;
let runesCache = null;
let runesCacheAt = 0;
const RUNE_SELECT = [
  'id', 'name_ko', 'glyph', 'name_en:name', 'keywords:keyword', 'meaning',
  'deity', 'element', 'advice', 'caution', 'remedy_magic',
  'talisman_material', 'talisman_engrave', 'talisman_carry', 'mantra:mood_quote',
].join(', ');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

async function getRunes() {
  if (runesCache && Date.now() - runesCacheAt < RUNES_TTL_MS) return runesCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('tarot_cards')
    .select(RUNE_SELECT)
    .eq('card_type', '룬타로')
    .order('id');
  if (error) {
    console.error('Failed to load rune cards from Supabase', error);
    if (runesCache) return runesCache; // serve stale data over a hard failure
    throw error;
  }
  runesCache = data;
  runesCacheAt = Date.now();
  return runesCache;
}

// Public runtime config for the browser Supabase client. The anon key is
// designed to be public (row level security enforces access) — same
// pattern as the color-tarot-app.
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// Every call below is made WITH THE USER'S OWN TOKEN, so Supabase row-level
// security decides what they can see — this server holds no admin key.
function sbFetch(pathAndQuery, token, init = {}) {
  return fetch(`${process.env.SUPABASE_URL}${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.body = { error: code, ...extra };
  }
}

async function requireUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'login_required');
  const r = await sbFetch('/auth/v1/user', token);
  if (!r.ok) throw new HttpError(401, 'login_required');
  return { token, user: await r.json() };
}

// Prices live in the database (coin_prices) so they can change without a
// redeploy. Cached for a few minutes per item.
const priceCache = {};
async function itemPrice(token, item) {
  const hit = priceCache[item];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.coins;
  let coins = hit ? hit.coins : 1;
  try {
    const r = await sbFetch(`/rest/v1/coin_prices?app_key=eq.${APP_KEY}&item=eq.${item}&select=coins`, token);
    const rows = r.ok ? await r.json() : [];
    if (rows[0]?.coins > 0) coins = rows[0].coins;
  } catch (e) {
    console.error('price lookup failed, using cached/default', e);
  }
  priceCache[item] = { coins, at: Date.now() };
  return coins;
}

async function walletBalance(token) {
  const r = await sbFetch('/rest/v1/wallets?select=balance', token);
  if (!r.ok) throw new HttpError(502, 'wallet_unavailable');
  const rows = await r.json();
  return rows[0]?.balance ?? 0;
}

// Login + enough coins, checked BEFORE spending AI money. The coin is only
// charged AFTER the reading exists, so an AI failure costs the user nothing.
async function requirePayer(req, item) {
  try {
    const { token } = await requireUser(req);
    const cost = await itemPrice(token, item);
    const balance = await walletBalance(token);
    if (balance < cost) throw new HttpError(402, 'insufficient_coins', { balance, cost });
    return { token, cost };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('auth/balance check failed', err);
    throw new HttpError(502, 'wallet_unavailable');
  }
}

// Saves the reading and charges the coin in ONE database step (all or nothing).
async function saveAndCharge(token, fn, args) {
  const saved = await sbFetch(`/rest/v1/rpc/${fn}`, token, { method: 'POST', body: JSON.stringify(args) });
  if (!saved.ok) {
    console.error(fn + ' failed', saved.status, await saved.text());
    throw new HttpError(502, 'save_failed');
  }
  const outcome = await saved.json();
  if (!outcome.ok) {
    const status = outcome.reason === 'insufficient_coins' ? 402 : 400;
    throw new HttpError(status, outcome.reason, { balance: outcome.balance, cost: outcome.cost });
  }
  return outcome;
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  console.error('request failed', err);
  return res.status(err.status || 500).json({ error: err.message || 'failed' });
}

// Google Play coin packs (see billing.js). Valid product ids come from the
// public coin_products table so a price/pack change needs no redeploy.
let productCache = { ids: [], at: 0 };
async function activeProductIds() {
  if (Date.now() - productCache.at < 60 * 1000 && productCache.ids.length) return productCache.ids;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/coin_products?active=eq.true&select=product_id`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) return productCache.ids;
  productCache = { ids: (await r.json()).map((p) => p.product_id), at: Date.now() };
  return productCache.ids;
}
registerBilling(app, {
  packageName: 'com.ozma.runetarot',
  requireUser, HttpError,
  limiter: createLimiter(),
  products: activeProductIds,
});

const cleanQuestion = (q) => String(q || '').slice(0, 500);

// 주식·부동산 리딩은 "무엇에 대한 리딩인지"를 받는다. 프롬프트에 그대로 들어가므로
// 글자 종류와 길이를 엄격히 제한한다(지시문 끼워 넣기 방지).
const REALESTATE_KINDS = ['이사 고민', '새 집 계약 앞둠', '입주 앞둠', '지금 사는 곳'];
const SUBJECT_RE = /^[0-9A-Za-z가-힣 .,&()\-]{1,40}$/;
function cleanSubject(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'subject_required' };
  if (!SUBJECT_RE.test(s)) return { error: 'bad_subject' };
  return { value: s };
}

async function findRune(id) {
  const runes = await getRunes();
  return runes.find((r) => r.id === id);
}

// Builds the grounding block passed to the model for one rune. `theme`
// (love/stock/realestate/health) narrows which of the rune's meanings to
// lean on; null means the general/free reading.
function runeGroundingLines(rune, theme) {
  const lines = [
    `룬 이름: ${rune.name_ko} ${rune.name_en} (${rune.glyph})`,
    rune.keywords && `키워드: ${rune.keywords}`,
    rune.meaning && `기본 의미: ${rune.meaning}`,
    rune.deity && `수호신: ${rune.deity}`,
    rune.element && `원소: ${rune.element}`,
    rune.advice && `룬의 조언: ${rune.advice}`,
    rune.caution && `주의할 점(그림자 측면): ${rune.caution}`,
    rune.remedy_magic && `전통적 활용: ${rune.remedy_magic}`,
  ];
  return lines.filter(Boolean).join('\n');
}

const THEME_LABEL = {
  love: '애정운 (연애, 관계, 결혼)',
  stock: '재물운 (돈을 대하는 마음가짐, 흐름의 기운, 조심할 점)',
  realestate: '주거운 (거주 위치, 이사·입주의 기운, 터와 생활의 조화)',
  health: '건강운 (몸과 마음의 상태, 주의할 점)',
};

async function callGemini(systemPrompt, userPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('AI reading is not configured yet (missing GEMINI_API_KEY).');
    err.status = 503;
    throw err;
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const apiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  if (!apiRes.ok) {
    const errText = await apiRes.text();
    console.error('Gemini API error', apiRes.status, errText);
    const err = new Error('AI reading failed');
    err.status = 502;
    throw err;
  }
  const data = await apiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Could not find JSON in AI response', text);
    const err = new Error('AI reading failed');
    err.status = 502;
    throw err;
  }
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------
// POST /api/reading — single-rune draw, 1 coin. Used by draw.html (룬 뽑기).
// ---------------------------------------------------------------------
app.post('/api/reading', createLimiter(), async (req, res) => {
  const { id, displayName } = req.body || {};
  const question = cleanQuestion(req.body && req.body.question);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'unknown rune' });
  const rune = await findRune(id);
  if (!rune) return res.status(400).json({ error: 'unknown rune' });

  let payer;
  try { payer = await requirePayer(req, 'draw'); } catch (err) { return sendError(res, err); }

  const systemPrompt = `당신은 'OZ 룬타로'에서 사용자의 질문에 룬으로 답해주는 다정하고 통찰력 있는 리더입니다. 룬의 전통적인 상징(아래 자료)을 존중하면서, 사용자의 실제 상황에 자연스럽게 녹여 리딩합니다.

규칙:
- 아래 전달되는 룬 데이터는 참고 자료입니다. 항목명을 그대로 나열하지 말고 자연스러운 이야기로 풀어내세요.
- 사용자가 질문/상황을 남겼다면 그에 먼저 공감한 뒤, 룬이 지금 이 상황에 어떤 의미로 다가오는지 풀어주세요. 질문이 없다면 오늘 하루나 지금 이 순간에 대한 조언으로 풀어주세요.
${displayName ? `- 사용자의 이름은 "${displayName}"입니다. 자연스러운 곳에서 한 번 정도 "${displayName}님"이라고 불러주세요.` : ''}
- 룬은 방향 없이 하나의 모습으로 읽습니다(역방향·정방향 구분은 하지 않습니다). 룬의 조언과 그림자 측면(주의할 점)을 함께 다뤄 균형 있게 풀어주세요.
- 예언하거나 단정짓지 말고, 통찰과 조언을 주는 톤으로 씁니다.
- "reading" 필드는 다음 3부분을 \\n\\n으로 구분해 전체 450~700자 분량으로 작성하세요: (1) 지금 상황에 대한 공감 2~3문장 (2) 룬이 전하는 메시지와 그 그림자 측면 5~6문장 (3) 오늘부터 해볼 수 있는 구체적인 실천 조언 2~3문장.
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "reading": "3문단을 \\n\\n으로 구분한 텍스트"
}`;

  const userPrompt = `사용자 질문/상황: "${question || '(오늘 하루에 대한 조언을 구합니다)'}"

뽑힌 룬 정보:
${runeGroundingLines(rune, null)}`;

  try {
    const parsed = await callGemini(systemPrompt, userPrompt);
    const result = {
      reading: parsed.reading,
      rune: { id: rune.id, name_ko: rune.name_ko, name_en: rune.name_en, glyph: rune.glyph },
    };
    const outcome = await saveAndCharge(payer.token, 'save_rune_reading_with_spend', {
      p_item: 'draw',
      p_card_id: rune.id,
      p_mood: question,
      p_memo: JSON.stringify({ type: 'draw', ...result }),
    });
    res.json({ ...result, balance: outcome.balance, cost: outcome.cost, readingId: outcome.reading_id });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------
// GET /api/daily-rune — the single shared "오늘의 룬" for today (KST).
// Computed and cached ONCE per calendar day, server-side, and served
// identically to every visitor — not a per-visitor random draw. This
// keeps the name honest (one "rune of the day", not "a random rune you
// happened to get"), makes it consistent across a visitor's devices, and
// calls Gemini once per day total instead of once per visitor.
// ---------------------------------------------------------------------
let dailyRuneCache = null; // { date, payload }

function todayKST() {
  const nowKST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return nowKST.toISOString().slice(0, 10);
}

// Deterministic PRNG seeded from the date string, so "today's runes" are
// stable across server restarts within the same day, not just within
// one process's uptime.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickThreeForDate(runes, dateStr) {
  let seed = 0;
  for (let i = 0; i < dateStr.length; i++) seed = (seed * 31 + dateStr.charCodeAt(i)) >>> 0;
  const rng = mulberry32(seed);
  const pool = [...runes];
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// Builds (once per KST day) the shared payload: 3 runes + one-line summary +
// the full reading. Every visitor gets the same one.
async function getDailyPayload() {
  const date = todayKST();
  if (dailyRuneCache && dailyRuneCache.date === date) return dailyRuneCache.payload;

  const allRunes = await getRunes();
  const runes = pickThreeForDate(allRunes, date);

    const positions = ['오늘의 상황', '오늘의 도전 과제', '오늘의 조언'];
    const groundingBlock = runes
      .map((r, i) => `[${positions[i]}] ${runeGroundingLines(r, null)}`)
      .join('\n\n');

    const systemPrompt = `당신은 'OZ 룬타로'의 '오늘의 룬' 코너를 진행하는 리더입니다. 세 개의 룬(상황/도전 과제/조언)이 뽑혔습니다. 이 셋을 각각 따로 설명하지 말고, 하나로 이어지는 오늘 하루의 이야기로 엮어서 들려주세요. 이 리딩은 오늘 하루 동안 이 앱을 방문하는 모든 사람에게 똑같이 보여지는 공용 메시지이니, 특정 개인을 향한 말투("당신은 ~하시는군요" 식의 지나치게 개인적인 상담 어투)보다는 오늘 하루 전체를 향한 담담하고 통찰력 있는 어투로 씁니다.

규칙:
- 세 룬을 순서대로 나열하지 말고, "오늘은 이런 기운으로 시작해서(상황) → 이런 벽을 만날 수 있고(도전) → 이렇게 풀어가면 좋다(조언)"는 하나의 흐름으로 자연스럽게 이어 쓰세요.
- 각 룬의 이름은 리딩 중 자연스럽게 한 번씩 언급하되, 항목처럼 나열하지 마세요.
- 전체 400~600자 분량의 따뜻하고 통찰력 있는 하루 운세로 작성하세요. 문단 사이는 \\n\\n으로 구분하세요(2~3문단 권장).
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "reading": "오늘의 룬 리딩 전체 텍스트",
  "one_line": "오늘 하루를 한 문장으로 요약한 문구 (15자 내외)"
}`;

    const userPrompt = `오늘(${date}) 뽑힌 세 룬:\n\n${groundingBlock}`;

    const parsed = await callGemini(systemPrompt, userPrompt);
  const payload = {
    date,
    reading: parsed.reading,
    one_line: parsed.one_line,
    runes: runes.map((r) => ({ id: r.id, name_ko: r.name_ko, name_en: r.name_en, glyph: r.glyph })),
  };
  dailyRuneCache = { date, payload };
  return payload;
}

// Did this (optional) logged-in caller already open today's reading?
async function hasOpenedDaily(req, date) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { token: null, opened: false };
  try {
    const u = await sbFetch('/auth/v1/user', token);
    if (!u.ok) return { token: null, opened: false };
    const r = await sbFetch(`/rest/v1/unlocked_items?app_key=eq.${APP_KEY}&item=eq.daily&ref=eq.${date}&select=id`, token);
    const rows = r.ok ? await r.json() : [];
    return { token, opened: rows.length > 0 };
  } catch {
    return { token: null, opened: false };
  }
}

// Free preview: the three runes and the one-line summary. The full reading is
// only included for someone who already opened it today.
app.get('/api/daily-rune', createLimiter(), async (req, res) => {
  try {
    const payload = await getDailyPayload();
    const { token, opened } = await hasOpenedDaily(req, payload.date);
    const cost = token ? await itemPrice(token, 'daily') : 1;
    const base = { date: payload.date, runes: payload.runes, one_line: payload.one_line, cost };
    if (opened) return res.json({ ...base, locked: false, reading: payload.reading });
    res.json({ ...base, locked: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Opens today's reading for 1 coin (once per day; opening it again is free and
// the text stays in the user's history).
app.post('/api/daily-rune/unlock', createLimiter(), async (req, res) => {
  try {
    const { token } = await requireUser(req);
    // generate first: if the AI is down the user is not charged
    const payload = await getDailyPayload();
    const { opened } = await hasOpenedDaily(req, payload.date);
    if (opened) {
      const balance = await walletBalance(token);
      return res.json({ reading: payload.reading, one_line: payload.one_line, already: true, balance });
    }
    const cost = await itemPrice(token, 'daily');
    const balance = await walletBalance(token);
    if (balance < cost) throw new HttpError(402, 'insufficient_coins', { balance, cost });

    const outcome = await saveAndCharge(token, 'save_daily_rune_with_spend', {
      p_date: payload.date,
      p_card_id: payload.runes[0].id,
      p_memo: JSON.stringify({
        type: 'daily', date: payload.date, one_line: payload.one_line,
        reading: payload.reading, runes: payload.runes,
      }),
    });
    res.json({
      reading: payload.reading, one_line: payload.one_line,
      already: !!outcome.already, balance: outcome.balance, cost: outcome.cost,
    });
  } catch (err) {
    if (err instanceof HttpError && err.body.error === 'bad_date') {
      return res.status(409).json({ error: 'date_changed' });
    }
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/premium-reading — 애정/주식/부동산/건강 룬, 1 coin per reading.
// ---------------------------------------------------------------------
app.post('/api/premium-reading', createLimiter(), async (req, res) => {
  const { id, category, displayName } = req.body || {};
  const question = cleanQuestion(req.body && req.body.question);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'unknown rune' });
  const rune = await findRune(id);
  if (!rune) return res.status(400).json({ error: 'unknown rune' });
  const themeLabel = THEME_LABEL[category];
  if (!themeLabel) return res.status(400).json({ error: 'unknown category' });

  let subject = null;
  let kind = null;
  if (category === 'realestate') {
    const s = cleanSubject(req.body && req.body.subject);
    if (s.error) return res.status(400).json({ error: s.error });
    subject = s.value;
    const k = req.body && req.body.kind;
    kind = REALESTATE_KINDS.includes(k) ? k : null;
  }

  let payer;
  try { payer = await requirePayer(req, 'premium'); } catch (err) { return sendError(res, err); }

  const DISCLAIMER = category === 'stock'
    ? '이 리딩은 룬의 상징으로 읽은 마음 이야기이며 투자 권유나 정보가 아닙니다. 투자 판단과 책임은 본인에게 있어요.'
    : '이 리딩은 룬의 상징으로 읽은 생활 이야기이며 부동산 계약·투자 권유가 아닙니다. 판단과 책임은 본인에게 있어요.';
  const STOCK_RULES = `- 이 리딩은 투자 정보나 조언이 아니라, 돈과 투자를 대하는 사용자의 마음(욕심, 조급함, 인내, 불안)을 룬의 상징으로 비춰보는 이야기입니다.
- 특정 종목·코인·펀드를 언급하거나 평가하지 마세요. 사용자가 종목을 물어도 정중히 거절하고, 그 질문 뒤의 마음가짐으로 돌려서 이야기하세요.
- 매수·매도 시점, 목표가, 시장·가격 전망, 수익이나 손실의 예측·보장, "오를 것이다/내릴 것이다" 같은 단정은 절대 말하지 마세요. 실제 시세·뉴스·재무 정보는 알지 못하며 사용하지 않습니다.
- "reading"의 마지막 문장은 반드시 다음 문장으로 끝내세요: "${DISCLAIMER}"`;
  const REALESTATE_RULES = `- 이번 리딩의 대상은 사용자가 입력한 주거용 위치(동네·단지)입니다. 룬의 상징으로 그곳에서의 생활 기운, 이사나 입주를 앞둔 마음가짐, 조심할 점을 읽어주세요.
- 당신은 그 지역의 실제 시세·정책·매물 정보를 알지 못하며 사용하지 않습니다. 가격 전망, 투자 수익 예측, 계약을 하라/말라는 권유는 절대 하지 마세요.
- "reading"의 마지막 문장은 반드시 다음 문장으로 끝내세요: "${DISCLAIMER}"`;
  const subjectRules = category === 'stock' ? STOCK_RULES : category === 'realestate' ? REALESTATE_RULES : '';

  const systemPrompt = `당신은 'OZ 룬타로'의 프리미엄 상담 코너를 진행하는 전문 리더입니다. 이번 리딩의 주제는 "${themeLabel}"입니다. 아래 룬 데이터를 이 주제에 맞게 해석해 깊이 있는 리딩을 제공하세요.

규칙:
- 룬의 일반적 의미를 그대로 나열하지 말고, 반드시 "${themeLabel}" 관점으로 재해석해서 풀어주세요.
- 사용자가 남긴 질문/상황이 있다면 거기에 구체적으로 답하듯 리딩하세요.
${displayName ? `- 사용자의 이름은 "${displayName}"입니다. 자연스러운 곳에서 한 번 불러주세요.` : ''}
- 룬은 방향 없이 하나의 모습으로 읽습니다(역방향·정방향 구분은 하지 않습니다). 룬의 조언과 그림자 측면을 이 주제에 맞게 함께 풀어주세요.
- "reading" 필드는 다음을 \\n\\n으로 구분해 400~600자 분량으로 작성하세요: (1) 상황 공감 1~2문장 (2) 룬이 이 주제에 대해 전하는 메시지 3~4문장 (3) 구체적인 실천 조언 2문장.
- "caution" 필드에는 이 리딩에서 특별히 주의해야 할 점을 1~2문장으로 요약하세요.
${subjectRules}
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "reading": "리딩 전체 텍스트",
  "caution": "주의할 점 요약"
}`;

  const subjectLine = !subject ? ''
    : `\n대상 주거 위치: "${subject}"${kind ? ` (상황: ${kind})` : ''}`;
  const userPrompt = `사용자 질문/상황: "${question || `(구체적인 상황 설명 없이 ${themeLabel}에 대한 전반적인 조언을 구합니다)`}"${subjectLine}

뽑힌 룬 정보:
${runeGroundingLines(rune, category)}`;

  try {
    const parsed = await callGemini(systemPrompt, userPrompt);
    const result = {
      reading: parsed.reading,
      caution: parsed.caution,
      rune: { id: rune.id, name_ko: rune.name_ko, name_en: rune.name_en, glyph: rune.glyph },
    };
    const outcome = await saveAndCharge(payer.token, 'save_rune_reading_with_spend', {
      p_item: 'premium',
      p_card_id: rune.id,
      p_mood: question,
      p_memo: JSON.stringify({ type: 'premium', category, subject, kind, ...result }),
    });
    res.json({ ...result, balance: outcome.balance, cost: outcome.cost, readingId: outcome.reading_id });
  } catch (err) {
    sendError(res, err);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.listen(PORT, () => {
  console.log(`Rune Tarot App running at http://localhost:${PORT}`);
});
