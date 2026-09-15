import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { CARD_BILL_ISSUER_RE, isCardOrLoanPayment, matchIncomeRule, matchIncomingFromRule, matchMerchantRule, matchTransferRule } from "@/lib/household/defaults";
import { CATEGORY_NAME } from "@/lib/household/category-names";
import { GENERIC_PAYEE, normalizeLoanPayee, pickReusableLoan } from "@/lib/household/loan-reuse";
import { cardIssuerKey, counterpartyHasName, extractWalletBalance, extractWalletLabel, hashIngestToken, ignoreTraceGuessedType, isNumericCodeMerchant, kindToTxnType, matchCardNameToMethod, parseSms, seoulToday, shiftIsoDate, skipDedupKey, skipDisposition, smsDedupKey, walletChainLinks, walletLabelPick, WALLET_LABEL_HISTORY_LIMIT, type SmsKind, type SmsParsed, type WalletChainPrev, type WalletLabelHistoryRow } from "@/lib/household/sms";
import type { HhLoanTerms } from "@/lib/household/types";

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** 문자열에서 은행/기관 핵심 토큰 추출(기관명↔계좌명 매칭용). 예: "KB국민은행"→"국민은행", "국민은행(이바다)"→"국민은행". */
function bankToken(s: string | null): string | null {
  if (!s) return null;
  const m = s.replace(/[(（].*$/, "").match(/[가-힣]{2,}(?:은행|뱅크|화폐|증권|카드)/);
  return m ? m[0] : null;
}

function bearerToken(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/** 토큰 헤더/본문/쿼리에서 ingest 토큰 추출. */
function extractToken(request: NextRequest, bodyToken: string | null): string | null {
  return (
    request.headers.get("x-ingest-token") ??
    request.headers.get("x-device-token") ??
    bearerToken(request.headers.get("authorization")) ??
    bodyToken ??
    request.nextUrl.searchParams.get("token") ??
    request.nextUrl.searchParams.get("device_token") ??
    request.nextUrl.searchParams.get("ingest_token")
  );
}

/** 토큰 해시로 owner 식별. 없으면 null. */
async function resolveOwner(
  supabase: SupabaseClient,
  token: string
): Promise<{ id: string; owner: string } | null> {
  const tokenHash = hashIngestToken(token);
  const { data: tokenRow } = await supabase
    .from("hh_ingest_token")
    .select("id, owner_auth_uid")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!tokenRow) return null;
  return { id: tokenRow.id as string, owner: tokenRow.owner_auth_uid as string };
}

/** 수집함 insert 에 들어갈 guessed_* 필드. */
export interface InboxGuess {
  guessed_kind: SmsParsed["kind"];
  /** 승인취소가 취소하는 원 거래. 확정 시 새 거래를 만들지 않고 이 거래를 삭제한다. (설계 151) */
  cancel_target_txn_id: string | null;
  guessed_type: string;
  guessed_amount: number | null;
  guessed_merchant: string | null;
  guessed_institution: string | null;
  guessed_loan_terms: HhLoanTerms | null;
  guessed_category_id: string | null;
  guessed_account_id: string | null;
  guessed_payment_method_id: string | null;
  guessed_from_account_id: string | null;
  guessed_to_account_id: string | null;
  guessed_date: string;
  guessed_time: string | null;
  guessed_installment_months: number | null;
  guessed_loan_id: string | null; // 납부(payment)의 대출 자동매칭(설계 94 컬럼, 105 에서 자동기재).
  user_memo: string | null;
  reported_balance: number | null; // 메시지가 알려준 잔액(원). 장부 대조용. (설계 71)
  reported_balance_account_id: string | null; // 그 잔액이 속한 계좌 — 문자에 근거가 있을 때만(설계 129).
}

interface AccountNumberCandidate {
  account_no: string | null;
}

/** 문자에 보이는 계좌번호 조각과 유일하게 일치하는 등록 계좌를 고른다. */
export function pickAccountByNumber<T extends AccountNumberCandidate>(
  accounts: readonly T[],
  parsed: Pick<SmsParsed, "accountTail" | "accountPrefix" | "accountSuffix">
): T | null {
  const digits = (account: AccountNumberCandidate) => (account.account_no ?? "").replace(/\D/g, "");
  const uniqueHit = (list: T[]): T | null => (list.length === 1 ? list[0] : null);
  const prefix = parsed.accountPrefix;
  const suffix = parsed.accountSuffix;

  return (
    (parsed.accountTail ? uniqueHit(accounts.filter((account) => digits(account).slice(-4) === parsed.accountTail)) : null) ??
    (prefix
      ? uniqueHit(accounts.filter((account) => {
          const accountDigits = digits(account);
          // 같은 KB 지점의 두 계좌는 앞 6자리가 같을 수 있어, 카드 끝4 오인 구멍을 열지 않고 보이는 끝 3자리로 좁힌다. (설계 193)
          return accountDigits.startsWith(prefix) && (!suffix || accountDigits.endsWith(suffix));
        }))
      : null)
  );
}

/** 설계 194 지난 확정 조회 상한 — 이만큼 꽉 차 돌아오면 절단됐을 수 있어 유일성 판정을 포기한다. */
const REUSE_PRIOR_LIMIT = 500;

/** 거래일(일)과 등록 납부일이 월 순환 기준 ±5일 안인가. (설계 105, 주말 밀림·월말 순환 커버) */
function nearPayDay(day: number, payDay: number | null): boolean {
  if (payDay == null || !Number.isFinite(day)) return false;
  const diff = Math.abs(day - payDay);
  return Math.min(diff, 31 - diff) <= 5;
}

/**
 * 파싱 + DB 매칭(가맹점→카테고리·계좌·카드·자기계좌이체)으로 guessed_* 필드를 만든다.
 * SMS·알림 수집이 공유한다. (설계 docs/household/25·26·27·32, 알림=42)
 */
export async function enrichParsed(
  supabase: SupabaseClient,
  owner: string,
  text: string,
  sender: string | null
): Promise<{ parsed: SmsParsed; familyTransfer: boolean; fields: InboxGuess }> {
  const parsed = parseSms(text, sender);
  const date = parsed.occurredAt ?? seoulToday();
  const guessedType = kindToTxnType(parsed.kind);

  // 가맹점 → 이전 확정값(카테고리·결제수단·계좌) 재사용.
  let learnedMerchantRule: {
    merchant_key: string;
    category_id: string | null;
    payment_method_id: string | null;
    account_id: string | null;
  } | null = null;
  // 카드론 안내문(설계 181)은 상호가 카드사명(채널)이라 merchant_map 학습을 붙이지 않는다 —
  //   카드대금 결제로 학습된 카테고리·계좌가 실행금 수입에 붙으면 오분류다(교차리뷰 Medium).
  if (parsed.merchant && !parsed.loanTerms) {
    const { data: mm } = await supabase
      .from("hh_merchant_map")
      .select("merchant_key, category_id, payment_method_id, account_id")
      .eq("owner_auth_uid", owner);
    learnedMerchantRule = matchMerchantRule(parsed.merchant, mm ?? []);
  }
  let guessedCategoryId: string | null = learnedMerchantRule?.category_id ?? null;
  if (guessedType === "expense" && parsed.merchant) {
    // 매핑 안 됨 + 숫자+영문 코드성 가맹점(ATM출금·무통장송금 등) → 용돈으로 추정. (설계 docs/household/42)
    if (!guessedCategoryId && isNumericCodeMerchant(parsed.merchant)) {
      const { data: pocket } = await supabase
        .from("hh_category")
        .select("id")
        .eq("owner_auth_uid", owner)
        .eq("kind", "expense")
        .eq("name", CATEGORY_NAME.pocket)
        .maybeSingle();
      guessedCategoryId = pocket?.id ?? null;
    }
  }

  // 계좌 자동기재: 문자 속 계좌 끝4자리가 등록 계좌의 account_no 끝자리와 일치하면 그 계좌로. (설계 docs/household/25)
  let guessedAccountId: string | null = null;
  let matchedAccountName: string | null = null;
  if (parsed.accountTail || parsed.accountPrefix) {
    const { data: accts } = await supabase
      .from("hh_account")
      .select("id, account_no, person_id, name")
      .eq("owner_auth_uid", owner)
      .not("account_no", "is", null);
    // ① 끝4 일치 우선 ② 없으면 앞자리(prefix) startsWith 매칭(끝자리까지 마스킹된 카드용). (설계 docs/household/34)
    // ★교차리뷰 반영(2026-07-28): 예전엔 find() 로 **첫 일치**를 골랐다 — 끝자리가 겹치는 계좌가 둘 이상이면
    //   엉뚱한 계좌를 '문자가 지정한 계좌'로 확정해버리고, 그러면 체크카드 연결계좌 보정(설계 107)도
    //   덮어쓰지 못해 잘못된 계좌에서 차감된다. → **유일할 때만** 채운다(모호하면 빈칸, 설계 105 원칙).
    const hit = pickAccountByNumber(accts ?? [], parsed);
    guessedAccountId = hit?.id ?? null;
    matchedAccountName = hit?.name ?? null;
  }

  // 가족 구성원 간 이체 자동분류: 이동성 거래의 상대방에 등록 인물(가족) 누구의 이름이든
  // 포함되면 '이체'로. (설계 docs/household/48 — 27의 "같은 사람끼리만" 제한을 가족 전체로 확장)
  // 카드승인(approve)은 제외. 계좌 미매칭(토스 등)이어도 유형은 transfer로 둔다(from/to는 보스가 선택).
  // ⚠️ merchant 뿐 아니라 원문(text)도 검사: 앱 알림 서술형("송금 김하늘님이 보낸 …입금됐어요")은
  //    상호 추출이 흔들려 이름이 merchant에서 빠지므로, 원문까지 봐야 놓치지 않는다(수입 규칙과 동일 보정).
  //    자동이체(autopay)로 오는 가족 간 이체(토스 자동이체 등)도 포함한다.
  let selfTransfer = false;
  let selfTransferPersonName: string | null = null;
  let famMyAccountId: string | null = null; // 가족이체에서 '내 계좌' 쪽만 유추(유일할 때만 채움).
  let selfXferFromId: string | null = null; // 본인 증권→토스뱅크 자기이체의 출금계좌(증권).
  let selfXferToId: string | null = null; //   〃                       입금계좌(토스뱅크).
  // 방향: '보낸/입금/받' 표현이면 내가 받는 쪽(TO=입금), 아니면 보내는 쪽(FROM=출금).
  const famIncoming = parsed.kind === "deposit" || /보낸|입금|받았|이체받/.test(text);
  const isMovement =
    parsed.kind === "withdraw" || parsed.kind === "transfer" || parsed.kind === "deposit" || parsed.kind === "autopay";
  if (isMovement) {
    const { data: persons } = await supabase
      .from("hh_person")
      .select("id, name")
      .eq("owner_auth_uid", owner);
    const hitPerson = (persons ?? []).find(
      (p) => counterpartyHasName(parsed.merchant, p.name) || counterpartyHasName(text, p.name)
    );
    selfTransfer = hitPerson != null;
    selfTransferPersonName = hitPerson?.name ?? null;

    // 가족이체 계좌 부분 자동배정: 앱 알림엔 계좌번호가 없어 끝자리 매칭이 안 되므로,
    // 기관+사람으로 '내 계좌' 쪽만 유추한다(상대 계좌는 문장에 기관이 없어 대개 비움).
    // 기관이 일치하고 소유자가 상대방(counterparty)이 아닌 계좌가 '유일할 때만' 채운다(오배정 방지).
    if (selfTransfer && !guessedAccountId && parsed.institution && hitPerson) {
      const instToken = bankToken(parsed.institution);
      if (instToken) {
        const { data: allAccts } = await supabase
          .from("hh_account")
          .select("id, name, person_id")
          .eq("owner_auth_uid", owner);
        const cands = (allAccts ?? []).filter(
          (a) => (a.name ?? "").includes(instToken) && a.person_id && a.person_id !== hitPerson.id
        );
        if (cands.length === 1) famMyAccountId = cands[0].id;
      }
    }

    // 토스 자기이체(증권/저축 → 내 토스뱅크): "입금 <본인> → 내 토스뱅크 통장"은 보내는 쪽을
    // 본인 이름으로 표기해, 위 가족이체 로직(상대≠나)이 반대로 골라 배우자 토스뱅크로 오배정한다.
    // 지목된 사람이 '본인 소유의 토스뱅크+증권계좌'를 모두 가지면 본인의 증권→토스뱅크 자기이체로 본다.
    // (설계 docs/household/68 — 배우자 증권계좌는 비활성이라 이 규칙에 안 걸린다.)
    if (selfTransfer && hitPerson && famIncoming && /내\s*토스뱅크\s*통장/.test(text)) {
      const { data: pAccts } = await supabase
        .from("hh_account")
        .select("id, name")
        .eq("owner_auth_uid", owner)
        .eq("person_id", hitPerson.id)
        .eq("is_active", true);
      const tossBank = (pAccts ?? []).find((a) => (a.name ?? "").includes("토스뱅크"));
      const securities = (pAccts ?? []).find((a) => (a.name ?? "").includes("증권"));
      if (tossBank && securities) {
        selfXferToId = tossBank.id;
        selfXferFromId = securities.id;
      }
    }
  }

  // 이체 상대처 규칙(경기지역화폐 등 '충전 대상') — 파싱된 상대처(merchant)에만 매칭한다. (설계 docs/household/52)
  // ⚠️ 원문 전체가 아닌 merchant 에 매칭하는 이유: 경기지역화폐로 '결제'한 지출은 merchant 가 실제 가맹점(스타벅스 등)이라
  //    규칙 key 를 포함하지 않아 지출로 남고, '충전'만 상대처(코나아이(주)(경기지역화폐))가 잡혀 이체가 된다.
  // ★계좌(from/to) 해석은 여기서 하지 않는다 — 끝자리 매칭이 끝난 뒤로 미룬다(아래 '이체 규칙 계좌 해석').
  //   여기서 풀면 규칙에 하드코딩된 from 이 **문자가 지목한 계좌를 덮어쓴다**. (설계 docs/household/129)
  const transferRule = matchTransferRule(parsed.merchant);
  const ruleTransfer = transferRule != null;

  // 수입 상대처 규칙(토스포트 이자 등) — 상대처(merchant) 또는 원문에 key 포함 시 '수입'으로 분류. (설계 docs/household/53)
  // ⚠️ merchant 뿐 아니라 원문(text)도 보는 이유: 앱 알림 합본에서 상대처 추출이 흔들려도 놓치지 않기 위함.
  //    토스포트는 이자 입금 전용이라 지출로 오분류될 위험이 없다. 이체·자기이체보다 우선한다.
  let ruleIncomeCategoryId: string | null = null;
  let ruleIncomeAccountId: string | null = null;
  const incomeRule = matchIncomeRule(parsed.merchant) ?? matchIncomeRule(text);
  if (incomeRule) {
    const { data: cat } = await supabase
      .from("hh_category")
      .select("id")
      .eq("owner_auth_uid", owner)
      .eq("kind", "income")
      .eq("name", incomeRule.category)
      .maybeSingle();
    ruleIncomeCategoryId = cat?.id ?? null;
    const { data: acc } = await supabase
      .from("hh_account")
      .select("id")
      .eq("owner_auth_uid", owner)
      .ilike("name", `%${incomeRule.account}%`)
      .limit(1);
    ruleIncomeAccountId = acc?.[0]?.id ?? null;
  }
  const ruleIncome = incomeRule != null;

  // 카드 할부: 승인(approve) 문자에 2개월↑ 표기가 있으면 '할부'로. 수입·이체 규칙보다 낮은 우선순위. (설계 docs/household/54)
  const isInstallment = parsed.kind === "approve" && (parsed.installmentMonths ?? 0) >= 2;

  // 카드 월 대금·대출 원리금 납부 = 'payment'(잔액만 깎고 지출집계 제외 — 개별승인과 이중계산 방지). (설계 docs/household/70)
  let isPayment = isCardOrLoanPayment(text, parsed.kind);

  // ★보험료 CMS 되돌리기(설계 186, 팀장 지시 2026-08-22): 'CMS출' 판정(설계 70)은 대출·카드대금을
  //   노린 것인데 **보험사 CMS 출금도 같은 문구로 와서** 매달 payment 로 들어왔다 — payment 는 지출
  //   집계에서 빠지므로(calc.ts categorySpending 은 expense 만 센다) 보험료가 통계에서 사라진다.
  //   등록된 보험 정기지출(kind='insurance')과 금액 정확일치 + 납부일 ±5일(설계 105 와 같은 창)이면
  //   payment 를 되돌려 expense 로 흘린다. 그러면 아래 설계 105 블록이 카테고리(보험)·출금계좌를 채운다
  //   (같은 금액 정기지출이 유일할 때만 — 모호하면 타입만 expense 로 두고 빈칸, 설계 105 원칙).
  //   보험사명 하드코딩 목록은 두지 않는다 — 근거는 등록 데이터다(표기 흔들림·신규 보험사에 자동 대응).
  // 되돌리지 않는 경우(전부 "모호하면 현상 유지 payment 가 안전 방향" — 교차리뷰 2026-08-22 반영):
  //   ⓐ원문에 카드사명이 있으면 카드대금이다 — 카드 청구액이 보험료와 우연히 같으면 개별 승인과
  //     이중계상된다(설계 105 ① 이 대출 매칭을 건너뛰는 것과 같은 대칭 가드).
  //   ⓑ같은 금액·같은 창의 정기지출에 보험 아닌 것이 섞여 있으면(대출 고정비 등) 정체가 모호하다.
  //   ⓒ활성 대출 월납입액과 같은 금액이면 대출 원리금일 수 있다 — 대출 원장 오염 방지.
  //     실측(2026-08-22): 보험 정기지출 7건 금액 vs 활성 대출 16건 월납 충돌 0건.
  //   ⓓ조회가 실패하면 되돌리지 않는다(fail-closed) — 에러를 '충돌 없음'으로 읽으면 가드가 죽는다.
  if (isPayment && parsed.amount != null && !CARD_BILL_ISSUER_RE.test(text.replace(/\s+/g, ""))) {
    const { data: sameAmtScheds, error: schedErr } = await supabase
      .from("hh_scheduled_payment")
      .select("id, kind, pay_day")
      .eq("owner_auth_uid", owner)
      .eq("is_active", true)
      .eq("direction", "out")
      .eq("amount", parsed.amount);
    const day = Number(date.slice(8, 10));
    const hits = (sameAmtScheds ?? []).filter((s) => nearPayDay(day, s.pay_day));
    if (!schedErr && hits.length > 0 && hits.every((s) => s.kind === "insurance")) {
      const { data: loanClash, error: loanErr } = await supabase
        .from("hh_loan")
        .select("id")
        .eq("owner_auth_uid", owner)
        .eq("status", "active")
        .eq("monthly_payment", parsed.amount)
        .limit(1);
      if (!loanErr && (loanClash ?? []).length === 0) isPayment = false;
    }
  }

  // ③ 지난 확정 재사용(설계 194) — 설계 70 의 payment 키워드(카드사·캐피탈·CMS출·원리금)가 **없는** 출금 알림이라도,
  //    같은 상호를 지난 400일 안에 팀장이 '대출 납부(payment + loan_id)'로 확정한 적이 있고 그 확정이 한 활성 대출만
  //    가리키며 금액도 비슷하면 → payment 로 올리고 그 대출을 붙인다. 실사례: 토스 "요금납부 2,989원 출금 … → 현대약대이자"
  //    (약관대출 이자, 매달 2,700~2,989 로 흔들려 월납 3,000 정확일치도, 대출 이름 포함도 안 걸려 매달 손으로 고쳤다).
  //  ★조건은 loan-reuse.ts pickReusableLoan 한 곳(정확일치·유일·활성·±15%·기관종류어 제외). 부분일치는 금지.
  //  ★수입·이체·할부 규칙이 먼저 잡은 알림, 카드 승인(approve)·입금(deposit), 카드사명이 있는 원문(카드대금)에는 안 건다.
  //  ★조회 실패는 fail-closed — 승격도 연결도 하지 않는다.
  let reusedLoan: { id: string; account_id: string | null } | null = null;
  {
    const reuseMerchant = normalizeLoanPayee(parsed.merchant);
    const movementOut = parsed.kind === "withdraw" || parsed.kind === "autopay";
    if (
      !ruleIncome && !ruleTransfer && !selfTransfer && !isInstallment && movementOut &&
      parsed.amount != null && reuseMerchant.length >= 3 && !GENERIC_PAYEE.test(reuseMerchant) &&
      !CARD_BILL_ISSUER_RE.test(text.replace(/\s+/g, ""))
    ) {
      const [{ data: activeLoans, error: activeErr }, { data: priorPayments, error: priorError }] = await Promise.all([
        supabase.from("hh_loan").select("id, account_id").eq("owner_auth_uid", owner).eq("status", "active"),
        supabase
          .from("hh_transaction")
          .select("counterparty, amount, loan_id, txn_date")
          .eq("owner_auth_uid", owner)
          .eq("type", "payment")
          .not("loan_id", "is", null)
          .gte("txn_date", shiftIsoDate(date, -400))
          .lte("txn_date", date)
          .order("txn_date", { ascending: false })
          .limit(REUSE_PRIOR_LIMIT),
      ]);
      if (activeErr || priorError) {
        console.warn(`[hh-sms] 지난 확정 납부 조회 실패 — 대출 재사용을 포기한다: ${(activeErr ?? priorError)!.message}`);
      } else if ((priorPayments ?? []).length >= REUSE_PRIOR_LIMIT) {
        // 잘렸을 수 있으면 유일성 가드를 믿을 수 없다 — 모호로 보고 포기(배포 전 리뷰 Low).
        console.warn(`[hh-sms] 지난 확정 납부가 ${REUSE_PRIOR_LIMIT}건 이상 — 절단 가능성으로 대출 재사용을 포기한다`);
      } else {
        const reusableLoanId = pickReusableLoan({
          merchant: parsed.merchant,
          amount: parsed.amount,
          priorPayments: priorPayments ?? [],
          activeLoanIds: new Set((activeLoans ?? []).map((loan) => loan.id)),
          asOfDate: date,
        });
        if (reusableLoanId) {
          reusedLoan = { id: reusableLoanId, account_id: (activeLoans ?? []).find((loan) => loan.id === reusableLoanId)?.account_id ?? null };
          isPayment = true;
        }
      }
    }
  }

  const finalType = ruleIncome
    ? "income"
    : ruleTransfer || selfTransfer
      ? "transfer"
      : isPayment
        ? "payment"
        : isInstallment
          ? "installment"
          : guessedType;

  // 납부(payment) 자동분류(설계 105): 확정 화면에서 매달 손으로 고르던 대출·카드대금을 수집 시점에 채운다.
  // payment 는 merchant_map 학습 대상이 아니라(설계 94) 등록 데이터(대출·정기지출)로 매칭한다.
  // 모호(일치 2건 이상)하면 채우지 않는다 — 오분류보다 빈칸이 낫다.
  let guessedLoanId: string | null = null;
  let paymentCategoryId: string | null = null;
  let paymentFromAccountId: string | null = null;
  if (finalType === "payment" && parsed.amount != null) {
    // 원문의 카드사명을 먼저 본다: 카드사명이 있으면 카드대금이므로 대출 금액매칭을 건너뛴다
    // — 카드 청구액이 어느 대출 월납입액과 우연히 같을 때 대출 원장까지 오염되는 걸 막는다(교차리뷰 2026-07-28).
    const issuer = text.replace(/\s+/g, "").match(CARD_BILL_ISSUER_RE)?.[1] ?? null;
    // ① 대출: 진행중 대출의 월납입액과 정확히 일치(유일)하면 그 대출 + 등록된 출금계좌.
    //    확정 RPC(설계 94)가 loan_id 만으로 '대출상환' 카테고리를 정하므로 카테고리는 안 채운다.
    if (!issuer) {
      const { data: loans, error: loansError } = await supabase
        .from("hh_loan")
        .select("id, name, monthly_payment, account_id")
        .eq("owner_auth_uid", owner)
        .eq("status", "active");
      if (loansError) {
        console.warn(`[hh-sms] 활성 대출 조회 실패 — 납부 대출 자동연결을 포기한다: ${loansError.message}`);
      }
      const loanHits = (loans ?? []).filter((l) => Number(l.monthly_payment) === parsed.amount);
      if (loanHits.length === 1) {
        guessedLoanId = loanHits[0].id;
        paymentFromAccountId = loanHits[0].account_id ?? null;
      }
      // ★금액이 매달 조금씩 달라지는 대출이 있다 — 이자 변동분이다. (설계 160)
      //   실사례 2026-08-10: 하나저축은행 등록 월납 388,070 vs 실출금 388,748(차이 678원).
      //   금액 정확일치만 보면 매칭이 통째로 실패해 **카테고리·대출연결이 빈 채로** 들어온다.
      //   → 금액이 안 맞으면 **상호로** 한 번 더 본다. 대출 이름이 상호를 담고 있고 **유일**할 때만.
      //   ★상호는 이름이라 금액보다 특정적이다(금액 우연일치로 남의 대출 원장을 오염시키는 위험이 없다).
      //     그래도 모호(2건 이상)하면 채우지 않는다 — 오분류보다 빈칸(설계 105 원칙).
      //   ★★일반 조각은 배제한다 — 상호가 `저축은행` 뿐이면 지금은 그 문자열을 가진 활성 대출이
      //     하나뿐이라 "유일 매칭"이 되어 **엉뚱한 대출에 연결된다**(2026-08-10 자체 실측으로 발견).
      //     기관 종류를 가리키는 낱말만으로는 특정이 아니다. 상호가 기관종류어 하나로 끝나면 건너뛴다.
      if (!guessedLoanId && parsed.merchant) {
        // ★대출 이름 포함 검사는 종전 그대로 대소문자를 보존한다(소문자화하면 'KB…' 같은 이름을 못 찾는 회귀 — 설계 194 검토에서 잡음).
        const needle = parsed.merchant.replace(/\s+/g, "");
        //   ★★이름이 유일하다는 건 **문자열의 유일성**이지 거래 정체성의 유일성이 아니다(교차리뷰).
        //     그래서 **금액 근접성**을 함께 요구한다 — 이 폴백이 노리는 건 '이자 변동으로 몇백 원 어긋난'
        //     경우지 전혀 다른 금액이 아니다. 등록 월납 대비 ±5% 안일 때만 연결한다.
        //     (실사례 388,070 vs 388,748 = 0.17%.) 월납이 0/없으면 근거가 없으므로 연결하지 않는다.
        const CLOSE_RATIO = 0.05;
        if (!GENERIC_PAYEE.test(needle) && needle.length >= 3) {
          const nameHits = (loans ?? []).filter((l) => {
            if (!(l.name ?? "").replace(/\s+/g, "").includes(needle)) return false;
            const monthly = Number(l.monthly_payment);
            if (!Number.isFinite(monthly) || monthly <= 0) return false;
            return Math.abs(monthly - (parsed.amount as number)) / monthly <= CLOSE_RATIO;
          });
          if (nameHits.length === 1) {
            guessedLoanId = nameHits[0].id;
            paymentFromAccountId ??= nameHits[0].account_id ?? null;
          }
        }
      }

      // ③ 지난 확정 재사용(설계 194) — 위에서 판정한 reusedLoan. ①월납 정확일치·②이름 폴백이 먼저 붙였으면 그대로 두고,
      //    둘 다 비었을 때만 쓴다(정확일치가 더 강한 근거).
      //  ★근거 충돌은 빈칸: ③이 '대출 A 의 확정 이력'으로 payment 로 올렸는데 ①/②가 금액 우연일치로 **다른** 대출 B 를 붙였다면
      //    두 근거가 갈린 것이다 — 어느 쪽도 믿지 않는다(배포 전 리뷰 High. ③이 평범한 출금을 ① 금액 매처 앞으로 새로 밀어 넣기 때문).
      if (reusedLoan && guessedLoanId && guessedLoanId !== reusedLoan.id) {
        guessedLoanId = null;
        paymentFromAccountId = null;
      } else if (!guessedLoanId && reusedLoan) {
        guessedLoanId = reusedLoan.id;
        paymentFromAccountId ??= reusedLoan.account_id;
      }
    }
    // ② 카드대금: 원문에 카드사명(isCardOrLoanPayment 와 동일 목록)이 있으면 '카드대금'.
    //    출금계좌는 그 카드사의 정기지출(카드대금-…)이 유일하게 가리키는 계좌로. 같은 카드사가
    //    두 사람 명의로 있으면 문자의 기관 토큰(내 토스뱅크 통장 등)으로 계좌명을 좁힌다.
    if (issuer) {
      const { data: cardCat } = await supabase
        .from("hh_category")
        .select("id")
        .eq("owner_auth_uid", owner)
        .eq("kind", "expense")
        .eq("name", CATEGORY_NAME.cardBill)
        .maybeSingle();
      paymentCategoryId = cardCat?.id ?? null;
      const [{ data: scheds }, { data: schedAccts }] = await Promise.all([
        supabase
          .from("hh_scheduled_payment")
          .select("id, title, payee, account_id")
          .eq("owner_auth_uid", owner)
          .eq("is_active", true)
          .eq("direction", "out"),
        supabase.from("hh_account").select("id, name").eq("owner_auth_uid", owner),
      ]);
      let cands = (scheds ?? []).filter(
        (s) => `${s.title ?? ""} ${s.payee ?? ""}`.includes(issuer) && s.account_id
      );
      const instToken = bankToken(parsed.institution);
      if (cands.length > 1 && instToken) {
        cands = cands.filter((s) =>
          ((schedAccts ?? []).find((a) => a.id === s.account_id)?.name ?? "").includes(instToken)
        );
      }
      const candAccounts = Array.from(new Set(cands.map((s) => s.account_id)));
      if (candAccounts.length === 1) paymentFromAccountId = candAccounts[0];
    }
  }

  // 지출 정기지출 금액 매칭(설계 105): 첫 등장이라 merchant_map 학습이 없어도, 은행 출금/자동이체
  // (카드승인 제외)가 등록된 정기지출과 금액이 정확히 일치(유일)하면 그 카테고리·계좌를 재사용한다.
  // 교차리뷰 보정(2026-07-28): ① 라운드 금액(1만원 등)의 일회성 출금 오탐을 줄이려 납부일 ±5일
  // (주말 밀림 실측 25→27일 커버, 월말 순환 고려)까지 요구 ② 유일성은 금액일치 '전체'로 판정 —
  // 카테고리 없는 행도 같은 금액의 다른 고정비라는 모호성 신호이므로 세고 나서 채울 수 있는지 본다.
  let schedAccountId: string | null = null;
  if (
    finalType === "expense" &&
    !guessedCategoryId &&
    parsed.amount != null &&
    (parsed.kind === "withdraw" || parsed.kind === "autopay")
  ) {
    const { data: scheds } = await supabase
      .from("hh_scheduled_payment")
      .select("id, amount, category_id, account_id, pay_day")
      .eq("owner_auth_uid", owner)
      .eq("is_active", true)
      .eq("direction", "out")
      .eq("amount", parsed.amount);
    const day = Number(date.slice(8, 10));
    const hits = (scheds ?? []).filter((s) => nearPayDay(day, s.pay_day));
    if (hits.length === 1 && hits[0].category_id) {
      guessedCategoryId = hits[0].category_id;
      schedAccountId = hits[0].account_id ?? null;
    }
  }

  // 결제수단(카드) 자동기재: ① 카드 끝4자리가 등록 카드의 card_no 끝자리와 일치하면 그 카드로(설계 26).
  // ② 끝4가 없거나 못 맞추면, 카드앱(토스 등) 알림의 카드명으로 매칭(설계 51).
  // ③ 그것도 없으면 문자 카드사(기관명)와 발급사가 같은 **활성** 결제수단이 정확히 하나일 때 그 카드(설계 163).
  //    카드 결제 문자(approve·cancel)에만 적용한다 — 카드사발 자동결제(autopay) 통지는 payment 로
  //    재분류돼 결제수단을 안 쓰는데, 여기서 카드를 고르면 107 이 연결계좌까지 얹어 출금계좌가 오염된다.
  const msgCardIssuer =
    parsed.kind === "approve" || parsed.kind === "cancel" ? cardIssuerKey(parsed.institution) : null;
  let guessedPaymentMethodId: string | null = null;
  let matchedMethodName: string | null = null;
  if (parsed.cardLast4 || parsed.cardName || msgCardIssuer) {
    const { data: methods } = await supabase
      .from("hh_payment_method")
      .select("id, card_no, name, is_active")
      .eq("owner_auth_uid", owner);
    const all = methods ?? [];
    let hit = parsed.cardLast4
      ? all.find((m) => (m.card_no ?? "").replace(/\D/g, "").slice(-4) === parsed.cardLast4)
      : undefined;
    if (!hit && parsed.cardName) {
      const byName = matchCardNameToMethod(parsed.cardName, all);
      hit = byName ? all.find((m) => m.id === byName) : undefined;
    }
    // ★③은 끝4·카드명이 **아예 없을 때만** 발동한다(교차리뷰 R2). 끝4가 있는데 못 맞췄다 = 미등록
    //   카드(설계 117)인데, 여기서 같은 카드사의 다른 카드를 채우면 117 가드(unmatchedCardApproval)가
    //   pm 이 채워졌다는 이유로 꺼져 버려 **틀린 카드 + 연결계좌**로 확정된다. 카드명 실패도 같다 —
    //   문자가 특정 카드를 지목했으면 다른 카드를 추측하지 않는다(틀리게 채우느니 빈칸).
    if (!hit && !parsed.cardLast4 && !parsed.cardName && msgCardIssuer) {
      const issuerHits = all.filter((m) => m.is_active !== false && cardIssuerKey(m.name) === msgCardIssuer);
      if (issuerHits.length === 1) hit = issuerHits[0];
    }
    guessedPaymentMethodId = hit?.id ?? null;
    matchedMethodName = hit?.name ?? null;
  }

  // 계좌번호/카드번호가 없는 간편결제 알림의 보수적 폴백.
  if (!guessedPaymentMethodId && parsed.institution === "부천페이") {
    const { data: localMethods } = await supabase
      .from("hh_payment_method")
      .select("id, name")
      .eq("owner_auth_uid", owner)
      .eq("is_active", true)
      .ilike("name", "%부천페이%");
    if ((localMethods ?? []).length === 1) {
      guessedPaymentMethodId = localMethods![0].id;
      matchedMethodName = localMethods![0].name;
    }
  }
  // 페이스페이 결제는 토스뱅크 통장에서 바로 빠진다 → 출금계좌를 토스뱅크로 못 박는다.
  // ★알림 형식이 두 가지다(설계 154, 2026-08-06 실측):
  //   ⓐ 예전: `64,925원 결제 페이스페이 (토스뱅크) | 아구랑코다리`      — '페이스페이 (토스뱅크)'
  //   ⓑ 지금: `3,043원 결제 토스뱅크 | 비발디파크 오션월드 페이스페이 1,000원 할인`
  //           결제수단 자리에 '토스뱅크'만 오고 '페이스페이'는 상호 뒤 할인 문구에 붙는다.
  //   ⓑ 를 안 받아 주면 계좌가 안 붙어 그 지출이 토스뱅크 잔액에서 안 빠진다(실제로 3건 그랬다).
  const isFacePay =
    /페이스페이\s*[（(]\s*토스뱅크\s*[)）]/.test(text) ||
    (/페이스페이/.test(text) && /결제\s*토스뱅크/.test(text));
  if (!guessedAccountId && isFacePay) {
    // 페이스페이는 토스뱅크 계좌에서 빠진다 — 이름이 "토스뱅크"로 시작하는 활성 계좌가 **하나뿐일 때만** 붙인다
    // (둘 이상이면 어느 통장인지 문자로는 알 수 없으니 비워 둔다).
    const { data: tossAccounts } = await supabase
      .from("hh_account")
      .select("id, name")
      .eq("owner_auth_uid", owner)
      .eq("is_active", true)
      .ilike("name", "토스뱅크%");
    const faceAccount = tossAccounts?.length === 1 ? tossAccounts[0] : null;
    guessedAccountId = faceAccount?.id ?? null;
    matchedAccountName = faceAccount?.name ?? matchedAccountName;
  }

  // ── 선불 지갑(부천페이 등) 결제: 문자가 지갑을 **이름으로 지목하지 않는다** — 지갑이 소유자별로 둘이다.
  //   대신 '총 보유 잔액'을 준다. **결제 전 잔액 = 문자잔액 + 결제금액** 이고,
  //   그 값과 장부잔액이 **유일하게** 일치하는 지갑이 그 지갑이다. (설계 160)
  //   ★배경(2026-08-10): 지금까지 부천페이 결제에 계좌가 붙은 건 전부 merchant_map 학습 덕이었다.
  //     학습이 없으면 계좌가 비고(파리바게뜨 6,500), 학습이 다른 수단으로 덮이면 **틀린 계좌**가 붙는다
  //     (카페게이트 — 8/8 우리체크 결제가 학습돼 8/10 부천페이 결제에 우리은행이 붙었다).
  //   ★후보가 하나뿐일 때는 발동하지 않는다 — 기존 동작(학습값)을 건드리지 않기 위해서다.
  //   ★일치가 없거나 둘 이상이면 **빈칸으로 둔다**(설계 105: 모호하면 빈칸).
  //   ⚠️한계: 같은 지갑의 미확정 결제가 쌓여 있으면 장부잔액이 사슬의 머리와만 맞는다.
  //     앞엣것을 확정하면 장부가 따라 올라가 다음 건이 맞는다(순서대로 확정하면 자연히 풀린다).
  // ★교차리뷰 반영: 계좌를 **이름 접두사**로 고르면 선불 지갑이 아닌 은행·카드 승인까지 걸린다.
  //   선불 지갑은 결제수단 `kind='cash'` + `linked_account_id` 로 정확히 식별된다 —
  //   그쪽을 기준으로 삼으면 ⓐ선불에만 발동하고 ⓑ계좌와 결제수단이 **같은 지갑에서** 나온다.
  let walletAccountIds: string[] = [];
  let walletMethodIds: string[] = [];
  let walletMethods: { id: string; linked_account_id: string }[] = [];
  let walletQueryFailed = false;
  // 조회는 **할 일이 있을 때만** 한다 — ⓐ학습값이 있어 막을 게 있거나(설계 160 가드) ⓑ문자에 '총 보유 잔액'이
  //   실려 사슬을 이을 수 있을 때(설계 161). ★2026-08-10 보류 때는 ⓐ만 조건이라 **새 가맹점에는 사슬이 아예
  //   안 돌았다** — 설계의 핵심 가치를 스스로 무력화한 결함. 두 조건을 따로 둔다.
  const hasLearnedTarget = learnedMerchantRule?.account_id != null || learnedMerchantRule?.payment_method_id != null;
  // ★'총 보유 잔액'이 명시된 문자만 사슬 입력이다 — 일반 `잔액 N원`(은행 잔액)은 충전 문자에도 실려 오므로
  //   받으면 은행 잔액으로 지갑을 잇는 오염이 생긴다. **이번 문자에도** 같은 기준을 건다(보류 때 Major 3).
  const walletBalance = extractWalletBalance(text);
  const chainEligible = walletBalance != null && parsed.amount != null && parsed.amount > 0 && guessedAccountId == null;
  if (parsed.institution && parsed.kind === "approve" && (hasLearnedTarget || chainEligible)) {
    const { data: prepaid, error: prepaidError } = await supabase
      .from("hh_payment_method")
      .select("id, name, linked_account_id")
      .eq("owner_auth_uid", owner)
      .eq("kind", "cash")
      .eq("is_active", true)
      .not("linked_account_id", "is", null)
      .ilike("name", `${parsed.institution}%`);
    if (prepaidError) {
      console.warn(`[hh-sms] 선불 지갑 결제수단 조회 실패 — 지갑 판정과 학습 폴백을 포기한다: ${prepaidError.message}`);
      walletQueryFailed = true;
    } else {
      walletMethods = (prepaid ?? []).map((w) => ({ id: w.id as string, linked_account_id: w.linked_account_id as string }));
      walletAccountIds = walletMethods.map((w) => w.linked_account_id);
      walletMethodIds = walletMethods.map((w) => w.id);
    }
  }
  // ── 선불 지갑 자동배정 = **문자 잔액 사슬** (설계 161) ─────────────────────────────────────
  //   직전 문자 잔액 − 이번 결제금액 == 이번 문자 잔액 이면 같은 지갑이다 → 직전 건의 지갑을 물려받는다.
  //   장부잔액 앵커(설계 160, 뺐다)와 달리 수집함 원문끼리 비교하므로 **확정 순서·학습값과 무관**하다.
  //   ★지갑별로 직전 건을 따로 조회한다(전역 limit 은 한 지갑이 최근 행을 점유하면 다른 지갑의 직전 건을
  //     가린다 — 보류 때 Major 2). 창은 **거래일(guessed_date) 기준 45일**이고 이번 거래일 이후 행은 '직전'이
  //     아니다(보류 때 Major 1: 경계만 거래일로 재고 필터는 수집시각에 걸려 있었다).
  //   ★직전 건은 그 지갑에 **배정된** 행만이다(계좌 = 지갑계좌 또는 결제수단 = 그 지갑의 선불 수단). 빈칸으로
  //     남은 행은 앵커가 아니므로 사슬이 끊기면 빈칸이다 — 틀리게 채우느니 빈칸(설계 105).
  //   ★사슬이 성립하는 지갑이 **정확히 하나**일 때만 채택한다. 둘 이상(우연 일치)이면 빈칸.
  //   ★결제수단은 **그 계좌에 연결된 선불 수단**만 채운다 — 연결 수단이 둘이면 수단은 빈칸(보류 때 Major 4).
  //   ★충전 문자엔 지갑 잔액이 없어(은행 잔액만) 충전 직후 한 건은 구조적으로 못 잇는다 — 화면에서 지정.
  //   실사례 2026-08-18: 하삼동커피 부천페이 결제 — 학습이 08-16 우리체크로 덮여 빈칸으로 왔고, 사슬
  //   221,550(08-13) → 209,580 → 201,980 이 부천페이 지갑 하나를 유일하게 가리켰다.
  const WALLET_CHAIN_WINDOW_DAYS = 45;
  const distinctWalletAccountIds = [...new Set(walletAccountIds)];
  // ★지갑이 둘 이상이면 **사슬이 유일한 권위**다 — 사슬이 못 정하면 학습된 지갑값도 쓰지 않고 빈칸으로 둔다.
  //   (교차리뷰 2026-08-18 High) 학습값이 '상대 배우자 지갑'이면 설계 160 가드는 통과시키고, 그렇게 잘못
  //   붙은 행이 그 지갑의 앵커가 되어 **이후 결제가 연쇄로 상대 지갑에 붙는다**(내 잔액이 상대 지갑 사슬이 됨).
  //   161 이전엔 학습 오배정이 그 가맹점 1건에 갇혔는데, 사슬은 그걸 지갑 단위로 증폭시킨다 → 폴백 자체를 끊는다.
  //   지갑이 하나뿐이면 이름 폴백(설계 105)·학습값 그대로 — 틀릴 지갑이 없다.
  const walletChainAuthority = chainEligible && distinctWalletAccountIds.length >= 2;
  let walletChainPickedAccountId: string | null = null;
  let walletLabelPickedAccountId: string | null = null; // 설계 197 표기 채택 — 잔액 귀속은 하지 않는다(아래)
  if (!walletQueryFailed && chainEligible && distinctWalletAccountIds.length > 0) {
    const prevs: WalletChainPrev[] = [];
    const lower = shiftIsoDate(date, -WALLET_CHAIN_WINDOW_DAYS);
    let queryFailed = false;
    const anchorsByWallet: Record<string, string> = {};
    for (const walletAccountId of distinctWalletAccountIds) {
      // 그 지갑에 배정된 직전 행 = 계좌가 지갑계좌이거나 **결제수단이 그 지갑의 선불 수단**인 행.
      //   (실측 2026-08-18: 화면에서 결제수단만 고르고 확정한 행은 guessed_account_id 가 비어 있고
      //    수단만 지갑을 가리킨다 — 계좌만 보면 그 지갑의 사슬이 통째로 안 보인다.)
      //   휴지통(ignored)·중복(duplicate) 행은 앵커가 아니다. pending 은 앵커다 — 문자가 몰아서 오면 확정 전에
      //   이어져야 하고, 위 '사슬 유일 권위' 규칙 덕에 pending 의 지갑값도 사슬(또는 사람 손)에서만 나온다.
      //   ilike 는 느슨하게(`총%보유%잔액`) 걸고 최종 판정은 extractWalletBalance 한 곳에서 한다(두 기준이 어긋나면 앵커 누락).
      const methodIds = walletMethods.filter((w) => w.linked_account_id === walletAccountId).map((w) => w.id);
      const base = () =>
        supabase
          .from("hh_transaction_inbox")
          .select("id, raw_text, guessed_date, collected_at")
          .eq("owner_auth_uid", owner)
          .in("status", ["pending", "confirmed", "archived"])
          .ilike("raw_text", "%총%보유%잔액%")
          .gte("guessed_date", lower)
          .lte("guessed_date", date)
          .order("guessed_date", { ascending: false })
          .order("collected_at", { ascending: false })
          .limit(1);
      const [byAccount, byMethod] = await Promise.all([
        base().eq("guessed_account_id", walletAccountId).maybeSingle(),
        methodIds.length
          ? base().in("guessed_payment_method_id", methodIds).maybeSingle()
          : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
      ]);
      // ★조회 실패 = '앵커 없음'이 아니다 — 한 지갑이 조용히 빠지면 '모호→빈칸'이 '유일→오배정'으로 뒤집힌다(교차리뷰 M4).
      if (byAccount.error || byMethod.error) {
        console.warn(`[hh-sms] 지갑 사슬 앵커 조회 실패 — 사슬 판정을 포기한다: ${byAccount.error?.message ?? byMethod.error?.message}`);
        queryFailed = true;
        break;
      }
      const cands = [byAccount.data, byMethod.data].filter((r): r is NonNullable<typeof r> => r != null);
      cands.sort((x, y) =>
        String(y.guessed_date).localeCompare(String(x.guessed_date)) || String(y.collected_at).localeCompare(String(x.collected_at)),
      );
      const prev = cands[0] ?? null;
      // 직전 행의 잔액도 원문에서 '총 보유 잔액'으로 다시 뽑는다 — reported_balance 는 일반 '잔액' 정규식 값이다.
      const prevBalance = prev ? extractWalletBalance(prev.raw_text as string) : null;
      if (prev && prevBalance != null) {
        prevs.push({ walletAccountId, prevBalance });
        anchorsByWallet[walletAccountId] = `${prev.guessed_date}/${String(prev.id).slice(0, 8)}`;
      }
    }
    const hits = queryFailed ? [] : walletChainLinks({ amount: parsed.amount, balance: walletBalance }, prevs);
    if (hits.length === 1) {
      const walletAccountId = hits[0];
      const linked = walletMethods.filter((w) => w.linked_account_id === walletAccountId);
      guessedAccountId = walletAccountId;
      walletChainPickedAccountId = walletAccountId;
      // 계좌와 수단은 한 지갑 — 그 계좌에 연결된 선불 수단이 유일할 때만 채우고, 다른 지갑 수단이 들어와 있으면 비운다.
      if (linked.length === 1) guessedPaymentMethodId = linked[0].id;
      else if (guessedPaymentMethodId && !linked.some((w) => w.id === guessedPaymentMethodId)) guessedPaymentMethodId = null;
      // ★채택은 항상 기록한다 — 참 지갑에 앵커가 없고 다른 지갑이 우연히 산식을 만족하는 경우(원 단위라 드물지만 0 은 아니다)는
      //   코드로 못 막는다. 대신 어느 앵커에서 이어졌는지 남겨 잔액 대조표 드리프트가 뜰 때 되짚을 수 있게 한다.
      console.log(
        `[hh-sms] 지갑 사슬 채택(설계 161): 지갑 ${walletAccountId.slice(0, 8)} ← 앵커 ${anchorsByWallet[walletAccountId]} (후보 ${prevs.length}/${distinctWalletAccountIds.length} 지갑)`,
      );
    } else if (hits.length > 1) {
      console.warn(`[hh-sms] 지갑 잔액 사슬이 ${hits.length}개 지갑에 성립 — 모호해서 빈칸으로 둔다(설계 161)`);
    }
  }

  // ── 선불 지갑 자동배정 폴백 = **원문 표기 학습** (설계 197, 2026-09-01) ─────────────────────────
  //   사슬(161)은 **충전 직후 1건을 구조적으로 못 잇고**(충전 문자엔 지갑 잔액이 없다), 그 건이 빈칸이면 다음 건도
  //   앵커가 없어 또 빈칸이다 — 충전할 때마다 재발(실측 2026-09-01: 500,000 충전 직후 240,000·140,000 두 건 빈칸).
  //   원문엔 단서가 있다: '총 보유 잔액' 바로 앞의 카드 상품명 `부천페이(캐릭터)` vs `부천페이`(무표기).
  //   수집함 전량에서 캐릭터 → 한 지갑 38/38, 무표기 → 다른 지갑 5/5. 이 표기→지갑을 **사람이 확정한 이력**에서 배운다.
  //   ★사슬이 유일 지갑을 못 정했을 때만 발동한다 — 사슬은 잔액 산식이라 표기보다 강한 증거다(같은 상품 카드가 둘이 되면
  //     표기는 무력해지지만 사슬은 산다). 사슬이 정했으면 여기 오지 않는다.
  //   ★confirmed/archived 만 센다 — pending 의 지갑값을 세면 오배정이 앵커가 되어 증폭된다(161 교차리뷰의 그 논리).
  //   ★같은 표기가 3건 이상이고 지갑이 만장일치일 때만 채택 — 표기가 두 지갑에 걸리는 순간 조용히 빈칸으로 돌아간다(설계 105).
  //   ★merchant_map 학습값은 지갑이 둘일 때 여전히 쓰지 않는다(walletChainAuthority 불변).
  if (!walletQueryFailed && chainEligible && distinctWalletAccountIds.length >= 2 && walletChainPickedAccountId == null && guessedAccountId == null) {
    const walletLabel = extractWalletLabel(text, parsed.institution);
    if (walletLabel != null) {
      const { data: hist, error: histError } = await supabase
        .from("hh_transaction_inbox")
        .select("id, raw_text, guessed_account_id, guessed_payment_method_id")
        .eq("owner_auth_uid", owner)
        .in("status", ["confirmed", "archived"])
        .ilike("raw_text", "%총%보유%잔액%")
        .gte("guessed_date", shiftIsoDate(date, -365))
        .lte("guessed_date", date)
        .order("guessed_date", { ascending: false })
        .order("collected_at", { ascending: false })
        .limit(WALLET_LABEL_HISTORY_LIMIT);
      if (histError) {
        console.warn(`[hh-sms] 지갑 표기 학습 조회 실패 — 설계 197 폴백을 포기한다: ${histError.message}`);
      } else if ((hist ?? []).length >= WALLET_LABEL_HISTORY_LIMIT) {
        // 상한에 닿았으면 잘린 이력이다 — 반대 지갑 확정이 빠져 만장일치가 거짓일 수 있다 → 빈칸(교차리뷰 M1).
        console.warn(`[hh-sms] 지갑 표기 학습 이력이 상한(${WALLET_LABEL_HISTORY_LIMIT})에 닿아 잘렸다 — 설계 197 폴백을 포기한다`);
      } else {
        const history: WalletLabelHistoryRow[] = [];
        for (const r of hist ?? []) {
          const acctId = r.guessed_account_id as string | null;
          const methodId = r.guessed_payment_method_id as string | null;
          const walletAccountId = acctId && walletAccountIds.includes(acctId)
            ? acctId
            : (walletMethods.find((w) => w.id === methodId)?.linked_account_id ?? null);
          if (!walletAccountId) continue;
          const label = extractWalletLabel(r.raw_text as string, parsed.institution);
          if (label == null) continue;
          history.push({ label, walletAccountId });
        }
        const picked = walletLabelPick(walletLabel, history);
        if (picked) {
          const linked = walletMethods.filter((w) => w.linked_account_id === picked);
          guessedAccountId = picked;
          walletLabelPickedAccountId = picked;
          if (linked.length === 1) guessedPaymentMethodId = linked[0].id;
          else if (guessedPaymentMethodId && !linked.some((w) => w.id === guessedPaymentMethodId)) guessedPaymentMethodId = null;
          console.log(
            `[hh-sms] 지갑 표기 학습 채택(설계 197): 지갑 ${picked.slice(0, 8)} ← 표기 ${walletLabel} (확정 이력 ${history.filter((h) => h.label === walletLabel).length}건)`,
          );
        }
      }
    }
  }

  // 문자가 "카드 승인"이라고 명시했는데(끝4가 있는데) 등록 카드와 못 맞춘 경우 = **미등록 카드**다.
  // 이때 가맹점 학습값의 계좌를 대신 채우면 거짓이 된다 — 카드 결제는 은행계좌에서 즉시 나가지 않는다(설계 70).
  // 결제수단 폴백도 막는다: 문자는 특정 카드를 지목했으므로 다른 학습 카드를 채우면 틀린 카드로 확정되고,
  // 그게 체크카드면 아래 설계 107 자동연결이 걸려 은행계좌가 다시 붙는다(같은 결함의 우회로).
  // 실사례 2026-08-01: 삼성1234 승인이 카드 등록보다 1시간52분 먼저 수집돼 매칭에 실패했고,
  // 같은 가게를 7/19 이바다 국민 체크카드로 썼던 학습값이 붙어 국민은행(이바다) 출금으로 잡혔다.
  // 카테고리 학습값은 그대로 쓴다(가맹점→분류는 결제수단과 무관). (설계 117)
  const unmatchedCardApproval = parsed.cardLast4 != null && guessedPaymentMethodId == null;

  // 새 문자에서 계좌·카드를 특정하지 못한 경우, 이전 확정에서 학습한 값을 재사용한다.
  const accountFromMessage = guessedAccountId != null; // 끝자리 매칭 등 '문자가 말해 준' 계좌인지
  const methodFromMessage = guessedPaymentMethodId != null; // 끝4·카드명으로 '문자가 지목한' 카드인지 (설계 129)
  // 잔액 귀속 계좌(설계 71)는 **문자에 근거가 있을 때만** 채운다 — 학습값(merchant_map)으로 채우면
  // 남의 계좌에 잔액이 붙어 대조표에 유령이 상주한다(실사례: 우리은행 문자 1건이 토스뱅크로 붙어
  // −10,522,285원이 상시 노출, 2026-08-03 정정). (설계 129)
  let balanceAccountId: string | null = guessedAccountId;
  // ★표기(197)로 정한 지갑엔 잔액을 **귀속시키지 않는다** — 사슬은 잔액 산식이 스스로 검증하지만 표기는 통계 근거뿐이라,
  //   틀리면 남의 지갑 잔액이 대조표에 상주한다(설계 129 유령 잔액과 같은 유형, 배포 전 교차리뷰 M3). 계좌·수단만 채운다.
  if (walletLabelPickedAccountId) balanceAccountId = null;
  // 사슬(161)로 지갑을 정했으면 귀속 잔액은 '총 보유 잔액'이어야 한다 — 원문에 은행 `잔액` 이 따로 있어 parsed.balance 가
  //   다른 값이면 지갑에 은행 잔액이 귀속돼 대조표에 유령이 생긴다(교차리뷰 M6). 그땐 귀속을 비운다.
  if (walletChainPickedAccountId && parsed.balance !== walletBalance) balanceAccountId = null;
  // ★문자가 **선불 지갑 기관**을 지목했는데 학습값이 그 지갑이 아니면, 학습값을 쓰지 않는다. (설계 160)
  //   실사례 2026-08-10: `… 부천페이 추가형 인센티브 … 부천페이(캐릭터) 총 보유 잔액 …` 결제인데
  //   같은 가맹점을 8/8 에 우리체크로 쓴 학습값이 붙어 **엉뚱한 은행계좌 출금**으로 잡혔다.
  //   ⚠️주석에 실명(계좌 표시명의 소유자)을 적지 마라 — 교차리뷰 에이전트가 PII 로 보고 리뷰를
  //     통째로 중단한다(2026-08-09·08-10 실제로 세 번 중단됐다). 기관명까지만 적는다.
  //   같은 가게를 두 수단으로 쓰면 마지막 확정이 이전 학습을 덮는데, 원문이 수단을 말해 주는데도 학습이 이긴다.
  //   설계 117(미등록 카드 승인에 학습 계좌를 붙이지 않는다)과 같은 원칙 — **틀리게 채우느니 빈칸.**
  //   ★지갑을 특정하지 못했어도(위 잔액 앵커 실패) 최소한 **틀린 계좌는 막는다.**
  //   ★후보가 하나뿐이어도 발동한다 — 문자가 선불 지갑을 말했는데 학습값이 은행계좌면 그건 틀린 값이다.
  //     선불 결제수단이 등록된 기관에만 걸리므로(은행·카드 승인은 walletAccountIds 가 비어 안 걸린다)
  //     기존 학습 동작을 넓게 막지 않는다.
  //   ★★계좌만 보면 구멍이 남는다(교차리뷰): 같은 가맹점을 예전에 **신용카드**로 결제했으면 학습 행은
  //     `payment_method_id=신용카드 · account_id=null` 이라 계좌 조건이 걸리지 않고, 그 카드가 선불
  //     결제에 그대로 재사용된다. 계좌 오배정은 막아도 **결제수단 오배정이 남는다** → 수단도 함께 본다.
  const learnedWalletMismatch =
    walletAccountIds.length > 0 &&
    ((learnedMerchantRule?.account_id != null && !walletAccountIds.includes(learnedMerchantRule.account_id)) ||
      (learnedMerchantRule?.payment_method_id != null && !walletMethodIds.includes(learnedMerchantRule.payment_method_id)));
  // ★문자가 **카드사**를 지목했는데 ①~③에서 카드를 못 정했다면 학습 폴백(카드·파생 계좌)을 쓰지 않는다. (설계 163)
  //   같은 가맹점을 예전에 다른 카드로 결제했으면 merchant_map 의 그 카드가 재사용된다 — 문자가 카드사를
  //   말해 주는데도 학습이 이기면 틀린 카드로 확정되고, 그게 체크카드면 설계 107 이 은행계좌까지 얹는다
  //   (실사례 2026-08-11: 끝4 없는 카드 승인에 다른 카드사 학습 카드가 자동 선택돼 팀장이 수동 정정).
  //   설계 117(미등록 끝4)·설계 160(선불 지갑)과 같은 원칙 — **틀리게 채우느니 빈칸.** 카테고리 학습값은 유지.
  const cardIssuerClueUnresolved = msgCardIssuer != null && guessedPaymentMethodId == null;
  // ★선불 지갑이 둘 이상이고 문자에 지갑 잔액이 실렸으면(설계 161) 학습된 지갑값은 쓰지 않는다 — 사슬이 못 정했으면 빈칸.
  //   (교차리뷰 High: 학습이 상대 지갑이면 160 가드가 통과시키고, 그 행이 앵커가 되어 연쇄 오배정 · H2: 사슬이 계좌를
  //    정한 뒤 학습 수단 폴백이 다른 지갑 수단을 얹어 계좌≠수단.) 카테고리 학습값은 그대로 쓴다.
  // 납부(payment)의 출금계좌 우선순위(아래 finalFromId 주석)를 지키기 위해 '학습값으로 채웠는지'를 기억한다(설계 194).
  let accountFromLearnedRule = false;
  if (!unmatchedCardApproval && !learnedWalletMismatch && !cardIssuerClueUnresolved && !walletChainAuthority && !walletQueryFailed) {
    if (guessedAccountId == null && learnedMerchantRule?.account_id != null) accountFromLearnedRule = true;
    guessedAccountId ??= learnedMerchantRule?.account_id ?? null;
    guessedPaymentMethodId ??= learnedMerchantRule?.payment_method_id ?? null;
  }

  // 체크카드는 **카드에 연결된 계좌**에서 즉시 빠진다 — 그게 진실이다. 과거 오확정으로 학습된 계좌가
  // 재사용되면 엉뚱한 계좌 잔액이 줄고(실사례 2026-07-28: 우리체크 결제가 국민은행(이바다)에서 차감),
  // 확정 RPC 의 체크카드 자동연결(설계 77)은 '계좌가 빌 때만' 채우므로 이걸 바로잡지 못한다.
  // 문자에서 직접 특정한 계좌는 건드리지 않는다. 신용카드는 계좌 없음 유지(설계 70). (설계 107)
  if (!accountFromMessage && guessedPaymentMethodId) {
    const { data: pm } = await supabase
      .from("hh_payment_method")
      .select("kind, linked_account_id")
      .eq("id", guessedPaymentMethodId)
      .maybeSingle();
    // 선불(cash: 부천페이·지역화폐)도 즉시 출금이라 같은 규칙 — calc.ts:481 과 기준을 맞춘다. (교차리뷰)
    if ((pm?.kind === "check" || pm?.kind === "cash") && pm.linked_account_id) {
      guessedAccountId = pm.linked_account_id;
      accountFromLearnedRule = false; // 이제 학습값이 아니라 카드 연결계좌다(설계 194 출금계좌 우선순위가 이걸 학습값으로 오인하지 않게)
      // 체크·선불카드 문자의 '잔액'은 그 카드에 연결된 계좌의 잔액이다 — 단 **문자가 그 카드를 지목했을 때만**
      // 근거가 있다(학습값으로 고른 카드의 연결계좌는 문자가 말해 준 게 아니다). (설계 129)
      if (methodFromMessage) balanceAccountId = pm.linked_account_id;
    }
    // 신용·할부는 반대로 **계좌를 비워야** 한다 — 월 카드대금 payment 가 이미 그 계좌에서 빠지므로
    // 채우면 이중차감된다(설계 70). 107 은 check/cash 만 덮어써서, 같은 가맹점을 예전에 체크카드로 썼을 때
    // merchant_map 이 학습한 은행계좌가 신용카드 결제에 그대로 붙어 있었다.
    // 실사례 2026-07-31 하삼동커피부천옥 7,600원 — 삼성카드(이바다) 결제가 국민은행(이바다)에서도 출금. (설계 117)
    if (pm?.kind === "credit" || pm?.kind === "installment") guessedAccountId = null;
  }

  // ── 이체 규칙 계좌 해석(설계 52 규칙의 from/to → 실제 계좌) ─────────────────── (설계 docs/household/129)
  // ★끝자리 매칭이 끝난 **뒤에** 푼다. 규칙의 from 은 폴백일 뿐이고, 문자가 지목한 계좌가 이긴다.
  //   실사례 2026-08-03: 이바다이 국민은행(이바다)에서 경기지역화폐 300,000 을 충전했는데
  //   규칙의 from(토스뱅크(김하늘))이 문자가 지목한 계좌를 덮어써, 같은 날 김하늘의 같은 금액 충전과
  //   출금계좌·금액·날짜가 모두 같아지며 '중복'으로 걸러져 실거래 1건이 장부에서 통째로 빠졌다.
  // ★to 는 소유자별로 지갑이 갈린다(부천페이(김하늘)/부천페이(이바다)) — 이름 조각만으로는 못 고르므로
  //   **출금계좌의 주인**과 같은 지갑을 고른다. 예전 to("경기지역화폐")는 어느 계좌명과도 안 맞아 늘 null 이었고,
  //   확정 RPC 가 '이체는 입금계좌가 필요합니다'로 막아 충전 문자는 확정 자체가 불가능했다.
  let ruleFromAccountId: string | null = null;
  let ruleToAccountId: string | null = null;
  if (transferRule) {
    const { data: ruleAccts } = await supabase
      .from("hh_account")
      .select("id, name, person_id, is_active")
      .eq("owner_auth_uid", owner);
    // 해지 계좌는 후보에서 뺀다(유령 잔액의 원인). is_active 가 없는 행은 거르지 않는다.
    const cands = (ruleAccts ?? []).filter((a) => a.is_active !== false);
    const byName = (needle: string) => cands.filter((a) => (a.name ?? "").includes(needle));

    // from = ① 문자가 지목한 계좌 ② 규칙 이름으로 **유일하게** 걸리는 계좌(모호하면 빈칸 — 설계 105 원칙)
    const fromCands = byName(transferRule.from);
    if (fromCands.length !== 1) {
      console.warn(
        `[hh-sms] 이체규칙 출금계좌 '${transferRule.from}' 후보 ${fromCands.length}건 — 폴백 불가(계좌명 변경 확인)`
      );
    }
    ruleFromAccountId =
      (accountFromMessage ? guessedAccountId : null) ?? (fromCands.length === 1 ? fromCands[0].id : null);

    // to = 출금계좌 주인의 지갑. 주인을 모르면 후보가 하나일 때만 채운다.
    const toCands = byName(transferRule.to);
    const fromPerson = cands.find((a) => a.id === ruleFromAccountId)?.person_id ?? null;
    ruleToAccountId =
      (fromPerson ? (toCands.find((a) => a.person_id === fromPerson)?.id ?? null) : null) ??
      (toCands.length === 1 ? toCands[0].id : null);
    // ★못 찾으면 조용히 null 로 두지 않는다 — 이체 확정이 막히는데 화면엔 이유가 안 보인다.
    if (!ruleToAccountId) {
      console.warn(
        `[hh-sms] 이체규칙 입금계좌 '${transferRule.to}' 미해결(후보 ${toCands.length}건, 출금계좌 주인=${fromPerson ?? "미상"}) — 이 문자는 확정이 막힌다`
      );
    }
  }

  // 기관명: 문자에서 직접 추출한 값 우선, 없으면 끝자리로 매칭된 계좌·카드의 은행/카드사명으로 보완. (설계 docs/household/32)
  const stripOwnerSuffix = (name: string | null): string | null => {
    if (!name) return null;
    const base = name.split(/[(（-]/)[0].trim();
    return base || null;
  };
  const guessedInstitution =
    parsed.institution ?? stripOwnerSuffix(matchedAccountName) ?? stripOwnerSuffix(matchedMethodName);

  // 가족 간 이체는 서술형 알림에서 상호 추출이 깨져("이 내 KB 계좌로 됐어요") 보기 불편하므로,
  // 매칭된 가족 구성원 이름을 상대처로 깔끔히 표기한다. (그 외에는 파싱된 상호 그대로)
  const displayMerchant = selfTransfer && selfTransferPersonName ? selfTransferPersonName : parsed.merchant;

  // ★승인취소(설계 151): 확정 시 **삭제할 원 거래**를 수집 시점에 찾아 둔다.
  // 취소 문자는 kindToTxnType 이 expense 로 떨궈서, 그대로 확정하면 같은 금액 지출이 하나 더 생긴다
  // (2026-08-01 쿠팡 42,260원에서 실제로 걸렸다). 확정 RPC 가 '새 거래 생성'이 아니라 '원 거래 삭제'로
  // 갈라지려면 대상이 필요하다. **못 찾으면 null 로 둔다** — RPC 가 예외로 알리고 사람이 판단한다.
  // 엉뚱한 거래를 지우느니 멈추는 쪽이 낫다(설계 106 '빈칸이 오분류보다 낫다'의 삭제판).
  let cancelTargetTxnId: string | null = null;
  if (parsed.kind === "cancel" && parsed.amount != null) {
    const to = date ?? new Date().toISOString().slice(0, 10);
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - 60); // 취소는 보통 결제 직후지만 늦게 오는 것도 받는다
    let q = supabase
      .from("hh_transaction")
      .select("id, txn_date, counterparty")
      .eq("owner_auth_uid", owner)
      .eq("type", "expense")
      .eq("amount", parsed.amount)
      .gte("txn_date", fromDate.toISOString().slice(0, 10))
      .lte("txn_date", to);
    // 문자가 카드를 지목했으면 그 카드 것만 본다(같은 금액이 다른 카드에도 있을 수 있다).
    if (guessedPaymentMethodId) q = q.eq("payment_method_id", guessedPaymentMethodId);
    const { data: cands } = await q;
    let hits = (cands ?? []) as { id: string; txn_date: string; counterparty: string | null }[];
    // 상호로 좁힌다 — 취소 문자 상호엔 '[취소]'·카드 끝4 부스러기가 섞여 있어 그것부터 걷어낸다.
    const hint = String(parsed.merchant ?? "")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\d{3,}/g, " ")
      .replace(/취소/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // ★상호 대조는 **후보가 몇 개든 항상** 한다. (설계 154 — 151 의 실전 결함)
    //   예전엔 `hits.length > 1` 일 때만 대조해서, **카드 필터로 후보가 1개가 되면 상호를 안 보고**
    //   그대로 확정했다. 2026-08-06 실사례: 소노호텔앤 13,500원 취소가 60일 전 범위에서
    //   `2026-08-04 미도인 홍대 13,500원`(같은 우리체크)을 지목했다 — 확정했으면 **엉뚱한 거래가
    //   삭제**됐다. 취소는 삭제라 되돌리기 어려우니 근거 없는 매칭은 아예 만들지 않는다.
    //   (당일 원 거래가 아직 수집함에 pending 이면 hh_transaction 에 없어 후보군에 애초에 없다.)
    if (hint.length >= 2) {
      hits = hits.filter((h) => {
        const c = String(h.counterparty ?? "");
        return c.length >= 2 && (c.includes(hint) || hint.includes(c));
      });
    } else {
      hits = []; // 상호 힌트가 없으면 금액만으로는 못 고른다 — 사람이 지우게 둔다
    }
    // ★날짜로 한 번 더 좁힌다. (설계 154) 상호·금액이 같은 거래는 단골집에서 흔하다 —
    //   같은 상호·같은 금액의 **몇 주 전 거래**가 유일한 후보로 남으면 그걸 지우게 된다.
    //   취소는 대개 결제 당일이므로 ⓐ같은 날짜가 있으면 그것만 본다 ⓑ없으면 7일 이내만 인정한다.
    //   (60일 창은 '늦게 오는 취소 문자'를 받기 위한 것이지 60일 전 거래를 지우라는 뜻이 아니다.)
    const sameDay = hits.filter((h) => h.txn_date === date);
    if (sameDay.length) hits = sameDay;
    else {
      const DAY = 86400000;
      hits = hits.filter((h) => Math.abs(new Date(date).getTime() - new Date(h.txn_date).getTime()) <= 7 * DAY);
    }
    // ★유일할 때만 확정한다. 여럿이면 어느 것을 지울지 기계가 정할 근거가 없다.
    if (hits.length === 1) cancelTargetTxnId = hits[0].id;
  }

  // from/to 최종값. 아래 폴백 하나만 얹기 위해 지역변수로 뽑는다(예전엔 return 안에 인라인이었다).
  // ★납부(payment)의 출금계좌 순서 = ①문자 끝자리 매칭 계좌 → ②대출·정기지출에 등록된 계좌 → ③merchant_map 학습 계좌.
  //   예전엔 학습 계좌가 guessedAccountId 에 섞여 ②보다 먼저 이겼다 — 짧은 키 `이자`(→국민 이바다)가 `현대약대이자` 를 삼켜
  //   토스뱅크 약관대출 이자의 출금계좌를 국민은행으로 채웠다(설계 194 실원문 검증에서 발견). 학습값은 마지막 폴백으로만.
  const finalFromId =
    finalType === "payment"
      ? ((accountFromLearnedRule ? null : guessedAccountId) ?? paymentFromAccountId ?? guessedAccountId)
      : ruleTransfer
        ? ruleFromAccountId
        : selfXferFromId ?? (selfTransfer && !famIncoming ? (guessedAccountId ?? famMyAccountId) : null);
  const finalToId =
    finalType === "payment"
      ? null
      : ruleTransfer
        ? ruleToAccountId
        : selfXferToId ?? (selfTransfer && famIncoming ? (guessedAccountId ?? famMyAccountId) : null);

  // ★들어온 이체인데 **출금계좌를 문자가 안 알려줄 때** 상습 경로로 채운다. (설계 154, 팀장 지시 2026-08-06)
  //   은행 입금 SMS 는 보낸 사람 이름만 준다 — `우리 08/06 09:18 *120000 입금 200,000원 김하늘`.
  //   본인이 본인에게 보낸 것이라 상대처가 '김하늘'뿐이고, 어느 통장에서 나갔는지는 문자에 없다.
  //   실측(2026-08-06): 같은 형태 8건이 **전부** 토스뱅크(김하늘)→우리은행(김하늘) 였고 매번 손으로 채웠다.
  //   ★`from` 이 비어 있을 때만 얹는다 — 문자에 근거가 있으면 그쪽이 항상 이긴다(설계 129 의 결).
  //   ★`to` 까지 맞을 때만 발동한다 — 상대처 '김하늘'만 보고 걸면
  //     `563,770원 입금 김하늘 → 내 토스뱅크 통장`(출금=하나은행)까지 잘못 채운다.
  let fallbackFromId: string | null = null;
  if (finalType === "transfer" && !finalFromId && finalToId) {
    const rule = matchIncomingFromRule(parsed.merchant);
    if (rule) {
      const { data: pair } = await supabase
        .from("hh_account")
        .select("id, name")
        .eq("owner_auth_uid", owner)
        .eq("is_active", true)
        .in("name", [rule.toName, rule.fromName]);
      const toAcc = (pair ?? []).find((a) => a.name === rule.toName);
      const fromAcc = (pair ?? []).find((a) => a.name === rule.fromName);
      if (toAcc && fromAcc && toAcc.id === finalToId) fallbackFromId = fromAcc.id;
    }
  }

  return {
    parsed,
    familyTransfer: selfTransfer,
    fields: {
      guessed_kind: parsed.kind,
      cancel_target_txn_id: cancelTargetTxnId,
      guessed_type: finalType,
      guessed_amount: parsed.amount,
      guessed_merchant: displayMerchant,
      guessed_institution: guessedInstitution,
      guessed_loan_terms: parsed.loanTerms ? {
        rate: parsed.loanTerms.rate,
        term_months: parsed.loanTerms.termMonths,
        repayment_type: parsed.loanTerms.repaymentType,
        total_repayment: parsed.loanTerms.totalRepayment,
        maturity_date: parsed.loanTerms.maturityDate,
      } : null,
      // 이체는 카테고리·결제수단·단일계좌를 비우고 from/to 만 채운다. 납부(payment)는 설계 105:
      // 카드대금이면 카테고리, 대출이면 guessed_loan_id 를 채운다(확정 RPC 가 loan→'대출상환' 유도).
      // 수입 규칙(토스포트 등)이 걸리면 규칙의 카테고리·입금계좌를 채우고 결제수단은 비운다.
      guessed_category_id: finalType === "payment" ? paymentCategoryId : finalType === "transfer" ? null : ruleIncome ? ruleIncomeCategoryId : guessedCategoryId,
      // 할부는 카드 결제라 단일계좌(account) 대신 결제수단만 채운다. 납부(payment)는 from_account만 쓴다.
      guessed_account_id: finalType === "transfer" || finalType === "installment" || finalType === "payment" ? null : ruleIncome ? ruleIncomeAccountId : (guessedAccountId ?? schedAccountId),
      guessed_payment_method_id: finalType === "transfer" || finalType === "payment" || ruleIncome ? null : guessedPaymentMethodId,
      guessed_installment_months: finalType === "installment" ? parsed.installmentMonths : null,
      guessed_loan_id: finalType === "payment" ? guessedLoanId : null,
      // from/to: 상대처 규칙(경기지역화폐 등)이 있으면 규칙 계좌 우선, 없으면 self-transfer 의 끝자리 매칭 계좌.
      // 납부(payment)는 출금계좌만 = 끝자리 매칭 계좌 우선, 없으면 대출·정기지출에 등록된 계좌(설계 105).
      guessed_from_account_id: finalFromId ?? fallbackFromId,
      guessed_to_account_id: finalToId,
      guessed_date: date,
      guessed_time: parsed.occurredTime,
      // 사용내역 = 가맹점만(없으면 빈칸). 문자 원문은 raw_text에 보존. (설계 docs/household/25)
      user_memo: displayMerchant ?? null,
      // 잔액 대조(설계 71): 메시지의 '잔액'과 그 잔액이 속한 계좌.
      // ★귀속 계좌는 guessedAccountId 가 아니라 balanceAccountId 다 — 문자에 근거가 있는 계좌
      //   (끝자리·앞자리 매칭, 또는 문자가 지목한 체크·선불카드의 연결계좌)만 쓴다. 학습값(merchant_map)
      //   으로 채워진 계좌는 잔액의 주인이 아니다. (설계 129)
      // 타입 재분류(payment/transfer)로 guessed_account_id가 비워져도 잔액 귀속 계좌는 보존한다.
      reported_balance: parsed.balance,
      reported_balance_account_id: parsed.balance != null ? balanceAccountId : null,
    },
  };
}

/**
 * 미인식(trace-unknown)·배제(ignore-trace, 설계 196) 문자를 휴지통(ignored)에 흔적으로 남긴다. (설계 docs/household/56)
 * - trace-unknown: 거래인지 판단 못한 문자라 매칭(enrichParsed)은 하지 않고 원문·날짜만 보존. dedup 은 원문 앞 80자+날짜(하루 1건).
 * - ignore-trace: 파싱된 거래(금액·상호·종류)를 함께 싣고 `raw_meta.trace` 로 표식. dedup 은 **원문 전체 해시**+날짜 —
 *   앞 80자 키는 영수증 머리말이 전부 같아 같은 날 두 번째부터 소실됐고(교차리뷰 H1), 금액·상호·시각 키도 시각 없는
 *   형식(KG모빌리언스)에선 서로 다른 두 결제가 같은 키가 됐다(재검증 High). 재전송(같은 원문)만 억제된다.
 * 실거래 오판이면 보스가 휴지통에서 복원(→pending)해 확정한다(취소 문자는 원 거래가 없어 확정 불가 — 설계 196 주의).
 * SMS·알림 수집이 공유한다.
 */
export async function insertTraceUnknown(
  supabase: SupabaseClient,
  owner: string,
  opts: {
    source: "sms" | "notification";
    sourceAdapter: string | null;
    rawText: string;
    date: string;
    time: string | null;
    rawMeta?: Record<string, unknown> | null;
    /** ignore-trace(설계 196): 파싱된 거래라 금액·상호·종류를 실어 휴지통에서 알아볼 수 있게 한다(교차리뷰 H2).
     *  trace-unknown 은 넘기지 않는다(미인식이라 값이 없다). */
    parsed?: { kind: SmsKind; amount: number | null; merchant: string | null } | null;
    /** 카드대금 사후 안내(설계 205-B)만 payment. 생략하면 기존 호출부와 같은 expense. */
    guessedType?: "payment" | "expense";
  }
): Promise<{ id?: string; duplicate?: boolean; failed?: true; error?: string }> {
  const p = opts.parsed ?? null;
  const dedupHash = p
    ? `trace|${opts.date}|${hashIngestToken(opts.rawText.replace(/\s+/g, " ")).slice(0, 32)}`
    : skipDedupKey(opts.rawText, opts.date);
  const row: Record<string, unknown> = {
    owner_auth_uid: owner,
    source: opts.source,
    source_adapter: opts.sourceAdapter,
    raw_text: opts.rawText,
    status: "ignored",
    guessed_kind: p?.kind ?? "unknown",
    guessed_type: opts.guessedType ?? "expense",
    guessed_date: opts.date,
    guessed_time: opts.time,
    guessed_amount: p?.amount ?? null,
    guessed_merchant: p?.merchant ?? null,
    dedup_hash: dedupHash,
  };
  // 휴지통 화면의 '자동 걸러짐' 배지는 kind=unknown 으로 판정했다 — 배제 행은 진짜 kind 를 실으므로 표식을 따로 남긴다(재검증 L5).
  //   (purge-raw 가 30일 뒤 raw_meta 를 비우면 배지는 사라진다 — 행 자체는 남는다.)
  if (opts.rawMeta || p) row.raw_meta = { ...(opts.rawMeta ?? {}), ...(p ? { trace: "ignore-trace" } : {}) };

  const { data, error } = await supabase
    .from("hh_transaction_inbox")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      console.warn(`[hh-trace] 휴지통 적재 생략(같은 키 이미 있음): ${dedupHash}`);
      return { duplicate: true };
    }
    // ★삼키지 않는다. (설계 199)
    //   전에는 `return {}` 이라 두 호출부가 성공으로 보고 **HTTP 201 `traced:true`** 를 돌려줬다 —
    //   휴지통 행이 안 만들어졌는데 폰은 성공을 받는다. 돈이 오간 문자가 흔적 없이 사라지는 경로다.
    //   실패를 위로 올려 호출부가 5xx 로 답하게 한다(폰이 재시도할 여지를 남긴다 — 재시도해도
    //   dedup_hash UNIQUE 가 이중 적재를 막는다).
    console.error("[hh-trace] insert failed:", error.message);
    return { failed: true, error: error.message };
  }
  return { id: data.id as string };
}

