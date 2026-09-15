-- app_logs 를 service_role 전용으로 **명시적으로 못박는다**. (설계 159, 2026-08-09)
--
-- ⚠️먼저 사실관계 — **이 마이그레이션은 지금 열려 있는 구멍을 막는 것이 아니다.**
--   `20260804000000_tighten_legacy_rls.sql`(설계 146)이 `hh!_%` 가 아닌 모든 public 표에서
--   `auth.role() = 'authenticated'` 를 쓰는 정책을 **조건으로** 훑어 지운다. app_logs 의
--   `auth_select`·`auth_insert` 는 그 조건에 걸리므로 **08-04 에 이미 사라졌다.**
--   (2026-08-09 실측: authenticated JWT 로 SELECT → 빈 배열, INSERT → 42501 RLS 위반.
--    같은 시각 service_role 로 센 행 수 16,422. 즉 표에는 데이터가 있는데 앱 키로는 안 보인다.)
--   ★**"08-04~08-09 사이에 감사로그가 아무 로그인 계정에게 열려 있었다"는 사실이 아니다.**
--   그런 노출 창은 없었다 — 이 주석의 초안이 그렇게 적혀 있었고, 배포 전 리뷰가 잡았다.
--
-- 그럼 왜 두는가: **조건부 스윕에 기대지 않기 위해서다.** 08-04 스윕은 "그때 그 조건에 맞은 것"을
--   지웠을 뿐이라, 누군가 나중에 app_logs 에 정책을 다시 만들면 아무도 막지 않는다.
--   감사로그는 표 이름을 **직접 적어** 의도를 남겨 두는 편이 안전하다(belt and braces).
--
-- 왜 스코프가 아니라 0개인가: **앱이 이 표를 anon 키로 건드리지 않는다.**
--   · 읽기 — `/api/logs` 의 GET 은 이미 제거됐고(역할 검사 없이 전체를 반환해서), 화면 어디에도
--     app_logs 를 읽는 코드가 없다. 유일한 독자는 `scripts/diag_audit.mjs`(service_role).
--   · 쓰기 — 서버의 `src/lib/logger.ts` 와 `/api/logs` POST 가 **service_role** 로 넣는다.
--     클라이언트는 `sendLog()` → `POST /api/logs` 로 서버를 거친다(직접 insert 하지 않는다).
--   service_role 은 RLS 를 바이패스하므로 기록·조회·정리는 그대로 된다.
--
-- ⚠️남는 것(이 마이그레이션이 닫지 않는다):
--   · `POST /api/logs` 는 로그인한 사용자가 임의의 action·message 를 넣게 해 준다(위조 가능).
--     actor·IP 는 서버가 채우므로 **남의 이름으로는** 못 쓴다. 계정 1개·가입 차단이라 실위험은 낮다.
--   · 보존기간·정리 작업이 없다. 하루 약 700행(대부분 NAVIGATE_PAGE) → 연 25만행.
--
-- 되돌리기: 아래 두 줄을 실행하면 init.sql 원본과 같은 정책이 된다.
--   CREATE POLICY auth_select ON public.app_logs FOR SELECT USING ((auth.role() = 'authenticated'::text));
--   CREATE POLICY auth_insert ON public.app_logs FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));
--   ⚠️단 `supabase db reset` 으로 마이그레이션을 처음부터 재생하면 08-04 스윕이 그 둘을 다시 지운다.

DROP POLICY IF EXISTS auth_select ON public.app_logs;
DROP POLICY IF EXISTS auth_insert ON public.app_logs;

-- RLS 는 켜 둔 채로 정책을 0개로 = anon/authenticated 전부 거부, service_role 만 통과.
ALTER TABLE public.app_logs ENABLE ROW LEVEL SECURITY;

-- ★RLS 는 TRUNCATE 에 적용되지 않는다. init.sql 의 `GRANT ALL` 에 TRUNCATE 가 들어 있어
--   "앱 키로는 지울 수 없다"가 문자 그대로는 성립하지 않았다(PostgREST 로 닿는 경로는 못 찾았으니
--   실제 구멍이라기보다 주장 정확성 문제다). 권한을 거둬 사실로 만든다.
REVOKE ALL ON public.app_logs FROM anon, authenticated;
