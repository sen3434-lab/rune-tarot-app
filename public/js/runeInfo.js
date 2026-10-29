// "룬 정보" card shown under a reading: what this rune means on its own.
// The text comes from the shared tarot_cards table (already loaded by
// runes.js), so showing it costs nothing extra.

let styled = false;
function ensureStyle() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
    .rune-info { border: 0.8px solid var(--border); border-radius: 16px; overflow: hidden; margin-top: 18px; background: var(--card); }
    .rune-info .ri-head { padding: 12px 16px; background: rgba(188,99,56,.06); border-bottom: 0.8px solid var(--border); font-weight: 600; font-size: 13.5px; color: var(--primary-dark); }
    .rune-info .ri-row { display: flex; gap: 12px; padding: 11px 16px; border-bottom: 0.8px solid var(--border); font-size: 13px; line-height: 1.65; }
    .rune-info .ri-row:last-child { border-bottom: none; }
    .rune-info .ri-l { width: 64px; flex-shrink: 0; color: var(--muted-foreground); }
    .rune-info .ri-v { color: var(--foreground); min-width: 0; }
  `;
  document.head.appendChild(s);
}

const ROWS = [
  ['키워드', 'keywords'],
  ['의미', 'meaning'],
  ['수호신', 'deity'],
  ['원소', 'element'],
  ['룬의 조언', 'advice'],
  ['주의할 점', 'caution'],
];

// container: an element to fill; rune: one row from getRunes()
export function renderRuneInfo(container, rune) {
  if (!container || !rune) return;
  ensureStyle();
  container.textContent = '';
  const rows = ROWS.filter(([, key]) => rune[key] && String(rune[key]).trim());
  if (!rows.length) return;

  const card = document.createElement('div');
  card.className = 'rune-info';
  const head = document.createElement('div');
  head.className = 'ri-head';
  head.textContent = `${rune.glyph || 'ᚱ'} ${rune.name_ko} · 룬 정보`;
  card.appendChild(head);
  rows.forEach(([label, key]) => {
    const row = document.createElement('div');
    row.className = 'ri-row';
    const l = document.createElement('div');
    l.className = 'ri-l';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'ri-v';
    v.textContent = String(rune[key]).trim();
    row.append(l, v);
    card.appendChild(row);
  });
  container.appendChild(card);
}
