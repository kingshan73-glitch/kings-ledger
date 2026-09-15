-- 수집함 사용내역 편집 필드 + 확정 시 거래 memo 반영 (설계 docs/household/23)
-- 원문(raw_text)은 보존하고, 사용자가 편집한 사용내역은 user_memo에 저장한다.
-- 확정 시 hh_transaction.memo = coalesce(user_memo, raw_text)로 복사한다.

alter table public.hh_transaction_inbox
  add column if not exists user_memo text;

comment on column public.hh_transaction_inbox.user_memo is
  '사용자가 편집한 사용내역(없으면 raw_text 표시). 확정 시 hh_transaction.memo로 복사.';

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

  -- RLS(security_invoker)로 본인 항목만 조회됨
  select * into r from public.hh_transaction_inbox where id = p_inbox_id;
  if not found then
    raise exception '수집 항목을 찾을 수 없습니다.';
  end if;

  -- 이미 확정된 항목이면 기존 거래 id를 반환(중복 거래 생성 방지 = 멱등)
  if r.status = 'confirmed' and r.confirmed_txn_id is not null then
    return r.confirmed_txn_id;
  end if;

  v_type := case
    when r.guessed_type = 'income' then 'income'
    when r.guessed_type = 'transfer' then 'transfer'
    else 'expense'
  end;

  -- 사용내역: 편집값 우선, 없으면 원문. 빈 문자열은 null 취급.
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
    if r.guessed_payment_method_id is null then
      raise exception '지출은 결제수단이 필요합니다.';
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
