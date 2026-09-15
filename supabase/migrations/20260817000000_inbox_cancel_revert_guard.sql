-- 설계 179 §2. 승인취소 확정은 원 거래를 삭제하지만 hh_revert_inbox 에는 cancel 분기가 없어,
-- 되돌려도 원 거래가 살아나지 않는데 화면은 성공으로 안내했다. 복구 불가능한 되돌리기를 RPC 에서 차단한다.

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

  -- ★설계 179 §2: 승인취소 확정은 원 거래를 **삭제**했다(설계 151). 되돌려도 살아나지 않으니 막는다.
  --   pending 멱등 반환 **뒤**에 둔다 — 아직 확정 안 된 취소 행은 종전대로 무해하게 no-op.
  if r.guessed_kind = 'cancel' then
    raise exception '승인취소 확정은 원 거래를 삭제했으므로 되돌릴 수 없습니다. 필요하면 원 지출을 수기로 다시 등록해 주세요.';
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