/** dedup 후보 행에서 이체 계좌 비교에 쓰는 최소 필드. */
type DedupCandidate = {
  guessed_type?: string | null;
  guessed_from_account_id?: string | null;
  guessed_to_account_id?: string | null;
};
/** 들어오는 이체의 끝점 계좌. */
export type TransferEndpoints = { fromAccountId: string | null; toAccountId: string | null };

/**
 * 같은 날·같은 금액의 후보가 들어온 이체와 '서로 다른 이체'로 확신되는가. (설계 63 보강 2026-07-19)
 * 같은 이체의 두 다리(출금 SMS + 입금 알림)는 목적지(to) 또는 출발(from) 계좌를 공유한다 → 같은 이체(false).
 * 두 계좌가 모두 알려져 있고 어느 끝점도 안 겹치면 다른 이체(true) → dedup에서 제외.
 * 후보가 이체가 아니면(카드결제 등) 이체와 같은 거래일 수 없으므로 '다른 것'(true)으로 본다.
 * 끝점을 비교할 수 없으면(한쪽 계좌 미상) 확신 못 하므로 false(=중복 후보로 남김, 보수적).
 */
function isConfidentlyDifferentTransfer(inc: TransferEndpoints, cand: DedupCandidate): boolean {
  if (cand.guessed_type !== "transfer") return true;
  const shareTo = Boolean(inc.toAccountId && cand.guessed_to_account_id && inc.toAccountId === cand.guessed_to_account_id);
  const shareFrom = Boolean(inc.fromAccountId && cand.guessed_from_account_id && inc.fromAccountId === cand.guessed_from_account_id);
  if (shareTo || shareFrom) return false; // 끝점 공유 = 같은 이체의 다른 다리
  const toComparable = Boolean(inc.toAccountId && cand.guessed_to_account_id);   // 둘 다 목적지 알고 있고(위에서 다름)
  const fromComparable = Boolean(inc.fromAccountId && cand.guessed_from_account_id);
  return toComparable || fromComparable; // 알려진 끝점이 서로 다름 = 다른 이체
}

