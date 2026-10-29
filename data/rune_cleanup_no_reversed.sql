-- ============================================================
-- 룬에는 역방향이 없다 — DB에 남아 있는 "정방향/역방향" 문구 정리
--
-- 앱 코드는 이미 방향 개념을 쓰지 않습니다. 이 파일은 데이터베이스(tarot_cards)에 저장된
-- 룬 설명 안에 "정방향/역방향"이라는 말이 남아 있으면 AI 풀이에 섞여 나올 수 있어서,
-- 먼저 찾아보고(1번), 위르드 문구만 안전하게 고치는(2번) 용도입니다.
-- 재실행해도 안전합니다.
-- ============================================================

-- 1) 어떤 룬의 어떤 칸에 남아 있는지 확인 (아무것도 바꾸지 않음)
select name_ko,
       name,
       case when meaning       ~ '정방향|역방향' then 'meaning'       end as in_meaning,
       case when advice        ~ '정방향|역방향' then 'advice'        end as in_advice,
       case when caution       ~ '정방향|역방향' then 'caution'       end as in_caution,
       case when remedy_magic  ~ '정방향|역방향' then 'remedy_magic'  end as in_remedy
from public.tarot_cards
where card_type = '룬타로'
  and (meaning ~ '정방향|역방향' or advice ~ '정방향|역방향'
       or caution ~ '정방향|역방향' or remedy_magic ~ '정방향|역방향')
order by id;

-- 2) 위르드(Wyrd)의 "정방향과 역방향의 구분이 없다" 문장만 제거
update public.tarot_cards
set caution = replace(caution,
      '위르드는 정방향과 역방향의 구분이 없다. 어느 자리에 나오든',
      '위르드는 어느 자리에 나오든')
where card_type = '룬타로' and name = 'Wyrd'
  and caution like '%정방향과 역방향의 구분이 없다%';

-- 3) 다시 확인: 결과가 0줄이면 정리 끝. 줄이 남으면 그 룬의 해당 칸을 직접 고쳐 주세요.
select name_ko, name from public.tarot_cards
where card_type = '룬타로'
  and (meaning ~ '정방향|역방향' or advice ~ '정방향|역방향'
       or caution ~ '정방향|역방향' or remedy_magic ~ '정방향|역방향')
order by id;
