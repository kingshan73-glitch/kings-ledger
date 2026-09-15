-- 알림(Notification) 수집 지원. (설계 docs/household/42)
-- 토스뱅크 등 SMS를 안 보내고 앱 푸시 알림만 주는 거래를 MacroDroid 알림 트리거로 받아 적재한다.
-- ① source CHECK에 'notification' 추가  ② 알림 원본 envelope 보존용 raw_meta jsonb 컬럼.

alter table public.hh_transaction_inbox
  drop constraint if exists hh_inbox_source_check;

alter table public.hh_transaction_inbox
  add constraint hh_inbox_source_check
  check (source in ('sms', 'file', 'manual', 'notification'));

alter table public.hh_transaction_inbox
  add column if not exists raw_meta jsonb;

comment on column public.hh_transaction_inbox.raw_meta is
  '알림 수집 원본 envelope(app/package/title/text/bigText/channel/receivedAt 등). source=notification일 때 사용. (docs/household/42)';