/**
 * 동일시각 이중수집 판정: 같은 소유자의 **날짜 + 거래시각(HH:MM) + 금액**이 같은 수집 건이
 * 이미 검토대기/확정/보관에 있는가. (설계 163)
 * 같은 결제 한 건이 카드 승인 문자와 은행 출금 문자로 **둘 다** 들어오면 dedup_hash 는 원문 형식이
 * 달라 안 걸리고, 소스까지 같으면(둘 다 SMS) 크로스소스 판정(설계 63)도 통과해 검토대기 2건이 된다.
 * 네 값이 모두 있을 때만 판정한다 — 시각이나 금액이 없는 행은 기존 중복 규칙만 탄다.
 * 뒤에 온 행은 삭제가 아니라 휴지통(ignored)으로 보존한다(오탐이면 복원). 같은 분에 같은 금액의
 * **정당한 별도 결제**도 둘째가 휴지통으로 간다 — 팀장이 요청한 규칙의 직접적 결과다(2026-08-11).
 * ★승인취소(cancel)는 양방향으로 제외한다(교차리뷰) — 취소 문자는 **원 승인과 같은 거래일·시각·금액**을
 *   담고 오므로, 걸러 버리면 취소가 휴지통으로 가 설계 151 의 원거래 삭제 흐름이 통째로 죽는다.
 *   반대로 취소 행이 형제로 잡혀 새 승인이 걸러지는 것도 막는다(.neq). 인덱스 술어도 동일하게 제외.
 * ⚠️조회→삽입 사이의 동시 요청 경쟁은 이 함수로 못 막는다 — pending 한정 부분 고유 인덱스
 * (hh_inbox_same_time_pending_uq)가 DB 에서 막고, 걸리면 핸들러가 ignored 로 재삽입한다.
 * ⚠️조회가 실패하면 false 로 두고 로그만 남긴다(던지면 수집 자체가 죽어 원문을 잃는다).
 *   이때 형제가 pending 이면 인덱스가 그래도 막지만, **confirmed/archived 형제는 인덱스 밖이라
 *   중복 pending 이 하나 생길 수 있다** — 설계 163 이전과 같은 모습으로 화면에 드러나는 강등이지,
 *   조용한 데이터 파손은 아니다.
 */
