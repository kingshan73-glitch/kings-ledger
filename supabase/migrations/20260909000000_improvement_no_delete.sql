-- 개선사항 게시판(설계 156)을 **지울 수 없는 이력**으로 못박는다. (팀장 결정 2026-09-09)
--
-- 배경: 게시판 설계는 "행을 지우지 말고 status='dropped' 로 내린다" 인데, RLS 는 로그인한 본인에게
--   DELETE 를 허용하고 있었다(20260807000000_improvement_board.sql 의 hh_improvement_owner_delete).
--   화면에 삭제 버튼은 없지만 브라우저 콘솔·REST 로는 지울 수 있어, **설계 의도와 DB 권한이 어긋나** 있었다.
--   2026-08-08 Codex×Claude 교차리뷰에서 Codex 가 단독으로 잡았고(게시판 f5a99d1a), 팀장 판단으로 남겨 뒀다.
--   2026-09-09 팀장 결정: **이력 보존이 이 게시판의 목적이므로 삭제를 막는다.**
--
-- 무엇이 바뀌나
--   · authenticated(=앱 로그인 계정) 는 이제 이 표의 행을 지울 수 없다. SELECT·INSERT·UPDATE 는 그대로다.
--   · service_role 은 RLS 를 바이패스하므로 스크립트로는 여전히 가능하다 —
--     의도적이다. 잘못 넣은 행은 화면에서 dropped 로 내리고, 그래도 지워야 하면 스크립트로 한다.
--   · 앱 코드에는 이 표를 지우는 경로가 없다(2026-09-09 확인: src/ 에 delete 호출 0건). 기능 영향 없음.
--
-- 되돌리기(한 줄):
--   CREATE POLICY hh_improvement_owner_delete ON public.hh_improvement
--       FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);
--
-- ★RLS 는 TRUNCATE 에 적용되지 않는다 — app_logs 때와 같은 이유로 권한도 함께 거둔다
--   (init.sql 의 GRANT ALL 에 TRUNCATE 가 들어 있다). SELECT·INSERT·UPDATE 는 다시 준다.

DROP POLICY IF EXISTS hh_improvement_owner_delete ON public.hh_improvement;

REVOKE ALL ON public.hh_improvement FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hh_improvement TO authenticated;
