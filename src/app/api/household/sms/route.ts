import { NextRequest } from "next/server";

import { handleSmsIngest } from "@/lib/household/sms-ingest";

/**
 * 가계부 결제문자 자동수집 webhook. (설계: docs/household/22)
 * 별칭: POST /api/household/inbox/sms — 동일 동작(공통 핸들러).
 * 폰의 문자전달 앱이 결제/입금 SMS를 이 URL로 POST 한다. 사용법: docs/household/SMS_FORWARDING.md
 */
export async function POST(request: NextRequest) {
  return handleSmsIngest(request);
}
