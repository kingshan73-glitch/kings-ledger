-- 가계부(household) 모듈 초기 스키마
-- 설계 문서: docs/household/02_domain-model.md · 05_db-schema.md
-- 개인 데이터이므로 owner_auth_uid = auth.uid() 소유자 스코프 RLS.
-- 금액은 정수(원), 잔액/월합계는 뷰로 계산(저장하지 않음).
-- update_updated_at() 트리거 함수는 기존 init 마이그레이션에서 생성된 것을 재사용.

-- =====================================================================
-- 1. 마스터 테이블
-- =====================================================================

-- 인물 (예: 김하늘 / 이바다 / 가족)
CREATE TABLE public.hh_person (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    name           text NOT NULL,
    sort_order     smallint DEFAULT 0 NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp with time zone DEFAULT now() NOT NULL
);

-- 계좌 (⚠ 로그인 ID/비밀번호 컬럼 없음 — 보안)
CREATE TABLE public.hh_account (
    id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid  uuid NOT NULL,
    name            text NOT NULL,
    bank            text,
    account_no      text,
    person_id       uuid REFERENCES public.hh_person(id) ON DELETE SET NULL,
    kind            text NOT NULL DEFAULT 'checking',
    opening_balance integer DEFAULT 0 NOT NULL,
    sort_order      smallint DEFAULT 0 NOT NULL,
    is_active       boolean DEFAULT true NOT NULL,
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    updated_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_account_kind_check CHECK (kind IN ('checking','stock','family','other'))
);

-- 카테고리 (수입/지출)
CREATE TABLE public.hh_category (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    name           text NOT NULL,
    kind           text NOT NULL,
    is_fixed       boolean DEFAULT false NOT NULL,
    sort_order     smallint DEFAULT 0 NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_category_kind_check CHECK (kind IN ('income','expense')),
    CONSTRAINT hh_category_unique UNIQUE (owner_auth_uid, name, kind)
);

-- 결제수단 (현금 + 카드)
CREATE TABLE public.hh_payment_method (
    id                uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid    uuid NOT NULL,
    name              text NOT NULL,
    kind              text NOT NULL,
    person_id         uuid REFERENCES public.hh_person(id) ON DELETE SET NULL,
    linked_account_id uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    billing_day       smallint,
    is_active         boolean DEFAULT true NOT NULL,
    sort_order        smallint DEFAULT 0 NOT NULL,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_payment_method_kind_check CHECK (kind IN ('cash','check','credit','installment')),
    CONSTRAINT hh_payment_method_billing_day_check
        CHECK (billing_day IS NULL OR (billing_day BETWEEN 1 AND 28))
);

-- =====================================================================
-- 2. 스케줄 테이블 (거래보다 먼저 — 거래가 FK로 참조)
-- =====================================================================

-- 대출
CREATE TABLE public.hh_loan (
    id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid  uuid NOT NULL,
    name            text NOT NULL,
    origin_date     date,
    principal       integer NOT NULL,
    current_balance integer NOT NULL DEFAULT 0,
    maturity_date   date,
    interest_rate   numeric(5,2),
    monthly_payment integer,
    payment_day     smallint,
    status          text DEFAULT 'active' NOT NULL,
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    updated_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_loan_status_check CHECK (status IN ('active','closed')),
    CONSTRAINT hh_loan_payment_day_check
        CHECK (payment_day IS NULL OR (payment_day BETWEEN 1 AND 28))
);

-- 할부
CREATE TABLE public.hh_installment (
    id                uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid    uuid NOT NULL,
    start_date        date NOT NULL,
    payment_method_id uuid REFERENCES public.hh_payment_method(id) ON DELETE SET NULL,
    category_id       uuid REFERENCES public.hh_category(id) ON DELETE SET NULL,
    title             text,
    total_amount      integer NOT NULL,
    total_count       smallint NOT NULL,
    start_installment smallint DEFAULT 1 NOT NULL,
    is_active         boolean DEFAULT true NOT NULL,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_installment_total_count_check CHECK (total_count > 0)
);

-- 정기지출 / 자동이체 (현금흐름 예측 핵심 입력)
CREATE TABLE public.hh_scheduled_payment (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    title          text NOT NULL,
    kind           text NOT NULL,
    amount         integer,
    frequency      text NOT NULL DEFAULT 'monthly',
    pay_day        smallint,
    account_id     uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    category_id    uuid REFERENCES public.hh_category(id) ON DELETE SET NULL,
    person_id      uuid REFERENCES public.hh_person(id) ON DELETE SET NULL,
    direction      text DEFAULT 'out' NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    start_date     date,
    end_date       date,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_scheduled_payment_kind_check CHECK (kind IN
        ('autopay','subscription','insurance','telecom','maintenance','saving','loan','card_bill','income')),
    CONSTRAINT hh_scheduled_payment_frequency_check CHECK (frequency IN ('monthly','weekly','bimonthly')),
    CONSTRAINT hh_scheduled_payment_direction_check CHECK (direction IN ('out','in'))
);

