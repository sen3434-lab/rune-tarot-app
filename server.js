require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
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
  'deity', 'element', 'upright:advice', 'reversed:caution', 'remedy_magic',
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
    rune.upright && `정방향(순리대로 흐를 때): ${rune.upright}`,
    rune.reversed && `역방향(경고/그림자 측면, 위르드처럼 역방향이 없는 룬은 해석 원칙): ${rune.reversed}`,
    rune.remedy_magic && `전통적 활용: ${rune.remedy_magic}`,
  ];
  return lines.filter(Boolean).join('\n');
}

const THEME_LABEL = {
  love: '애정운 (연애, 관계, 결혼)',
  stock: '주식·투자운 (매매 타이밍, 리스크 관리)',
  realestate: '부동산운 (매매, 이사, 계약, 입지)',
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
// POST /api/reading — single-rune draw, free. Used by draw.html (룬 뽑기).
// ---------------------------------------------------------------------
app.post('/api/reading', async (req, res) => {
  const { id, question, displayName } = req.body || {};
  const rune = await findRune(id);
  if (!rune) return res.status(400).json({ error: 'unknown rune' });

  const systemPrompt = `당신은 'OZ 룬타로'에서 사용자의 질문에 룬으로 답해주는 다정하고 통찰력 있는 리더입니다. 룬의 전통적인 상징(아래 자료)을 존중하면서, 사용자의 실제 상황에 자연스럽게 녹여 리딩합니다.

규칙:
- 아래 전달되는 룬 데이터는 참고 자료입니다. 항목명을 그대로 나열하지 말고 자연스러운 이야기로 풀어내세요.
- 사용자가 질문/상황을 남겼다면 그에 먼저 공감한 뒤, 룬이 지금 이 상황에 어떤 의미로 다가오는지 풀어주세요. 질문이 없다면 오늘 하루나 지금 이 순간에 대한 조언으로 풀어주세요.
${displayName ? `- 사용자의 이름은 "${displayName}"입니다. 자연스러운 곳에서 한 번 정도 "${displayName}님"이라고 불러주세요.` : ''}
- 정방향/역방향 중 어느 쪽으로 리딩할지는 스스로 판단하되(역방향이 없는 룬은 정방향 의미와 그 그림자 측면을 함께 다루세요), 그 판단이 왜 지금 상황에 맞는지 리딩 속에 자연스럽게 드러나야 합니다.
- 예언하거나 단정짓지 말고, 통찰과 조언을 주는 톤으로 씁니다.
- "reading" 필드는 다음 3부분을 \\n\\n으로 구분해 작성하세요: (1) 지금 상황에 대한 공감 1~2문장 (2) 룬이 전하는 메시지 3~4문장 (3) 실천 조언 1~2문장.
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "reading": "3문단을 \\n\\n으로 구분한 텍스트",
  "orientation": "정방향 또는 역방향 중 이번 리딩에서 채택한 쪽"
}`;

  const userPrompt = `사용자 질문/상황: "${question || '(오늘 하루에 대한 조언을 구합니다)'}"

뽑힌 룬 정보:
${runeGroundingLines(rune, null)}`;

  try {
    const parsed = await callGemini(systemPrompt, userPrompt);
    res.json({
      reading: parsed.reading,
      orientation: parsed.orientation,
      rune: { id: rune.id, name_ko: rune.name_ko, name_en: rune.name_en, glyph: rune.glyph },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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

app.get('/api/daily-rune', async (req, res) => {
  const date = todayKST();
  if (dailyRuneCache && dailyRuneCache.date === date) {
    return res.json(dailyRuneCache.payload);
  }

  try {
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
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Subscription check for the 4 premium categories. Verifies against the
// caller's OWN Supabase row via RLS (their access token), so no service
// role key is needed — a request can never read someone else's enrollment.
// ---------------------------------------------------------------------
async function requireActiveSubscription(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error('로그인이 필요해요.');
    err.status = 401;
    throw err;
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) {
    const err = new Error('로그인이 필요해요.');
    err.status = 401;
    throw err;
  }
  const { data: enrollment } = await sb
    .from('enrollments')
    .select('subscription_status')
    .eq('member_id', userData.user.id)
    .eq('app_key', APP_KEY)
    .maybeSingle();

  if (!enrollment || enrollment.subscription_status !== 'active') {
    const err = new Error('프리미엄 룬 구독이 필요해요.');
    err.status = 403;
    throw err;
  }
}

// ---------------------------------------------------------------------
// POST /api/premium-reading — 애정/주식/부동산/건강 룬, subscription-gated.
// ---------------------------------------------------------------------
app.post('/api/premium-reading', async (req, res) => {
  const { id, category, question, displayName } = req.body || {};
  const rune = await findRune(id);
  if (!rune) return res.status(400).json({ error: 'unknown rune' });
  const themeLabel = THEME_LABEL[category];
  if (!themeLabel) return res.status(400).json({ error: 'unknown category' });

  try {
    await requireActiveSubscription(req);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const systemPrompt = `당신은 'OZ 룬타로'의 프리미엄 상담 코너를 진행하는 전문 리더입니다. 이번 리딩의 주제는 "${themeLabel}"입니다. 아래 룬 데이터를 이 주제에 맞게 해석해 깊이 있는 리딩을 제공하세요.

규칙:
- 룬의 일반적 의미를 그대로 나열하지 말고, 반드시 "${themeLabel}" 관점으로 재해석해서 풀어주세요.
- 사용자가 남긴 질문/상황이 있다면 거기에 구체적으로 답하듯 리딩하세요.
${displayName ? `- 사용자의 이름은 "${displayName}"입니다. 자연스러운 곳에서 한 번 불러주세요.` : ''}
- 정방향/역방향 중 상황에 맞는 쪽을 스스로 판단해 리딩하세요.
- "reading" 필드는 다음을 \\n\\n으로 구분해 400~600자 분량으로 작성하세요: (1) 상황 공감 1~2문장 (2) 룬이 이 주제에 대해 전하는 메시지 3~4문장 (3) 구체적인 실천 조언 2문장.
- "caution" 필드에는 이 리딩에서 특별히 주의해야 할 점을 1~2문장으로 요약하세요.
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "reading": "리딩 전체 텍스트",
  "caution": "주의할 점 요약",
  "orientation": "정방향 또는 역방향 중 채택한 쪽"
}`;

  const userPrompt = `사용자 질문/상황: "${question || `(구체적인 상황 설명 없이 ${themeLabel}에 대한 전반적인 조언을 구합니다)`}"

뽑힌 룬 정보:
${runeGroundingLines(rune, category)}`;

  try {
    const parsed = await callGemini(systemPrompt, userPrompt);
    res.json({
      reading: parsed.reading,
      caution: parsed.caution,
      orientation: parsed.orientation,
      rune: { id: rune.id, name_ko: rune.name_ko, name_en: rune.name_en, glyph: rune.glyph },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.listen(PORT, () => {
  console.log(`Rune Tarot App running at http://localhost:${PORT}`);
});
