import { NextRequest } from "next/server";

import { handleSmsIngest } from "@/lib/household/sms-ingest";

/**
 * 결제문자 자동수집 webhook (권장 경로). (설계: docs/household/22)
 * 기존 /api/household/sms 와 동일 동작(공통 핸들러). 사용법: docs/household/SMS_FORWARDING.md
 */
export async function POST(request: NextRequest) {
  return handleSmsIngest(request);
}