export async function hasSameTimeSibling(
  supabase: SupabaseClient,
  owner: string,
  kind: string | null,
  date: string | null,
  time: string | null,
  amount: number | null
): Promise<boolean> {
  if (kind === "cancel") return false;
  if (!date || !time || amount == null) return false;
  const { data, error } = await supabase
    .from("hh_transaction_inbox")
    .select("id")
    .eq("owner_auth_uid", owner)
    .eq("guessed_date", date)
    .eq("guessed_time", time)
    .eq("guessed_amount", amount)
    // ★neq 는 SQL <> 라 kind 가 NULL 인 옛 행을 형제에서 빼 버린다 — 인덱스 술어(is distinct from)와
    //   기준이 어긋나므로 or 로 NULL 을 포함한다(교차리뷰 R2). cancel 만 빼는 게 의도다.
    .or("guessed_kind.is.null,guessed_kind.neq.cancel")
    .in("status", ["pending", "confirmed", "archived"])
    .limit(1);
  if (error) console.error("[hh-inbox] same-time dedup 조회 실패:", error.message);
  return (data ?? []).length > 0;
}

/**
 * 같은 날·같은 금액·지출 방향의 수집 건(소스 무관)이 이미 검토대기/확정/보관에 있는가. (설계 165)
 * **캐시백 결합 알림 전용 가드** — 같은 결제가 결제 알림과 캐시백 결합 알림으로 두 번 오면
 * 상호가 서로 달라 dedup_hash·크로스소스(다른 소스만 봄)·동일시각(시각 없음) 어디에도 안 걸린다
 * (08-07 카카오T주차 실사례). 발동 조건을 결합 알림으로 좁혀 오탐 반경을 줄인다.
 * cancel 제외는 163 과 같은 이유. 조회 실패는 false + 로그(수집이 죽으면 원문을 잃는다).
 */
