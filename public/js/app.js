// Shared app bootstrap: Supabase client, auth helpers, nav, toast.
// Loaded as a module on every page. Mirrors color-tarot-app/public/js/app.js
// so both apps share the same multi-app membership schema.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let _sb = null;
let _sbReady;

async function initSupabase() {
  if (_sb) return _sb;
  const res = await fetch('/api/config');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  _sb = createClient(supabaseUrl, supabaseAnonKey);
  return _sb;
}

_sbReady = initSupabase();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

export async function getSb() {
  return _sbReady;
}

// True when running inside the Android TWA wrapper (see color-tarot-app's
// app.js for why this matters — Play Billing requirements for in-app payment UI).
export function isTWA() {
  return document.referrer.startsWith('android-app://');
}

export async function getSession() {
  const sb = await getSb();
  const { data } = await sb.auth.getSession();
  return data.session;
}

// This app's key in the shared multi-app membership schema (public.apps).
export const APP_KEY = 'rune-tarot';

// Ensures public.members and public.enrollments (this app's row) both
// exist for the current user, then returns a merged view.
export async function ensureMemberRow(session, nickname) {
  if (!session) return null;
  const sb = await getSb();

  // Two separate lookups on purpose — a person who already has a `members`
  // row from another ozma app (e.g. color-tarot) but no enrollment for
  // *this* app_key yet must still be recognized as an existing member.
  // An inner-joined single query here would wrongly treat "no enrollment
  // for this app" as "no member at all" and try to re-insert a members
  // row with the same id, which fails on the primary key.
  let { data: memberRow } = await sb
    .from('members')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!memberRow) {
    const oauthName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || null;
    let pendingNickname = null;
    try { pendingNickname = localStorage.getItem('rt_pending_nickname'); } catch {}
    const { data: created, error } = await sb
      .from('members')
      .insert({ id: session.user.id, email: session.user.email, display_name: oauthName || nickname || pendingNickname || null })
      .select()
      .single();
    if (error) {
      console.error('ensureMemberRow (members) failed', error);
      return null;
    }
    try { localStorage.removeItem('rt_pending_nickname'); } catch {}
    memberRow = created;
  }

  let { data: enrollment } = await sb
    .from('enrollments')
    .select('*')
    .eq('member_id', session.user.id)
    .eq('app_key', APP_KEY)
    .maybeSingle();

  if (!enrollment) {
    const { data: created, error } = await sb
      .from('enrollments')
      .insert({ member_id: session.user.id, app_key: APP_KEY })
      .select()
      .single();
    if (error) {
      console.error('ensureMemberRow (enrollment) failed', error);
      return null;
    }
    enrollment = created;
  } else if (enrollment.role !== 'student') {
    // Only worth the extra round trip if they're not already a student —
    // once promoted there's nothing left to recheck. Matches
    // color-tarot-app's behavior: someone added to the roster after they
    // first signed up gets upgraded on their next visit.
    const { data: isStudent } = await sb.rpc('recheck_student_status', { p_app_key: APP_KEY });
    if (isStudent) {
      enrollment = { ...enrollment, role: 'student' };
    }
  }

  return {
    id: memberRow.id,
    email: memberRow.email,
    display_name: memberRow.display_name,
    created_at: memberRow.created_at,
    enrollment_id: enrollment.id,
    role: enrollment.role,
    subscription_status: enrollment.subscription_status,
    subscription_expires_at: enrollment.subscription_expires_at,
    daily_reading_count: enrollment.daily_reading_count,
    daily_reading_reset_date: enrollment.daily_reading_reset_date,
  };
}

export async function getMember(session, nickname) {
  return ensureMemberRow(session, nickname);
}

export function isSubscribed(member) {
  return !!member && member.subscription_status === 'active';
}

// 룬 뽑기 하루 1회 제한의 예외 — 수강생이거나 프리미엄 결제 회원이면 무제한.
// (프리미엄 4개 카테고리 자체는 결제 회원 전용이라 isSubscribed()만 쓴다 —
// 수강생이라고 해서 프리미엄까지 자동으로 열리는 건 아니다.)
export function hasUnlimitedDraws(member) {
  return !!member && (member.role === 'student' || member.subscription_status === 'active');
}

export async function signOut() {
  const sb = await getSb();
  await sb.auth.signOut();
  window.location.href = '/auth.html';
}

export function showToast(msg, ms = 2200) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

const NAV_ITEMS = [
  { href: '/index.html', ic: '\u{1FAA8}', label: '홈' },
  { href: '/daily.html', ic: '\u{2600}\u{FE0F}', label: '오늘의 룬' },
  { href: '/draw.html', ic: '\u{1F52E}', label: '룬 뽑기' },
  { href: '/premium.html', ic: '\u{2728}', label: '프리미엄' },
  { href: '/settings.html', ic: '\u{2699}\u{FE0F}', label: '설정' },
];

export function renderBottomNav(active) {
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = NAV_ITEMS.map(item => `
    <a href="${item.href}" class="${active === item.href ? 'active' : ''}">
      <span class="ic">${item.ic}</span>
      <span>${item.label}</span>
    </a>
  `).join('');
  document.body.appendChild(nav);
}

export function fmtDate(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}년 ${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/auth.html';
    return null;
  }
  return session;
}
