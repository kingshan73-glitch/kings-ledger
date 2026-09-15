-- 설계 201. 크로스소스 사후 스윕(설계 200)의 "승자 확인 → 패자 강등"을 **한 트랜잭션**으로 묶는다.
--
-- 왜: PostgREST 로는 "승자가 살아 있을 때만 패자를 내린다"를 원자적으로 쓸 수 없어, 설계 200 은
--     읽고-내리고-다시 읽어-틀렸으면 되돌리는 **보상**으로 근사했다. 그래도 창이 남았다 —
--     승자 재조회 직후 사람이 승자를 휴지통으로 옮기면 `승자=ignored · 패자=duplicate` 가 되어
--     pending 대표가 사라진다(설계 200 「남은 창」, 테스트 ㉕ 로 고정해 뒀던 한계).
--
-- 이 함수는 승자 행을 `for update` 로 **잠근 뒤** 상태를 보고, 같은 트랜잭션에서 패자를 내린다.
-- 그래서 판정과 반영 사이에 남이 끼어들 수 없다. 끼어들기는 우리 커밋 **뒤**로 직렬화되고,
-- 그건 경쟁이 아니라 "사람이 나중에 그 행을 버렸다" = 설계 63 이후 늘 있던 정상 동작이다.
--
-- ★판정 로직(어느 행이 같은 거래인가·누가 승자인가·수기입력 제외)은 **TypeScript 에 그대로 둔다.**
--   SQL 로 옮기면 `sameDirectionClass`·`isSameAsManualEntry`·`isConfidentlyDifferentTransfer` 가
--   두 벌이 되어 조용히 어긋난다(전역 규칙: 한 사실은 한 파일에만). 여기서는 **원자성만** 얻는다.
--
-- 부수 효과: 설계 200 의 자기 재조회·보상·되돌리기 코드가 통째로 필요 없어진다
--   (자기가 휴지통이면 승자 검사 또는 패자의 status='pending' 조건에 걸려 자연히 아무 일도 안 일어난다).
--   경쟁 시 왕복도 최대 5회 → 2회(후보조회 + 이 함수)로 준다.

-- ★`auth.uid()` 가 아니라 `p_owner` 를 인자로 받는다 — 이 저장소의 다른 RPC(hh_revert_inbox 등)와 다르다.
--   이 함수는 **수집 라우트(service_role)** 가 부르는데 그때 `auth.uid()` 는 null 이기 때문이다.
--   owner 는 요청 본문이 아니라 `hh_ingest_token` 조회에서 나온 **서버 파생값**이라 위조할 수 없고,
--   앱(authenticated)이 부르면 RLS(`auth.uid() = owner_auth_uid`)가 남의 owner 를 막는다.
--   그래도 아래에서 실행 권한을 service_role 로 좁혀 이중으로 막는다.
create or replace function public.hh_sweep_demote_losers(
  p_owner     uuid,
  p_self_id   uuid,
  p_winner_id uuid,
  p_loser_ids uuid[]
)
returns uuid[]
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_winner_status text;
  v_self_status   text;
  v_demoted       uuid[] := '{}';
begin
  if p_owner is null or p_winner_id is null or p_loser_ids is null or array_length(p_loser_ids, 1) is null then
    return '{}';
  end if;

  -- 승자를 잠근다. 여기서 읽은 상태는 이 트랜잭션이 끝날 때까지 남이 못 바꾼다.
  select status into v_winner_status
    from public.hh_transaction_inbox
   where id = p_winner_id
     and owner_auth_uid = p_owner
   for update;

  -- 승자가 없거나(삭제) 이미 죽었으면(휴지통·중복) 아무도 내리지 않는다.
  -- ★"모르면 내리지 않는다" — 안 보이게 하느니 pending 으로 남겨 사람이 본다.
  if v_winner_status is null or v_winner_status not in ('pending', 'confirmed') then
    return '{}';
  end if;

  -- ★스윕을 촉발한 행(자기)이 **살아 있을 때만** 판정을 반영한다. (배포 전 교차리뷰 — 양쪽이 독립으로 지적)
  --   TS 는 자기를 무조건 pending 으로 무리에 넣는다. 후보 조회~여기 사이에 사람이 자기를 휴지통으로
  --   옮기면, 3건 이상 무리에서 **휴지통에 있는 내가 방아쇠가 되어 남의 행을 내리는** 일이 생긴다.
  --   설계 200 의 '자기 재조회' 방어가 하던 일을 여기서 같은 트랜잭션 안으로 가져왔다(더 강하다).
  if p_self_id is not null then
    select status into v_self_status
      from public.hh_transaction_inbox
     where id = p_self_id
       and owner_auth_uid = p_owner;
    if v_self_status is null or v_self_status <> 'pending' then
      return '{}';
    end if;
  end if;

  -- 패자는 **pending 일 때만** 내린다(확정·휴지통 행은 절대 덮지 않는다).
  -- 승자 자신이 목록에 섞여 들어와도 여기서 걸러진다.
  with upd as (
    update public.hh_transaction_inbox
       set status = 'duplicate'
     where id = any(p_loser_ids)
       and id <> p_winner_id
       and owner_auth_uid = p_owner
       and status = 'pending'
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_demoted from upd;

  return v_demoted;
end;
$$;

comment on function public.hh_sweep_demote_losers(uuid, uuid, uuid, uuid[]) is
  '설계 201 — 크로스소스 사후 스윕의 승자·자기 확인 + 패자 강등을 한 트랜잭션으로. 판정 로직은 TS 에 있고 여기서는 원자성만 얻는다.';

-- ★최소권한: 이 함수는 **수집 라우트(service_role)만** 부른다. (배포 전 리뷰 M2)
--   지금은 RLS 가 남의 데이터를 막아 주지만, 스키마 변경은 되돌리기가 비싸니 처음부터 좁혀 둔다.
revoke execute on function public.hh_sweep_demote_losers(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.hh_sweep_demote_losers(uuid, uuid, uuid, uuid[]) to service_role;

-- 롤백: drop function public.hh_sweep_demote_losers(uuid, uuid, uuid, uuid[]);
