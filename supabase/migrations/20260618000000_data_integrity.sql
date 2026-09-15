-- 16. 데이터 무결성 강화 (설계: docs/household/16_data-integrity-hardening.md)
-- 보스 확정: #3→C(보관+RESTRICT, 보관은 기존 is_active 재사용), #4→B(역할분리/뷰정리), 인접 H-2·H-3·M-2/3 전부 포함.
--
-- #3 마스터 삭제 보호: 거래·할부가 참조하는 FK를 ON DELETE SET NULL → RESTRICT 로 교체.
--    (SET NULL은 삭제 시 거래의 FK를 조용히 NULL로 만들어 잔액·통계를 깨뜨리고 CHECK 위반행을 남김)
--    수집함(staging)·학습사전·정기지출 설정의 FK는 이력 장부가 아니므로 SET NULL 유지.
-- #4 결제↔거래 분리 명문화: type='payment' 거래가 생성되지 않아 항상 '원금-0'이던 hh_loan_balance 뷰를
--    수기 관리 컬럼 current_balance 기준으로 재정의(결제관리=고정비 예산, 거래=실제 현금흐름).
-- H-3 마감월 잠금: 마감된 월의 결제 실적을 DB 트리거로도 수정/삽입/삭제 차단(화면 disabled 우회 방지).
-- H-2 결제 등록 원자성: scheduled_payment + 이번달 payment_entry 를 단일 트랜잭션 RPC로.
-- M-2/M-3 수집함 확정 원자성·중복방지: 거래 insert + inbox status update 를 단일 RPC로, 재확정은 멱등.