export async function hasSameDayAmountSibling(
  supabase: SupabaseClient,
  owner: string,
  date: string | null,
  amount: number | null
): Promise<boolean> {
  if (!date || amount == null) return false;
  const { data, error } = await supabase
    .from("hh_transaction_inbox")
    .select("id")
    .eq("owner_auth_uid", owner)
    .eq("guessed_date", date)
    .eq("guessed_amount", amount)
    .in("guessed_type", ["expense", "installment", "payment"])
    .or("guessed_kind.is.null,guessed_kind.neq.cancel")
    .in("status", ["pending", "confirmed", "archived"])
    .limit(1);
  if (error) console.error("[hh-inbox] same-day-amount dedup 조회 실패:", error.message);
  return (data ?? []).length > 0;
}

/**
 * 수집함 삽입 + 동일시각 인덱스 충돌 시 휴지통(ignored) 재삽입. (설계 163)
 * 사전조회(hasSameTimeSibling)가 못 본 동시 요청 경쟁이 인덱스(23505)로 드러나면,
 * 같은 행을 status='ignored' 로 다시 넣는다(삭제가 아니라 보존). SMS·알림 핸들러가 공유한다.
 * 반환: trashedByRace=true 면 경쟁으로 휴지통에 들어간 것. error 가 남으면 호출자가 기존
 * 23505(dedup)/500 분기를 그대로 탄다.
 */