-- =====================================================================
-- 3. 거래 (중심 테이블)
-- =====================================================================

CREATE TABLE public.hh_transaction (
    id                uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid    uuid NOT NULL,
    txn_date          date NOT NULL,
    type              text NOT NULL,
    amount            integer NOT NULL,
    category_id       uuid REFERENCES public.hh_category(id) ON DELETE SET NULL,
    counterparty      text,
    memo              text,
    note              text,
    payment_method_id uuid REFERENCES public.hh_payment_method(id) ON DELETE SET NULL,
    account_id        uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    from_account_id   uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    to_account_id     uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    person_id         uuid REFERENCES public.hh_person(id) ON DELETE SET NULL,
    installment_id    uuid REFERENCES public.hh_installment(id) ON DELETE SET NULL,
    loan_id           uuid REFERENCES public.hh_loan(id) ON DELETE SET NULL,
    source            text DEFAULT 'manual' NOT NULL,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_transaction_type_check
        CHECK (type IN ('income','expense','installment','transfer','payment')),
    CONSTRAINT hh_transaction_amount_check CHECK (amount >= 0),
    CONSTRAINT hh_transaction_source_check CHECK (source IN ('manual','inbox','import')),
    -- 유형별 필수 필드 강제 (보스 확정: 전부 DB CHECK)
    CONSTRAINT hh_transaction_type_fields CHECK (
        CASE type
            WHEN 'income' THEN
                account_id IS NOT NULL AND category_id IS NOT NULL
                AND from_account_id IS NULL AND to_account_id IS NULL
            WHEN 'expense' THEN
                category_id IS NOT NULL AND payment_method_id IS NOT NULL
                AND from_account_id IS NULL AND to_account_id IS NULL
            WHEN 'installment' THEN
                installment_id IS NOT NULL AND category_id IS NOT NULL
                AND from_account_id IS NULL AND to_account_id IS NULL
            WHEN 'transfer' THEN
                from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                AND from_account_id <> to_account_id
            WHEN 'payment' THEN
                from_account_id IS NOT NULL
            ELSE false
        END
    )
);

CREATE INDEX hh_transaction_owner_date_idx     ON public.hh_transaction (owner_auth_uid, txn_date);
CREATE INDEX hh_transaction_owner_type_date_idx ON public.hh_transaction (owner_auth_uid, type, txn_date);
CREATE INDEX hh_transaction_category_idx        ON public.hh_transaction (category_id);
CREATE INDEX hh_transaction_account_idx         ON public.hh_transaction (account_id);
CREATE INDEX hh_transaction_from_account_idx    ON public.hh_transaction (from_account_id);
CREATE INDEX hh_transaction_to_account_idx      ON public.hh_transaction (to_account_id);
CREATE INDEX hh_transaction_installment_idx     ON public.hh_transaction (installment_id);
CREATE INDEX hh_transaction_loan_idx            ON public.hh_transaction (loan_id);

-- =====================================================================
-- 4. 수집함 (staging) + 학습 사전
-- =====================================================================

CREATE TABLE public.hh_transaction_inbox (
    id                        uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid            uuid NOT NULL,
    raw_text                  text,
    source                    text NOT NULL,
    source_adapter            text,
    collected_at              timestamp with time zone DEFAULT now() NOT NULL,
    guessed_date              date,
    guessed_amount            integer,
    guessed_merchant          text,
    guessed_category_id       uuid REFERENCES public.hh_category(id) ON DELETE SET NULL,
    guessed_account_id        uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    guessed_payment_method_id uuid REFERENCES public.hh_payment_method(id) ON DELETE SET NULL,
    guessed_type              text,
    confidence                smallint,
    status                    text DEFAULT 'pending' NOT NULL,
    dedup_hash                text,
    confirmed_txn_id          uuid REFERENCES public.hh_transaction(id) ON DELETE SET NULL,
    created_at                timestamp with time zone DEFAULT now() NOT NULL,
    updated_at                timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_inbox_source_check CHECK (source IN ('sms','file','manual')),
    CONSTRAINT hh_inbox_status_check CHECK (status IN ('pending','confirmed','ignored','duplicate')),
    CONSTRAINT hh_inbox_confidence_check CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),
    CONSTRAINT hh_inbox_dedup_unique UNIQUE (owner_auth_uid, dedup_hash)
);

CREATE INDEX hh_inbox_owner_status_idx ON public.hh_transaction_inbox (owner_auth_uid, status);

-- 학습된 가맹점 → 분류 사전
CREATE TABLE public.hh_merchant_map (
    id                uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid    uuid NOT NULL,
    merchant_key      text NOT NULL,
    category_id       uuid REFERENCES public.hh_category(id) ON DELETE SET NULL,
    payment_method_id uuid REFERENCES public.hh_payment_method(id) ON DELETE SET NULL,
    account_id        uuid REFERENCES public.hh_account(id) ON DELETE SET NULL,
    hit_count         integer DEFAULT 1 NOT NULL,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_merchant_map_unique UNIQUE (owner_auth_uid, merchant_key)
);

