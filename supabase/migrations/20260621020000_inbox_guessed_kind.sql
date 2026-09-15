-- 결제문자 자동수집 v2 (docs/household/22): 수집함에 거래종류(승인/취소/입금/출금/이체/자동이체) 보존.
-- hh_transaction_inbox 재사용 — 컬럼만 추가. RLS·정책 영향 없음.
alter table public.hh_transaction_inbox
  add column if not exists guessed_kind text;

comment on column public.hh_transaction_inbox.guessed_kind is
  '결제문자 파서 추정 거래종류: approve|cancel|deposit|withdraw|transfer|autopay|unknown (docs/household/22)';