export async function insertInboxWithSameTimeRetry(
  supabase: SupabaseClient,
  row: Record<string, unknown>
): Promise<{ id: string | null; createdAt: string | null; error: { code?: string; message: string } | null; trashedByRace: boolean }> {
  // created_at 도 받아 온다 — 사후 스윕의 승자 판정에 쓴다(설계 200).
  let { data, error } = await supabase.from("hh_transaction_inbox").insert(row).select("id, created_at").single();
  if (error && isSameTimeIndexViolation(error)) {
    ({ data, error } = await supabase
      .from("hh_transaction_inbox")
      .insert({ ...row, status: "ignored" })
      .select("id, created_at")
      .single());
    if (!error && data) return { id: data.id as string, createdAt: (data.created_at as string) ?? null, error: null, trashedByRace: true };
  }
  return { id: (data?.id as string) ?? null, createdAt: (data?.created_at as string) ?? null, error, trashedByRace: false };
}

/** 동일시각 인덱스 충돌(23505)인지 — 메시지의 제약 이름으로 가른다(기존 dedup_hash 충돌과 구분). */
export function isSameTimeIndexViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "23505" && String(error.message ?? "").includes("hh_inbox_same_time_pending_uq");
}

/**
 * 크로스소스 이중수집 판정. (설계 docs/household/63)
 * 같은 거래가 SMS(카드사)와 앱 알림(토스 등)으로 각각 들어오면, dedup_hash 포맷이 소스마다 달라
 * (SMS=파싱키, 알림=title|text|분) UNIQUE 제약으로는 안 잡힌다. merchant 도 소스마다 달라(위택스↔지자체세입금)
 * 파싱키 통일로도 못 잡는다. 그래서 기본은 **금액+날짜**만으로(merchant 무관) 다른 소스가 이미 수집한
 * pending/confirmed 항목이 있는지 확인한다. 있으면 이번 항목은 이중수집일 확률이 높아 status='duplicate'로
 * 표시(삭제 아님 → 팀장님이 수집함에서 검토·복원 가능). 금액이 없으면 판정하지 않는다(오탐 방지).
 * ★보강(2026-07-19): 같은 날 같은 금액의 '서로 다른 이체' 2건(예: 국민→토스 / 토스→우리)이 오판되던 문제로,
 *   들어온 게 이체이고 끝점 계좌를 알면 계좌가 겹치지 않는 다른 이체 후보는 중복에서 제외한다.
 */
