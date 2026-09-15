-- 설계 163: 동일 소유자의 같은 날짜·거래시각(HH:MM)·금액 수집 건은 검토대기(pending)에 1건만 둔다.
-- 배경(2026-08-11): 같은 결제 한 건이 카드 승인 문자 + 은행 출금 문자로 둘 다 검토대기에 들어왔다.
-- 두 행은 원문 형식이 달라 dedup_hash 가 다르고, 둘 다 SMS 라 크로스소스 판정(설계 63)도 통과했다.
--
-- ⓐ 기존 pending 충돌 정리: 같은 키의 확정(confirmed)·보관(archived) 행이 있으면 pending 을,
--    pending 끼리면 (collected_at, id) 첫 행만 남기고 나머지를 휴지통(ignored)으로 옮긴다.
--    삭제가 아니다 — 수집함 휴지통 탭에서 복원할 수 있다.
-- ⓑ pending 한정 부분 고유 인덱스 — 앱 사전조회(hasSameTimeSibling)가 못 보는
--    동시 수집 경쟁 조건을 DB 가 막는다. 걸리면 핸들러가 같은 행을 ignored 로 재삽입한다.
--    ★확정·보관을 인덱스에 넣지 않는다(Codex 인수인계안에서 킹스가 좁힘):
--      같은 분·같은 금액의 **정당한 별도 결제 2건**이 과거에 이미 둘 다 확정돼 있으면 인덱스 생성이
--      실패하고, 그렇다고 확정 행을 강등하면 실거래 기록과 어긋난다. 확정·보관과의 충돌은 사람 확정이
--      초 단위로 경쟁하지 않으므로 앱 사전조회로 충분하다. (2026-08-11 실측: 확정·보관 충돌 그룹 0개)
--    ★승인취소(guessed_kind='cancel')는 제외한다(교차리뷰) — 취소 문자는 원 승인과 같은
--      거래일·시각·금액을 담고 오므로, 인덱스에 넣으면 취소가 휴지통으로 가 설계 151 의
--      원거래 삭제 흐름이 죽는다. 정리 UPDATE 도 같은 이유로 cancel 행을 세지도 옮기지도 않는다.
--    ★고유 인덱스는 NULL 을 서로 다른 값으로 보므로 not null 술어는 안전장치 겸 인덱스 축소용이다.
--
-- ★정리 UPDATE 와 인덱스 생성 사이에 새 pending 이 끼어들면 인덱스 생성이 실패한다(교차리뷰).
--   테이블 잠금으로 이 트랜잭션이 끝날 때까지 쓰기를 세운다 — 수집 요청은 잠깐 대기할 뿐이고,
--   이 마이그레이션은 작은 테이블 UPDATE + 인덱스 생성이라 수 초 안에 끝난다.
-- ★begin/commit 을 명시한다 — supabase db push 는 문장을 트랜잭션으로 감싸 주지 않아
--   LOCK TABLE 이 "can only be used in transaction blocks"(25P01)로 실패했다(2026-08-12 실측).
begin;

lock table public.hh_transaction_inbox in exclusive mode;

with ranked as (
  select id,
         row_number() over (
           partition by owner_auth_uid, guessed_date, guessed_time, guessed_amount
           order by (status = 'pending'), collected_at, id
         ) as rn
  from public.hh_transaction_inbox
  where status in ('pending', 'confirmed', 'archived')
    and (guessed_kind is distinct from 'cancel')
    and guessed_date is not null
    and guessed_time is not null
    and guessed_amount is not null
)
update public.hh_transaction_inbox t
set status = 'ignored'
from ranked r
where t.id = r.id
  and r.rn > 1
  and t.status = 'pending';

create unique index if not exists hh_inbox_same_time_pending_uq
  on public.hh_transaction_inbox (owner_auth_uid, guessed_date, guessed_time, guessed_amount)
  where status = 'pending'
    and (guessed_kind is distinct from 'cancel')
    and guessed_date is not null
    and guessed_time is not null
    and guessed_amount is not null;

comment on index public.hh_inbox_same_time_pending_uq is
  '설계 163: 같은 소유자·날짜·시각·금액의 검토대기(pending)는 1건만(승인취소 제외). 충돌 행은 앱이 휴지통(ignored)으로 재삽입.';

commit;
