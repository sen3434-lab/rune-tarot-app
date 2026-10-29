// Shared logic for the 4 premium category pages (love/stock/realestate/health).
// Each page just supplies a small config object; this module handles the
// login / coin gate, the draw flow, and rendering — so the four pages never
// duplicate the same logic. Each reading costs 1 coin (charged by the server
// only after the reading was generated) and is saved to the user's history.

import { getSession, getMember, renderBottomNav, showToast, claimFreeCoins, renderCoinBadge, gateMessage } from '/js/app.js';
import { getRunes } from '/js/runes.js';
import { startCastSound, stopCastSound } from '/js/castSound.js';
import { renderRuneInfo } from '/js/runeInfo.js';

export async function initPremiumPage(config) {
  const { category, label, icon, placeholder, navActive, subject: subjectCfg, kinds, disclaimer } = config;

  renderBottomNav(navActive);

  const gateView = document.getElementById('gateView');
  const askView = document.getElementById('askView');
  const loadingView = document.getElementById('loadingView');
  const resultView = document.getElementById('resultView');

  document.getElementById('categoryLabel').textContent = label;
  document.getElementById('categoryIcon').textContent = icon;
  document.getElementById('questionText').placeholder = placeholder;

  function showGate(title, desc, btnText, btnHref) {
    askView.style.display = 'none';
    loadingView.style.display = 'none';
    resultView.style.display = 'none';
    gateView.style.display = 'block';
    document.getElementById('gateTitle').textContent = title;
    document.getElementById('gateDesc').textContent = desc;
    document.getElementById('gateBtn').textContent = btnText;
    document.getElementById('gateBtn').href = btnHref;
  }

  function showGateFor(status) {
    const g = gateMessage(status);
    showGate(g.title, g.desc, g.btn, g.href);
  }

  let session, member;
  try {
    session = await getSession();
    member = session ? await getMember(session) : null;
    if (session) await claimFreeCoins(session);
    await renderCoinBadge(document.getElementById('coinBadge'));
  } catch (err) {
    // Never leave the page blank on an unexpected auth/network error.
    console.error(err);
    showGate(
      '회원 정보를 확인하지 못했어요',
      `${label}은 코인 1개로 볼 수 있어요. 잠시 후 새로고침해서 다시 시도해주세요.`,
      '코인 화면 보기',
      '/coins.html'
    );
    return;
  }

  // 질문 입력창은 로그인 여부와 상관없이 보여주고, 풀이를 열 때 확인한다.
  askView.style.display = 'block';
  const submitBtn = document.querySelector('#askForm button[type="submit"]');
  if (submitBtn && !submitBtn.dataset.priced) {
    submitBtn.dataset.priced = '1';
    submitBtn.textContent += ' · 🪙 1코인';
  }

  const askForm = document.getElementById('askForm');
  const SUBJECT_RE = /^[0-9A-Za-z가-힣 .,&()\-]{1,40}$/;

  // 주거룬: 어디(동네·단지)에 대한 리딩인지, 어떤 상황인지 먼저 받는다.
  if (subjectCfg) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('label');
    lab.setAttribute('for', 'subjectInput');
    lab.style.cssText = 'display:block;font-size:12.5px;color:var(--muted-foreground);margin-bottom:6px;';
    lab.textContent = subjectCfg.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'subjectInput';
    input.maxLength = 40;
    input.placeholder = subjectCfg.placeholder || '';
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%;border:0.8px solid var(--border);border-radius:10px;padding:11px 12px;font-size:14px;background:var(--card);';
    wrap.append(lab, input);
    if (Array.isArray(kinds) && kinds.length) {
      const sel = document.createElement('select');
      sel.id = 'kindSelect';
      sel.style.cssText = 'width:100%;margin-top:10px;border:0.8px solid var(--border);border-radius:10px;padding:11px 12px;font-size:14px;background:var(--card);';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = '지금 어떤 상황인가요? (선택)';
      sel.appendChild(first);
      kinds.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
      wrap.appendChild(sel);
    }
    askForm.insertBefore(wrap, askForm.firstChild);
  }

  // 안내 문구: 투자 권유가 아니라는 점을 입력 화면과 결과 화면 양쪽에 보여준다.
  function noticeEl() {
    const p = document.createElement('p');
    p.className = 'small muted';
    p.style.cssText = 'text-align:center;line-height:1.7;margin-top:16px;';
    p.textContent = disclaimer;
    return p;
  }
  if (disclaimer) {
    askForm.appendChild(noticeEl());
    const actions = resultView.querySelector('.result-actions');
    resultView.insertBefore(noticeEl(), actions || null);
  }

  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = document.getElementById('questionText').value.trim();
    const subject = subjectCfg ? document.getElementById('subjectInput').value.replace(/\s+/g, ' ').trim() : '';
    const kindEl = document.getElementById('kindSelect');
    const kind = kindEl ? kindEl.value : '';
    if (subjectCfg) {
      if (!subject) { showToast('사는 곳(동네·단지)을 입력해주세요.'); return; }
      if (!SUBJECT_RE.test(subject)) { showToast('한글·숫자·영문만 40자까지 입력할 수 있어요.'); return; }
    }

    const fresh = await getSession();
    if (!fresh) { showGateFor(401); return; }

    askView.style.display = 'none';
    loadingView.style.display = 'block';
    gateView.style.display = 'none';

    try {
      const runes = await getRunes();
      const rune = runes[Math.floor(Math.random() * runes.length)];
      startCastSound();

      const res = await fetch('/api/premium-reading', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${fresh.access_token}`,
        },
        body: JSON.stringify({
          id: rune.id,
          category,
          question,
          subject: subjectCfg ? subject : undefined,
          kind: kind || undefined,
          displayName: member?.display_name || null,
        }),
      });
      if (res.status === 401 || res.status === 402) {
        stopCastSound();
        showGateFor(res.status);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '리딩에 실패했어요.');

      if (subjectCfg) {
        let echo = document.getElementById('subjectEcho');
        if (!echo) {
          echo = document.createElement('p');
          echo.id = 'subjectEcho';
          echo.className = 'small muted';
          echo.style.cssText = 'text-align:center;margin-top:18px;';
          resultView.insertBefore(echo, resultView.firstChild);
        }
        echo.textContent = '📍 ' + subject + (kind ? ' · ' + kind : '');
      }
      document.getElementById('glyphEl').textContent = rune.glyph || '';
      document.getElementById('runeNameEl').innerHTML = `${rune.name_ko} <span class="en">${rune.name_en}</span>`;
      document.getElementById('readingText').textContent = data.reading || '';
      document.getElementById('cautionText').textContent = data.caution || '';
      let infoBox = document.getElementById('runeInfoBox');
      if (!infoBox) {
        infoBox = document.createElement('div');
        infoBox.id = 'runeInfoBox';
        const actions = resultView.querySelector('.result-actions');
        resultView.insertBefore(infoBox, actions || null);
      }
      renderRuneInfo(infoBox, rune);

      stopCastSound();
      loadingView.style.display = 'none';
      resultView.style.display = 'block';
      await renderCoinBadge(document.getElementById('coinBadge'));
      showToast(`🪙 코인 ${data.cost}개를 썼어요 · 풀이는 기록에 저장돼요`, 3200);
    } catch (err) {
      console.error(err);
      stopCastSound();
      // 서버는 AI 풀이가 실패하면 코인을 차감하지 않는다.
      showToast('풀이를 불러오지 못했어요. 코인은 차감되지 않았어요.');
      loadingView.style.display = 'none';
      askView.style.display = 'block';
    }
  });

  document.getElementById('redrawBtn').addEventListener('click', () => {
    resultView.style.display = 'none';
    document.getElementById('questionText').value = '';
    askView.style.display = 'block';
  });
}
