-- 설계 203 — 정기지출 결제수단의 월별 오버라이드.
-- 학원비처럼 달마다 결제수단이 바뀌는 항목은 hh_scheduled_payment.payment_method_id 한 값으로
-- 담을 수 없다. 카드로 고정돼 있으면 지갑으로 낸 달의 현금 유출이 합계에서 통째로 빠지고
-- (2026-07~09 실측 1,020,000원이 카드청구로 합계에서 빠져 있었다 — 그중 350,000 은 오매칭으로
-- 엉뚱한 항목이 대신 세고 있었고, 정정 후 순증은 670,000원이다).
-- 반대로 지갑으로 고정하면 카드로 낸 달이 카드대금과 이중계상된다.
--
-- NULL = 종전과 동일(항목 등록값을 따른다). 값이 있으면 그 달의 cardCharge·출금계좌를 그 수단으로 재판정.
alter table public.hh_cashflow_override
  add column if not exists payment_method_id uuid references public.hh_payment_method(id) on delete set null;

comment on column public.hh_cashflow_override.payment_method_id is
  '이 달만 다른 결제수단으로 냈을 때의 수단(설계 203). NULL이면 항목에 등록된 결제수단을 따른다.';
