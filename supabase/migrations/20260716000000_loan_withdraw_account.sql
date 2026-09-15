-- 78. 대출 출금계좌 연결: 대출 상환금이 빠져나가는 계좌를 대출에 직접 기록. (설계 docs/household/78)
-- 배경: 대출관리 목록에 '출금계좌'를 표기하려면 대출↔계좌 연결이 필요한데 hh_loan 에 계좌 컬럼이 없었다.
-- 규칙: nullable FK. 계좌 삭제 시 대출은 남기고 연결만 해제(ON DELETE SET NULL). 미지정이면 목록에 '-' 표기.
ALTER TABLE public.hh_loan
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.hh_account(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hh_loan_account_idx ON public.hh_loan (account_id);
