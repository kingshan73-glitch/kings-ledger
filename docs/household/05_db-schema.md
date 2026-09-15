# 05. DB 스키마 (Supabase)

> 02(도메인)·03(규칙)·04(UI)를 확정한 뒤 작성하는 **확정 스키마 설계**입니다.
> 이 문서가 확인되면 `supabase/migrations/`에 마이그레이션 SQL을 작성하고 `supabase db push`로 적용합니다.
>
> **상태:** 스키마 설계 1차 완료 — 마이그레이션 작성(구현)으로 진행.

---

## 0. 설계 결정 (기존 스키마 관례 반영)

기존 `20260101000000_init.sql` 분석 결과를 그대로 따른다:

- **접두사 `hh_`** (household) — 회사 재무 테이블(`expenses`, `revenues`, `deposits` 등)과 분리.
- **PK**: `id uuid DEFAULT gen_random_uuid()`.
- **금액**: `integer` (원 단위 정수, 기존 `recurring_expenses.amount integer`와 동일). 소수점 없음.
- **날짜**: 거래일은 `date`, 생성/수정은 `timestamptz DEFAULT now()`.
- **타임스탬프**: `created_at`, `updated_at timestamptz` + `update_updated_at()` 트리거(기존 함수 재사용).
- **RLS**: 가계부는 **개인 데이터** → 회사 공유형(`WITH CHECK (true)`)이 아니라
  **`owner_auth_uid uuid = auth.uid()` 소유자 스코프**(기존 `contracts.owner_auth_uid` 선례).
  모든 `hh_*` 테이블에 `owner_auth_uid` 컬럼 + 본인 행만 select/insert/update/delete.
- **소프트 삭제 없음**(기존 관례 따라 hard delete + `confirm()`), 단 `is_active`로 마스터 비활성 처리.

> **결정 필요 ①:** `owner_auth_uid`를 **로그인한 관리자(admin) 1명 고정**으로 볼지, 멀티유저 가족 공유로 볼지.
> 권장 = 우선 **본인 소유 스코프**(부부 공유는 같은 계정 사용 또는 2차 확장). 인물(Person)으로 가족 구분은 별개.

---

## 1. 마스터 테이블

### `hh_person` — 인물
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL            -- RLS
name            text NOT NULL            -- 김하늘 / 이바다 / 가족
sort_order      smallint DEFAULT 0
is_active       boolean DEFAULT true
created_at, updated_at timestamptz
```

### `hh_account` — 계좌  ⚠️ 로그인 자격증명 컬럼 없음
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
name            text NOT NULL            -- 토스뱅크, 국민은행-한
bank            text                     -- 은행명
account_no      text                     -- 계좌번호(저장, 화면 마스킹). NULL 허용
person_id       uuid → hh_person(id)     -- 명의
kind            text NOT NULL            -- 'checking'(입출금)|'stock'(주식)|'family'(가족)|'other'
opening_balance integer DEFAULT 0        -- 기초(이월)잔액
sort_order      smallint DEFAULT 0
is_active       boolean DEFAULT true
created_at, updated_at
-- 현잔액은 저장하지 않음 → 뷰에서 계산(R1)
```

### `hh_category` — 카테고리
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
name            text NOT NULL            -- 외식비, 식료품비, 급여 ...
kind            text NOT NULL            -- 'income' | 'expense'
is_fixed        boolean DEFAULT false    -- 고정비 여부(월고정비현황 대응)
sort_order      smallint DEFAULT 0
is_active       boolean DEFAULT true
created_at, updated_at
UNIQUE(owner_auth_uid, name, kind)
```

### `hh_payment_method` — 결제수단
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
name            text NOT NULL            -- 현금, 삼성카드(한)
kind            text NOT NULL            -- 'cash'|'check'(체크)|'credit'(신용)|'installment'
person_id       uuid → hh_person(id)     -- 카드 명의
linked_account_id uuid → hh_account(id)  -- 결제 출금계좌(카드대금 빠지는 통장)
billing_day     smallint                 -- 신용카드 결제일(1~28), 현금흐름 추정용. NULL 허용
is_active       boolean DEFAULT true
sort_order      smallint DEFAULT 0
created_at, updated_at
CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 28)
```

---

## 2. 거래 (중심 테이블)

