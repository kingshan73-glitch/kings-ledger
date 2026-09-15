-- 91. 수집함 확정/되돌리기 원자화. (설계 docs/household/91, 덱스 전반점검 P1 반영)
--
-- 1) hh_confirm_inbox — 행 잠금 추가.
--    기존(20260717000000)은 잠금 없이 상태를 읽어, 첫 확정이 커밋되기 전 들어온
--    동시 요청(더블클릭·다중 탭)이 멱등 체크를 통과해 거래를 2건 만들 수 있었다.
--    select ... for update 로 잠그면 두 번째 요청은 첫 커밋까지 대기 후 멱등 체크에
--    걸려 기존 id를 반환한다. 잠금 외 나머지 분기는 20260717000000 과 동일.
--
-- 2) hh_revert_inbox — 되돌리기를 단일 트랜잭션 RPC로.
--    기존 화면은 거래 삭제 → 상태 복원을 클라이언트에서 순차 실행해 중간 실패 시
--    "확정됨인데 거래 없음" 불일치가 남았고, 할부(confirmed_installment_id) 경로가 없었다.
--    - source='inbox' 거래만 삭제, 수기 등 다른 소스는 보존하고 링크만 해제(이중계상 방지).
--    - related_txn_id 파생 거래(설계 84 인센티브)는 FK cascade 로 함께 삭제된다.
--    - 할부 확정은 hh_installment 마스터를 삭제한다.
--    - 확정과 같은 행 잠금을 쓰므로 확정/되돌리기 동시 실행도 직렬화된다.

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

-- 되돌리기: 확정이 만든 거래/할부를 지우고 검토대기로 복원. 전부 한 트랜잭션. (설계 91)
create or replace function public.hh_revert_inbox(p_inbox_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_owner uuid := auth.uid();
  r       public.hh_transaction_inbox;
  v_src   text;
begin
  if v_owner is null then
    raise exception '인증 정보가 없습니다.';
  end if;

  select * into r from public.hh_transaction_inbox where id = p_inbox_id for update;
  if not found then
    raise exception '수집 항목을 찾을 수 없습니다.';
  end if;

  -- 멱등: 이미 검토대기면 할 일이 없다.
  if r.status = 'pending' then
    return;
  end if;

  if r.confirmed_txn_id is not null then
    select source into v_src from public.hh_transaction where id = r.confirmed_txn_id;
    -- 확정이 만든 거래(source='inbox')만 삭제. 수기 등 다른 소스는 보존하고 링크만 해제한다.
    if v_src = 'inbox' then
      delete from public.hh_transaction where id = r.confirmed_txn_id;
    end if;
  end if;

  if r.confirmed_installment_id is not null then
    delete from public.hh_installment where id = r.confirmed_installment_id;
  end if;

  update public.hh_transaction_inbox
     set status = 'pending', confirmed_txn_id = null, confirmed_installment_id = null
   where id = p_inbox_id;
end;
$$;
