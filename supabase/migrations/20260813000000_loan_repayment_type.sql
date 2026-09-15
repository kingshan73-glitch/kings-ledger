-- 설계 168 — 대출 상환방식(repayment_type) 추가
--
-- 왜: 설계 167 의 카드론 월납 역산이 **원리금균등을 가정**한다. 상환방식이 원금균등이면
--     초기 회차가 그 값보다 크다(설계 162 실측: 국민 26.08 은 18개월 평균 956,177 vs
--     1회차 실제 1,059,583 — 약 10만원 차이). hh_loan 에 방식 필드가 없어 구분할 수 없었다.
--
-- ★nullable 로 둔다. null = 미지정이며 기존과 똑같이 **원리금균등으로 가정**한다.
--   NOT NULL + DEFAULT 로 하면 "모르는 것"과 "원리금균등이라고 확인한 것"을 구분할 수 없다 —
--   화면에서 '가정값'과 '확인값'을 갈라 말할 수 없게 되므로 일부러 null 을 남긴다.
--   (기존 18건은 전부 null 이 되어 화면 숫자가 바뀌지 않는다.)
--
-- ⚠️엑셀 재적재는 hh_loan 을 통째로 지운다(import_household_excel.py:385).
--   이 컬럼도 함께 사라지므로 재적재 전 백업 대상에 포함할 것.

alter table public.hh_loan
  add column if not exists repayment_type text;

alter table public.hh_loan
  drop constraint if exists hh_loan_repayment_type_check;

alter table public.hh_loan
  add constraint hh_loan_repayment_type_check
  check (repayment_type is null or repayment_type in ('annuity', 'equal_principal', 'interest_only'));

comment on column public.hh_loan.repayment_type is
  '상환방식: annuity=원리금균등 · equal_principal=원금균등 · interest_only=만기일시(이자만). null=미지정(원리금균등으로 가정). 설계 168';
