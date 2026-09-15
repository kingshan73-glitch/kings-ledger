-- 결제수단 카드정보(카드번호·유효기간) 추가. (docs/household/11)
-- card_no = 카드번호(예: 1234-5678-9012-3456), card_expiry = 유효기간(MM/YY).
-- 카드번호는 화면에서 끝 4자리만 노출(maskCardNo).
ALTER TABLE public.hh_payment_method
  ADD COLUMN IF NOT EXISTS card_no text,
  ADD COLUMN IF NOT EXISTS card_expiry text;
