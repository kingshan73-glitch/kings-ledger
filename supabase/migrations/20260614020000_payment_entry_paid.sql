-- 결제관리: 월별 실적에 결제 완료 여부 추가 (결제/미결제 구분).
-- 지출 금액이 잡힌 과거 실적은 결제완료로 본다(import 시 true 설정).
ALTER TABLE public.hh_payment_entry ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT false;
