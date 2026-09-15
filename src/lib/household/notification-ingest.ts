import { NextRequest, NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { enrichParsed, hasSameDayAmountSibling, hasSameTimeSibling, insertInboxWithSameTimeRetry, insertTraceUnknown, isCrossSourceDuplicate, isDuplicateFamilyTransfer, sweepAfterInsertIfPending } from "@/lib/household/sms-ingest";
import { cashbackComboPayAmount, hashIngestToken, ignoreTraceGuessedType, skipDisposition } from "@/lib/household/sms";

function bearerToken(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 알림 봉투에서 기대하는 키 목록.
const KNOWN_KEYS = [
  "source", "app", "package", "pkg", "title", "text", "bigText", "big_text",
  "channel", "receivedAt", "received_at", "token", "ingest_token",
];

/**
 * 깨진 JSON 관용 파싱. (설계 docs/household/47)
 * 폰(MacroDroid)이 값 따옴표를 빠뜨려(`"app" : 토스"`) JSON.parse가 실패할 때,
 * 알려진 키별로 `"key" : value` 를 정규식으로 추출한다. 값 양끝 따옴표·콤마·공백은 제거.
 * 금액 콤마(1,000,000)는 다음 토큰이 `"key":`가 아니라 잘리지 않는다.
 */
function looseParseBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const keyAlt = KNOWN_KEYS.join("|");
  for (const key of KNOWN_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*([\\s\\S]*?)\\s*(?=,\\s*"(?:${keyAlt})"\\s*:|}\\s*$|$)`);
    const m = raw.match(re);
    if (!m) continue;
    const v = m[1].trim().replace(/,+\s*$/, "").trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();
    if (v) out[key] = v;
  }
  return out;
}

/** receivedAt(ISO/epoch ms·s) 또는 현재시각을 Asia/Seoul "YYYY-MM-DD HH:MM"(분단위)로. */
function minuteKey(receivedAt: unknown): string {
  let d: Date | null = null;
  if (typeof receivedAt === "number" && Number.isFinite(receivedAt)) {
    d = new Date(receivedAt > 1e12 ? receivedAt : receivedAt * 1000);
  } else if (typeof receivedAt === "string" && receivedAt.trim()) {
    const n = Number(receivedAt);
    if (Number.isFinite(n) && receivedAt.trim().match(/^\d+$/)) {
      d = new Date(n > 1e12 ? n : n * 1000);
    } else {
      const t = Date.parse(receivedAt);
      if (!Number.isNaN(t)) d = new Date(t);
    }
  }
  if (!d || Number.isNaN(d.getTime())) d = new Date();
  // en-CA + 24시간제 → "2026-06-29, 14:03" 형태에서 분까지만 사용
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * 알림(Notification) 수집 webhook. (설계 docs/household/42)
 * 토스뱅크 등 SMS 미발송·앱푸시 전용 거래를 MacroDroid 알림 트리거로 받아 적재한다.
 *
 * 인증: 헤더 `x-ingest-token`(없으면 본문 token / 쿼리 token).
 * Body(JSON): { source, app, package, title, text, bigText, channel, receivedAt, token? }
 * 동작: 원본 envelope을 raw_meta에 보존 + best-effort 파싱(가맹점·금액·계좌·카테고리)
 *       → 광고·정보성 알림(주식 시세·할인 등)은 SMS와 동일 필터로 skip, 거래만
 *       hh_transaction_inbox(source='notification', pending)에 적재. (설계 docs/household/50)
 * 중복: title + text + 분단위시각(receivedAt) 기준 dedup_hash.
 */
export async function handleNotificationIngest(request: NextRequest) {
  try {
    const bodyRaw = await request.text();
    let body: Record<string, unknown> = {};
    if (bodyRaw.trim()) {
      try {
        const parsed = JSON.parse(bodyRaw);
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
        else body = { text: bodyRaw };
      } catch {
        // 깨진 JSON(폰에서 값 따옴표 누락 등) → 알려진 키 관용 추출. 그래도 0개면 전체를 text로. (설계 docs/household/47)
        const loose = looseParseBody(bodyRaw);
        body = Object.keys(loose).length > 0 ? loose : { text: bodyRaw };
      }
    }

    const token =
      request.headers.get("x-ingest-token") ??
      request.headers.get("x-device-token") ??
      bearerToken(request.headers.get("authorization")) ??
      str(body.token) ??
      str(body.ingest_token) ??
      request.nextUrl.searchParams.get("token") ??
      request.nextUrl.searchParams.get("ingest_token");
    if (!token || !token.trim()) {
      return NextResponse.json({ error: "Unauthorized: missing token" }, { status: 401 });
    }

    const source = str(body.source) ?? "notification";
    const app = str(body.app);
    const pkg = str(body.package) ?? str((body as Record<string, unknown>)["pkg"]);
    const title = str(body.title);
    const text = str(body.text);
    const bigText = str(body.bigText) ?? str((body as Record<string, unknown>)["big_text"]);
    const channel = str(body.channel);
    const receivedAt = body.receivedAt ?? body.received_at ?? null;

    // 파싱용 본문 = title + 본문(bigText 우선) 합본. (설계 docs/household/47)
    // 토스 등은 금액이 title("1,000,000원 입금"), 상대/계좌가 본문("이바다 → 내 토스뱅크 통장")에 나뉘므로
    // 합쳐야 금액·상대를 모두 인식한다. 중복(제목=본문)은 한 번만.
    const bodyText = bigText ?? text;
    const rawText = [title, bodyText]
      .filter((s): s is string => !!s && !!s.trim())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .join(" ")
      .trim();
    if (!rawText) {
      return NextResponse.json({ error: "Empty notification (title/text/bigText all missing)" }, { status: 400 });
    }

    const supabase = createAdminClient();

    const tokenHash = hashIngestToken(token);
    const { data: tokenRow } = await supabase
      .from("hh_ingest_token")
      .select("id, owner_auth_uid")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!tokenRow) {
      return NextResponse.json({ error: "Unauthorized: invalid token" }, { status: 401 });
    }
    const owner = tokenRow.owner_auth_uid as string;

    // best-effort 파싱 + 계좌·카드·카테고리 매칭(앱명을 발신처로).
    const { parsed, fields, familyTransfer } = await enrichParsed(supabase, owner, rawText, app ?? pkg);

    // 스킵 처리. SMS와 동일 필터 공유. (설계 docs/household/50·56)
    // - ignore-noise(주식 시세·할인 쿠폰 등 명백한 광고/정보성): DB에 흔적없이 skip.
    // - trace-unknown(거래인지 판단 못한 미인식): 휴지통(ignored)에 원문·봉투(raw_meta) 보존으로 남김.
    // - ignore-trace(휴대폰 소액결제 영수증): 휴지통(ignored)에 원문·봉투(raw_meta) 보존으로 남김. (설계 196)
    const disposition = skipDisposition(rawText, parsed);
    if (disposition === "ignore-noise") {
      await supabase.from("hh_ingest_token").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);
      return NextResponse.json({ success: true, skipped: true, reason: "non-transactional" }, { status: 200 });
    }
    if (disposition === "trace-unknown" || disposition === "ignore-trace") {
      const rawMeta = { source, app, package: pkg, title, text, bigText, channel, receivedAt };
      const traceResult = await insertTraceUnknown(supabase, owner, {
        source: "notification",
        sourceAdapter: app ?? pkg,
        rawText,
        date: fields.guessed_date,
        time: fields.guessed_time,
        rawMeta,
        parsed: disposition === "ignore-trace" ? parsed : null,
        ...(disposition === "ignore-trace" ? { guessedType: ignoreTraceGuessedType(rawText) } : {}),
      });
      await supabase.from("hh_ingest_token").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);
      // ★적재가 실패했으면 성공(201)으로 답하지 않는다. (설계 199 — SMS 핸들러와 동일)
      if (traceResult.failed) {
        return NextResponse.json({ error: `휴지통 적재 실패: ${traceResult.error}`, traced: false }, { status: 500 });
      }
      return NextResponse.json({ success: true, skipped: true, traced: true, reason: disposition, ...traceResult }, { status: 201 });
    }

    // 중복 방지: title + text + 분단위시각. (보스 지정) — 같은 알림 재전송 억제용.
    const dedupHash = [title ?? "", text ?? "", minuteKey(receivedAt)].join("|");

    // 크로스소스 이중수집(SMS 등 다른 소스가 같은 금액·날짜를 이미 수집)이면 duplicate로. (설계 docs/household/63)
    // 이체는 끝점 계좌로 '서로 다른 이체'를 구분해 오판 방지(보강 2026-07-19).
    // 상호·계좌도 넘긴다 — 수기입력 후보를 가려내는 데 쓴다(설계 107).
    const txEndpoints = {
      type: fields.guessed_type,
      fromAccountId: fields.guessed_from_account_id,
      toAccountId: fields.guessed_to_account_id,
      merchant: fields.guessed_merchant,
      accountId: fields.guessed_account_id,
    };
    // 같은 날짜·시각·금액 수집 건이 이미 있으면 이번 행은 휴지통(ignored)으로. (설계 163 — SMS 핸들러와 동일)
    const sameTimeDup = await hasSameTimeSibling(supabase, owner, parsed.kind, fields.guessed_date, fields.guessed_time, parsed.amount);
    const crossDup = sameTimeDup ? false : await isCrossSourceDuplicate(supabase, owner, "notification", fields.guessed_date, parsed.amount, txEndpoints);
    // 가족 내부 이체는 보낸/받은 쪽 2건으로 들어올 수 있어(같은 소스여도) 같은 날·금액이면 duplicate로. (설계 48·63)
    const famDup = !sameTimeDup && familyTransfer ? await isDuplicateFamilyTransfer(supabase, owner, fields.guessed_date, parsed.amount, txEndpoints) : false;
    // 캐시백 결합 알림("N원 캐시백 🎉 M원 결제")은 같은 결제의 **재통보**일 수 있다 — 결제 알림과
    // 상호가 달라 어느 기존 가드에도 안 걸리므로, 같은 날·같은 금액·지출 방향이 이미 있으면
    // duplicate 로 표시(삭제 아님). 발동은 결합 알림일 때만으로 좁힌다. (설계 165)
    // ★cancel 은 제외한다(교차리뷰 — 163 과 같은 회귀: 취소가 원 지출의 duplicate 로 격리되면
    //   설계 151 취소 흐름이 죽는다). 현재 알림이 지출 방향일 때만 본다(오파싱 방어).
    const comboDup = !sameTimeDup && !crossDup && !famDup
      && parsed.kind !== "cancel"
      && ["expense", "installment", "payment"].includes(fields.guessed_type)
      && cashbackComboPayAmount(rawText) != null
      ? await hasSameDayAmountSibling(supabase, owner, fields.guessed_date, parsed.amount)
      : false;

    const rawMeta = { source, app, package: pkg, title, text, bigText, channel, receivedAt };

    const row = {
      owner_auth_uid: owner,
      source: "notification",
      source_adapter: app ?? pkg,
      raw_text: rawText,
      raw_meta: rawMeta,
      status: sameTimeDup ? "ignored" : crossDup || famDup || comboDup ? "duplicate" : "pending",
      dedup_hash: dedupHash,
      ...fields,
    };
    // 삽입 + 동일시각 인덱스 충돌(동시 요청 경쟁) 시 휴지통 재삽입. (설계 163 — SMS 핸들러와 동일)
    const { id: insertedId, createdAt, error, trashedByRace } = await insertInboxWithSameTimeRetry(supabase, row);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ success: true, duplicate: true }, { status: 200 });
      }
      console.error("[hh-notif] insert failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 사후 스윕 — 사전조회가 경쟁(수십 ms 차)으로 못 본 크로스소스 중복을 커밋 뒤 한 번 더 본다. (설계 200)
    // 발동 조건은 `sweepAfterInsertIfPending` 안에 **한 벌만** 있다(SMS 핸들러와 공유 — 사본 금지).
    const swept = await sweepAfterInsertIfPending(
      supabase,
      owner,
      { id: insertedId, createdAt, source: "notification", trashedByRace, insertedStatus: row.status },
      fields.guessed_date,
      parsed.amount,
      txEndpoints
    );

    await supabase.from("hh_ingest_token").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);

    const trashed = sameTimeDup || trashedByRace;
    return NextResponse.json(
      {
        success: true,
        id: insertedId,
        source: "notification",
        kind: parsed.kind,
        amount: parsed.amount,
        ...(trashed ? { duplicate: true, trashed: true } : {}),
        ...(swept?.demotedSelf ? { duplicate: true, swept: true } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    console.error("[hh-notif] unhandled error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
