-- 31. 현금흐름 출금예정 항목별 월별 오버라이드 (설계: docs/household/31)
-- 출금예정 항목(고정비/대출/할부/카드대금)은 매달 자동 계산되는 파생값이라 고유 ID가 없다.
-- "해당 월에만" 금액수정·출금계좌지정·출금해제를 저장하기 위한 (월 + 항목출처)별 오버라이드.
--   source_kind → source_id 매핑:
--     fixed       → hh_scheduled_payment.id
--     loan        → hh_loan.id
--     installment → hh_installment.id
--     card        → hh_payment_method.id (신용카드 대금)

CREATE TABLE public.hh_cashflow_override (
    id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid  uuid NOT NULL,
    year_month      text NOT NULL,                                   -- 'YYYY-MM'
    source_kind     text NOT NULL,
    source_id       uuid NOT NULL,
    amount_override integer,                                         -- 수정 금액(없으면 자동계산값)
    account_id      uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,  -- 지정 출금계좌
    released        boolean DEFAULT false NOT NULL,                  -- 출금해제 여부
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    updated_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_cfo_ym_check     CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT hh_cfo_kind_check   CHECK (source_kind IN ('fixed','loan','installment','card')),
    CONSTRAINT hh_cfo_amount_check CHECK (amount_override IS NULL OR amount_override >= 0),
    CONSTRAINT hh_cfo_unique       UNIQUE (owner_auth_uid, year_month, source_kind, source_id)
);

CREATE INDEX hh_cfo_owner_ym_idx ON public.hh_cashflow_override (owner_auth_uid, year_month);

ALTER TABLE public.hh_cashflow_override ENABLE ROW LEVEL SECURITY;

CREATE POLICY hh_cfo_owner_select ON public.hh_cashflow_override
    FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY hh_cfo_owner_insert ON public.hh_cashflow_override
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_cfo_owner_update ON public.hh_cashflow_override
    FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_cfo_owner_delete ON public.hh_cashflow_override
    FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);

CREATE TRIGGER hh_cashflow_override_updated_at BEFORE UPDATE ON public.hh_cashflow_override
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
