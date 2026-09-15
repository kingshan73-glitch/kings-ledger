-- 151. 카드 승인취소를 구조적으로 처리한다. (설계 150 ① 후속, 팀장 지시 2026-08-06)
--
-- 무엇이 문제였나
--   승인취소 문자는 파서가 kind='cancel' 로 알아보지만, `kindToTxnType` 이 cancel 을 **expense** 로
--   떨군다. 그래서 수집함엔 '지출'로 들어오고, 화면에서 그대로 확정하면 **같은 금액 지출이 하나 더**
--   생긴다(취소가 반영되기는커녕 두 배가 된다). 2026-08-01 쿠팡 42,260원에서 실제로 걸렸고,
--   그때는 사람이 알아채 원 거래를 손으로 지웠다. 다음 취소에서 또 걸릴 자리라 구조로 막는다.
--
-- 어떻게 고치나
--   신용카드 승인취소는 **계좌로 돈이 돌아오지 않는다** — 카드사가 청구에서 뺄 뿐이다.
--   그래서 '환급 수입'을 만들면 안 되고(수입은 account_id 가 필수라 없는 입금이 잔액을 부풀린다),
--   **원 지출을 없애는 것**이 유일하게 맞는 처리다(설계 70 의 카드 회계모델과도 일관).
--   → 수집 시점에 원 거래를 찾아 `cancel_target_txn_id` 에 적어 두고,
--     확정 시 새 거래를 만드는 대신 **그 거래를 삭제**한다.
--   → 원 거래를 못 찾았으면 조용히 넘어가지 않고 **예외를 던진다**(빈칸이 오분류보다 낫다, 설계 106).

alter table public.hh_transaction_inbox
  add column if not exists cancel_target_txn_id uuid references public.hh_transaction(id) on delete set null;

comment on column public.hh_transaction_inbox.cancel_target_txn_id is
  '승인취소 문자가 취소하는 원 거래. 확정 시 새 거래를 만들지 않고 이 거래를 삭제한다. (설계 151)';

create or replace function public.hh_confirm_inbox(p_inbox_id uuid)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_owner  uuid := auth.uid();
  r        public.hh_transaction_inbox;
  v_type   text;
  v_memo   text;
  v_txn_id uuid;
  v_acct   uuid;  -- expense 출금계좌(체크카드·선불카드면 연결계좌로 보정)
  v_pay_cat uuid; -- payment 카테고리(대출이면 '대출상환', 아니면 사용자가 고른 것)
