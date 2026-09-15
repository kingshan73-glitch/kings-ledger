-- 17. 결제문자 자동수집용 인제스트 토큰 (설계: docs/household/17)
-- 폰의 문자전달 앱이 POST /api/household/sms 에 보낼 때 헤더로 제시하는 per-user 토큰.
-- 원문 토큰은 저장하지 않고 sha256 해시만 저장(발급 시 1회만 화면 표시).

CREATE TABLE public.hh_ingest_token (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    token_hash     text NOT NULL UNIQUE,
    label          text,
    last_used_at   timestamp with time zone,
    created_at     timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX hh_ingest_token_owner_idx ON public.hh_ingest_token (owner_auth_uid);

ALTER TABLE public.hh_ingest_token ENABLE ROW LEVEL SECURITY;

-- 소유자 스코프(다른 hh_* 테이블과 동일). 토큰 조회/발급/폐기는 본인만.
-- 엔드포인트는 service_role로 token_hash 조회(RLS 우회)하므로 SELECT 정책과 무관.
CREATE POLICY hh_ingest_token_owner_select ON public.hh_ingest_token
    FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY hh_ingest_token_owner_insert ON public.hh_ingest_token
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_ingest_token_owner_delete ON public.hh_ingest_token
    FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);
