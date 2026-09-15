import { NextRequest, NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 수집함 원문 보존기간 정리 cron. (설계 docs/household/22 §4 · 42 · 179 §6)
 * 30일 지난 source in ('sms','file','notification') 수집행의 raw_text·raw_meta 를 NULL (행·파싱결과 유지).
 * 2026-08-17 팀장 결정으로 알림 봉투도 같은 보존기간.
 * 인증: Authorization: Bearer ${CRON_SECRET} (Vercel Cron). 일 1회(vercel.json).
 */
const RETENTION_DAYS = 30;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = createAdminClient();
  // ★count:"exact" — 반환 행(representation)은 1,000행에서 잘리므로 data.length 로 세면 첫 실행(누적분 일괄)
  //   때 purged 가 실제보다 작게 보고된다. UPDATE 자체는 필터에 맞는 전 행에 적용된다.
  const { data, error, count } = await supabase
    .from("hh_transaction_inbox")
    .update({ raw_text: null, raw_meta: null }, { count: "exact" })
    .in("source", ["sms", "file", "notification"])
    .lt("collected_at", cutoff)
    .or("raw_text.not.is.null,raw_meta.not.is.null")
    .select("id");

  if (error) {
    console.error("[hh-inbox-purge] failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, purged: count ?? data?.length ?? 0, cutoff });
}
