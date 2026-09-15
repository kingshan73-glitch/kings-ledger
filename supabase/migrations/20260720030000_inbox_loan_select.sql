-- 94. 수집함 확정 시 대출 선택. (설계 docs/household/94)
--
-- 문제: payment 분기가 category_id·loan_id 를 아무것도 넣지 않아, 수집함으로 확정한
--       대출상환은 '대출 미연결'로조차 세어지지 않고 통계에서 통째로 빠졌다
--       (데이터 건강도는 type='payment' AND category_id=대출상환 으로 센다, 설계 91 §6).
-- 해결: 수집함에 guessed_loan_id 를 두고, 확정 시 loan_id 와 '대출상환' 카테고리를
--       한 곳에서 함께 넣는다. 둘이 어긋날 수 없게 하기 위해서다.
--
-- 나머지 분기는 20260720000000 과 동일하다(행 잠금·멱등 포함).

alter table public.hh_transaction_inbox
  add column if not exists guessed_loan_id uuid references public.hh_loan(id) on delete set null;

comment on column public.hh_transaction_inbox.guessed_loan_id is
  '확정 시 연결할 대출(설계 94). null 이면 대출이 아닌 납부(카드대금 등).';

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
  v_loan_cat uuid; -- '대출상환' 카테고리(대출을 고른 납부에만 쓴다)
begin
  if v_owner is null then
    raise exception '인증 정보가 없습니다.';
  end if;

  -- 행 잠금: 동시 확정 요청은 여기서 직렬화되어 멱등 체크가 항상 최신 상태를 본다. (설계 91)
  select * into r from public.hh_transaction_inbox where id = p_inbox_id for update;
  if not found then
    raise exception '수집 항목을 찾을 수 없습니다.';
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

    -- ★대출을 골랐으면 loan_id 와 '대출상환' 카테고리를 함께 넣는다. (설계 94)
    --   카테고리가 비면 통계·데이터 건강도가 이 상환을 못 본다. 두 값이 어긋나지 않게 한 곳에서 넣는다.
    --   대출을 안 골랐으면(카드대금 등) 둘 다 null — 기존 동작 그대로.
    if r.guessed_loan_id is not null then
      select c.id into v_loan_cat
        from public.hh_category c
       where c.owner_auth_uid = v_owner
         and c.name = '대출상환'
       limit 1;
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, from_account_id, counterparty, memo, source,
       loan_id, category_id)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'payment', r.guessed_amount,
       r.guessed_from_account_id, r.guessed_merchant, v_memo, 'inbox',
       r.guessed_loan_id, v_loan_cat)
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
