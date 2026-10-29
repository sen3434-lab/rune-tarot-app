-- ============================================================
-- 룬타로 코인제 도입 (오늘의 룬 · 룬 뽑기 · 프리미엄 룬 각 1코인)
--
-- 먼저 실행되어 있어야 하는 것: coins_1_wallet.sql (RUN_THIS_coins_setup.sql 에 포함)
-- 재실행해도 안전합니다.
--
-- 이 파일이 하는 일
--   1) 룬타로 가격표: draw(룬 뽑기) / daily(오늘의 룬) / premium(프리미엄 룬) 각 1코인
--   2) 룬 풀이를 "저장 + 코인 차감"을 한 번에 하는 함수 (둘 다 되거나 둘 다 안 됨)
--   3) 오늘의 룬: 하루 한 번만 결제되는 함수 (같은 날 다시 열면 무료, 기록으로 다시 볼 수 있음)
--
-- 풀이 내용(memo)은 readings 표에 저장되어 앱의 "기록"에서 언제든 다시 볼 수 있습니다.
-- ============================================================

insert into public.coin_prices (app_key, item, coins) values
  ('rune-tarot', 'draw',    1),
  ('rune-tarot', 'daily',   1),
  ('rune-tarot', 'premium', 1)
on conflict (app_key, item) do nothing;

-- 코인 사용 내역에 보이는 이름
create or replace function public._rune_label(p_item text)
returns text
language sql
immutable
as $$
  select case p_item
    when 'draw'    then '룬 뽑기'
    when 'daily'   then '오늘의 룬'
    when 'premium' then '프리미엄 룬'
    else '룬 리딩'
  end;
$$;

-- 룬 뽑기 / 프리미엄 룬: 풀이 저장 + 코인 차감 (AI 풀이가 성공한 뒤에 서버가 호출)
create or replace function public.save_rune_reading_with_spend(
  p_item text, p_card_id bigint, p_mood text, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cost int;
  v_reading_id bigint;
  v_balance int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_logged_in');
  end if;
  if p_item not in ('draw', 'premium') then
    return jsonb_build_object('ok', false, 'reason', 'bad_item');
  end if;
  if length(coalesce(p_memo, '')) > 20000 or length(coalesce(p_mood, '')) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;

  v_cost := public._price('rune-tarot', p_item);
  begin
    insert into public.readings (user_id, card_id, mood_input, memo, app_key)
      values (v_uid, p_card_id, p_mood, p_memo, 'rune-tarot')
      returning id into v_reading_id;
    v_balance := public._wallet_apply(v_uid, -v_cost, 'spend', 'rune-tarot', v_reading_id::text,
                                      public._rune_label(p_item));
  exception when raise_exception then
    if sqlerrm = 'insufficient_coins' then
      -- 이 블록 안의 변경(풀이 저장)은 자동으로 취소됨
      select coalesce(balance, 0) into v_balance from public.wallets where member_id = v_uid;
      return jsonb_build_object('ok', false, 'reason', 'insufficient_coins',
                                'balance', coalesce(v_balance, 0), 'cost', v_cost);
    end if;
    raise;
  end;

  return jsonb_build_object('ok', true, 'reading_id', v_reading_id, 'balance', v_balance, 'cost', v_cost);
end;
$$;

-- 오늘의 룬: 하루(한국 시간) 한 번만 결제. 같은 날 다시 호출하면 무료로 "이미 열었음"을 알려줌.
create or replace function public.save_daily_rune_with_spend(
  p_date text, p_card_id bigint, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today text := ((now() at time zone 'Asia/Seoul')::date)::text;
  v_cost int;
  v_reading_id bigint;
  v_balance int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_logged_in');
  end if;
  -- 오늘 날짜만 가능 (다른 날짜를 몰래 사서 기록에 끼워 넣지 못하게)
  if p_date is distinct from v_today then
    return jsonb_build_object('ok', false, 'reason', 'bad_date');
  end if;
  if length(coalesce(p_memo, '')) > 20000 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;

  -- 같은 사람의 동시 요청이 이중 차감되지 않도록 지갑 행을 먼저 잠금
  insert into public.wallets (member_id) values (v_uid) on conflict do nothing;
  perform 1 from public.wallets where member_id = v_uid for update;

  if exists (select 1 from public.unlocked_items
             where member_id = v_uid and app_key = 'rune-tarot' and item = 'daily' and ref = p_date) then
    select coalesce(balance, 0) into v_balance from public.wallets where member_id = v_uid;
    return jsonb_build_object('ok', true, 'already', true, 'balance', v_balance);
  end if;

  v_cost := public._price('rune-tarot', 'daily');
  begin
    insert into public.readings (user_id, card_id, mood_input, memo, app_key)
      values (v_uid, p_card_id, '오늘의 룬 ' || p_date, p_memo, 'rune-tarot')
      returning id into v_reading_id;
    v_balance := public._wallet_apply(v_uid, -v_cost, 'spend', 'rune-tarot', 'daily:' || p_date,
                                      public._rune_label('daily'));
  exception when raise_exception then
    if sqlerrm = 'insufficient_coins' then
      select coalesce(balance, 0) into v_balance from public.wallets where member_id = v_uid;
      return jsonb_build_object('ok', false, 'reason', 'insufficient_coins',
                                'balance', coalesce(v_balance, 0), 'cost', v_cost);
    end if;
    raise;
  end;

  insert into public.unlocked_items (member_id, app_key, item, ref, meta)
    values (v_uid, 'rune-tarot', 'daily', p_date, jsonb_build_object('reading_id', v_reading_id))
    on conflict do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'reading_id', v_reading_id,
                            'balance', v_balance, 'cost', v_cost);
end;
$$;

revoke all on function public._rune_label(text)                                    from public, anon, authenticated;
revoke all on function public.save_rune_reading_with_spend(text,bigint,text,text)  from public, anon;
revoke all on function public.save_daily_rune_with_spend(text,bigint,text)         from public, anon;
grant execute on function public.save_rune_reading_with_spend(text,bigint,text,text) to authenticated;
grant execute on function public.save_daily_rune_with_spend(text,bigint,text)        to authenticated;

-- ------------------------------------------------------------
-- (선택) 룬타로 수강생 코드 만들기 — 코드 입력 시 100코인
--   코드 이름은 원하는 대로 바꾸세요. 예시:
--
--   insert into public.class_codes (code, app_key, label, coins)
--   values ('OZMA-2026-RUNE', 'rune-tarot', '2026 룬타로 수강생', 100)
--   on conflict (code, app_key) do nothing;
--
--   (인원 제한·만료일을 넣으려면 max_uses, expires_at 칸도 함께 쓰세요.
--    칸 설명은 schema_migration_4_class_codes.sql 참고)
-- ------------------------------------------------------------
