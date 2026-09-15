-- 결제관리: 정기지출에 '결재처'(어느 통장/카드로 내는지) 원문 보존 컬럼 추가.
-- 월고정비현황 import 및 결제관리 화면에서 사용.
ALTER TABLE public.hh_scheduled_payment ADD COLUMN IF NOT EXISTS payee text;
