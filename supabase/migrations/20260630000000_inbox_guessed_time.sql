-- 44. 수집함 시:분 표기. (설계 docs/household/44)
-- 결제문자에서 추출한 거래 시각(HH:MM)을 수집함 표시 전용으로 보관한다.
-- 거래 본체(hh_transaction.txn_date)는 날짜 단위 유지 — 확정 시 미사용.
alter table public.hh_transaction_inbox
  add column if not exists guessed_time text;

comment on column public.hh_transaction_inbox.guessed_time is 'SMS 추출 거래 시각(HH:MM). 표시 전용 추정값(거래 확정 시 미사용).';