export async function isCrossSourceDuplicate(
  supabase: SupabaseClient,
  owner: string,
  source: string,
  date: string,
  amount: number | null,
  incoming?: TransferEndpoints & { type: string; merchant?: string | null; accountId?: string | null }
): Promise<boolean> {
  return (await findCrossSourceDuplicateCandidates(supabase, owner, source, date, amount, incoming)).length > 0;
}

/**
 * 위 판정의 몸통 — 걸러진 '같은 거래로 보이는 다른 소스 항목'들을 그대로 돌려준다. (설계 200)
 * 사전조회(isCrossSourceDuplicate)와 사후 스윕(sweepCrossSourceDuplicateAfterInsert)이 **같은 함수**를
 * 쓰게 하려고 꺼냈다 — 판정을 두 벌로 갈라 두면 조용히 어긋난다.
 */
async function findCrossSourceDuplicateCandidates(
  supabase: SupabaseClient,
  owner: string,
  source: string,
  date: string,
  amount: number | null,
  incoming?: TransferEndpoints & { type: string; merchant?: string | null; accountId?: string | null }
): Promise<CrossSourceCandidate[]> {
  if (amount == null) return [];
  const { data, error } = await supabase
    .from("hh_transaction_inbox")
    .select("id, source, status, created_at, guessed_type, guessed_merchant, guessed_account_id, guessed_from_account_id, guessed_to_account_id")
    .eq("owner_auth_uid", owner)
    .eq("guessed_date", date)
    .eq("guessed_amount", amount)
    .neq("source", source)
    .in("status", ["pending", "confirmed"]);
  // 조회가 실패하면 **후보 없음**으로 간다 — 조용히 삼키는 게 아니라 의도한 fail-safe 다.
  // 여기서 "중복"으로 기울면 실거래가 수집함에서 사라지고, "후보 없음"이면 pending 으로 남아 사람이 본다.
  // (설계 199 의 교훈: 삼키더라도 로그는 반드시 남긴다.)
  if (error) console.error("[hh-dedup] 크로스소스 후보 조회 실패 — 중복 판정을 포기한다:", error.message);
  let cands = (data ?? []) as CrossSourceCandidate[];
  // 방향이 반대면 같은 거래일 수 없다(출금 100,000 vs 입금 100,000). (설계 107)
  // ★교차리뷰 반영(2026-07-28): 처음엔 유형 '완전일치'를 요구했는데, 그러면 **같은 실거래가 소스마다
  //   다른 유형으로 파싱되는 경우**(카드사 SMS 는 할부 개월수가 찍혀 installment, 앱 알림은 expense)
  //   크로스소스 dedup 이 아예 안 걸려 설계 63 의 원래 기능이 회귀한다.
  //   → 나가는 돈 계열(expense·installment·payment)은 **서로 같은 것으로 본다.**
  if (incoming?.type) cands = cands.filter((c) => !c.guessed_type || sameDirectionClass(c.guessed_type, incoming.type));
  // 수기입력(manual)은 SMS↔알림 이중수집 경로가 아니다 — 금액·날짜만 같다고 실거래를 삼키면 안 된다.
  // "안 잡혀서 손으로 넣었는데 뒤늦게 문자가 온" 경우만 잡도록 상호 포함관계나 계좌 일치를 요구한다. (설계 107)
  // 실사례 2026-07-28: 수기 '한별 용돈' 100,000원이 우리은행 출금 100,000원(0000000000000)을 삼켰다.
  cands = cands.filter((c) => c.source !== "manual" || isSameAsManualEntry(incoming, c));
  if (cands.length === 0) return [];
  // 이체 + 끝점 계좌를 알면 '다른 이체'(계좌 안 겹침) 후보는 제외. 그 외(비이체·계좌미상)는 기존 금액+날짜 판정.
  if (incoming?.type === "transfer" && (incoming.fromAccountId || incoming.toAccountId)) {
    return cands.filter((c) => !isConfidentlyDifferentTransfer(incoming, c));
  }
  return cands;
}

type CrossSourceCandidate = {
  id: string;
  source: string;
  status: string;
  created_at: string | null;
  guessed_type?: string | null;
  guessed_merchant?: string | null;
  guessed_account_id?: string | null;
  guessed_from_account_id?: string | null;
  guessed_to_account_id?: string | null;
};

/**
 * 크로스소스 이중수집 **사후 스윕**. (설계 200)
 *
 * 사전조회(isCrossSourceDuplicate)는 **자기 insert 전에** 돌기 때문에, 같은 결제의 문자와 앱알림이
 * 수십 ms 차로 들어오면 서로의 행이 아직 커밋 전이라 둘 다 "중복 아님"이 된다
 * (2026-09-03 실사례: 어서와 25,000 이 63ms 차로 pending 2건). 그래서 **자기 행이 커밋된 뒤**
 * 같은 판정을 한 번 더 돌린다 — 그때는 상대도 반드시 커밋돼 있다.
 *
 * ★스위퍼는 "자기"가 아니라 **짝의 패자**를 내린다. "보면 내가 내려간다"로 하면 둘 다 스윕할 때
 *   서로를 내려 **2건 모두 소실**하고, "created_at 이 늦은 쪽이 자기를 내린다"로 하면 `now()` 가
 *   트랜잭션 **시작** 시각이라 커밋 순서와 어긋나 **둘 다 살아남는다**. 무리에서 승자를 정하고
 *   나머지 pending 을 내리면 누가 스윕하든 답이 같고(결정적) 두 번 돌아도 같다(멱등).
 *
 * 승자: ①confirmed 가 하나면 그것 ②confirmed 가 둘 이상이면 **아무것도 안 한다**(사람이 볼 일)
 *       ③아니면 created_at 이 이른 쪽, 같으면 id 가 작은 쪽(사전조회의 "먼저 온 쪽이 남는다"와 동일).
 * 패자 UPDATE 에는 `status='pending'` 조건을 달아 확정·휴지통 행을 절대 덮지 않는다.
 */
/**
 * 위 스윕의 **호출 게이트**. (설계 200 — 배포 전 리뷰 M1)
 *
 * ★이 조건은 두 라우트가 똑같이 써야 하는데, 처음엔 주석까지 통째로 **양쪽에 복사**돼 있었다.
 *   전역 규칙("한 사실은 한 파일에만 둔다 — 사본은 조용히 어긋난다")에 걸릴 뿐 아니라,
 *   **가장 위험한 한 줄**이 사본 두 벌인데 지키는 장치가 사람 눈뿐이었다.
 *   한쪽에서 `trashedByRace` 를 떨어뜨리면 **휴지통에 재삽입된 행이 멀쩡한 상대를 내려**
 *   그 거래가 수집함에서 통째로 사라진다.
 *
 * `trashedByRace` 를 반드시 본다 — 동일시각 충돌로 휴지통(ignored)에 재삽입된 경우
 * `insertedStatus`(= 넣으려던 row.status)는 여전히 "pending" 이라 그것만 보면 안 된다.
 */
export async function sweepAfterInsertIfPending(
  supabase: SupabaseClient,
  owner: string,
  inserted: { id: string | null; createdAt: string | null; source: string; trashedByRace: boolean; insertedStatus: unknown },
  date: string,
  amount: number | null,
  incoming?: TransferEndpoints & { type: string; merchant?: string | null; accountId?: string | null }
): Promise<{ demotedSelf: boolean; demoted: string[] } | null> {
  if (!inserted.id || inserted.trashedByRace || inserted.insertedStatus !== "pending") return null;
  return sweepCrossSourceDuplicateAfterInsert(
    supabase,
    owner,
    { id: inserted.id, source: inserted.source, createdAt: inserted.createdAt },
    date,
    amount,
    incoming
  );
}

