-- 92 보정. 앞선 20260720010000 이 만든 부분 인덱스를 되돌린다. (설계 docs/household/92)
--
-- 사실관계 정정: hh_transaction.loan_id 는 '추가할 컬럼'이 아니라 최초 스키마
-- (20260613000000_household_init.sql:157)부터 있던 컬럼이다. 인덱스도 이미 있다
-- (hh_transaction_loan_idx). 덱스 전반점검 보고서의 "loan_id 추가" 지적은 부정확했고,
-- 20260720010000 은 컬럼 추가는 no-op 으로 넘어갔지만 인덱스는 중복 생성했다.
-- 진짜 문제는 컬럼 부재가 아니라 '한 번도 채워지지 않았다'는 것(적용 전 0건).

drop index if exists public.hh_transaction_loan_id_idx;