-- =====================================================================
-- #3. 거래/할부 FK → ON DELETE RESTRICT
-- =====================================================================
-- (인라인 REFERENCES로 생성돼 제약명은 <table>_<column>_fkey 관례를 따른다)

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_category_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES public.hh_category(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_payment_method_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_payment_method_id_fkey
  FOREIGN KEY (payment_method_id) REFERENCES public.hh_payment_method(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_account_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES public.hh_account(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_from_account_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_from_account_id_fkey
  FOREIGN KEY (from_account_id) REFERENCES public.hh_account(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_to_account_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_to_account_id_fkey
  FOREIGN KEY (to_account_id) REFERENCES public.hh_account(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_person_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_person_id_fkey
  FOREIGN KEY (person_id) REFERENCES public.hh_person(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_installment_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_installment_id_fkey
  FOREIGN KEY (installment_id) REFERENCES public.hh_installment(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_transaction DROP CONSTRAINT IF EXISTS hh_transaction_loan_id_fkey;
ALTER TABLE public.hh_transaction ADD  CONSTRAINT hh_transaction_loan_id_fkey
  FOREIGN KEY (loan_id) REFERENCES public.hh_loan(id) ON DELETE RESTRICT;

-- 할부는 결제수단/카테고리를 참조(할부 자체가 지출 이력의 일부)
ALTER TABLE public.hh_installment DROP CONSTRAINT IF EXISTS hh_installment_payment_method_id_fkey;
ALTER TABLE public.hh_installment ADD  CONSTRAINT hh_installment_payment_method_id_fkey
  FOREIGN KEY (payment_method_id) REFERENCES public.hh_payment_method(id) ON DELETE RESTRICT;

ALTER TABLE public.hh_installment DROP CONSTRAINT IF EXISTS hh_installment_category_id_fkey;
ALTER TABLE public.hh_installment ADD  CONSTRAINT hh_installment_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES public.hh_category(id) ON DELETE RESTRICT;

-- =====================================================================
-- #4. 대출 잔액 뷰 재정의 (current_balance 기준)
-- =====================================================================

DROP VIEW IF EXISTS public.hh_loan_balance;
CREATE VIEW public.hh_loan_balance WITH (security_invoker = true) AS
SELECT l.id              AS loan_id,
       l.owner_auth_uid,
       l.name,
       l.principal,
       l.current_balance AS computed_balance
FROM public.hh_loan l;

-- =====================================================================
-- H-3. 마감월 잠금 트리거
-- =====================================================================

CREATE OR REPLACE FUNCTION public.hh_block_closed_month()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ym    text;
  v_owner uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ym := OLD.year_month; v_owner := OLD.owner_auth_uid;
  ELSE
    v_ym := NEW.year_month; v_owner := NEW.owner_auth_uid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hh_payment_month_close c
    WHERE c.owner_auth_uid = v_owner AND c.year_month = v_ym
  ) THEN
    RAISE EXCEPTION '마감된 월(%)의 결제 실적은 수정할 수 없습니다. 먼저 마감을 취소하세요.', v_ym
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS hh_payment_entry_closed_guard ON public.hh_payment_entry;
CREATE TRIGGER hh_payment_entry_closed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hh_payment_entry
  FOR EACH ROW EXECUTE FUNCTION public.hh_block_closed_month();

-- =====================================================================
-- H-2. 결제 항목 등록 원자성 RPC (마스터 + 이번달 실적 한 트랜잭션)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.hh_create_payments(p_items jsonb, p_ym text)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_item  jsonb;
  v_id    uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION '인증 정보가 없습니다.';
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(p_items) LOOP
    INSERT INTO public.hh_scheduled_payment
      (owner_auth_uid, title, payee, kind, amount, pay_day, frequency, account_id, category_id, direction, is_active)
    VALUES (
      v_owner,
      v_item->>'title',
      NULLIF(v_item->>'payee', ''),
      v_item->>'kind',
      (v_item->>'amount')::int,
      NULLIF(v_item->>'pay_day', '')::smallint,
      COALESCE(NULLIF(v_item->>'frequency', ''), 'monthly'),
      NULLIF(v_item->>'account_id', '')::uuid,
      NULLIF(v_item->>'category_id', '')::uuid,
      'out',
      COALESCE((v_item->>'is_active')::boolean, true)
    )
    RETURNING id INTO v_id;

    INSERT INTO public.hh_payment_entry
      (owner_auth_uid, scheduled_payment_id, year_month, fixed_amount, variable_amount)
    VALUES (v_owner, v_id, p_ym, (v_item->>'amount')::int, 0);

    RETURN NEXT v_id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hh_create_payments(jsonb, text) TO authenticated;

-- =====================================================================
-- M-2/M-3. 수집함 확정 원자성·중복방지 RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.hh_confirm_inbox(p_inbox_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_owner  uuid := auth.uid();
  r        public.hh_transaction_inbox;
  v_type   text;
  v_txn_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION '인증 정보가 없습니다.';
  END IF;

  -- RLS(security_invoker)로 본인 항목만 조회됨
  SELECT * INTO r FROM public.hh_transaction_inbox WHERE id = p_inbox_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '수집 항목을 찾을 수 없습니다.';
  END IF;

  -- 이미 확정된 항목이면 기존 거래 id를 반환(중복 거래 생성 방지 = 멱등)
  IF r.status = 'confirmed' AND r.confirmed_txn_id IS NOT NULL THEN
    RETURN r.confirmed_txn_id;
  END IF;

  v_type := CASE WHEN r.guessed_type = 'income' THEN 'income' ELSE 'expense' END;

  IF r.guessed_category_id IS NULL THEN
    RAISE EXCEPTION '카테고리를 먼저 지정해주세요.';
  END IF;
  IF r.guessed_amount IS NULL OR r.guessed_amount <= 0 THEN
    RAISE EXCEPTION '금액이 올바르지 않습니다.';
  END IF;

  IF v_type = 'income' THEN
    IF r.guessed_account_id IS NULL THEN
      RAISE EXCEPTION '수입은 입금계좌가 필요합니다.';
    END IF;
    INSERT INTO public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, category_id, account_id, counterparty, source)
    VALUES
      (v_owner, COALESCE(r.guessed_date, CURRENT_DATE), 'income', r.guessed_amount,
       r.guessed_category_id, r.guessed_account_id, r.guessed_merchant, 'inbox')
    RETURNING id INTO v_txn_id;
  ELSE
    IF r.guessed_payment_method_id IS NULL THEN
      RAISE EXCEPTION '지출은 결제수단이 필요합니다.';
    END IF;
    INSERT INTO public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, category_id, payment_method_id, account_id, counterparty, source)
    VALUES
      (v_owner, COALESCE(r.guessed_date, CURRENT_DATE), 'expense', r.guessed_amount,
       r.guessed_category_id, r.guessed_payment_method_id, r.guessed_account_id, r.guessed_merchant, 'inbox')
    RETURNING id INTO v_txn_id;
  END IF;

  UPDATE public.hh_transaction_inbox
     SET status = 'confirmed', confirmed_txn_id = v_txn_id
   WHERE id = p_inbox_id;

  RETURN v_txn_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hh_confirm_inbox(uuid) TO authenticated;
