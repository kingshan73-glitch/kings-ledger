-- 설계 179 §4: 음수·비정상 대출 수치가 코드 경로를 우회해 저장되는 것도 DB에서 차단한다.
-- 현재잔액이 원금보다 큰 경우는 연체·이자 자본화 가능성이 있어 제약하지 않고 화면에서 경고한다.
alter table public.hh_loan drop constraint if exists hh_loan_numeric_check;

alter table public.hh_loan
  add constraint hh_loan_numeric_check
  check (
    principal > 0
    and current_balance >= 0
    and (interest_rate is null or interest_rate >= 0)
    and (monthly_payment is null or monthly_payment >= 0)
  );