### `hh_transaction` — 모든 거래를 type으로 구분
```sql
id               uuid PK
owner_auth_uid   uuid NOT NULL
txn_date         date NOT NULL
type             text NOT NULL            -- 'income'|'expense'|'installment'|'transfer'|'payment'
amount           integer NOT NULL CHECK (amount >= 0)   -- 항상 양수, 부호는 type으로(R6)
category_id      uuid → hh_category(id)   -- income/expense/installment
counterparty     text                     -- 입금처/가맹점명
memo             text                     -- 내역/상세
note             text                     -- 비고

-- 결제수단(지출용)
payment_method_id uuid → hh_payment_method(id)

-- 계좌 관계 (type에 따라 의미)
account_id       uuid → hh_account(id)    -- income=입금계좌, expense(현금/체크)=출금계좌
from_account_id  uuid → hh_account(id)    -- transfer/payment 출금
to_account_id    uuid → hh_account(id)    -- transfer 입금

-- 귀속/연결
person_id        uuid → hh_person(id)     -- 용돈 귀속(nullable)
installment_id   uuid → hh_installment(id)-- 할부 회차 반영 거래
loan_id          uuid → hh_loan(id)       -- 대출 상환(payment) 연결

source           text DEFAULT 'manual'    -- 'manual'|'inbox'(수집함 확정)|'import'(엑셀이관)
created_at, updated_at

-- 유형별 필수필드 보장(부분 CHECK 또는 앱단 검증 — 결정 필요 ②)
```

> **결정 필요 ②:** 유형별 필수 필드(예: transfer는 from/to 둘 다 NOT NULL)를
> **DB CHECK 제약**으로 강제할지 **앱 검증**으로 둘지. 권장 = 핵심만 CHECK
> (`type='transfer' → from_account_id, to_account_id NOT NULL`), 나머지는 앱 폼 검증.

**인덱스:** `(owner_auth_uid, txn_date)`, `(owner_auth_uid, type, txn_date)`, `(category_id)`, `(account_id)`, `(installment_id)`, `(loan_id)`.

---

## 3. 스케줄 테이블

### `hh_installment` — 할부
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
start_date      date NOT NULL
payment_method_id uuid → hh_payment_method(id)  -- 사용카드
category_id     uuid → hh_category(id)
title           text                     -- 내용
total_amount    integer NOT NULL         -- 총금액
total_count     smallint NOT NULL        -- 총회차
start_installment smallint DEFAULT 1      -- 시작회차
is_active       boolean DEFAULT true
created_at, updated_at
-- 월금액 = round(total_amount/total_count), 끝수는 마지막 회차 보정(R3) → 계산값
```

### `hh_loan` — 대출
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
name            text NOT NULL
origin_date     date                     -- 발생일
principal       integer NOT NULL         -- 대출금액(원금)
current_balance integer NOT NULL         -- 현재잔액(상환 연동 갱신 또는 계산)
maturity_date   date                     -- 만기일
interest_rate   numeric(5,2)             -- 이자율(%)
monthly_payment integer                  -- 월납입금
payment_day     smallint                 -- 약정 상환일(1~28), 현금흐름용
status          text DEFAULT 'active'     -- 'active'(상환중)|'closed'(완료)
created_at, updated_at
CHECK (payment_day IS NULL OR payment_day BETWEEN 1 AND 28)
```
> 잔액: 단순모델 = `principal − Σ(연결 payment.amount)`(R4). 화면 계산 또는 트리거 — **결정 필요 ③**(권장: 뷰 계산).

### `hh_scheduled_payment` — 정기지출/자동이체 ★ (현금흐름 예측 핵심 입력)
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
title           text NOT NULL
kind            text NOT NULL            -- 'autopay'|'subscription'|'insurance'|'telecom'|
                                         --  'maintenance'|'saving'|'loan'|'card_bill'|'income'
