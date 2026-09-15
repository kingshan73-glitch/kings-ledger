-- 54. 할부 수집함 편입 (설계 docs/household/54)
-- 카드 할부 결제 문자를 수집함에서 '할부' 유형으로 확정 → hh_installment 마스터 생성.
-- 월별 청구분은 계산으로 파생(calc.installmentProgress)하므로 별도 거래는 만들지 않는다.

-- (1) 수집함 컬럼 추가
alter table public.hh_transaction_inbox
  add column if not exists guessed_installment_months smallint,
  add column if not exists confirmed_installment_id uuid references public.hh_installment(id) on delete set null;

comment on column public.hh_transaction_inbox.guessed_installment_months is '추정 할부 개월수(회차). 2 이상일 때 할부로 본다.';
comment on column public.hh_transaction_inbox.confirmed_installment_id is '할부 확정 시 생성된 hh_installment id (confirmed_txn_id는 hh_transaction FK라 별도).';

-- (2) 확정 RPC: installment 분기 추가(나머지 분기는 20260625010000과 동일)
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

  -- 멱등: 이미 확정된 항목은 생성 결과 id(거래 또는 할부)를 반환하고 재생성하지 않는다.
  if r.status = 'confirmed' and (r.confirmed_txn_id is not null or r.confirmed_installment_id is not null) then
    return coalesce(r.confirmed_txn_id, r.confirmed_installment_id);
  end if;

  v_type := case
    when r.guessed_type = 'income' then 'income'
    when r.guessed_type = 'transfer' then 'transfer'
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
