-- 설계 108: 정기지출(고정비)에 '결제수단'을 붙인다.
--
-- 왜: 학원비·통신비처럼 **카드로 결제되는 고정비**가 있는데 지금은 출금계좌(account_id)만 있어
-- 표현할 방법이 없었다. 그래서 실무상 ① 계좌를 비워두거나(계좌별 잔액 예측에서 통째로 누락)
-- ② 카드대금이 빠지는 계좌를 억지로 넣어(카드대금 정기지출과 이중차감) 둘 다 숫자가 틀렸다.
--
-- 신용카드를 지정하면 그 항목은 '현금이 그날 빠지는 것'이 아니라 카드대금 날짜에 함께 빠진다
-- → 계좌 잔액 예측·출금예정 합계에서 제외하고, 카드대금 정기지출이 대표한다(앱 로직, 설계 108).
-- 체크/선불카드는 즉시 출금이라 연결계좌에서 그대로 빠진다.

ALTER TABLE public.hh_scheduled_payment
    ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES public.hh_payment_method(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.hh_scheduled_payment.payment_method_id IS
    '이 고정비가 결제되는 수단(카드 등). 신용카드면 현금 유출은 카드대금일에 발생한다(설계 108).';

-- 결제수단이 지정된 행만 찾으면 되므로 부분 인덱스 하나면 충분하다(정기지출은 행 수가 적다).
-- ⚠️ 이 FK 는 결제수단이 **같은 소유자**인지까지는 검사하지 않는다(RLS 는 행별 owner_auth_uid 만 본다).
--    단일 관리자 DB 운영이고 화면은 본인 결제수단만 내려주므로 실제 위험은 없다 — 다중 사용자로 갈 때
--    복합 FK(owner_auth_uid, id) 나 트리거로 막을 것. (설계 108 교차리뷰 지적, 팀장 defer)
CREATE INDEX IF NOT EXISTS hh_scheduled_payment_method_idx
    ON public.hh_scheduled_payment (payment_method_id)
    WHERE payment_method_id IS NOT NULL;
