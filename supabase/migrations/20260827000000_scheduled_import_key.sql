-- 정기지출에 엑셀 원천 키(import_key)를 둔다 — 재적재가 이름으로 짝을 맞추지 않게.
--
-- 엑셀 재적재가 정기지출을 전량 삭제 후 재삽입하면 id 가 매번 새로 발급돼 참조가 끊기고 앱에서 고친 값이 사라진다.
-- import_key = 엑셀 항목명 원문. 재적재는 이 값으로 기존 행을 찾아 UPDATE 하고 id 를 지킨다.
-- 앱이 만든 행(수집함에서 추가 등)은 NULL — 재적재가 건드리지 않는다.
ALTER TABLE public.hh_scheduled_payment ADD COLUMN IF NOT EXISTS import_key text;
CREATE UNIQUE INDEX IF NOT EXISTS hh_scheduled_payment_import_key_uq
  ON public.hh_scheduled_payment (owner_auth_uid, import_key) WHERE import_key IS NOT NULL;
COMMENT ON COLUMN public.hh_scheduled_payment.import_key IS '엑셀 월고정비현황 D열 원문 — 재적재 upsert 키(설계 191). 앱 생성 행은 NULL.';