export async function sweepCrossSourceDuplicateAfterInsert(
  supabase: SupabaseClient,
  owner: string,
  self: { id: string; source: string; createdAt: string | null },
  date: string,
  amount: number | null,
  incoming?: TransferEndpoints & { type: string; merchant?: string | null; accountId?: string | null }
): Promise<{ demotedSelf: boolean; demoted: string[] }> {
  const none = { demotedSelf: false, demoted: [] as string[] };
  if (amount == null) return none;
  const cands = await findCrossSourceDuplicateCandidates(supabase, owner, self.source, date, amount, incoming);
  if (cands.length === 0) return none; // 경쟁이 없었다 = 사전조회와 같은 답. 대부분 여기서 끝난다.

  const group: CrossSourceCandidate[] = [
    { id: self.id, source: self.source, status: "pending", created_at: self.createdAt },
    ...cands,
  ];
  const confirmed = group.filter((r) => r.status === "confirmed");
  // 확정이 둘 이상이면 이미 장부에 2건이 들어갔다는 뜻 — 자동으로 고를 문제가 아니다.
  if (confirmed.length > 1) {
    console.error(`[hh-dedup] 사후 스윕 보류 — confirmed 가 ${confirmed.length}건이다(${confirmed.map((r) => r.id).join(", ")})`);
    return none;
  }
  // ★시각은 **파싱해서 숫자로** 비교한다(설계 200 배포 전 리뷰 M3). self 의 created_at 은 INSERT 응답에서,
  //   후보는 별도 SELECT 에서 온다 — 지금은 같은 포맷이지만 타임존 직렬화가 어긋나면
  //   문자열 비교가 **경고 없이 승자를 뒤집는다**(결과는 여전히 "pending 1건"이라 라이브도 초록이다).
  //   못 읽는 값·null 은 `Infinity` = **패배**로 둔다. `?? ""` 는 null 을 '가장 이른 값'으로 만들어
  //   fail-safe 방향이 반대였다(이 저장소의 다른 fail-safe 와도 어긋난다).
  const at = (r: CrossSourceCandidate) => {
    const t = r.created_at ? Date.parse(r.created_at) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  const winner =
    confirmed[0] ??
    group.reduce((best, r) => {
      const a = at(r);
      const b = at(best);
      if (a !== b) return a < b ? r : best;
      return r.id < best.id ? r : best;
    });

  // ★수기입력은 **승자는 되어도 패자로는 안 내린다**(설계 200 배포 전 리뷰 M2).
  //   사전조회(설계 63)는 늘 '들어온 행'만 내렸다 — 스윕은 무리를 돌며 **기존 행**도 내리므로,
  //   팀장님이 손으로 넣은 행이 사전조회~스윕 사이에 커밋되면 그게 내려갈 수 있다.
  //   수기입력은 보통 정보가 가장 정확한 행이고, 설계 107 이 수기입력을 특별 취급한 취지와도 맞다.
  const losers = group.filter((r) => {
    if (r.id === winner.id || r.status !== "pending") return false;
    if (r.source === "manual") {
      console.warn(`[hh-dedup] 수기입력 ${r.id} 는 패자로 내리지 않는다 — 중복이면 사람이 정리한다.`);
      return false;
    }
    return true;
  });
  if (losers.length === 0) return none;

  // ★승자 확인과 패자 강등을 **한 트랜잭션**으로 넘긴다. (설계 201)
  //   설계 200 은 이걸 PostgREST 로 못 써서 읽고-내리고-다시 읽어-되돌리는 **보상**으로 근사했고,
  //   그래도 "승자 재조회 직후 사람이 승자를 휴지통으로" 라는 창이 남았다(그때 pending 대표가 0건이 된다).
  //   RPC 는 승자를 `for update` 로 잠근 뒤 같은 트랜잭션에서 패자를 내리므로 그 사이에 끼어들 수 없다.
  //   덤으로 **자기 재조회·보상·되돌리기가 통째로 필요 없어졌다** — 자기가 휴지통이면 승자 검사나
  //   패자의 `status='pending'` 조건에 걸려 자연히 아무 일도 안 일어난다.
  //   판정 로직(같은 거래인가·누가 승자인가·수기입력 제외)은 여기 TS 에만 있다 — SQL 로 옮기면 두 벌이 된다.
  //   `p_self_id` 를 함께 넘긴다 — 자기가 그 사이 휴지통이 됐으면 함수가 아무것도 하지 않는다.
  //   (설계 200 의 '자기 재조회' 방어를 같은 트랜잭션 안으로 옮긴 것. 3건 이상 무리에서
  //    휴지통에 있는 내가 방아쇠가 되어 남의 행을 내리는 것을 막는다 — 배포 전 리뷰에서 양쪽이 지적.)
  const { data: demotedIds, error } = await supabase.rpc("hh_sweep_demote_losers", {
    p_owner: owner,
    p_self_id: self.id,
    p_winner_id: winner.id,
    p_loser_ids: losers.map((r) => r.id),
  });
  if (error) {
    // 실패해도 종전보다 나빠지지 않는다 — pending 2건이 수집함에 그대로 남아 사람이 본다(설계 200 M2).
    console.error("[hh-dedup] 사후 스윕 실패:", error.message);
    return none;
  }
  const demoted = (demotedIds ?? []) as string[];
  if (demoted.length) console.warn(`[hh-dedup] 경쟁으로 새어 나온 크로스소스 중복 ${demoted.length}건 정리 — 승자 ${winner.id}`);
  // ★패자를 넘겼는데 0건이 돌아온 경우 — **이 마이그레이션이 존재하는 바로 그 사건**(승자나 자기가
  //   그 사이에 죽었다)이다. 로그가 없으면 이 창이 실제로 얼마나 열리는지 영영 모른다(리뷰 L2).
  else console.warn(`[hh-dedup] 사후 스윕이 아무도 내리지 않았다 — 승자 ${winner.id} 또는 자기 ${self.id} 가 그 사이에 바뀌었다(패자 후보 ${losers.length}건).`);
  return { demotedSelf: demoted.includes(self.id), demoted };
}

/**
 * 두 유형이 '같은 방향'인가. 나가는 돈(expense·installment·payment)은 소스마다 다르게 파싱될 수 있어
 * 한 묶음으로 본다. income·transfer 는 각각 그 자체와만 같다. (설계 107 교차리뷰)
 */
function sameDirectionClass(a: string, b: string): boolean {
  const outLike = (t: string) => t === "expense" || t === "installment" || t === "payment";
  return a === b || (outLike(a) && outLike(b));
}

/**
 * 수기입력 후보가 이번에 들어온 항목과 '같은 거래'로 볼 만한가. (설계 107)
 * 상호가 서로 포함관계이거나(공백·괄호 무시) 계좌가 같으면 같은 거래로 본다.
 * 판단 근거가 없으면 false = 중복 아님 → 수집함에 pending 으로 남아 사람이 본다(조용히 사라지는 것보다 안전).
 */
function isSameAsManualEntry(
  incoming: { merchant?: string | null; accountId?: string | null; fromAccountId?: string | null } | undefined,
  cand: { guessed_merchant?: string | null; guessed_account_id?: string | null; guessed_from_account_id?: string | null }
): boolean {
  const inAcct = incoming?.accountId ?? incoming?.fromAccountId ?? null;
  const candAcct = cand.guessed_account_id ?? cand.guessed_from_account_id ?? null;
  if (inAcct && candAcct && inAcct === candAcct) return true;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s(){}[\]（）]/g, "");
  const a = norm(incoming?.merchant);
  const b = norm(cand.guessed_merchant);
  if (!a || !b) return false;
  // 짧은 상호의 포함관계는 오탐이 크다('김밥' 수기 ↔ '김밥천국' 실거래) → 3글자 이상일 때만 인정. (교차리뷰)
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length < 3) return a === b;
  return a.includes(b) || b.includes(a);
}

/**
 * 가족 내부 이체 이중수집 판정. (설계 docs/household/48·63 연장)
 * 한 번의 가족 이체가 '보낸 쪽'(예: "자동이체 이바다님에게")과 '받은 쪽'("송금 …입금됐어요") 알림으로
 * 각각 들어와 pending 2건이 되던 문제. 두 알림은 소스가 같을 수 있어(둘 다 notification) 크로스소스 dedup이
 * 못 잡는다. 그래서 가족이체(familyTransfer)에 한해 **같은 날짜·같은 금액의 다른 이체 항목**이 이미 있으면
 * 이번 건을 duplicate로 표시한다. 삭제가 아니라 상태 표시(가역적) — 오탐이면 수집함에서 복원. 금액 없으면 판정 안 함.
 * ★보강(2026-07-19): 끝점 계좌를 알면, 계좌가 겹치지 않는 '서로 다른 가족이체'는 중복에서 제외(설계 63과 동일 기법).
 */
export async function isDuplicateFamilyTransfer(
  supabase: SupabaseClient,
  owner: string,
  date: string,
  amount: number | null,
  incoming?: TransferEndpoints
): Promise<boolean> {
  if (amount == null) return false;
  const { data } = await supabase
    .from("hh_transaction_inbox")
    .select("id, guessed_type, guessed_from_account_id, guessed_to_account_id")
    .eq("owner_auth_uid", owner)
    .eq("guessed_date", date)
    .eq("guessed_amount", amount)
    .eq("guessed_type", "transfer")
    .in("status", ["pending", "confirmed"]);
  const cands = data ?? [];
  if (cands.length === 0) return false;
  if (incoming && (incoming.fromAccountId || incoming.toAccountId)) {
    return cands.some((c) => !isConfidentlyDifferentTransfer(incoming, c));
  }
  return true;
}

/**
 * 결제문자 수집 공통 핸들러. (설계 docs/household/22)
 * `/api/household/sms` 와 `/api/household/inbox/sms` 가 함께 호출한다.
 *
 * 인증: 헤더 `X-Ingest-Token`(없으면 본문/쿼리 token). 본문은 JSON/form/plain 모두 허용.
 * 동작: 토큰으로 owner 식별 → 룰 파싱(종류·금액·가맹점·일시) → 가맹점→카테고리 추정
 *       → hh_transaction_inbox(source='sms', pending)에 원문과 함께 적재. 실패해도 원문 보존.
 */
export async function handleSmsIngest(request: NextRequest) {
  try {
    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    const bodyRaw = await request.text();

    let smsText = "";
    let sender: string | null = null;
    let bodyToken: string | null = null;

    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(bodyRaw);
        if (typeof parsed === "string") {
          smsText = parsed;
        } else if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          smsText = firstString(obj, ["text", "message", "body", "sms", "raw_message", "sms_message"]) ?? "";
          sender = firstString(obj, ["sender", "from", "address", "phone", "sms_sender"]);
          bodyToken = firstString(obj, ["token", "device_token", "ingest_token"]);
        }
      } catch {
        smsText = bodyRaw;
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(bodyRaw);
      smsText =
        params.get("text") ??
        params.get("message") ??
        params.get("body") ??
        params.get("sms") ??
        params.get("raw_message") ??
        params.get("sms_message") ??
        "";
      sender = params.get("sender") ?? params.get("from") ?? params.get("address") ?? params.get("phone") ?? params.get("sms_sender");
      bodyToken = params.get("token") ?? params.get("device_token") ?? params.get("ingest_token");
      if (!smsText && sender) {
        smsText = sender;
        sender = null;
      }
    } else {
      smsText = bodyRaw;
    }

    const token = extractToken(request, bodyToken);
    if (!token || !token.trim()) {
      return NextResponse.json({ error: "Unauthorized: missing token" }, { status: 401 });
    }

    smsText = smsText.trim();
    if (!smsText) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const tokenRow = await resolveOwner(supabase, token);
    if (!tokenRow) {
      return NextResponse.json({ error: "Unauthorized: invalid token" }, { status: 401 });
    }
    const owner = tokenRow.owner;

    // 룰 파싱(광고·정보성 판정용 선파싱)
    const preParsed = parseSms(smsText, sender);

    // 스킵 처리. (설계 docs/household/56)
    // - ignore-noise(명백한 광고/정보성): DB에 흔적없이 skip.
    // - trace-unknown(거래인지 판단 못한 미인식): 휴지통(ignored)에 원문 보존으로 남김.
    // - ignore-trace(휴대폰 소액결제 영수증): 휴지통(ignored)에 원문 보존으로 남김. (설계 196)
    const disposition = skipDisposition(smsText, preParsed);
    if (disposition === "ignore-noise") {
      await supabase.from("hh_ingest_token").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);
      return NextResponse.json({ success: true, skipped: true, reason: "non-transactional" }, { status: 200 });
    }
    if (disposition === "trace-unknown" || disposition === "ignore-trace") {
      const traceResult = await insertTraceUnknown(supabase, owner, {
        source: "sms",
        sourceAdapter: sender,
        rawText: smsText,
        date: preParsed.occurredAt ?? seoulToday(),
        time: preParsed.occurredTime,
        parsed: disposition === "ignore-trace" ? preParsed : null,
        ...(disposition === "ignore-trace" ? { guessedType: ignoreTraceGuessedType(smsText) } : {}),
      });
      await supabase.from("hh_ingest_token").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);
      // ★적재가 실패했으면 성공(201)으로 답하지 않는다. (설계 199)
      if (traceResult.failed) {
        return NextResponse.json({ error: `휴지통 적재 실패: ${traceResult.error}`, traced: false }, { status: 500 });
      }
      return NextResponse.json({ success: true, skipped: true, traced: true, reason: disposition, ...traceResult }, { status: 201 });
    }

    const { parsed, fields, familyTransfer } = await enrichParsed(supabase, owner, smsText, sender);

    const dedupHash = smsDedupKey({
      kind: parsed.kind,
      date: fields.guessed_date,
      amount: parsed.amount,
      merchant: parsed.merchant,
      cardLast4: parsed.cardLast4,
      time: parsed.occurredTime, // 설계 164 — 같은 날 재결제를 재전송과 구분
      balance: parsed.balance,
    });

    // 크로스소스 이중수집(알림 등 다른 소스가 같은 금액·날짜를 이미 수집)이면 duplicate로. (설계 docs/household/63)
    // 이체는 끝점 계좌로 '서로 다른 이체'를 구분해 오판 방지(보강 2026-07-19).
    // 상호·계좌도 넘긴다 — 수기입력 후보를 가려내는 데 쓴다(설계 107).
    const txEndpoints = {
      type: fields.guessed_type,
      fromAccountId: fields.guessed_from_account_id,
      toAccountId: fields.guessed_to_account_id,
      merchant: fields.guessed_merchant,
      accountId: fields.guessed_account_id,
    };
    // 같은 날짜·시각·금액 수집 건이 이미 있으면 이번 행은 휴지통(ignored)으로. (설계 163)
    // ★duplicate 탭이 아니라 휴지통이다 — 팀장 지정. 크로스소스 판정보다 먼저 본다.
    const sameTimeDup = await hasSameTimeSibling(supabase, owner, parsed.kind, fields.guessed_date, fields.guessed_time, parsed.amount);
    // 크로스소스 이중수집(알림 등 다른 소스가 같은 금액·날짜를 이미 수집)이면 duplicate로. (설계 docs/household/63)
    // 이체는 끝점 계좌로 '서로 다른 이체'를 구분해 오판 방지(보강 2026-07-19).
    const crossDup = sameTimeDup ? false : await isCrossSourceDuplicate(supabase, owner, "sms", fields.guessed_date, parsed.amount, txEndpoints);
    // 가족 내부 이체는 보낸/받은 쪽 2건으로 들어올 수 있어(같은 소스여도) 같은 날·금액이면 duplicate로. (설계 48·63)
    const famDup = !sameTimeDup && familyTransfer ? await isDuplicateFamilyTransfer(supabase, owner, fields.guessed_date, parsed.amount, txEndpoints) : false;

    const row = {
      owner_auth_uid: owner,
      source: "sms",
      source_adapter: sender,
      raw_text: smsText,
      status: sameTimeDup ? "ignored" : crossDup || famDup ? "duplicate" : "pending",
      dedup_hash: dedupHash,
      ...fields,
    };
    // 삽입 + 동일시각 인덱스 충돌(동시 요청 경쟁) 시 휴지통 재삽입. (설계 163)
    const { id: insertedId, createdAt, error, trashedByRace } = await insertInboxWithSameTimeRetry(supabase, row);

    if (error) {
      // dedup UNIQUE 충돌(23505) = 이미 수집된 동일 원문 → 정상(중복 무시, 새 행 불필요)
      if (error.code === "23505") {
        return NextResponse.json({ success: true, duplicate: true }, { status: 200 });
      }
      console.error("[hh-sms] insert failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 사후 스윕 — 사전조회가 경쟁(수십 ms 차)으로 못 본 크로스소스 중복을 커밋 뒤 한 번 더 본다. (설계 200)
    // 발동 조건은 `sweepAfterInsertIfPending` 안에 **한 벌만** 있다(알림 핸들러와 공유 — 사본 금지).
    const swept = await sweepAfterInsertIfPending(
      supabase,
      owner,
      { id: insertedId, createdAt, source: "sms", trashedByRace, insertedStatus: row.status },
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
        kind: parsed.kind,
        amount: parsed.amount,
        ...(trashed ? { duplicate: true, trashed: true } : {}),
        ...(swept?.demotedSelf ? { duplicate: true, swept: true } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    console.error("[hh-sms] unhandled error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
