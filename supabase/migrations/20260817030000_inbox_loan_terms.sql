alter table public.hh_transaction_inbox
  add column if not exists guessed_loan_terms jsonb;

comment on column public.hh_transaction_inbox.guessed_loan_terms is
  '설계 181 — 카드론 안내문에서 뽑은 대출 조건 {rate, term_months, repayment_type, total_repayment, maturity_date}. raw_meta 와 달리 30일 purge 대상 아님';
