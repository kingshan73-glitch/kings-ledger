-- 설계 170 — hh_loan · hh_installment 에 source 추가 (재적재가 앱 등록분을 지우지 않도록)
--
-- 문제: `scripts/import_household_excel.py` 는 이 두 표를 **owner 단위로 통째 삭제**한다(383~385행).
--       `hh_transaction` 만 `source='import'` 로 걸러 지우고 있었는데, 이 두 표엔 그 컬럼이 없어서다.
--       그래서 앱·스크립트로 등록한 대출·할부가 재적재마다 영구 소실됐다.
--       실제로 잃을 뻔한 것(2026-08-13 실측): 대출 4건 — 삼성 카드론 26.03·26.08,
--       국민 카드론 26.08, **대출상환-신한저축은행**(설계 162 에서 실거래로 역산해 넣은 것) · 할부 3건.
--
-- ★DEFAULT 를 'manual' 로 둔다. 누가 source 를 안 넣고 insert 했을 때
--   **지워지는 쪽이 아니라 보존되는 쪽으로 틀리게** 하기 위해서다.
--   (반대로 'import' 를 기본값으로 하면 앱에서 등록한 행이 다음 재적재에 조용히 사라진다.)
--
-- 백필 기준: 마지막 재적재 배치는 2026-07-06T07:27:44 **한 타임스탬프**에 몰려 있고
--   (대출 14건 · 할부 462건), 그 다음 등록은 12일 뒤인 2026-07-18 이다. 경계가 겹치지 않는다.
--   → created_at < timestamptz '2026-07-07 00:00:00+00' 을 'import' 로 본다.
--   ★교차리뷰 지적(TZ): created_at 은 timestamptz 라 리터럴에 TZ 가 없으면 세션 시간대로 해석된다.
--     +00 을 명시해 어느 세션에서 돌려도 같은 경계가 되게 했다. 배치(07-06 07:27 UTC)와
--     다음 등록(07-18) 사이가 12일이라 어차피 여유가 크지만, 경계는 명시하는 게 맞다.
--   ★실측: 이 두 표에 2026-07-06 **이전** 행은 0건이다 — 오분류될 manual 행이 애초에 없다.
--   ⚠️이 경계는 **이 설치본의 실측값**이다. 다른 설치본에 그대로 쓰지 마라 —
--     재적재 시각을 먼저 확인할 것.

-- ── hh_loan ────────────────────────────────────────────────────────────────
alter table public.hh_loan
  add column if not exists source text not null default 'manual';

alter table public.hh_loan
  drop constraint if exists hh_loan_source_check;
alter table public.hh_loan
  add constraint hh_loan_source_check check (source in ('manual', 'import'));

update public.hh_loan
   set source = 'import'
 where created_at < timestamptz '2026-07-07 00:00:00+00'
   and source <> 'import';   -- 재실행해도 같은 결과(idempotent)

-- ── hh_installment ─────────────────────────────────────────────────────────
alter table public.hh_installment
  add column if not exists source text not null default 'manual';

alter table public.hh_installment
  drop constraint if exists hh_installment_source_check;
alter table public.hh_installment
  add constraint hh_installment_source_check check (source in ('manual', 'import'));

update public.hh_installment
   set source = 'import'
 where created_at < timestamptz '2026-07-07 00:00:00+00'
   and source <> 'import';

comment on column public.hh_loan.source is
  'manual=앱·스크립트 등록(재적재가 보존) · import=엑셀 재적재분(재적재가 지우고 다시 넣음). 설계 170';
comment on column public.hh_installment.source is
  'manual=앱·스크립트 등록(재적재가 보존) · import=엑셀 재적재분(재적재가 지우고 다시 넣음). 설계 170';
