-- 32. SMS 기관명(은행/카드사) 표시용 컬럼. (설계 docs/household/32)
-- 결제문자에서 추출한 기관명을 수집함 점검 보조로 보관(표시 전용, 거래 확정 시 미사용).
alter table public.hh_transaction_inbox
  add column if not exists guessed_institution text;

comment on column public.hh_transaction_inbox.guessed_institution is 'SMS 추출 기관명(은행/카드사/페이). 표시 전용 추정값.';