amount          integer                  -- 고정금액(추정이면 NULL 가능)
frequency       text NOT NULL            -- 'monthly'|'weekly'|'bimonthly'
pay_day         smallint                 -- 매월: 1~28 / 매주: 0~6(요일)
account_id      uuid → hh_account(id)    -- 출금계좌
category_id     uuid → hh_category(id)
person_id       uuid → hh_person(id)
direction       text DEFAULT 'out'        -- 'out'(지출)|'in'(예상수입)
is_active       boolean DEFAULT true
start_date      date
end_date        date
created_at, updated_at
```
> 기존 `recurring_expenses`(day_of_month 1~28 CHECK)와 같은 패턴. UI는 `recurring-expense-dialog` 재사용.

---

## 4. 수집함 (staging) ★

02의 설계 선택지 중 **(A) 별도 테이블** 채택 — 원문·신뢰도 등 staging 전용 필드가 많고
확정 전 거래를 본 테이블과 섞지 않는 게 깔끔. 확정 시 `hh_transaction` 1건 생성 + 링크.

### `hh_transaction_inbox`
```sql
id               uuid PK
owner_auth_uid   uuid NOT NULL
raw_text         text                     -- 원문(결제문자/명세서 행)
source           text NOT NULL            -- 'sms'|'file'|'manual'
source_adapter   text                     -- 'samsung_card'|'kb_bank' ... (어댑터 식별)
collected_at     timestamptz DEFAULT now()
guessed_date     date
guessed_amount   integer
guessed_merchant text
guessed_category_id      uuid → hh_category(id)        -- 자동분류
guessed_account_id       uuid → hh_account(id)
guessed_payment_method_id uuid → hh_payment_method(id)
guessed_type     text                     -- income/expense 추정
confidence       smallint                 -- 0~100
status           text DEFAULT 'pending'    -- 'pending'|'confirmed'|'ignored'|'duplicate'
dedup_hash       text                     -- (date+amount+merchant+source) 해시
confirmed_txn_id uuid → hh_transaction(id) -- 확정 시 생성된 거래
created_at, updated_at
UNIQUE(owner_auth_uid, dedup_hash)         -- 중복 방지
```

### `hh_merchant_map` — 학습된 가맹점→분류 사전
```sql
id              uuid PK
owner_auth_uid  uuid NOT NULL
merchant_key    text NOT NULL            -- 정규화된 가맹점/입금처명
category_id     uuid → hh_category(id)
payment_method_id uuid → hh_payment_method(id)
account_id      uuid → hh_account(id)
hit_count       integer DEFAULT 1        -- 사용 빈도(정확도 가중)
updated_at
UNIQUE(owner_auth_uid, merchant_key)
```
> 사용자가 수집함에서 고친 (가맹점→카테고리)를 여기에 upsert → 다음 자동분류 정확도 향상(03 6단계).

---

## 5. 집계/계산 — 뷰(View) vs 화면 계산

**결정:** 단순 합계는 **뷰**로, 복잡한 현금흐름 예측은 **앱(서버 액션)** 계산.

- `hh_account_balance`(뷰): 계좌별 현잔액 = 기초 + Σ입금 − Σ출금 (R1). 신용카드 일시불은 제외(납부 시점 반영).
- `hh_monthly_summary`(뷰): 월·카테고리·지불방식별 합계 (R2) — 현황(01)·통계 ③④⑤ 소스.
- **현금흐름 예측**: ScheduledPayment + Loan + Installment + 카드대금 추정을 기간 합산 →
  뷰로는 무리. **서버 액션/유틸 함수**에서 계산(03 §현금흐름 규칙). 테이블 추가 없음.

> **결정 필요 ④:** 잔액을 매번 뷰로 계산(정확·단순) vs 캐시 컬럼+트리거(빠름·복잡).
> 권장 = **뷰 계산**(거래량이 가계부 수준이라 성능 충분, 정합성 안전).

---

## 6. RLS 정책 (모든 `hh_*` 동일 패턴)

```sql
ALTER TABLE public.hh_xxx ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hh_xxx owner select" ON public.hh_xxx
  FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY "hh_xxx owner insert" ON public.hh_xxx
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY "hh_xxx owner update" ON public.hh_xxx
  FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY "hh_xxx owner delete" ON public.hh_xxx
  FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);
```
- `owner_auth_uid`는 insert 시 서버에서 `auth.uid()`로 채움(클라 입력 금지).
- 뷰는 base 테이블 RLS를 상속(security_invoker) — 뷰 생성 시 `WITH (security_invoker = true)`.

---

## 7. 엑셀 이관(import) — 별도 1회성 스크립트

마이그레이션과 분리. `scripts/household-import.ts`(또는 Python) 1회 실행.

1. `msoffcrypto-tool`로 복호화 → `openpyxl`/`xlsx` 파싱(비밀번호는 실행 시 입력, 저장 안 함).
2. 98개 월별 시트를 **블록 헤더로 탐지**(고정 인덱스 금지, 18/19/22열 대응).
3. 마스터 먼저 생성: 시트 전체 스캔 → 계좌·카테고리·결제수단·대출·인물 유니크 추출 → insert.
4. 블록별 거래 적재(이름으로 FK 매칭):
   - 02→`income` / 03→`transfer` / 04→`payment` / 05→`installment`(스케줄+회차) / 06→`expense`.
   - 수입 음수(증권 매수)는 `transfer`로 재분류(R6 확정).
5. **민감 칸(로그인 ID/PW) 제외.**
6. import 후 **검증 리포트**: 월별 합계를 엑셀 현황(01)과 대조 → 불일치 목록 출력.
7. `source='import'`로 표시해 추후 구분.

---

## 8. 마이그레이션 파일 계획 (CLAUDE.md 준수)

- 파일: `supabase/migrations/<timestamp>_household_init.sql`
- 순서: 마스터(person→account→category→payment_method) → loan/installment/scheduled_payment →
  transaction → inbox/merchant_map → 뷰 → RLS/정책 → 트리거.
- 작성 후 `supabase db push`로 적용, 한 사이클로 완료.

---

## 결정 사항

1. ✅ **소유 스코프 = 본인(admin) `owner_auth_uid = auth.uid()` 고정.**
2. ✅ **유형별 필수필드 = 전부 DB CHECK 제약**으로 강제(`hh_transaction_type_fields`).
3. ✅ **대출 잔액 = 뷰 계산**.
4. ✅ **계좌 잔액 = 뷰 계산**(`hh_account_balance`).

→ 확정 완료. 마이그레이션 `supabase/migrations/20260613000000_household_init.sql` 작성·적용.
