-- 98. 정기지출 영구보류 마커. is_active=false 인 항목 중
-- '영구보류(무기한 세워둠, 화면에 보임)'와 '폐지(끝남/유령/중복, 숨김)'를 구분한다.
-- 기존 비활성 22건은 default=false → 폐지로 분류(원하는 결과, 데이터 보정 불필요).
ALTER TABLE public.hh_scheduled_payment
    ADD COLUMN permanent_hold boolean NOT NULL DEFAULT false;
