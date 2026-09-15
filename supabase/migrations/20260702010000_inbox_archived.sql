-- 55. 수집함 '보관(archived)' 상태 추가 (설계 docs/household/55)
-- 확정 후 검수까지 끝난 항목을 '보관'으로 옮겨 확정 탭에서 숨긴다. 거래는 그대로, 복원 가능.

alter table public.hh_transaction_inbox
  drop constraint if exists hh_inbox_status_check;

alter table public.hh_transaction_inbox
  add constraint hh_inbox_status_check
  check (status in ('pending','confirmed','ignored','duplicate','archived'));
