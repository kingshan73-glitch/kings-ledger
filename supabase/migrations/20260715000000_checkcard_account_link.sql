-- 77. 체크카드 지출 확정 시 출금계좌(account_id) 자동 연결. (설계 docs/household/77)
-- 배경: 체크카드는 결제 즉시 연결계좌에서 출금되는데 account_id=null 로 확정되면 통장내역/잔액에
--       안 잡힌다(신용카드는 월 카드대금 payment 로 빠지므로 null 이 맞음).
-- 규칙: expense 이고 출금계좌 미지정이며 결제수단이 kind='check'+linked_account_id 있으면
--       account_id := 결제수단.linked_account_id. 명시적 계좌 선택은 존중, 신용/현금은 null 유지.
-- 나머지 분기는 20260712000000 과 동일.

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
  v_acct   uuid;  -- expense 출금계좌(체크카드면 연결계좌로 보정)
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
    -- 카드대금·대출 원리금 납부 = 출금계좌 −금액. 카테고리·결제수단 없음(지출집계 제외).
    if r.guessed_from_account_id is null then
      raise exception '납부는 출금계좌가 필요합니다.';
    end if;

    insert into public.hh_transaction
      (owner_auth_uid, txn_date, type, amount, from_account_id, counterparty, memo, source)
    values
      (v_owner, coalesce(r.guessed_date, current_date), 'payment', r.guessed_amount,
       r.guessed_from_account_id, r.guessed_merchant, v_memo, 'inbox')
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

    -- 체크카드 자동 연결: 출금계좌 미지정 + 결제수단이 체크카드(연결계좌 보유)면 그 계좌로 차감.
    -- 신용카드(linked_account_id=null)·현금은 v_acct 가 null 로 남아 잔액에 영향 없음(설계 70 유지).
    v_acct := r.guessed_account_id;
    if v_acct is null and r.guessed_payment_method_id is not null then
      select pm.linked_account_id into v_acct
        from public.hh_payment_method pm
       where pm.id = r.guessed_payment_method_id and pm.kind = 'check';
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

grant execute on function public.hh_confirm_inbox(uuid) to authenticated;
