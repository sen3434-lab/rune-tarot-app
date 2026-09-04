// Shared logic for the 4 premium category pages (love/stock/realestate/health).
// Each page just supplies a small config object; this module handles the
// subscription gate, the draw flow, and rendering — so the four pages never
// duplicate the same logic.

import { getSb, getSession, getMember, renderBottomNav, isSubscribed, showToast } from '/js/app.js';
import { getRunes } from '/js/runes.js';
import { startCastSound, stopCastSound } from '/js/castSound.js';

export async function initPremiumPage(config) {
  const { category, label, icon, placeholder, navActive } = config;

  renderBottomNav(navActive);

  const gateView = document.getElementById('gateView');
  const askView = document.getElementById('askView');
  const loadingView = document.getElementById('loadingView');
  const resultView = document.getElementById('resultView');

  document.getElementById('categoryLabel').textContent = label;
  document.getElementById('categoryIcon').textContent = icon;
  document.getElementById('questionText').placeholder = placeholder;

  function showGate(title, desc, btnText, btnHref) {
    gateView.style.display = 'block';
    document.getElementById('gateTitle').textContent = title;
    document.getElementById('gateDesc').textContent = desc;
    document.getElementById('gateBtn').textContent = btnText;
    document.getElementById('gateBtn').href = btnHref;
  }

  let session, member;
  try {
    session = await getSession();
    member = session ? await getMember(session) : null;
  } catch (err) {
    // Never leave the page blank on an unexpected auth/network error — a
    // person who lands here always needs to know this is a paid feature,
    // whatever went wrong finding out their exact membership status.
    console.error(err);
    showGate(
      '프리미엄 구독이 필요해요',
      `${label}은 유료 결제(구독) 회원만 이용하실 수 있는 프리미엄 서비스예요. 지금 회원 정보를 확인하지 못했어요 — 잠시 후 새로고침해서 다시 시도해주세요.`,
      '구독 안내 보기',
      '/subscribe.html'
    );
    return;
  }

  if (!session) {
    showGate(
      '로그인이 필요해요',
      `${label}은 유료 결제(구독) 회원만 이용하실 수 있는 프리미엄 서비스예요. 먼저 로그인해주세요.`,
      '로그인하기',
      '/auth.html'
    );
    return;
  }

  if (!isSubscribed(member)) {
    showGate(
      '프리미엄 구독이 필요해요',
      `${label}은 유료 결제가 필요한 프리미엄 묶음 구독 전용 서비스예요. 구독하시면 애정·주식·부동산·건강 룬을 모두 무제한으로 만나보실 수 있어요.`,
      '구독 안내 보기',
      '/subscribe.html'
    );
    return;
  }

  askView.style.display = 'block';

  const askForm = document.getElementById('askForm');
  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = document.getElementById('questionText').value.trim();

    askView.style.display = 'none';
    loadingView.style.display = 'block';

    try {
      const runes = await getRunes();
      const rune = runes[Math.floor(Math.random() * runes.length)];
      startCastSound();

      const sb = await getSb();
      const { data: { session: freshSession } } = await sb.auth.getSession();
      const res = await fetch('/api/premium-reading', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${freshSession.access_token}`,
        },
        body: JSON.stringify({
          id: rune.id,
          category,
          question,
          displayName: member?.display_name || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '리딩에 실패했어요.');

      document.getElementById('glyphEl').textContent = rune.glyph || '';
      document.getElementById('runeNameEl').innerHTML = `${rune.name_ko} <span class="en">${rune.name_en}</span>`;
      document.getElementById('orientationTag').textContent = data.orientation === '역방향' ? '역방향 · Reversed' : '정방향 · Upright';
      document.getElementById('readingText').textContent = data.reading || '';
      document.getElementById('cautionText').textContent = data.caution || '';

      stopCastSound();
      loadingView.style.display = 'none';
      resultView.style.display = 'block';
    } catch (err) {
      console.error(err);
      stopCastSound();
      showToast(err.message || '리딩에 실패했어요.');
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
