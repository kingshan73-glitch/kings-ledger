-- 19. 월별 예산 (설계: docs/household/19) — 코덱스 검토서 §6 budgets
-- 월(ym)·지출카테고리별 예산액. 해당 월 예산행이 없으면 = 예산 미설정(초과경고 비대상).

CREATE TABLE public.hh_budget (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    ym             text NOT NULL,                                   -- 'YYYY-MM'
    category_id    uuid NOT NULL REFERENCES public.hh_category(id) ON DELETE CASCADE,
    amount         integer NOT NULL,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_budget_ym_check     CHECK (ym ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT hh_budget_amount_check CHECK (amount >= 0),
    CONSTRAINT hh_budget_unique       UNIQUE (owner_auth_uid, ym, category_id)
);

CREATE INDEX hh_budget_owner_ym_idx ON public.hh_budget (owner_auth_uid, ym);

ALTER TABLE public.hh_budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY hh_budget_owner_select ON public.hh_budget
    FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY hh_budget_owner_insert ON public.hh_budget
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_budget_owner_update ON public.hh_budget
    FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_budget_owner_delete ON public.hh_budget
    FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);

CREATE TRIGGER hh_budget_updated_at BEFORE UPDATE ON public.hh_budget
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
