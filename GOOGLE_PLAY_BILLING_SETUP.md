# 구글 플레이 결제 설정 (룬타로 (컬러타로·넘버스 타로와 같은 방식))

코드는 끝나 있고, 아래는 **구글/서버 쪽에서 한 번만 해 주는 설정**이에요.
순서대로 하면 됩니다. (앱마다 2·3번은 각각, 나머지는 한 번)

## 구조 한 줄 요약

앱에서 결제 → 구글이 영수증(구매 토큰) 발급 → 우리 서버가 **구글에 "진짜 결제 맞아?" 확인** → 맞으면 코인 지급 → 구글에 "처리 끝(소비)" 알림.
환불되면 `scripts/play-voided-sync.js` 가 구글의 환불 목록을 보고 코인을 회수해요.

---

## 1. DB 설정 (Supabase SQL Editor, 1번만)

1. `data/coins_5_billing.sql` 전체를 붙여 넣고 실행
2. 이어서 아래 한 줄 실행 (해시는 비밀이 아니라서 그대로 붙여도 안전)

```sql
insert into public.billing_secret (id, secret_hash)
values (1, 'a8a0615773ec1f6234e5e47b947f08b4c4f5eff2be01671f71ccd0eef6b2f78b')
on conflict (id) do update set secret_hash = excluded.secret_hash, updated_at = now();
```

> 서버에 DB 전체 권한 키(service_role)를 두지 않으려고 "결제 지급 전용 비밀번호"를 쓰는 방식이에요.
> 비밀번호 원문은 `color-tarot-app/twa/.billing-secret-DO-NOT-COMMIT.txt` 에 있고, 서버 `.env` 의 `BILLING_SECRET` 에만 넣습니다.

## 2. 플레이 콘솔: 상품 만들기 (앱마다)

앱 선택 → **수익 창출 → 제품 → 인앱 상품** → 상품 만들기

| 상품 ID (정확히 이대로) | 이름 | 가격 |
|---|---|---|
| `coins_15`  | 코인 15개  | 1,900원 |
| `coins_45`  | 코인 45개  | 4,900원 |
| `coins_100` | 코인 100개 | 9,900원 |

- 상품 ID는 **한 번 만들면 못 바꿔요.** DB의 `coin_products` 와 같아야 합니다.
- 종류는 일반 인앱 상품(소비성 — 코인처럼 여러 번 살 수 있는 것). 저장 후 **활성화**.
- 룬타로 앱에도 같은 3개를 만드세요.
- 결제 프로필(판매자 계정) 설정이 안 돼 있으면 상품 만들기가 막혀요. 안내대로 먼저 완료.

## 3. 구글 서비스 계정 (서버가 구글에 영수증 확인할 때 쓰는 열쇠, 1번만)

1. **구글 클라우드 콘솔**(console.cloud.google.com) → 프로젝트 선택(또는 새로 만들기)
2. **API 및 서비스 → 라이브러리 → "Google Play Android Developer API"** → 사용 설정
3. **IAM 및 관리자 → 서비스 계정 → 만들기** (이름 예: `ozma-play-billing`) → 만든 뒤 **키 → 키 추가 → JSON** → 파일 다운로드
4. **플레이 콘솔 → 사용자 및 권한 → 새 사용자 초대** → 이메일에 서비스 계정 주소(`...@...iam.gserviceaccount.com`) 입력
   → 권한: **앱 권한에서 두 앱 선택** + **"주문 및 구독 관리"**(재무 데이터가 아닌 주문 관리 권한) 체크 → 초대 보내기
5. 권한이 반영되기까지 **몇 시간까지** 걸릴 수 있어요. (바로 안 되면 기다렸다가 재시도)

JSON 파일은 **절대 깃에 올리지 마세요.** (`.gitignore` 에 `*service-account*.json`, `secrets/` 추가해 둠)

## 4. 서버(VPS)에 넣기 — 제가 SSH로 해드릴 수 있어요

JSON 파일을 서버 `/root/apps/secrets/play-service-account.json` 에 올리고(권한 600),
컬러/넘버스 두 앱의 `.env` 에 추가:

```
BILLING_SECRET=<twa/.billing-secret-DO-NOT-COMMIT.txt 의 값>
GOOGLE_SERVICE_ACCOUNT_FILE=/root/apps/secrets/play-service-account.json
```

그다음 `git pull` → `npm install` 은 필요 없음(새 패키지 없음) → `pm2 restart color-tarot numerology-tarot`

확인: `https://color.ozfortune.site/api/billing/status` 가 `{"enabled":true,...}` 이면 서버 준비 끝.
(`enabled:false` 면 위 환경변수 둘 중 하나가 빠진 거예요.)

## 5. 새 앱 올리기

- 컬러타로: 버전코드 **3**, 넘버스 타로: 버전코드 **4** 로 빌드한 AAB (`twa/` 폴더)
  - 이미 더 높은 버전코드를 올렸다면 알려 주세요. 올려서 다시 빌드할게요.
- 이 버전부터 앱에 구글 결제가 들어 있어요. **예전 버전 앱에서는 결제 버튼이 안 눌려요**(안내문만 보임).

## 6. 테스트 (실제 돈 안 나가게)

1. 플레이 콘솔 → **설정 → 라이선스 테스트** → 본인 구글 계정 이메일 추가
2. AAB를 **내부 테스트 트랙**에 올리고, 그 계정으로 플레이스토어에서 설치
   (⚠ 직접 APK 설치로는 결제가 안 돼요. 반드시 플레이스토어 설치본)
3. 앱 → 코인 → 15코인 결제 → 테스트 카드 결제창이 뜸 → 완료 후 코인이 들어오는지 확인
4. 코인 화면의 "결제 내역"에 기록이 보이는지 확인
5. 플레이 콘솔 → 주문 관리에서 테스트 주문 환불 → 아래 환불 동기화 실행 → 코인이 회수되는지 확인

## 7. 환불 코인 회수 (cron)

서버에서 (예: 6시간마다):

```
cd /root/apps/color-tarot-app && node scripts/play-voided-sync.js
cd /root/apps/numerology-tarot-app && node scripts/play-voided-sync.js
```

결과 예: `{"checked":1,"refunded":1,"already":0,"notFound":0}`
이미 써 버린 코인은 남은 만큼만 회수돼요(잔액이 마이너스가 되지 않음).

## 문제가 생기면

| 증상 | 원인 |
|---|---|
| 앱에서 "구글 플레이에서 설치한 앱에서만…" | 플레이스토어 설치본이 아님(웹/직접 설치) |
| "결제 기능을 준비 중이에요" | 서버 `/api/billing/status` 가 enabled:false (4번) |
| 결제는 되는데 코인이 안 들어옴 | 서비스 계정 권한 미반영(3-4~5) → 기다린 뒤 코인 화면을 다시 열면 자동 복구됨 |
| 서버 로그 `google lookup failed 401/403` | 서비스 계정에 앱 권한이 없음 |
| 서버 로그 `google lookup failed 404` | 상품 ID 오타, 또는 다른 앱의 영수증 |

## 정책 메모

- 인앱에서 파는 코인은 반드시 구글 결제를 써야 해요(코드가 그렇게 돼 있음). 앱 안에서 외부 결제(웹 결제 링크)로 안내하는 문구는 넣지 마세요.
- 출석·가입 보너스·수강생 코드로 **무료로 주는** 코인은 결제가 아니라서 괜찮아요.
- 환불/청약철회 안내, 통신판매업 신고, 이용약관은 별도로 준비가 필요해요(앱 설정 화면 링크 권장).
