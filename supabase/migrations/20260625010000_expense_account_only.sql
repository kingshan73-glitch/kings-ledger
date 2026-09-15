-- 34. 지출 확정: 결제수단 OR 출금계좌 중 하나면 허용 (설계 docs/household/34)
-- 은행 직출금(현금성 지출)은 출금계좌(account_id)만으로 확정 가능하게 한다.

-- (1) 유형별 필수필드 CHECK 완화: expense = category + (payment_method OR account)
alter table public.hh_transaction
  drop constraint if exists hh_transaction_type_fields;

alter table public.hh_transaction
  add constraint hh_transaction_type_fields CHECK (
    CASE type
      WHEN 'income' THEN
        account_id IS NOT NULL AND category_id IS NOT NULL
        AND from_account_id IS NULL AND to_account_id IS NULL
      WHEN 'expense' THEN
        category_id IS NOT NULL
        AND (payment_method_id IS NOT NULL OR account_id IS NOT NULL)
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
  );

-- (2) 확정 RPC: 지출 분기를 '결제수단 또는 출금계좌' 요구로 완화 (나머지 분기는 기존과 동일)
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
begin
  if v_owner is null then
    raise exception '인증 정보가 없습니다.';
  end if;

  select * into r from public.hh_transaction_inbox where id = p_inbox_id;
  if not found then
    raise exception '수집 항목을 찾을 수 없습니다.';
  end if;

  if r.status = 'confirmed' and r.confirmed_txn_id is not null then
    return r.confirmed_txn_id;
  end if;

  v_type := case
    when r.guessed_type = 'income' then 'income'
    when r.guessed_type = 'transfer' then 'transfer'
    else 'expense'
  end;

  v_memo := nullif(btrim(coalesce(r.user_memo, r.raw_text, '')), '');

  if r.guessed_amount is null or r.guessed_amount <= 0 then
    raise exception '금액이 올바르지 않습니다.';
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

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, category_id, payment_method_id, account_id, counterparty, memo, source)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'expense', r.guessed_amount,
       r.guessed_category_id, r.guessed_payment_method_id, r.guessed_account_id, r.guessed_merchant, v_memo, 'inbox')
    returning id into v_txn_id;
  end if;

  update public.hh_transaction_inbox
     set status = 'confirmed', confirmed_txn_id = v_txn_id
   where id = p_inbox_id;

  return v_txn_id;
end;
$$;

grant execute on function public.hh_confirm_inbox(uuid) to authenticated;
