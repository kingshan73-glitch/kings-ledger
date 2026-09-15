import { NextRequest } from "next/server";

import { handleNotificationIngest } from "@/lib/household/notification-ingest";

/**
 * 알림(Notification) 자동수집 webhook. (설계 docs/household/42)
 * MacroDroid 알림 트리거가 토스 등 앱 푸시 알림을 JSON으로 POST 한다.
 * 인증: Header x-ingest-token. Body: { source, app, package, title, text, bigText, channel, receivedAt }
 */
export async function POST(request: NextRequest) {
  return handleNotificationIngest(request);
}
