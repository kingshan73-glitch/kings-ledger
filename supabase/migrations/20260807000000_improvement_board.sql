-- 156. 개선사항 게시판 (설계: docs/household/156_improvement_board.md, 팀장 지시 2026-08-07)
--
-- 왜 만드나
--   오판 -> 재점검 -> 원인 규명 -> 개선의 과정이 지금은 내(에이전트) 작업 기억에만 쌓여
--   팀장님은 볼 수 없다. 2026-08-07 에 낡은 로그를 근거로 "토스페이·부천페이 잔액이 깨졌다"고
--   보고했는데 실제로 재보니 둘 다 이미 맞아 있었다. 그 오판과 재점검을 앱 안에 남긴다.
--
-- 설계 요지
--   · kind 로 두 종류를 한 테이블에 둔다 — 'check'(팀장 확인 필요) / 'fix'(개선 이력).
--     테이블을 쪼개면 "확인 요청했다가 조치까지 간 항목"이 한 행으로 이어지지 않는다.
--   · 이력은 증상 -> 원인 -> 조치 -> 근거 4단으로 쓴다. 나중에 게시판만 보고 복원 가능해야 한다.
--   · status='dropped' 를 둔 이유 = "확인해 보니 문제가 아니었다"를 남기기 위해서다.
--     행을 지우면 **오판 자체가 사라져** 이 게시판의 목적을 잃는다. 지우지 말고 dropped 로 내린다.

CREATE TABLE public.hh_improvement (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    kind           text NOT NULL,                        -- 'check' | 'fix'
    title          text NOT NULL,
    symptom        text,                                 -- 증상: 무엇이 잘못 보였나
    root_cause     text,                                 -- 원인: 진짜 이유
    action         text,                                 -- 조치: 무엇을 했나 / 무엇을 정해야 하나
    evidence       text,                                 -- 근거: 수치·스크립트명
    design_no      integer,                              -- 설계 번호(코드 주석과 상호참조)
    severity       text NOT NULL DEFAULT 'mid',          -- 'high' | 'mid' | 'low'
    status         text NOT NULL DEFAULT 'open',         -- 'open' | 'done' | 'dropped'
    occurred_on    date,                                 -- 발생·발견일
    checked_at     timestamp with time zone,             -- 팀장님 확인 시각
    checked_memo   text,                                 -- 팀장님 메모
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_improvement_kind_check     CHECK (kind IN ('check', 'fix')),
    CONSTRAINT hh_improvement_severity_check CHECK (severity IN ('high', 'mid', 'low')),
    CONSTRAINT hh_improvement_status_check   CHECK (status IN ('open', 'done', 'dropped')),
    CONSTRAINT hh_improvement_title_check    CHECK (btrim(title) <> ''),
    -- 재실행 안전: 같은 제목·같은 날짜를 두 번 넣지 못하게 한다(등록 스크립트를 또 돌려도 안전).
    CONSTRAINT hh_improvement_unique         UNIQUE (owner_auth_uid, title, occurred_on)
);

CREATE INDEX hh_improvement_owner_kind_idx
    ON public.hh_improvement (owner_auth_uid, kind, status, occurred_on DESC);

COMMENT ON TABLE public.hh_improvement IS
    '개선사항 게시판 — 오판·재점검·개선 이력(fix)과 팀장 확인 필요 항목(check). (설계 156)';
COMMENT ON COLUMN public.hh_improvement.status IS
    'open|done|dropped. dropped = 확인해 보니 문제가 아니었음. 행을 지우지 말고 여기로 내린다.';

ALTER TABLE public.hh_improvement ENABLE ROW LEVEL SECURITY;

CREATE POLICY hh_improvement_owner_select ON public.hh_improvement
    FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY hh_improvement_owner_insert ON public.hh_improvement
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_improvement_owner_update ON public.hh_improvement
    FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_improvement_owner_delete ON public.hh_improvement
    FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);

CREATE TRIGGER hh_improvement_updated_at BEFORE UPDATE ON public.hh_improvement
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
