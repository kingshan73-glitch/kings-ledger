-- 37. 현금흐름 출금예정 항목의 "해당 월 납부일(일자) 변경" 저장 (설계: docs/household/37)
-- 출금예정 항목의 날짜는 원래 자동 계산(고정비 납부일·카드 결제일 등)이지만,
-- 사용자가 그 달에 한해 날짜를 바꿔 정렬·예상잔액에 반영하고 싶을 때를 위한 오버라이드.
ALTER TABLE public.hh_cashflow_override
    ADD COLUMN day_override integer
    CONSTRAINT hh_cfo_day_check CHECK (day_override IS NULL OR (day_override >= 1 AND day_override <= 31));