-- =====================================================================
-- 5. 뷰 (잔액·월합계 계산 — 저장하지 않음). security_invoker로 base RLS 상속
-- =====================================================================

-- 계좌별 현잔액 = 기초 + Σ입금 − Σ출금 (신용카드 일시불은 납부 시점에 반영되므로 제외)
CREATE VIEW public.hh_account_balance WITH (security_invoker = true) AS
SELECT a.id            AS account_id,
       a.owner_auth_uid,
       a.name,
       a.opening_balance + COALESCE(m.delta, 0) AS current_balance
FROM public.hh_account a
LEFT JOIN (
    SELECT acc, SUM(d) AS delta
    FROM (
        -- 수입 입금
        SELECT account_id AS acc, amount AS d
          FROM public.hh_transaction WHERE type = 'income' AND account_id IS NOT NULL
        UNION ALL
        -- 이체 입금
        SELECT to_account_id AS acc, amount AS d
          FROM public.hh_transaction WHERE type = 'transfer'
        UNION ALL
        -- 이체 출금
        SELECT from_account_id AS acc, -amount AS d
          FROM public.hh_transaction WHERE type = 'transfer'
        UNION ALL
        -- 카드/대출 납부 출금
        SELECT from_account_id AS acc, -amount AS d
          FROM public.hh_transaction WHERE type = 'payment'
        UNION ALL
        -- 현금/체크 일시불 지출 출금 (account_id가 있을 때만 = 현금/체크)
        SELECT account_id AS acc, -amount AS d
          FROM public.hh_transaction WHERE type = 'expense' AND account_id IS NOT NULL
    ) parts
    GROUP BY acc
) m ON m.acc = a.id;

-- 월·유형·카테고리·지불방식별 합계 (현황 01 / 통계 소스)
CREATE VIEW public.hh_monthly_summary WITH (security_invoker = true) AS
SELECT owner_auth_uid,
       to_char(txn_date, 'YYYY-MM') AS ym,
       type,
       category_id,
       payment_method_id,
       SUM(amount) AS total_amount,
       COUNT(*)    AS txn_count
FROM public.hh_transaction
GROUP BY owner_auth_uid, to_char(txn_date, 'YYYY-MM'), type, category_id, payment_method_id;

-- 대출 현잔액 = 원금 − Σ(연결 payment 거래)
CREATE VIEW public.hh_loan_balance WITH (security_invoker = true) AS
SELECT l.id AS loan_id,
       l.owner_auth_uid,
       l.name,
       l.principal,
       l.principal - COALESCE(p.paid, 0) AS computed_balance
FROM public.hh_loan l
LEFT JOIN (
    SELECT loan_id, SUM(amount) AS paid
    FROM public.hh_transaction
    WHERE type = 'payment' AND loan_id IS NOT NULL
    GROUP BY loan_id
) p ON p.loan_id = l.id;

-- =====================================================================
-- 6. updated_at 트리거 (기존 public.update_updated_at() 재사용)
-- =====================================================================

CREATE TRIGGER hh_person_updated_at            BEFORE UPDATE ON public.hh_person            FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_account_updated_at           BEFORE UPDATE ON public.hh_account           FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_category_updated_at          BEFORE UPDATE ON public.hh_category          FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_payment_method_updated_at    BEFORE UPDATE ON public.hh_payment_method    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_loan_updated_at              BEFORE UPDATE ON public.hh_loan              FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_installment_updated_at       BEFORE UPDATE ON public.hh_installment       FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_scheduled_payment_updated_at BEFORE UPDATE ON public.hh_scheduled_payment FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_transaction_updated_at       BEFORE UPDATE ON public.hh_transaction       FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_transaction_inbox_updated_at BEFORE UPDATE ON public.hh_transaction_inbox FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER hh_merchant_map_updated_at      BEFORE UPDATE ON public.hh_merchant_map      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =====================================================================
-- 7. RLS — 모든 hh_* 테이블은 본인(auth.uid() = owner_auth_uid) 데이터만
-- =====================================================================

ALTER TABLE public.hh_person            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_account           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_category          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_payment_method    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_loan              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_installment       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_scheduled_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_transaction       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_transaction_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hh_merchant_map      ENABLE ROW LEVEL SECURITY;

-- 각 테이블에 대해 select/insert/update/delete 4개 정책을 동일 패턴으로 생성
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'hh_person','hh_account','hh_category','hh_payment_method','hh_loan',
        'hh_installment','hh_scheduled_payment','hh_transaction',
        'hh_transaction_inbox','hh_merchant_map'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid)',
            t || '_owner_select', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid)',
            t || '_owner_insert', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid)',
            t || '_owner_update', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid)',
            t || '_owner_delete', t);
    END LOOP;
END $$;
