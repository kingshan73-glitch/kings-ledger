-- 설계 179 §3: 시작 회차가 총 회차를 넘으면 영구 비활성·잔액 0인 유령 할부가 생성되므로 DB에서도 차단한다.
alter table public.hh_installment drop constraint if exists hh_installment_start_within_total;

alter table public.hh_installment
  add constraint hh_installment_start_within_total
  check (start_installment >= 1 and start_installment <= total_count);
