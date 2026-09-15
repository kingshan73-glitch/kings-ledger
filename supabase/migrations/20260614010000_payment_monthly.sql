-- 결제관리 월별 실적 + 월 마감. (docs/household/09)
-- hh_scheduled_payment = 결제 항목 마스터(기존). 아래 2개로 월별 관리.

-- 월별 결제 실적 (항목 × 월 = 고정비 + 변동비)
CREATE TABLE public.hh_payment_entry (
    id                   uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid       uuid NOT NULL,
    scheduled_payment_id uuid NOT NULL REFERENCES public.hh_scheduled_payment(id) ON DELETE CASCADE,
    year_month           text NOT NULL,
    fixed_amount         integer NOT NULL DEFAULT 0,
    variable_amount      integer NOT NULL DEFAULT 0,
    created_at           timestamp with time zone DEFAULT now() NOT NULL,
    updated_at           timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_payment_entry_ym_check CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT hh_payment_entry_unique UNIQUE (owner_auth_uid, scheduled_payment_id, year_month)
);
CREATE INDEX hh_payment_entry_owner_ym_idx ON public.hh_payment_entry (owner_auth_uid, year_month);

-- 월 마감 (해당 월 기록 잠금)
CREATE TABLE public.hh_payment_month_close (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    year_month     text NOT NULL,
    closed_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_payment_close_ym_check CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT hh_payment_close_unique UNIQUE (owner_auth_uid, year_month)
);

CREATE TRIGGER hh_payment_entry_updated_at BEFORE UPDATE ON public.hh_payment_entry FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.hh_payment_entry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_payment_month_close ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['hh_payment_entry','hh_payment_month_close'];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid)', t || '_owner_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid)', t || '_owner_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid)', t || '_owner_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid)', t || '_owner_delete', t);
    END LOOP;
END $$;
