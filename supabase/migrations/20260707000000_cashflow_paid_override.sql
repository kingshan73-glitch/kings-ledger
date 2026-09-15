-- 65-3. 당월 출금예정 '지급금액' 수동 입력 (설계 docs/household/65)
-- 실제 지출이 발생했는데 자동 매칭(matchOutflowActuals)에서 누락되는 경우를 대비해,
-- 지급금액을 수기로 입력할 수 있도록 오버라이드에 컬럼을 추가한다.
alter table public.hh_cashflow_override
  add column if not exists paid_override integer;

comment on column public.hh_cashflow_override.paid_override is
  '수기 입력한 실제 지급금액. null이면 자동 매칭 결과를 사용.';

do $$ begin
  alter table public.hh_cashflow_override
    add constraint hh_cfo_paid_check check (paid_override is null or paid_override >= 0);
exception when duplicate_object then null; end $$;
