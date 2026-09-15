-- 18. 엑셀 import 추적 강화 (설계: docs/household/18 §2 P0-데이터)
-- 코덱스 검토서 §6/§9 반영:
--  (1) hh_transaction 에 원본 추적 컬럼(source_sheet/source_row) 추가 — 어느 시트·행에서 왔는지 보존
--  (2) hh_import_log 신규 — import 1회 실행마다 파일명·시각·행수·오류수·오류상세(#REF! 등) 기록

-- (1) 원본 추적 컬럼 ---------------------------------------------------------
ALTER TABLE public.hh_transaction
    ADD COLUMN IF NOT EXISTS source_sheet text,
    ADD COLUMN IF NOT EXISTS source_row   integer;

COMMENT ON COLUMN public.hh_transaction.source_sheet IS '엑셀 import 출처 시트명(YYYYMM 등). 수동/수집 입력은 NULL.';
COMMENT ON COLUMN public.hh_transaction.source_row   IS '엑셀 import 출처 행 번호(1-base). 수동/수집 입력은 NULL.';

-- import 출처로 조회·재현할 수 있도록 인덱스(import 행만)
CREATE INDEX IF NOT EXISTS hh_transaction_source_origin_idx
    ON public.hh_transaction (owner_auth_uid, source_sheet, source_row)
    WHERE source = 'import';

-- (2) import 이력 + 오류 집계 -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.hh_import_log (
    id             uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_auth_uid uuid NOT NULL,
    file_name      text NOT NULL,
    -- 엑셀 마지막 수정/스냅샷 시각 등 외부 기준 시각(있으면). 실행 시각은 created_at.
    imported_at    timestamp with time zone DEFAULT now() NOT NULL,
    status         text DEFAULT 'success' NOT NULL,
    row_count      integer DEFAULT 0 NOT NULL,
    error_count    integer DEFAULT 0 NOT NULL,
    -- 오류 상세: [{sheet, row, col, kind, value}] 형태. #REF!·빈금액·날짜파싱실패 등.
    error_detail   jsonb,
    note           text,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hh_import_log_status_check CHECK (status IN ('success','partial','failed'))
);

CREATE INDEX IF NOT EXISTS hh_import_log_owner_idx ON public.hh_import_log (owner_auth_uid, created_at DESC);

ALTER TABLE public.hh_import_log ENABLE ROW LEVEL SECURITY;

-- 소유자 스코프(다른 hh_* 테이블과 동일). import 스크립트는 service_role로 적재(RLS 우회),
-- 화면 조회는 본인만.
CREATE POLICY hh_import_log_owner_select ON public.hh_import_log
    FOR SELECT TO authenticated USING (auth.uid() = owner_auth_uid);
CREATE POLICY hh_import_log_owner_insert ON public.hh_import_log
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_import_log_owner_update ON public.hh_import_log
    FOR UPDATE TO authenticated USING (auth.uid() = owner_auth_uid) WITH CHECK (auth.uid() = owner_auth_uid);
CREATE POLICY hh_import_log_owner_delete ON public.hh_import_log
    FOR DELETE TO authenticated USING (auth.uid() = owner_auth_uid);
