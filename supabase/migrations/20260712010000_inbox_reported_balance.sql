-- 71. 수집 메시지의 '잔액' 저장 → 장부 잔액과 대조(수집 누락·미확정 감지). (설계 docs/household/71)
-- 문자/알림에 "잔액 106,415원"이 이미 들어오지만 버려지고 있었다. 이를 저장해
-- 계좌별 '문자 최근 잔액'과 장부(hh_account_balance) 현재 잔액을 대조한다.

alter table public.hh_transaction_inbox
  add column if not exists reported_balance bigint,
  add column if not exists reported_balance_account_id uuid references public.hh_account(id) on delete set null;

comment on column public.hh_transaction_inbox.reported_balance is '수집 메시지가 알려준 잔액(원). 없으면 null.';
comment on column public.hh_transaction_inbox.reported_balance_account_id is '그 잔액이 속한 계좌(끝자리로 매칭된 은행계좌). 장부 잔액 대조용.';
