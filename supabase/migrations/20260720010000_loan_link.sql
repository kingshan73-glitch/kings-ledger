-- 92. 대출 상환 거래 → 대출 마스터 연결키. (설계 docs/household/92)
--
-- 배경: 지금은 상환 거래와 hh_loan 을 금액·이름으로 추정 매칭한다. 이 추정은 이미 두 번
--       오탐을 냈다(열대모임 10,000 / 현대해상 3,000 — 흔한 금액에 아무 거래나 붙음).
--       명시 FK 를 두어 '연결된 것'과 '모르는 것'을 구조적으로 구분한다.
--
-- on delete set null: 대출 마스터를 지워도 거래(=실제 출금 사실)는 남아야 한다.
--                     cascade 로 두면 대출 정리 한 번에 상환 이력이 통째로 사라진다.

alter table public.hh_transaction
  add column if not exists loan_id uuid
    references public.hh_loan(id) on delete set null;

comment on column public.hh_transaction.loan_id is
  '대출 상환 거래가 가리키는 대출 마스터(hh_loan). 확실한 건만 채우고 모르면 null 로 둔다 — null 은 "미연결"이며 통계에서 불완전으로 표기된다. (설계 92)';

create index if not exists hh_transaction_loan_id_idx
  on public.hh_transaction(loan_id)
  where loan_id is not null;