begin
  if v_owner is null then
    raise exception '인증 정보가 없습니다.';
  end if;

  -- 행 잠금: 동시 확정 요청은 여기서 직렬화되어 멱등 체크가 항상 최신 상태를 본다. (설계 91)
  select * into r from public.hh_transaction_inbox where id = p_inbox_id for update;
  if not found then
    raise exception '수집 항목을 찾을 수 없습니다.';
  end if;

  -- ★승인취소(설계 151): 새 거래를 만들지 않고 **원 거래를 삭제**한다.
  --   여기서 먼저 갈라야 한다 — 아래로 내려가면 cancel 이 expense 로 취급돼 지출이 하나 더 생긴다.
  if r.guessed_kind = 'cancel' then
    -- 멱등: 이미 처리했으면 다시 지우지 않는다(원 거래는 이미 없다).
    if r.status = 'confirmed' then
      return r.cancel_target_txn_id;
    end if;
    if r.cancel_target_txn_id is null then
      raise exception '취소 문자입니다. 취소 대상 거래를 자동으로 찾지 못했으니, 원 지출을 직접 삭제한 뒤 이 항목을 무시 처리해 주세요.';
    end if;

    -- 원 거래를 만들어 준 수집 항목도 함께 닫는다.
    -- ★삭제보다 **먼저** 해야 한다 — FK 가 ON DELETE SET NULL 이라 지운 뒤에는 연결이 끊겨 못 찾는다.
    update public.hh_transaction_inbox
       set status = 'ignored'
     where owner_auth_uid = v_owner
       and confirmed_txn_id = r.cancel_target_txn_id;

    delete from public.hh_transaction
     where id = r.cancel_target_txn_id and owner_auth_uid = v_owner;

    update public.hh_transaction_inbox
       set status = 'confirmed'
     where id = p_inbox_id;

    return r.cancel_target_txn_id;
  end if;

  -- 멱등: 이미 확정된 항목은 생성 결과 id(거래 또는 할부)를 반환하고 재생성하지 않는다.
  if r.status = 'confirmed' and (r.confirmed_txn_id is not null or r.confirmed_installment_id is not null) then
    return coalesce(r.confirmed_txn_id, r.confirmed_installment_id);
  end if;

  v_type := case
    when r.guessed_type = 'income' then 'income'
    when r.guessed_type = 'transfer' then 'transfer'
    when r.guessed_type = 'payment' then 'payment'
    when r.guessed_type = 'installment' then 'installment'
    else 'expense'
  end;

  v_memo := nullif(btrim(coalesce(r.user_memo, r.raw_text, '')), '');

  if r.guessed_amount is null or r.guessed_amount <= 0 then
    raise exception '금액이 올바르지 않습니다.';
  end if;

  -- 할부: hh_installment 마스터를 만들고 confirmed_installment_id에 기록 후 조기 반환.
  if v_type = 'installment' then
    if r.guessed_category_id is null then
      raise exception '카테고리를 먼저 지정해주세요.';
    end if;
    if r.guessed_payment_method_id is null then
      raise exception '할부는 결제수단(카드)이 필요합니다.';
    end if;
    if r.guessed_installment_months is null or r.guessed_installment_months < 2 then
      raise exception '할부 개월수(2 이상)를 지정해주세요.';
    end if;

    insert into public.hh_installment
      (owner_auth_uid, start_date, payment_method_id, category_id, title,
       total_amount, total_count, start_installment, is_active)
    values
      (v_owner, coalesce(r.guessed_date, current_date), r.guessed_payment_method_id, r.guessed_category_id,
       r.guessed_merchant, r.guessed_amount, r.guessed_installment_months, 1, true)
    returning id into v_txn_id;

    update public.hh_transaction_inbox
       set status = 'confirmed', confirmed_installment_id = v_txn_id
     where id = p_inbox_id;
    return v_txn_id;
  end if;

  if v_type = 'transfer' then
    if r.guessed_from_account_id is null or r.guessed_to_account_id is null then
      raise exception '이체는 출금계좌와 입금계좌가 모두 필요합니다.';
    end if;
    if r.guessed_from_account_id = r.guessed_to_account_id then
      raise exception '출금계좌와 입금계좌가 같을 수 없습니다.';
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, from_account_id, to_account_id, counterparty, memo, source)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'transfer', r.guessed_amount,
       r.guessed_from_account_id, r.guessed_to_account_id, r.guessed_merchant, v_memo, 'inbox')
    returning id into v_txn_id;
  elsif v_type = 'payment' then
    -- 카드대금·대출 원리금 납부 = 출금계좌 −금액. 결제수단 없음(지출집계 제외).
    if r.guessed_from_account_id is null then
      raise exception '납부는 출금계좌가 필요합니다.';
    end if;

    -- ★확정 시점에 분류를 끝낸다 — 비워두면 나중에 소급 분류 스크립트를 또 돌게 된다. (설계 94 §5)
    if r.guessed_loan_id is not null then
      -- 대출을 골랐다는 건 곧 '대출상환'이라는 뜻이다. 두 값이 어긋날 수 없게 여기서 정한다.
      select c.id into v_pay_cat
        from public.hh_category c
       where c.owner_auth_uid = v_owner
         and c.name = '대출상환'
       limit 1;
    else
      -- 대출이 아니면 화면에서 고른 카테고리(카드대금 등)를 그대로 쓴다. 없으면 null(기존 동작).
      v_pay_cat := r.guessed_category_id;
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, from_account_id, counterparty, memo, source,
       loan_id, category_id)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'payment', r.guessed_amount,
       r.guessed_from_account_id, r.guessed_merchant, v_memo, 'inbox',
       r.guessed_loan_id, v_pay_cat)
    returning id into v_txn_id;
  elsif v_type = 'income' then
    if r.guessed_category_id is null then
      raise exception '카테고리를 먼저 지정해주세요.';
    end if;
    if r.guessed_account_id is null then
      raise exception '수입은 입금계좌가 필요합니다.';
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, category_id, account_id, counterparty, memo, source)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'income', r.guessed_amount,
       r.guessed_category_id, r.guessed_account_id, r.guessed_merchant, v_memo, 'inbox')
    returning id into v_txn_id;
  else
    if r.guessed_category_id is null then
      raise exception '카테고리를 먼저 지정해주세요.';
    end if;
    -- 결제수단 또는 출금계좌 중 하나는 있어야 한다(은행 직출금은 계좌만으로 확정).
    if r.guessed_payment_method_id is null and r.guessed_account_id is null then
      raise exception '지출은 결제수단 또는 출금계좌가 필요합니다.';
    end if;

    -- 즉시출금 결제수단 자동 연결: 출금계좌 미지정 + 결제수단이 체크카드/선불카드(연결계좌 보유)면
    -- 그 계좌에서 차감. 신용카드(월 카드대금으로 별도 출금)·연결계좌 없는 현금은 null 유지(설계 70).
    v_acct := r.guessed_account_id;
    if v_acct is null and r.guessed_payment_method_id is not null then
      select pm.linked_account_id into v_acct
        from public.hh_payment_method pm
       where pm.id = r.guessed_payment_method_id
         and pm.kind in ('check', 'cash');
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, category_id, payment_method_id, account_id, counterparty, memo, source)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'expense', r.guessed_amount,
       r.guessed_category_id, r.guessed_payment_method_id, v_acct, r.guessed_merchant, v_memo, 'inbox')
    returning id into v_txn_id;
  end if;

  update public.hh_transaction_inbox
     set status = 'confirmed', confirmed_txn_id = v_txn_id
   where id = p_inbox_id;

  return v_txn_id;
end;
$$;
