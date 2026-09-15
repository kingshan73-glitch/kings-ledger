"use client";

import { Archive, CheckCheck, ChevronDown, Coins, FileUp, Inbox, ListChecks, Plus, RotateCcw, Settings, Trash2, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { InboxDialog, type InboxFormData } from "@/components/household/inbox-dialog";
import { QuickInterestDialog } from "@/components/household/quick-interest-dialog";
import { LoanDialog } from "@/components/household/loan-dialog";
import { findRegisteredLoan, loanPresetFromInbox } from "@/lib/household/loan-preset";
import type { LoanFormState } from "@/lib/household/loan-save";
import { StatementUploadDialog, type NewInboxRow } from "@/components/household/statement-upload-dialog";
import { HhSearchBar, type HhDateRange } from "@/components/household/hh-search-bar";
import {
  ErrorState,
  LoadingState,
  PageShell,
} from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SOLID } from "@/components/ui/tabs";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import { getOwnerUid } from "@/lib/household/owner";
import { HH_COL, HH_CELL, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { presetRange } from "@/lib/household/month";
import { MERCHANT_LEARN_MIN_LEN, matchMerchantCategory, shouldLearnMerchantKey } from "@/lib/household/defaults";
import { syncChargeIncentive } from "@/lib/household/sync-incentive";
import { categoryDisplay, memoDisplay, merchantDisplay } from "@/lib/household/merchant-display";
import { formatLoanTermsParts } from "@/lib/household/loan-terms-format";
import { CATEGORY_NAME, cardBillCategoryId } from "@/lib/household/category-names";
import {
  CARD_BILL_DONE_EVIDENCE_STATUSES,
  CARD_BILL_DONE_MATCH_WINDOW_DAYS,
  CARD_BILL_DONE_QUERY_LIMIT,
  CARD_BILL_DONE_TRACE_PREFIX,
  cardBillDoneCollectedBefore,
  cardBillDoneNoticeDateRange,
  findUnmatchedCardBillNotices,
  type CardBillDoneNotice,
} from "@/lib/household/cardbill-done-check";
import {
  QUICK_INTEREST,
  buildQuickInterestForm,
  findSameDayAmount,
  isAllowedAccount,
  isFutureDate,
  pickDefaultAccount,
  planQuickInterestBatch,
  quickInterestDedupHash,
  worstInterestGap,
  type InterestStat,
  resolveQuickInterestRefs,
  shouldWarnMissing,
} from "@/lib/household/quick-interest";
import { seoulToday, shiftIsoDate } from "@/lib/household/sms";
import {
  INBOX_STATUS_LABEL,
  type HhAccount,
  type HhCategory,
  type HhInboxStatus,
  type HhLoan,
  type HhPaymentMethod,
  type HhTransactionInbox,
} from "@/lib/household/types";

const selectClass =
  "hh-select h-8 rounded-md border border-input bg-background px-2 pr-6 text-base md:text-xs focus-visible:border-ring focus-visible:outline-none";
const inputClass =
  "h-8 rounded-md border border-input bg-background px-2 text-base md:text-xs focus-visible:border-ring focus-visible:outline-none";

/**
 * 수집함 전량 로드. 실패하면 null. (설계 90 §4 와 같은 이유)
 *
 * ★페이징 필수 — hh_transaction_inbox 는 문자·알림이 매일 쌓이기만 하고 삭제 정책이 없다
 *   (purge-raw 는 30일 지난 raw_text·raw_meta 만 비우고 행은 남긴다). 1,000행을 넘으면 그냥 select 는 조용히 잘리는데,
 *   그러면 오래된 '검토 대기' 항목이 목록에서 사라지고 탭 배지도 틀린다. 더 나쁜 건
 *   그걸 잡으라고 만든 hiddenPendingCount 마저 잘린 배열을 세어 0 을 보고한다는 점이다.
 *   collected_at 동률 대비로 id 를 2차 정렬키에 둬야 페이지 경계에서 누락·중복이 없다.
 */
async function fetchInboxPaged(
  supabase: ReturnType<typeof createClient>
): Promise<HhTransactionInbox[] | null> {
  const CHUNK = 1000;
  const MAX = 50000;
  const out: HhTransactionInbox[] = [];
  for (let from = 0; from < MAX; from += CHUNK) {
    const { data, error } = await supabase
      .from("hh_transaction_inbox")
      .select("*")
      .order("collected_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + CHUNK - 1);
    if (error) {
      console.error("수집함 조회 실패:", error);
      return null;
    }
    const rows = (data ?? []) as HhTransactionInbox[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  // DB 순서(collected_at)는 **페이징을 안전하게 하기 위한 것**이고, 화면 순서는 아래에서 다시 잡는다.
  // (정렬을 서버로 못 옮기는 이유: 아래 '시각 없으면 수집시각으로 대체'가 COALESCE 라 .order() 로 표현이 안 된다.
  //  어차피 전량을 이미 들고 있으므로 클라이언트 정렬이 정확하고 싸다.)
  return out.sort((a, b) => inboxSortKey(b).localeCompare(inboxSortKey(a)));
}

type CardBillDoneCheckResult = { failed: boolean; unmatched: CardBillDoneNotice[] };

/** 설계 205-A 카드대금 사후 안내의 은행 출금 증거를 RLS가 적용된 로그인 클라이언트로 점검한다. */
async function fetchCardBillDoneCheck(
  supabase: ReturnType<typeof createClient>,
): Promise<CardBillDoneCheckResult> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      console.error("카드대금 출금 점검 세션 확인 실패:", sessionError ?? "로그인 세션 없음");
      return { failed: true, unmatched: [] };
    }

    const today = seoulToday();
    const { lowerBound, upperBound } = cardBillDoneNoticeDateRange(today);
    const noticeRes = await supabase
      .from("hh_transaction_inbox")
      .select("id,guessed_date,guessed_amount")
      .eq("status", "ignored")
      .eq("guessed_type", "payment")
      .like("dedup_hash", `${CARD_BILL_DONE_TRACE_PREFIX}%`)
      .gte("guessed_date", lowerBound)
      .lte("guessed_date", upperBound)
      .lte("collected_at", cardBillDoneCollectedBefore(new Date()))
      .gt("guessed_amount", 0)
      .limit(CARD_BILL_DONE_QUERY_LIMIT);

    const notices = (noticeRes.data ?? []) as CardBillDoneNotice[];
    // PostgREST max_rows=1000이라 정확히 1000건과 잘린 결과를 구분할 수 없어 한도 도달도 실패로 둔다.
    if (noticeRes.error || notices.length >= CARD_BILL_DONE_QUERY_LIMIT) {
      console.error("카드대금 출금 점검 안내 조회 실패:", noticeRes.error ?? "조회 한도 도달");
      return { failed: true, unmatched: [] };
    }
    if (notices.length === 0) return { failed: false, unmatched: [] };

    const dates = notices.map((row) => row.guessed_date).filter((date): date is string => date != null);
    const amounts = [...new Set(notices.map((row) => Number(row.guessed_amount)).filter((amount) => Number.isFinite(amount) && amount > 0))];
    if (dates.length !== notices.length || amounts.length === 0) return { failed: true, unmatched: [] };
    const minDate = dates.reduce((min, date) => date < min ? date : min);
    const maxDate = dates.reduce((max, date) => date > max ? date : max);
    const evidenceStart = shiftIsoDate(minDate, -CARD_BILL_DONE_MATCH_WINDOW_DAYS);
    const evidenceEnd = shiftIsoDate(maxDate, CARD_BILL_DONE_MATCH_WINDOW_DAYS);

    const [inboxRes, txnRes] = await Promise.all([
      supabase
        .from("hh_transaction_inbox")
        .select("id,guessed_date,guessed_amount")
        .in("status", CARD_BILL_DONE_EVIDENCE_STATUSES)
        .in("guessed_amount", amounts)
        .gte("guessed_date", evidenceStart)
        .lte("guessed_date", evidenceEnd)
        .limit(CARD_BILL_DONE_QUERY_LIMIT),
      supabase
        .from("hh_transaction")
        .select("txn_date,amount")
        .in("amount", amounts)
        .gte("txn_date", evidenceStart)
        .lte("txn_date", evidenceEnd)
        .limit(CARD_BILL_DONE_QUERY_LIMIT),
    ]);
    if (
      inboxRes.error || txnRes.error ||
      (inboxRes.data ?? []).length >= CARD_BILL_DONE_QUERY_LIMIT ||
      (txnRes.data ?? []).length >= CARD_BILL_DONE_QUERY_LIMIT
    ) {
      console.error("카드대금 출금 점검 증거 조회 실패:", inboxRes.error ?? txnRes.error ?? "조회 한도 도달");
      return { failed: true, unmatched: [] };
    }

    return {
      failed: false,
      unmatched: findUnmatchedCardBillNotices(notices, inboxRes.data ?? [], txnRes.data ?? []),
    };
  } catch (caught) {
    console.error("카드대금 출금 점검 조회 실패:", caught);
    return { failed: true, unmatched: [] };
  }
}

/**
 * 수집함 화면 정렬키 = **거래 시각**(문자에 적힌 것) 내림차순. (설계 152)
 *
 * 왜 `collected_at`(수집 시각)이면 안 되나 — 대개는 둘이 거의 같지만(2026-08-06 실측: 수집 지연
 * 중앙 1분·최대 1분) **늦게 도착한 알림·수기 입력이 엉뚱한 자리에 꽂힌다.** 실제로 08-05 거래인
 * '토스이자·옥수수·여행 이체' 가 08-06 02:2x 에 수집돼 목록 맨 위에 올라와 있었다.
 *
 * ★`guessed_time` 이 비어 있을 때 **수집 시각의 시:분으로 대신한다**(전체 359건 중 195건이 빈칸 —
 *   은행 SMS 엔 시각이 있고 카드앱 알림엔 없다). 빈칸을 뒤로 몰면 **같은 결제가 두 경로로 들어온 짝**
 *   (은행 SMS + 카드앱 알림)이 갈라져 오히려 읽기 나빠진다. 지연이 1분이라 대체값이 사실상 정확하다.
 *
 * 마지막 키는 `id` — 값이 같아도 순서가 흔들리지 않게(전량 정렬이라 페이지 경계 문제는 없지만
 * 렌더 순서가 새로고침마다 바뀌면 안 된다).
 */
function inboxSortKey(r: HhTransactionInbox): string {
  const date = r.guessed_date ?? "0000-00-00";
  // collected_at 은 UTC 다 — KST(+9)로 옮겨야 문자 속 시각과 같은 축이 된다.
  const kstHm = new Date(new Date(r.collected_at).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);
  const time = r.guessed_time ?? kstHm;
  return `${date} ${time} ${r.collected_at} ${r.id}`;
}

// 계좌번호·카드번호의 끝 3자리(숫자만). 식별 보조 표기 '이름_뒷3자리'.
function last3(no: string | null | undefined): string {
  const d = (no ?? "").replace(/\D/g, "");
  return d.length >= 3 ? d.slice(-3) : d;
}

// 수집 소스 한글 약어(수집 컬럼 폭 절감). 알 수 없는 값은 원본 그대로.
const SOURCE_LABEL: Record<string, string> = {
  sms: "문자",
  notification: "알림",
  manual: "수동",
  file: "파일",
  import: "가져옴",
};
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

/** 서버가 거래인지 판단 못해(미인식) 자동으로 휴지통에 남긴 행인지. (설계 docs/household/56) */
// 자동 걸러짐 = 미인식(kind=unknown, 설계 56) 또는 배제 표식(raw_meta.trace, 설계 196 — 진짜 kind 를 실으므로 표식으로 구분).
const isAutoFiltered = (it: { status: string; guessed_kind: string | null; source: string; raw_meta?: unknown }) =>
  it.status === "ignored" &&
  (it.source === "sms" || it.source === "notification") &&
  (it.guessed_kind === "unknown" || (typeof it.raw_meta === "object" && it.raw_meta != null && (it.raw_meta as { trace?: unknown }).trace === "ignore-trace"));

// 수집함 표 열 폭 — 내용별 척도(설계 122). 괄호 안은 실측 필요폭(패딩 px-3 기준).
// ★셀 안이 select 인 열(카테고리·계좌)은 화살표(pr-7) 자리까지 필요해 고정폭을 주지 않고 가변으로 둔다 —
//   탭마다 읽기전용/편집이 갈려 필요폭이 크게 달라지기 때문이다(확정 탭은 텍스트, 미분류 탭은 select).
// ★탭마다 열 수가 다르다(기본 8 / 액션 9 / 휴지통 10). 배열을 이어 붙여 만들어 열 수가 어긋나지 않게 한다.
const COL_WIDTHS_BASE: (number | undefined)[] = [
  HH_COL.standard,  // 수집 — 체크박스 + 필터 헤더 (105.2)
  HH_COL.standard,  // 날짜 (92.0)
  // ★2026-08-09: 표시 전용 축약(merchantDisplay)을 넣었다고 이 열을 좁히지 마라 — 한 번 해 봤다가
  //   `배스킨라빈스부천옥길트레이더스`(156) · `KH에너지(주)직영 가평주유소`(153) · `이마트24춘천삼악산케이블카점`(150) ·
  //   `토스 포인트 → 내 토스뱅크 통장`(148) 처럼 **축약 규칙이 손댈 수 없는 평범한 상호 수십 개가 새로 꺾였다**.
  //   축약이 없앤 것은 `… (토스뱅크 체크카드)` 꼬리표가 붙은 214px 이상치뿐이다.
  HH_COL.xxwide,    // 가맹점/입금처 — '토스 포인트 → 내 토스뱅크 통장'(148)이 160 에서 꺾였다(설계 125)
  HH_COL.standard,  // 금액 (80.3, 편집 탭은 입력칸)
  HH_COL.short,     // 유형 — 배지 '지출/수입'(60.2). 미분류 탭 select 는 화살표까지 88 로 맞는다
  HH_COL.standard,  // 카테고리 — 확정/휴지통 탭은 텍스트(81), 미분류 탭은 select. 가변(160)으로 두면 텍스트 탭에서 96px 이 빈다
  HH_COL.xxwide,    // 결제/출금계좌 — select 값이 잘렸다. 꼬리표 조건부화(설계 125) 후에도 '달달할인 카드'가 147 필요
  HH_COL.xxwide,    // 사용내역 — 같은 문자열이 들어와 같은 폭이 필요하다(설계 125)
];
const COL_WIDTHS = COL_WIDTHS_BASE;
const COL_WIDTHS_ACTION = [...COL_WIDTHS_BASE, HH_COL.standard];               // 확정/보관: 액션 열
const COL_WIDTHS_TRASH = [...COL_WIDTHS_BASE, HH_COL.short, HH_COL.standard];  // 휴지통: 상태(62.8) + 액션

const TYPE_OPTIONS: { value: "expense" | "income" | "transfer" | "installment" | "payment"; label: string }[] = [
  { value: "expense", label: "지출" },
  { value: "income", label: "수입" },
  { value: "transfer", label: "이체" },
  { value: "installment", label: "할부" },
  { value: "payment", label: "납부" },
];

function inboxTypeLabel(type: string | null): string {
  if (type === "income") return "수입";
  if (type === "transfer") return "이체";
  if (type === "installment") return "할부";
  if (type === "payment") return "납부";
  return "지출";
}

function categoryKindForInbox(type: string | null): "income" | "expense" {
  return type === "income" ? "income" : "expense";
}

// 유형 정규화(확정 로직과 동일 기준): income/transfer/installment/payment면 그대로, 그 외(빈값·unknown)는 지출.
type InboxType = "expense" | "income" | "transfer" | "installment" | "payment";
function normalizeInboxType(type: string | null): InboxType {
  if (type === "income" || type === "transfer" || type === "installment" || type === "payment") return type;
  return "expense";
}

// 유형 표시 순서(헤더 필터 드롭다운 정렬용).
const TYPE_ORDER = ["지출", "수입", "이체", "할부", "납부"];

// 컬럼 헤더 필터(엑셀 오토필터식) 대상 컬럼. 각 컬럼 단일 선택, 여러 컬럼 AND. (설계 docs/household/69 2차)
type FilterCol = "source" | "date" | "merchant" | "type" | "category" | "account";
const FILTER_COLS: { col: FilterCol; label: string }[] = [
  { col: "source", label: "수집" },
  { col: "date", label: "날짜" },
  { col: "merchant", label: "가맹점/입금처" },
  { col: "type", label: "유형" },
  { col: "category", label: "카테고리" },
  { col: "account", label: "결제/출금계좌" },
];
const EMPTY_COL_FILTERS: Record<FilterCol, string> = { source: "", date: "", merchant: "", type: "", category: "", account: "" };
const UNSET = "__HH_UNSET__"; // '미지정' 선택 sentinel(빈 값 그룹, 실데이터와 충돌 없음)

type InboxTab = "pending" | "confirmed" | "trash" | "archived";

export default function HouseholdInboxPage() {
  const supabase = useMemo(() => createClient(), []);

  const [items, setItems] = useState<HhTransactionInbox[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  const [loans, setLoans] = useState<HhLoan[]>([]);
  // 설계 182 — 카드론 행 「대출로 등록」 프리필 팝업
  const [loanDialog, setLoanDialog] = useState<{ open: boolean; preset: Partial<LoanFormState> | null }>({ open: false, preset: null });
  const [merchantMap, setMerchantMap] = useState<{ merchant_key: string; category_id: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cardBillDoneCheck, setCardBillDoneCheck] = useState<CardBillDoneCheckResult>({ failed: false, unmatched: [] });
  const cardBillDoneCheckRequestSeq = useRef(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  // 토스 이자 빠른 입력. (설계 172)
  // interestProbe.date = 마지막으로 기록된 토스 이자의 거래일 / failed = 조회 자체가 실패
  // (실패를 '기록 없음'과 섞으면 네트워크 오류가 '미입력'으로 보인다).
  const [quickOpen, setQuickOpen] = useState(false);
  const [interestProbe, setInterestProbe] = useState<{ stats: InterestStat[]; failed: boolean }>({
    stats: [],
    failed: false,
  });
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 수집함 검색: 키워드 + 기간(guessed_date). 다른 화면과 동일하게 기본 '당월'.
  // 큐라서 기간 밖 대기 항목이 조용히 숨는 게 위험 → 숨은 대기 건수를 배너로 알리고 '전체 기간'을 한 번에 풀 수 있게 한다.
  const [search, setSearch] = useState("");
  const [range, setRange] = useState<HhDateRange>(() => presetRange("thisMonth"));
  const [tab, setTab] = useState<InboxTab>("pending"); // 활성 탭(액션 버튼을 탭 줄에 인라인 표시하려 controlled)
  // 컬럼 헤더 필터(엑셀 오토필터식): 컬럼별 단일 선택, 여러 컬럼 AND. (설계 69 2차)
  const [colFilters, setColFilters] = useState<Record<FilterCol, string>>(EMPTY_COL_FILTERS);
  // 열린 헤더 드롭다운(컬럼 + 화면좌표). fixed 배치라 표 overflow에 안 잘린다.
  const [filterMenu, setFilterMenu] = useState<{ col: FilterCol; x: number; y: number } | null>(null);
  const setColFilter = (col: FilterCol, val: string) => { setColFilters((p) => ({ ...p, [col]: val })); setSelected(new Set()); };
  const clearColFilters = () => { setColFilters(EMPTY_COL_FILTERS); setSelected(new Set()); };
  const activeFilterCount = Object.values(colFilters).filter(Boolean).length;

  // 표시 라벨: 계좌·카드는 '이름_뒷3자리'로 식별 보조.
  // ★뒷3자리는 **이름이 겹칠 때만** 붙인다. (설계 125, 팀장 지시 2026-08-02)
  //   무조건 붙이면 이름만으로 이미 구분되는 대부분이 30px 쯤 길어져 select 안 글자가 잘린다
  //   (실측: '<카드사>(<명의>) <제휴처>_<뒷3>' 형태가 152px > 안쪽 121px). 이름에 이미 번호가 든
  //   카드는 뒷3자리를 또 붙이면 같은 정보를 두 번 쓰는 셈이기도 하다.
  //   ⚠️예시에 실명·실제 카드번호를 적지 마라 — 교차리뷰 에이전트가 PII 로 보고 리뷰를 통째로
  //     중단한다(2026-08-09 Codex 실사고). 근거로 필요한 것은 **문자열 형태와 px 수치**뿐이다.
  //   ⚠️구분이 필요한 곳에서는 그대로 붙는다 — 정보를 버리는 게 아니라 겹칠 때만 쓴다.
  const dupNames = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of [...accounts.map((a) => a.name), ...methods.map((m) => m.name)]) count.set(n, (count.get(n) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > 1).map(([n]) => n));
  }, [accounts, methods]);
  const acctLabel = useCallback((a: HhAccount) => {
    const t = last3(a.account_no); return t && dupNames.has(a.name) ? `${a.name}_${t}` : a.name;
  }, [dupNames]);
  const methodLabel = useCallback((m: HhPaymentMethod) => {
    const t = last3(m.card_no); return t && dupNames.has(m.name) ? `${m.name}_${t}` : m.name;
  }, [dupNames]);
  const categoryName = useCallback((id: string | null) => categories.find((c) => c.id === id)?.name ?? "-", [categories]);
  const accountName = useCallback((id: string | null) => { const a = accounts.find((x) => x.id === id); return a ? acctLabel(a) : "-"; }, [accounts, acctLabel]);
  const methodName = useCallback((id: string | null) => { const m = methods.find((x) => x.id === id); return m ? methodLabel(m) : "-"; }, [methods, methodLabel]);

  // 컬럼 헤더 필터: 한 행에서 해당 컬럼의 '표시값'을 뽑는다. 빈 문자열 = 미지정. (설계 69 2차)
  // (accountName/categoryName 등에 의존 — React Compiler 자동 메모에 맡기려 일반 함수로 둔다.)
  const columnValue = (it: HhTransactionInbox, col: FilterCol): string => {
    switch (col) {
      case "source":
        return sourceLabel(it.source);
      case "date":
        return it.guessed_date ?? "";
      case "merchant":
        // ★필터 목록도 **표시값**이어야 한다 — 표에는 축약된 상호가 보이는데 드롭다운에만 원문이 뜨면
        //   같은 행을 두 이름으로 부르는 셈이 된다(merchantDisplay 는 표시 전용 축약, 저장값은 그대로다).
        return it.guessed_type === "transfer"
          // ⚠️빈 값은 반드시 "" 로 — merchantDisplay 는 빈 값에 "-" 를 돌려주는데 필터에서 ""(미지정)와 뜻이 다르다.
          ? (it.guessed_to_account_id ? accountName(it.guessed_to_account_id) : (it.guessed_merchant ? merchantDisplay(it.guessed_merchant).text : ""))
          : (it.guessed_merchant ? merchantDisplay(it.guessed_merchant).text : "");
      case "type":
        return inboxTypeLabel(normalizeInboxType(it.guessed_type));
      case "category":
        // 필터 목록 = 표시값. 납부 행은 이 칸에 **대출 이름**이 오므로 셀과 같은 함수를 쓴다.
        if (it.guessed_type === "transfer") return "이체";
        // ⚠️납부 종류를 아직 안 고른 행은 반드시 ""(미지정) — paymentKindDisplay 는 그때 "납부" 를 돌려주는데
        //   그걸 그대로 쓰면 '(미지정)' 필터에서 빠져 **확정 전에 분류를 채워야 할 행을 못 찾는다**(설계 94).
        if (it.guessed_type === "payment") {
          if (!it.guessed_loan_id && !it.guessed_category_id) return "";
          return categoryDisplay(paymentKindDisplay(it)).text;
        }
        return it.guessed_category_id ? categoryDisplay(categoryName(it.guessed_category_id)).text : "";
      case "account":
        if (it.guessed_type === "transfer") return it.guessed_from_account_id ? accountName(it.guessed_from_account_id) : "";
        if (it.guessed_type === "income") return it.guessed_account_id ? accountName(it.guessed_account_id) : "";
        return it.guessed_payment_method_id ? methodName(it.guessed_payment_method_id) : (it.guessed_account_id ? accountName(it.guessed_account_id) : "");
    }
  };
  // 현재 걸린 컬럼 필터를 모두(AND) 통과하는지.
  const passesColFilters = (it: HhTransactionInbox): boolean => {
    for (const { col } of FILTER_COLS) {
      const sel = colFilters[col];
      if (!sel) continue;
      const v = columnValue(it, col);
      if (sel === UNSET ? v !== "" : v !== sel) return false;
    }
    return true;
  };
  // 한 컬럼의 드롭다운 옵션: 주어진 행들에서 고유값+건수. 미지정(빈값)은 별도 집계.
  const columnOptions = (col: FilterCol, source: HhTransactionInbox[]) => {
    const map = new Map<string, number>();
    let unsetCount = 0;
    for (const it of source) {
      const v = columnValue(it, col);
      if (v === "") unsetCount += 1;
      else map.set(v, (map.get(v) ?? 0) + 1);
    }
    const entries = [...map.entries()];
    if (col === "date") entries.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)); // 최신 위
    else if (col === "type") entries.sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]));
    else entries.sort((a, b) => a[0].localeCompare(b[0], "ko"));
    return { entries, unsetCount, total: source.length };
  };

  // 지출 결제수단 칸: 카드(결제수단)와 출금계좌를 한 드롭다운으로 통합. value 접두 pm:/ac:로 구분.
  const paymentSelectValue = (it: HhTransactionInbox) =>
    it.guessed_payment_method_id ? `pm:${it.guessed_payment_method_id}` : it.guessed_account_id ? `ac:${it.guessed_account_id}` : "";
  const changePayment = (it: HhTransactionInbox, v: string) => {
    if (v.startsWith("pm:")) void patchItem(it.id, { guessed_payment_method_id: v.slice(3), guessed_account_id: null });
    else if (v.startsWith("ac:")) void patchItem(it.id, { guessed_account_id: v.slice(3), guessed_payment_method_id: null });
    else void patchItem(it.id, { guessed_payment_method_id: null, guessed_account_id: null });
  };
  // 납부 항목의 대출 후보 — 출금계좌가 같은 대출을 위로 올린다. (설계 94)
  // 자동 선택은 하지 않는다: 월 납입금이 같은 대출이 넷씩 있는 게 이 데이터의 현실이라
  // (설계 92 §1) 조용한 자동 선택은 틀려도 아무도 눈치채지 못한다. 고르는 건 사람이 한다.
  // 설계 182 — 카드론 조건이 있는 행: 이미 같은 대출(원금 일치·실행일 ±3일)이 있으면 「대출 등록됨」, 없으면 「대출로 등록」 버튼.
  //   버튼은 기존 대출 팝업을 프리필해 연다. 저장은 팝업의 saveLoan 그대로(월납입금은 비워 둔다 — 설계 176).
  const renderLoanRegister = (it: HhTransactionInbox) => {
    if (tab === "trash") return null; // 휴지통(버려진 행)에서는 등록 경로를 열지 않는다
    const registered = findRegisteredLoan(it, loans);
    if (registered) {
      // 표 셀: 라벨과 대출명을 한 노드에 이으면 두 줄로 꺾여 H 위반 — 요소를 둘로 쌓는다(설계 125·181 과 동일)
      return (
        <>
          <p className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>대출 등록됨</p>
          <p className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>{registered.name}</p>
        </>
      );
    }
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-1 h-6 px-2 text-xs"
        onClick={() => setLoanDialog({ open: true, preset: loanPresetFromInbox(it, accounts) })}
      >
        대출로 등록
      </Button>
    );
  };

  const loanOptions = (it: HhTransactionInbox) => {
    const from = it.guessed_from_account_id;
    const activeLoans = loans.filter((l) => l.status === "active");
    const mine = from ? activeLoans.filter((l) => l.account_id === from) : [];
    const rest = activeLoans.filter((l) => !mine.includes(l));
    const groups: { label: string; loans: HhLoan[] }[] = [];
    if (mine.length) groups.push({ label: "이 계좌에서 나가는 대출", loans: mine });
    if (rest.length) groups.push({ label: mine.length ? "그 밖의 대출" : "대출", loans: rest });
    return groups;
  };

  // 납부 종류 = 카드대금(카테고리) 또는 특정 대출(loan_id). 한 드롭다운으로 고르고 확정 시 분류가 끝난다.
  // ★비워두면 확정 후 미분류로 남아 소급 분류 스크립트를 또 돌아야 한다(설계 90이 그 사후 작업이었다).
  const cardPaymentCatId = cardBillCategoryId(categories, { activeOnly: true });

  const paymentKindValue = (it: HhTransactionInbox) =>
    it.guessed_loan_id ? `loan:${it.guessed_loan_id}` : it.guessed_category_id ? `cat:${it.guessed_category_id}` : "";

  const paymentKindDisplay = (it: HhTransactionInbox) => {
    // ★원문을 그대로 돌려준다 — 표시 축약은 그리는 자리에서 categoryDisplay() 로 한 번만 건다.
    //   납부 행의 이 칸에는 **대출 이름**이 오는데 그것도 `대출상환-…` 꼴이라 같은 축약이 필요하다.
    if (it.guessed_loan_id) return loans.find((l) => l.id === it.guessed_loan_id)?.name ?? CATEGORY_NAME.loanRepay;
    if (it.guessed_category_id) return categoryName(it.guessed_category_id);
    return "납부";
  };

  // 대출과 카테고리는 동시에 설정되지 않는다 — 한쪽을 고르면 다른 쪽은 반드시 비운다.
  const changePaymentKind = (it: HhTransactionInbox, v: string) => {
    if (v.startsWith("loan:")) void patchItem(it.id, { guessed_loan_id: v.slice(5), guessed_category_id: null });
    else if (v.startsWith("cat:")) void patchItem(it.id, { guessed_category_id: v.slice(4), guessed_loan_id: null });
    else void patchItem(it.id, { guessed_loan_id: null, guessed_category_id: null });
  };

  const paymentDisplay = (it: HhTransactionInbox) =>
    it.guessed_payment_method_id ? methodName(it.guessed_payment_method_id) : it.guessed_account_id ? accountName(it.guessed_account_id) : "-";

  const refreshCardBillDoneCheck = useCallback(async () => {
    const requestSeq = ++cardBillDoneCheckRequestSeq.current;
    const result = await fetchCardBillDoneCheck(supabase);
    if (requestSeq === cardBillDoneCheckRequestSeq.current) setCardBillDoneCheck(result);
  }, [supabase]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    const [inbox, catRes, accRes, mRes, mapRes, loanRes] = await Promise.all([
      fetchInboxPaged(supabase),
      supabase.from("hh_category").select("*").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase.from("hh_payment_method").select("*").order("sort_order").order("name"),
      supabase.from("hh_merchant_map").select("merchant_key,category_id"),
      // 납부 확정 시 고를 대출 목록. 상환완료는 뺀다. (설계 94)
      // ★active 만 받지 않는다(설계 182): 「대출 등록됨」 판정은 닫힌(철회) 대출도 봐야 이중 등록을 막는다.
      //   결제 선택 목록(loanOptions)은 아래에서 active 만 거른다.
      supabase.from("hh_loan").select("*").order("name"),
      refreshCardBillDoneCheck(),
    ]);

    // 마스터가 하나라도 실패하면 화면을 그리지 않는다 — 계좌·결제수단이 빈 채로 확정하면
    // 잘못 분류된 거래가 장부에 들어간다.
    const failed = [catRes, accRes, mRes, mapRes, loanRes].find((r) => r.error);
    if (inbox === null || failed) {
      console.error("수집함 조회 실패:", failed?.error);
      toast.error("수집함을 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }
    setItems(inbox);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setMethods((mRes.data ?? []) as HhPaymentMethod[]);
    setMerchantMap((mapRes.data ?? []) as { merchant_key: string; category_id: string | null }[]);
    setLoans((loanRes.data ?? []) as HhLoan[]);

    // 마지막으로 기록된 **토스뱅크** 이자 수입. 두 가지에 쓴다. (설계 172)
    //   ⓐ 며칠 비었는지 알리는 배지
    //   ⓑ **빠른 입력이 넣을 계좌를 정하는 근거** — 같은 은행 계좌가 명의별로 둘이라
    //      은행명만으로는 못 고르는데, 소스에 실명을 쓰면 덱스 교차리뷰가 중단된다.
    //      그래서 명의 대신 "이자가 실제로 들어오던 계좌"로 좁힌다.
    // ★후보를 은행명으로 먼저 거른다: 상호만 보면 다른 은행 결산이자·이자환급이 오늘 들어온 날
    //   토스 이자가 빠졌는데도 경고가 사라진다(교차리뷰 2026-08-14, Codex).
    // ★상호는 넓게 본다: 과거 기록이 '토스이자·통장이자·토스 이자…' 7가지 이름으로 흩어져 있어
    //   빠른 입력이 쓰는 이름 하나만 보면 "어제 넣었는데 비었다"고 거짓말을 한다.
    // 이 조회는 부가정보라 실패해도 화면을 막지 않되, **실패와 '기록 없음'을 구분**해 둔다
    // (둘 다 null 로 두면 조회 실패가 '미입력'으로 보인다).
    // ★★**계좌별로** 잰다(2026-08-14 4차 점검). 계좌 전체에서 '최신 1건'만 보면
    //   A 계좌가 사흘 비어도 B 계좌에 오늘 넣은 순간 경고가 사라져, '빠진 날을 알린다'는
    //   목적이 통째로 무력화된다. 기본 계좌도 '최근'이 아니라 **건수**로 정해야 안 흔들린다.
    const bankAccounts = ((accRes.data ?? []) as HhAccount[]).filter(
      (a) => a.is_active && a.name.includes(QUICK_INTEREST.accountBank),
    );
    if (bankAccounts.length) {
      const results = await Promise.all(
        bankAccounts.map(async (a) => {
          const base = () =>
            supabase.from("hh_transaction").select("txn_date").eq("type", "income").eq("account_id", a.id).ilike("counterparty", "%이자%");
          const [lastRes, cntRes] = await Promise.all([
            base().order("txn_date", { ascending: false }).limit(1),
            supabase
              .from("hh_transaction")
              .select("id", { count: "exact", head: true })
              .eq("type", "income")
              .eq("account_id", a.id)
              .ilike("counterparty", "%이자%"),
          ]);
          const err = lastRes.error || cntRes.error;
          if (err) console.error("이자 기록 조회 실패:", err);
          return {
            stat: {
              accountId: a.id,
              accountName: a.name,
              lastDate: (lastRes.data?.[0]?.txn_date as string | undefined) ?? null,
              count: cntRes.count ?? 0,
            },
            failed: !!err,
          };
        }),
      );
      // 한 계좌라도 조회에 실패하면 **판정을 하지 않는다** — 실패를 '미입력'이라 말하면 안 되고,
      // 반대로 조용히 통과시키면 빠진 날을 놓친다.
      setInterestProbe({ stats: results.map((r) => r.stat), failed: results.some((r) => r.failed) });
    } else {
      setInterestProbe({ stats: [], failed: true });
    }
    setLoading(false);
  }, [refreshCardBillDoneCheck, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const handleAdd = async (data: InboxFormData) => {
    const owner = await getOwnerUid(supabase);
    if (!owner) return toast.error("로그인 정보를 확인할 수 없습니다.");
    // 소스 무관 dedup(명세서 dedupHash와 동일 포맷) → 같은 거래의 이중 수집 차단
    const dedup = `${data.guessed_date}|${data.guessed_amount}|${data.guessed_merchant}`;
    const { error: err } = await supabase.from("hh_transaction_inbox").insert({
      owner_auth_uid: owner,
      raw_text: data.raw_text,
      source: "manual",
      guessed_date: data.guessed_date,
      guessed_amount: data.guessed_amount,
      guessed_merchant: data.guessed_merchant,
      guessed_category_id: data.guessed_category_id,
      guessed_account_id: data.guessed_account_id,
      guessed_payment_method_id: data.guessed_payment_method_id,
      guessed_from_account_id: data.guessed_from_account_id,
      guessed_to_account_id: data.guessed_to_account_id,
      guessed_installment_months: data.guessed_installment_months,
      guessed_type: data.guessed_type,
      confidence: 100,
      status: "pending",
      dedup_hash: dedup,
    });
    if (err) {
      toast.error(err.message.includes("dedup") || err.code === "23505" ? "이미 같은 항목이 수집함에 있습니다." : `추가 실패: ${err.message}`);
      return;
    }
    toast.success("수집함에 추가되었습니다.");
    await fetchData();
  };

  // ── 토스 이자 빠른 입력 (설계 172) ─────────────────────────────────────
  // 토스뱅크 이자는 팀장님이 앱에서 직접 받는 동작이라 **푸시가 안 떠 자동수집이 원천 불가**다
  // (2026-08-14 실측: 수집함 480건 전수에 이자 원문 0건). 그래서 손입력이 유일한 경로인데,
  // 그 손입력이 이름 7종·계좌 오입력 1건을 만들었다. 여기서 고정값으로 한 번에 넣고 확정한다.
  // 기본 계좌 근거 = **가장 많이 받아 온 계좌**(최근이 아니다 — 최근으로 하면 딴 계좌에 한 번만
  // 넣어도 다음날 기본값이 넘어가 '손 한 번'이 깨진다).
  const quickRefs = useMemo(
    () => resolveQuickInterestRefs(categories, accounts, pickDefaultAccount(interestProbe.stats)),
    [categories, accounts, interestProbe.stats],
  );
  const today = seoulToday();
  // ★계좌별로 재고 **가장 오래 빈 계좌**로 판정한다 — 전체 최신 1건으로 보면
  //   한쪽이 사흘 비어도 다른 쪽에 오늘 넣은 순간 경고가 꺼진다(2026-08-14 4차 점검).
  const worstGap = worstInterestGap(interestProbe.stats, today);
  const interestDays = worstGap ? worstGap.days : null;
  // 조회가 실패했으면 '며칠 비었다'고 말할 근거가 없다 — 경고색을 켜지 않고 title 로만 알린다.
  const interestWarn = !interestProbe.failed && shouldWarnMissing(interestDays);

  const handleQuickInterest = async ({ amounts, date, accountId }: { amounts: number[]; date: string; accountId: string }) => {
    if (quickRefs.missing) return toast.error(quickRefs.missing);
    if (!quickRefs.categoryId) return toast.error("수입 카테고리 '이자' 를 찾을 수 없습니다.");
    // ★화면이 준 값을 그대로 믿지 않는다 — 목록이 갱신되기 전의 선택값이나 후보 밖 계좌가
    //   들어오면 엉뚱한 계좌에 이자가 쌓인다(교차리뷰 2026-08-14 2차, Codex).
    if (!accountId || !isAllowedAccount(quickRefs.candidates, accountId)) {
      return toast.error("입금계좌를 다시 선택해주세요.");
    }
    // 여러 건(설계 184): 팝업이 준 금액 목록을 계획으로 바꾼다 — 빈 줄 제거·같은 금액 ordinal.
    // 화면 값을 다시 계획하는 이유는 위와 같다(화면이 거른 것을 믿지 않는다).
    const plan = planQuickInterestBatch(amounts);
    if (plan.error) return toast.error(plan.error);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast.error("날짜를 다시 입력해주세요.");
    // 미래 날짜 금지 — 오타 한 번이 '마지막 이자 기록'을 미래로 만들어 그날까지 미입력 경고를
    // 통째로 잠근다(오입력이 오입력을 숨긴다). 교차리뷰 2026-08-14.
    if (isFutureDate(date, seoulToday())) return toast.error("이자는 오늘 이전 날짜만 넣을 수 있습니다.");
    const owner = await getOwnerUid(supabase);
    if (!owner) return toast.error("로그인 정보를 확인할 수 없습니다.");

    // 같은 날 같은 금액이 이미 있으면 멈춘다 — 버튼을 두 번 누른 실수. 확정까지 가는 경로라
    // 조용히 통과시키면 장부에 이자가 두 번 잡힌다.
    // ★여러 건은 **넣기 전에 전량 검사**한다 — 3번째에서 걸리면 앞 2건만 들어가는 반쪽 저장이 생기고,
    //   그 상태로 다시 누르면 앞 2건이 이번엔 중복으로 걸려 나머지를 못 넣는다(설계 184).
    //   한 배치 안의 같은 금액은 가드 대상이 아니다(distinctAmounts 로 한 번씩만 본다) — 상품별 이자.
    // ① 화면에 있는 수집함 행(전량 로드라 탭·기간 필터와 무관하게 다 본다)
    //    ★걸린 금액을 **전부** 말한다 — 하나씩 알려 주면 줄을 지우고 다시 눌렀다가 또 막히는 왕복이 생긴다(리뷰 2026-08-19).
    const screenHits = plan.distinctAmounts.filter((amount) => findSameDayAmount(items, date, amount, accountId));
    if (screenHits.length) {
      return toast.error(`${date} 에 ${screenHits.map((a) => a.toLocaleString()).join("·")}원 이자가 이미 있습니다.`);
    }
    // ② ★장부(hh_transaction)까지 본다 — 수집함을 거치지 않은 이자가 실제로 있다(수기 등록·엑셀 import).
    //    ①만 보면 그런 건과 이중으로 잡히고, dedup_hash 는 상호가 달라('통장이자' 등) 안 부딪친다.
    //    교차리뷰 2026-08-14(Codex)가 잡은 빈틈. 금액을 묶어 한 번에 묻는다.
    const { data: already, error: dupErr } = await supabase
      .from("hh_transaction")
      .select("id, amount, counterparty")
      .eq("type", "income")
      .eq("txn_date", date)
      .in("amount", plan.distinctAmounts)
      .eq("account_id", accountId)
      // ★'이자'인 것만 본다 — 같은 날 같은 금액의 **다른 수입**(캐시백·환급 등)이 있으면
      //   정상 이자 입력까지 막힌다(교차리뷰 2026-08-14 4차, Codex). 수집함 가드와 조건을 맞춘다.
      .ilike("counterparty", "%이자%");
    // ★limit 을 걸지 않는다 — limit 은 **행 수**를 자르는데 이 기능은 같은 금액의 장부 행을
    //   여러 개 만든다(배치 안 동일 금액 허용). 금액 종류 수로 걸면 한 금액이 limit 을 다 먹어
    //   다른 금액이 잘리고, 그러면 아래 "전부 말한다"가 거짓이 된다(교차리뷰 2026-08-19 양쪽 지적).
    //   조건이 하루·한 계좌·'이자'로 좁아 행 수는 어차피 한 자리다.
    if (dupErr) return toast.error(`중복 확인에 실패해 저장을 멈췄습니다 — ${dupErr.message}`);
    if (already?.length) {
      // `.in()` 결과 순서는 보장되지 않는다 — 첫 행만 말하지 말고 걸린 금액을 전부 모아 말한다.
      // ★상대처도 금액마다 제 것을 붙인다 — `already[0]` 하나를 전부에 붙이면 128원은 '통장이자',
      //   15원은 '토스이자'인데 둘 다 '통장이자'로 말하게 된다(교차리뷰 2026-08-19).
      const byAmount = new Map<number, string>();
      for (const r of already) {
        const amt = Number(r.amount);
        if (!byAmount.has(amt)) byAmount.set(amt, r.counterparty ?? "-");
      }
      const hits = [...byAmount].map(([amt, cp]) => `${amt.toLocaleString()}원(${cp})`);
      return toast.error(`${date} 에 ${hits.join("·")} 수입이 이미 장부에 있습니다.`);
    }

    // 줄마다 수집함 한 행. dedup_hash 는 수동 추가(handleAdd)와 같은 포맷 + 계좌(설계 172),
    // 같은 배치의 같은 금액 2번째부터는 `#n`(설계 184) — 형식은 quickInterestDedupHash 한 곳.
    // ★배열 insert 는 원자적이다 — 하나라도 UNIQUE 에 걸리면 **아무것도 안 들어간다**(반쪽 저장 없음).
    const payload = plan.rows.map((r) => ({
      owner_auth_uid: owner,
      source: "manual" as const,
      confidence: 100,
      status: "pending" as const,
      // ★계좌를 포함한다 — 두 명의가 같은 날 같은 금액의 이자를 받으면 계좌 없는 해시로는
      //   UNIQUE 에 걸려 한쪽을 못 넣는다(교차리뷰 2026-08-14 2차). 수동 추가(handleAdd)의
      //   해시와 형식이 달라지지만, 그쪽과의 이중 수집은 화면·장부 가드가 따로 잡는다.
      dedup_hash: quickInterestDedupHash({ date, amount: r.amount, accountId, ordinal: r.ordinal }),
      ...buildQuickInterestForm({ amount: r.amount, date, categoryId: quickRefs.categoryId, accountId }),
    }));
    const { data: inserted, error: err } = await supabase
      .from("hh_transaction_inbox")
      .insert(payload)
      .select("*");
    if (err) {
      toast.error(err.code === "23505" ? "이미 같은 항목이 수집함에 있습니다." : `추가 실패: ${err.message}`);
      // ★실패해도 화면을 다시 읽는다 — 서버엔 들어갔는데 응답만 유실된 경우 `items` 가 그 행을
      //   모르는 채로 남아, 다시 눌렀을 때 화면 가드가 눈이 먼다(교차리뷰 2026-08-19).
      await fetchData();
      return;
    }

    // 이자는 사람이 판단할 게 없으므로 바로 확정한다(클릭 4회 → 1회).
    // ★확정이 실패해도 수집함 행은 남는다 — 조용히 사라지는 것보다 낫고, 화면에서 손으로 확정할 수 있다.
    //   여러 건이면 실패한 건만 남고 나머지는 확정된다 — 몇 건이 남았는지 말해 준다.
    // ★돌려받은 행 수를 확인한다 — 옛 `.single()` 은 0행이면 오류를 냈지만 배열 select 는 조용히 [] 다.
    //   그대로 두면 한 건도 확정 안 됐는데 "N건 확정" 으로 보고한다(리뷰 2026-08-19). 건수도 실측값에서 뽑는다.
    const rows = (inserted ?? []) as HhTransactionInbox[];
    if (rows.length !== plan.rows.length) {
      // ★"안 들어갔다"고 단정하지 않는다 — insert 는 성공했는데 표현만 못 받는 경우(RLS SELECT·
      //   프록시)도 여기로 온다. 확정만 건너뛰고 화면을 다시 읽어 사실을 보게 한다.
      toast.error(`수집함 저장 결과를 ${rows.length}/${plan.rows.length}건만 확인했습니다 — 화면에서 확인해주세요.`);
      setQuickOpen(false);
      await fetchData();
      return;
    }
    const failures: string[] = [];
    for (const row of rows) {
      const fail = await doConfirm(row);
      if (fail) failures.push(`${Number(row.guessed_amount).toLocaleString()}원: ${fail}`);
    }
    const n = rows.length;
    if (failures.length) {
      toast.error(
        // ★실패한 건을 전부 말한다 — 첫 건만 말하면 나머지 금액·사유가 어디에도 안 남는다
        //   (이 파일 confirmMany 의 `parts.join(" / ")` 와 같은 컨벤션).
        `수집함에 ${n}건을 넣었지만 ${failures.length}건 확정에 실패했습니다(수집함에 남아 있습니다) — ${failures.join(" / ")}`,
      );
    } else if (n === 1) {
      toast.success(`이자 ${plan.total.toLocaleString()}원을 넣고 확정했습니다.`);
    } else {
      toast.success(`이자 ${n}건(합계 ${plan.total.toLocaleString()}원)을 넣고 확정했습니다.`);
    }
    setQuickOpen(false);
    await fetchData();
  };

  // 명세서 업로드: 파싱된 후보행을 inbox에 일괄 적재(source='file')
  const existingHashes = useMemo(() => new Set(items.map((it) => it.dedup_hash).filter((h): h is string => !!h)), [items]);
  const handleUpload = async (newRows: NewInboxRow[]) => {
    const owner = await getOwnerUid(supabase);
    if (!owner) { toast.error("로그인 정보를 확인할 수 없습니다."); return; }
    const payload = newRows.map((r) => ({
      owner_auth_uid: owner,
      raw_text: r.raw_text,
      source: "file" as const,
      source_adapter: r.source_adapter,
      guessed_date: r.guessed_date,
      guessed_amount: r.guessed_amount,
      guessed_merchant: r.guessed_merchant,
      guessed_category_id: r.guessed_category_id,
      guessed_type: r.guessed_type,
      confidence: r.confidence,
      status: "pending" as const,
      dedup_hash: r.dedup_hash,
    }));
    const { error: err } = await supabase.from("hh_transaction_inbox").insert(payload);
    if (err) {
      toast.error(`업로드 실패: ${err.message}`);
      return;
    }
    toast.success(`명세서에서 ${payload.length}건을 수집했습니다.`);
    await fetchData();
  };

  // 인라인 추정값 수정
  // 성공=true. 상태 전이 호출부는 이 반환값을 보고 성공 토스트를 띄운다 — 실패했는데
  // "복원했습니다"가 같이 뜨던 거짓 성공을 막는다(설계 163 교차리뷰 R2. 복원은 동일시각
  // 인덱스에 막힐 수 있는 실제 실패 경로가 생겼다).
  const patchItem = async (id: string, patch: Partial<HhTransactionInbox>, opts?: { silent?: boolean }): Promise<boolean> => {
    const { error: err } = await supabase.from("hh_transaction_inbox").update(patch).eq("id", id);
    if (err) {
      toast.error(`수정 실패: ${err.message}`);
      return false;
    }
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    // 수집함엔 금액·날짜 편집 경로가 없다(셀은 읽기 전용, 추가는 fetchData 로 재조회) — 상태 변경만 재점검한다.
    if ("status" in patch) await refreshCardBillDoneCheck();
    // 인라인 셀 편집(카테고리/계좌/유형/사용내역) 피드백 — 상태 변경은 별도 안내하므로 제외.
    // 고정 id로 토스트를 갱신해 연속 편집 시 쌓이지 않게 한다.
    if (!("status" in patch) && !opts?.silent) {
      toast.success("저장됨", { id: "inbox-inline-saved", duration: 1200 });
    }
    return true;
  };

  // 유형 변경: 종류가 바뀌면 안 맞는 카테고리는 초기화한다(지출↔수입 카테고리 종류가 다름).
  // 할부가 아닌 유형으로 바꾸면 개월수도 비운다.
  const changeType = (it: HhTransactionInbox, newType: string) => {
    const patch: Partial<HhTransactionInbox> = {
      guessed_type: newType,
      guessed_category_id: null,
      ...(newType === "installment" ? {} : { guessed_installment_months: null }),
      // 납부가 아닌 유형으로 바꾸면 대출 선택은 의미가 없다 — 남겨두면 유형만 되돌렸을 때
      // 엉뚱한 대출이 붙은 채 확정된다. (설계 94)
      ...(newType === "payment" ? {} : { guessed_loan_id: null }),
    };
    // 납부(payment)로 바꾸면 기존 출금계좌를 from으로 옮겨 바로 확정 가능하게. (설계 docs/household/69)
    if (newType === "payment" && it.guessed_account_id && !it.guessed_from_account_id) {
      patch.guessed_from_account_id = it.guessed_account_id;
      patch.guessed_account_id = null;
      patch.guessed_payment_method_id = null;
    }
    void patchItem(it.id, patch);
  };

  // 사용내역(textarea) 저장: 원문(raw_text)은 보존하고 편집값만 user_memo에 저장.
  const saveMemo = (it: HhTransactionInbox, value: string) => {
    const v = value.trim();
    if (v === (it.user_memo ?? "")) return; // 변화 없음
    void patchItem(it.id, { user_memo: v || null });
  };

  // 체크박스 선택 토글 / 전체선택 토글(현재 표시된 검토대기 행 기준)
  const toggleSelect = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSelectAll = (rows: HhTransactionInbox[]) =>
    setSelected((prev) => {
      const ids = rows.map((r) => r.id);
      const allOn = ids.length > 0 && ids.every((i) => prev.has(i));
      if (allOn) return new Set([...prev].filter((i) => !ids.includes(i)));
      return new Set([...prev, ...ids]);
    });

  // 확정 가능 여부 검증(통과=null, 실패=사유). 토스트 없이 사유만 반환.
  const validateItem = (item: HhTransactionInbox): string | null => {
    if (!item.guessed_amount || item.guessed_amount <= 0) return "금액이 올바르지 않습니다.";
    if (item.guessed_type === "transfer") {
      if (!item.guessed_from_account_id || !item.guessed_to_account_id) return "이체는 출금/입금 계좌가 필요합니다.";
      if (item.guessed_from_account_id === item.guessed_to_account_id) return "출금/입금 계좌가 같을 수 없습니다.";
      return null;
    }
    // 납부(카드대금·대출 원리금): 출금계좌만 필요. 카테고리·결제수단 없음(지출집계 제외). (설계 docs/household/69)
    if (item.guessed_type === "payment") {
      if (!item.guessed_from_account_id) return "납부는 출금계좌가 필요합니다.";
      return null;
    }
    // 할부: 카테고리 + 결제수단(카드) + 개월수(2 이상). (설계 docs/household/54)
    if (item.guessed_type === "installment") {
      if (!item.guessed_category_id) return "카테고리가 비어 있습니다.";
      if (!item.guessed_payment_method_id) return "할부는 결제수단(카드)이 필요합니다.";
      if (!item.guessed_installment_months || item.guessed_installment_months < 2) return "할부 개월수(2 이상)가 필요합니다.";
      return null;
    }
    const type = item.guessed_type === "income" ? "income" : "expense";
    if (!item.guessed_category_id) return "카테고리가 비어 있습니다.";
    if (type === "income" && !item.guessed_account_id) return "수입은 입금계좌가 필요합니다.";
    // 지출은 결제수단 또는 출금계좌 중 하나면 확정 가능(은행 직출금은 계좌만으로). (설계 docs/household/34)
    if (type === "expense" && !item.guessed_payment_method_id && !item.guessed_account_id) return "지출은 결제수단 또는 출금계좌가 필요합니다.";
    return null;
  };

  // RPC 확정 + 충전 인센티브 + 가맹점→분류 학습. 성공=null, 실패=메시지. (검증은 호출 전에 수행)
  const doConfirm = async (item: HhTransactionInbox): Promise<string | null> => {
    const { data: txnId, error: err } = await supabase.rpc("hh_confirm_inbox", { p_inbox_id: item.id });
    if (err) return err.message;

    // 충전 인센티브(설계 84·130): 부천페이 같은 선불 지갑으로 들어온 '충전 이체'는 충전액의 10%가 얹힌다.
    // 예전엔 이 계산이 통장이동 폼·팝업에만 있어서, **문자 수집함에서 확정한 충전은 적립이 통째로 빠졌다**
    // (2026-08-03 실측: 부천페이 충전 3건 중 3건 모두 누락 — 소급 반영으로 90,000원을 뒤늦게 넣었다).
    // ★규칙(대상 계좌·비율)은 여기 적지 않는다 — defaults.ts 의 CHARGE_INCENTIVE_RULES 한 곳에서만 온다.
    // ★확정 자체는 이미 끝났으므로 인센티브 실패로 '확정 실패'라 보고하지 않는다(경고만) — 되돌리기는
    //   RPC 가 거래를 지우면 related_txn_id 의 ON DELETE CASCADE 가 인센티브도 같이 지운다.
    // ★수집함 행(guessed_*)이 아니라 **방금 만들어진 거래**를 읽어서 넘긴다 — 날짜는 RPC 가
    //   `coalesce(guessed_date, current_date)` 로 정하므로 guessed_date 가 비면 둘이 어긋난다.
    if (txnId && item.guessed_type === "transfer") {
      const { data: txn, error: txnErr } = await supabase
        .from("hh_transaction")
        .select("txn_date, amount, to_account_id, type")
        .eq("id", txnId as string)
        .maybeSingle();
      if (txnErr) {
        toast.error(`확정은 됐지만 충전 인센티브 확인에 실패했습니다 — ${txnErr.message}`);
      } else if (txn?.type === "transfer" && txn.to_account_id) {
        const owner = await getOwnerUid(supabase);
        if (owner) {
          const res = await syncChargeIncentive(supabase, {
            txnId: txnId as string,
            owner,
            accounts,
            txnDate: txn.txn_date as string,
            amount: Number(txn.amount),
            toAccountId: txn.to_account_id as string,
          });
          if (!res.ok) toast.error(`확정은 됐지만 충전 인센티브를 기록하지 못했습니다 — ${res.message}`);
          else if (res.message) toast.success(res.message);
        }
      }
    }

    // 학습: 가맹점 → 분류 매핑 upsert (정합성과 무관하므로 RPC 밖에서 수행)
    if (item.guessed_merchant && item.guessed_type !== "transfer" && item.guessed_type !== "payment") {
      const owner = await getOwnerUid(supabase);
      if (owner && !shouldLearnMerchantKey(item.guessed_merchant)) {
        // ★짧은 상호는 **새 키를 만들지 않는다**(부분일치로 긴 상호를 전부 잡는다 — 2026-09-09 '카카오' 실사고).
        //   단 이미 있는 키(사르르·어서와 같은 실제 짧은 상호)는 확정 때 고친 분류로 **갱신은** 한다 — 막으면
        //   틀린 옛 분류가 매번 되살아난다(교차리뷰 Medium). update 는 행이 없으면 아무것도 안 한다.
        const { data: upd } = await supabase
          .from("hh_merchant_map")
          .update({
            category_id: item.guessed_category_id,
            payment_method_id: item.guessed_payment_method_id,
            account_id: item.guessed_account_id,
          })
          .eq("owner_auth_uid", owner)
          .eq("merchant_key", item.guessed_merchant)
          .select("id");
        if (!upd?.length) {
          // 일괄 확정에서 토스트가 건수만큼 쌓이지 않게 id 를 고정한다(같은 파일 inbox-inline-saved 와 같은 방식).
          toast.info(`상호 "${item.guessed_merchant}" 는 ${MERCHANT_LEARN_MIN_LEN}자 미만이라 새로 학습하지 않습니다.`, { id: "inbox-learn-skip" });
        }
      } else {
        if (owner) {
          await supabase.from("hh_merchant_map").upsert(
            {
              owner_auth_uid: owner,
              merchant_key: item.guessed_merchant,
              category_id: item.guessed_category_id,
              payment_method_id: item.guessed_payment_method_id,
              account_id: item.guessed_account_id,
            },
            { onConflict: "owner_auth_uid,merchant_key" }
          );
        }
      }
    }
    sendLog("CONFIRM_HH_INBOX", `수집함 확정: ${item.guessed_merchant} ${item.guessed_amount}원`, { resource: "hh_transaction", resource_id: txnId as string });
    return null;
  };

  // 여러 건 순차 확정(분류 완성건만). label=토스트 머리말.
  const confirmMany = async (targets: HhTransactionInbox[], skipped: number) => {
    setConfirmingAll(true);
    let ok = 0;
    let failed = 0;
    for (const it of targets) {
      const fail = await doConfirm(it);
      if (fail) failed += 1;
      else ok += 1;
    }
    setConfirmingAll(false);
    const parts = [`${ok}건 확정`];
    if (skipped) parts.push(`${skipped}건 분류 미완성으로 건너뜀`);
    if (failed) parts.push(`${failed}건 실패`);
    toast.success(parts.join(" / "));
    setSelected(new Set());
    await fetchData();
  };

  // 전체 확정: 검토대기 중 분류가 완성된 건만 순차 확정(미완성은 건너뜀).
  const confirmAll = async () => {
    const pendings = filteredItems.filter((it) => it.status === "pending");
    const ready = pendings.filter((it) => validateItem(it) === null);
    if (ready.length === 0) {
      return toast.error("확정 가능한 항목이 없습니다. 분류(카테고리·계좌·결제수단)를 먼저 채워주세요.");
    }
    const skipped = pendings.length - ready.length;
    if (!window.confirm(`검토대기 ${pendings.length}건 중 분류가 완성된 ${ready.length}건을 거래로 확정합니다.${skipped ? `\n(분류 미완성 ${skipped}건은 건너뜁니다.)` : ""}`)) {
      return;
    }
    await confirmMany(ready, skipped);
  };

  // 선택 확정: 체크한 검토대기 행 중 분류 완성건만 확정.
  const confirmSelected = async () => {
    const chosen = filteredItems.filter((it) => it.status === "pending" && selected.has(it.id));
    if (chosen.length === 0) return toast.error("선택된 항목이 없습니다.");
    const ready = chosen.filter((it) => validateItem(it) === null);
    if (ready.length === 0) {
      return toast.error("선택한 항목 중 확정 가능한 게 없습니다. 분류(카테고리·계좌·결제수단)를 먼저 채워주세요.");
    }
    const skipped = chosen.length - ready.length;
    if (!window.confirm(`선택한 ${chosen.length}건 중 ${ready.length}건을 거래로 확정합니다.${skipped ? `\n(분류 미완성 ${skipped}건은 건너뜁니다.)` : ""}`)) {
      return;
    }
    await confirmMany(ready, skipped);
  };

  // 선택 비우기: 체크한 검토대기 행을 휴지통(ignored)으로 일괄 이동.
  const trashSelected = async () => {
    const ids = filteredItems.filter((it) => it.status === "pending" && selected.has(it.id)).map((it) => it.id);
    if (ids.length === 0) return toast.error("선택된 항목이 없습니다.");
    if (!window.confirm(`선택한 ${ids.length}건을 휴지통으로 보낼까요?`)) return;
    const { error: err } = await supabase.from("hh_transaction_inbox").update({ status: "ignored" }).in("id", ids);
    if (err) return toast.error(`비우기 실패: ${err.message}`);
    setItems((prev) => prev.map((it) => (ids.includes(it.id) ? { ...it, status: "ignored" as HhInboxStatus } : it)));
    setSelected(new Set());
    toast.success(`${ids.length}건을 휴지통으로 보냈습니다.`);
    await refreshCardBillDoneCheck();
  };

  // 휴지통 → 복원. ★실패할 수 있다(동일시각 인덱스 — 같은 키의 검토대기가 이미 있으면 막힌다.
  // 설계 163 §9-5). 그 pending 을 먼저 처리한 뒤 복원하면 된다.
  const restoreItem = async (item: HhTransactionInbox) => {
    if (await patchItem(item.id, { status: "pending" })) toast.success("검토대기로 복원했습니다.");
  };

  // 확정됨 → 검토대기 되돌리기 핵심 로직(확인창 없음). 성공=true.
  // 거래 삭제·상태 복원을 단일 RPC 트랜잭션으로 처리한다(설계 91) — 중간 실패 불일치 방지.
  // 확정이 만든 거래(source='inbox')만 삭제되고 수기 등 다른 소스는 링크만 해제, 할부 확정은 할부 마스터까지 삭제.
  const revertOne = async (it: HhTransactionInbox): Promise<boolean> => {
    const { error: err } = await supabase.rpc("hh_revert_inbox", { p_inbox_id: it.id });
    if (err) { toast.error(`되돌리기 실패: ${err.message}`); return false; }
    sendLog("UNCONFIRM_HH_INBOX", `수집함 되돌리기: ${it.guessed_merchant} ${it.guessed_amount}원`, { resource: "hh_transaction_inbox", resource_id: it.id });
    return true;
  };

  // 확정됨 → 검토대기로 되돌리기(단건).
  const unconfirmItem = async (item: HhTransactionInbox) => {
    if (item.guessed_kind === "cancel") {
      toast.error("승인취소 확정은 원 거래를 삭제했으므로 되돌릴 수 없습니다. 필요하면 원 지출을 수기로 다시 등록하세요.");
      return;
    }
    if (!window.confirm(`"${item.guessed_merchant ?? "이 항목"}"을(를) 검토대기로 되돌릴까요?\n확정 때 만든 거래가 삭제되고 다시 분류를 수정할 수 있습니다.`)) return;
    if (await revertOne(item)) {
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: "pending" as HhInboxStatus, confirmed_txn_id: null, confirmed_installment_id: null } : it)));
      setSelected((prev) => { const n = new Set(prev); n.delete(item.id); return n; });
      toast.success("검토대기로 되돌렸습니다.");
      await refreshCardBillDoneCheck();
    }
  };

  // 선택 되돌리기: 체크한 확정 행을 일괄로 검토대기로 되돌린다.
  const unconfirmSelected = async () => {
    const selectedItems = filteredItems.filter((it) => it.status === "confirmed" && selected.has(it.id));
    if (selectedItems.length === 0) return toast.error("선택된 항목이 없습니다.");
    const excludedCancelCount = selectedItems.filter((it) => it.guessed_kind === "cancel").length;
    const chosen = selectedItems.filter((it) => it.guessed_kind !== "cancel");
    if (excludedCancelCount > 0) toast.info(`승인취소 확정 ${excludedCancelCount}건은 복구 불가라 제외했습니다`);
    if (chosen.length === 0) return;
    if (!window.confirm(`선택한 ${chosen.length}건을 검토대기로 되돌릴까요?\n확정 때 만든 거래가 삭제됩니다.`)) return;
    let ok = 0;
    for (const it of chosen) { if (await revertOne(it)) ok += 1; }
    setSelected(new Set());
    toast.success(`${ok}건을 검토대기로 되돌렸습니다.${ok < chosen.length ? ` / ${chosen.length - ok}건 실패` : ""}`);
    await fetchData();
  };

  // 확정됨 → 보관(검수완료): 확정 탭에서 숨긴다. 거래는 유지. (설계 docs/household/55)
  const archiveItem = async (item: HhTransactionInbox) => {
    if (await patchItem(item.id, { status: "archived" })) toast.success("보관했습니다.");
  };

  // 선택 보관: 체크한 확정 행을 일괄 보관.
  const archiveSelected = async () => {
    const ids = filteredItems.filter((it) => it.status === "confirmed" && selected.has(it.id)).map((it) => it.id);
    if (ids.length === 0) return toast.error("선택된 항목이 없습니다.");
    if (!window.confirm(`선택한 ${ids.length}건을 보관할까요? (검수완료로 확정 탭에서 숨겨집니다)`)) return;
    const { error: err } = await supabase.from("hh_transaction_inbox").update({ status: "archived" }).in("id", ids);
    if (err) return toast.error(`보관 실패: ${err.message}`);
    setItems((prev) => prev.map((it) => (ids.includes(it.id) ? { ...it, status: "archived" as HhInboxStatus } : it)));
    setSelected(new Set());
    toast.success(`${ids.length}건을 보관했습니다.`);
    await refreshCardBillDoneCheck();
  };

  // 보관 → 확정으로 복원
  const unarchiveItem = async (item: HhTransactionInbox) => {
    if (await patchItem(item.id, { status: "confirmed" })) toast.success("확정으로 복원했습니다.");
  };

  // 영구삭제(되돌릴 수 없음)
  const deleteItem = async (item: HhTransactionInbox) => {
    if (!window.confirm("이 항목을 완전히 삭제할까요? 되돌릴 수 없습니다.")) return;
    const { error: err } = await supabase.from("hh_transaction_inbox").delete().eq("id", item.id);
    if (err) return toast.error(`삭제 실패: ${err.message}`);
    setItems((prev) => prev.filter((it) => it.id !== item.id));
    toast.success("삭제했습니다.");
    await refreshCardBillDoneCheck();
  };

  const emptyTrash = async () => {
    const trash = filteredItems.filter((it) => it.status === "ignored" || it.status === "duplicate");
    if (trash.length === 0) return;
    if (!window.confirm(`휴지통의 ${trash.length}건을 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;
    const ids = trash.map((it) => it.id);
    const { error: err } = await supabase.from("hh_transaction_inbox").delete().in("id", ids);
    if (err) return toast.error(`삭제 실패: ${err.message}`);
    setItems((prev) => prev.filter((it) => !ids.includes(it.id)));
    toast.success(`휴지통 ${ids.length}건을 비웠습니다.`);
    await refreshCardBillDoneCheck();
  };

  // 검색 필터(키워드 + 기간). 건수·탭·목록 모두 이 결과 기준. 날짜 없는 항목은 기간과 무관하게 항상 표시(큐 유실 방지).
  // (React Compiler 자동 메모이제이션 — 수동 useMemo는 이 파일 조합에서 보존 불가로 걸려 일반 파생값으로 둔다.)
  const kw = search.trim().toLowerCase();
  const filteredItems = items.filter((it) => {
    const gd = it.guessed_date;
    if (range.start && gd && gd < range.start) return false;
    if (range.end && gd && gd > range.end) return false;
    if (!kw) return true;
    const hay = [
      it.guessed_merchant, it.user_memo, it.raw_text, it.guessed_institution,
      categoryName(it.guessed_category_id),
      it.guessed_payment_method_id ? methodName(it.guessed_payment_method_id) : "",
      it.guessed_account_id ? accountName(it.guessed_account_id) : "",
      it.guessed_from_account_id ? accountName(it.guessed_from_account_id) : "",
      it.guessed_to_account_id ? accountName(it.guessed_to_account_id) : "",
    ].join("\n").toLowerCase();
    return hay.includes(kw);
  });

  // 기간 때문에 목록에서 빠진 '검토 대기' 건수(키워드 무관). 0이면 배너를 띄우지 않는다.
  const hiddenPendingCount = items.filter((it) => {
    if (it.status !== "pending") return false;
    const gd = it.guessed_date;
    if (!gd) return false; // 날짜 없는 항목은 애초에 기간 필터를 안 탄다
    return Boolean((range.start && gd < range.start) || (range.end && gd > range.end));
  }).length;

  // (파생값 — filteredItems가 일반 값이라 수동 useMemo는 컴파일러가 거부. React Compiler 자동 메모에 맡긴다.)
  const counts: Record<HhInboxStatus, number> = { pending: 0, confirmed: 0, ignored: 0, duplicate: 0, archived: 0 };
  for (const it of filteredItems) counts[it.status]++;
  const trashCount = counts.ignored + counts.duplicate;
  const selectedPendingCount = filteredItems.filter((it) => it.status === "pending" && selected.has(it.id)).length;
  const selectedConfirmedCount = filteredItems.filter((it) => it.status === "confirmed" && selected.has(it.id)).length;

  // 현재 탭의 상태 행(컬럼 필터 적용 전) — 헤더 드롭다운 옵션 산출용. (설계 69 2차)
  const activeStatusRows =
    tab === "trash"
      ? filteredItems.filter((it) => it.status === "ignored" || it.status === "duplicate")
      : filteredItems.filter((it) => it.status === tab);

  const renderTable = (tab: InboxTab) => {
    const statusRows =
      tab === "trash"
        ? filteredItems.filter((it) => it.status === "ignored" || it.status === "duplicate")
        : filteredItems.filter((it) => it.status === tab);
    // (archived 탭은 status === "archived" 로 위 filter가 처리)

    // 컬럼 헤더 필터(엑셀 오토필터식) 적용. 여러 컬럼 AND. (설계 69 2차)
    const rows = statusRows.filter(passesColFilters);

    if (statusRows.length === 0) {
      if (tab === "pending") {
        return (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-background/80 text-muted-foreground">
              <Inbox className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">검토할 항목이 없습니다.</p>
            <p className="mx-auto mt-1 hidden max-w-md text-sm leading-6 text-muted-foreground md:block">
              결제·입금 문자나 명세서로 자동 수집되거나 직접 추가한 거래가 여기에 모입니다. 확정하면 수입·지출에 반영됩니다.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" />수동 추가</Button>
              <Button variant="outline" onClick={() => setUploadOpen(true)}><FileUp className="h-4 w-4" />명세서 업로드</Button>
              <Button variant="outline" asChild><Link href="/dashboard/household/settings"><Settings className="h-4 w-4" />문자 자동수집 설정</Link></Button>
            </div>
          </div>
        );
      }
      const emptyLabel =
        tab === "trash"
          ? "휴지통이 비어 있습니다."
          : tab === "archived"
            ? "보관한 항목이 없습니다. 확정 탭에서 검수 후 보관하면 여기로 모입니다."
            : "확정한 거래가 없습니다. 검토대기에서 확정하면 여기에 모입니다.";
      return (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        </div>
      );
    }
    const editable = tab === "pending";
    const isTrash = tab === "trash";
    const isConfirmed = tab === "confirmed";
    const isArchived = tab === "archived";
    const selectable = editable || isConfirmed; // 체크박스 노출: 검토대기(확정/비우기)·확정됨(보관)
    const hasAction = isTrash || isConfirmed || isArchived; // 마지막 액션 컬럼
    // 탭에 따라 열 수가 달라지므로 폭 배열도 여기서 고른다. (설계 122)
    const colWidths = isTrash ? COL_WIDTHS_TRASH : hasAction ? COL_WIDTHS_ACTION : COL_WIDTHS;

    // 필터 가능 컬럼 헤더: 텍스트 + ▾. 필터 걸린 컬럼은 primary 강조. 클릭 시 fixed 드롭다운 좌표 저장. (설계 69 2차)
    const filterHeader = (col: FilterCol, label: string) => (
      <button
        type="button"
        className={`flex items-center gap-1 ${colFilters[col] ? "font-semibold text-primary" : "hover:text-foreground"}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setFilterMenu((m) => (m?.col === col ? null : { col, x: r.left, y: r.bottom }));
        }}
      >
        {label}
        <ChevronDown className={`h-3.5 w-3.5 ${colFilters[col] ? "opacity-100" : "opacity-40"}`} />
      </button>
    );



    return (
      <div className="space-y-3">
      {/* 모바일: 표 헤더가 없으니 컬럼 필터를 상단 select 줄로 제공(데스크톱은 헤더 클릭). (설계 69 2차) */}
      <div className="flex flex-wrap gap-2 md:hidden">
        {FILTER_COLS.map(({ col, label }) => {
          const { entries, unsetCount } = columnOptions(col, statusRows);
          if (entries.length === 0 && unsetCount === 0) return null;
          return (
            <select
              key={col}
              className={`${selectClass} max-w-[9.5rem] ${colFilters[col] ? "border-primary text-primary" : ""}`}
              value={colFilters[col]}
              onChange={(e) => setColFilter(col, e.target.value)}
            >
              <option value="">{label}: 전체</option>
              {unsetCount > 0 ? <option value={UNSET}>(미지정) ({unsetCount})</option> : null}
              {entries.map(([v, c]) => (<option key={v} value={v}>{v} ({c})</option>))}
            </select>
          );
        })}
      </div>

      {/* 필터 적용 표시 + 초기화(모바일·데스크톱 공통). 데스크톱은 헤더 클릭으로 걸고 여기서 한 번에 푼다. (설계 69 2차) */}
      {activeFilterCount > 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>필터 {activeFilterCount}개 적용 중 · {rows.length}건</span>
          <Button variant="ghost" size="sm" onClick={clearColFilters}><X className="h-4 w-4" /> 초기화</Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">이 조건에 해당하는 항목이 없습니다.</p>
          {activeFilterCount > 0 ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={clearColFilters}>
              <X className="h-4 w-4" /> 필터 초기화
            </Button>
          ) : null}
        </div>
      ) : (
      <>
      {/* 모바일: 표 대신 카드 스택 (가로 스크롤 제거, 큰 버튼) */}
      <div className="space-y-3 md:hidden">
        {rows.map((it, idx) => {
          const cats = categories.filter((c) => c.kind === categoryKindForInbox(it.guessed_type) && (c.is_active || c.id === it.guessed_category_id));
          const acctOpts = accounts.filter((a) => a.is_active || [it.guessed_from_account_id, it.guessed_to_account_id, it.guessed_account_id].includes(a.id));
          const methodOpts = methods.filter((m) => m.is_active || m.id === it.guessed_payment_method_id);
          const isTransfer = it.guessed_type === "transfer";
          const isPayment = it.guessed_type === "payment";
          return (
            <div key={it.id} className={`space-y-2 rounded-2xl border bg-card/85 p-3 shadow-sm ${selectable && selected.has(it.id) ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  {selectable ? (
                    <input type="checkbox" className="mt-1 size-4 shrink-0" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} aria-label="선택" />
                  ) : null}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="tabular-nums font-medium text-foreground">{idx + 1}</span>
                      <Badge variant="secondary">{sourceLabel(it.source)}</Badge>
                      {isAutoFiltered(it) ? (
                        <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground">자동 걸러짐</Badge>
                      ) : null}
                      <span>{it.guessed_date ?? "-"}</span>
                      {it.guessed_date && it.guessed_time ? (
                        <span className="tabular-nums text-muted-foreground">{it.guessed_time}</span>
                      ) : null}
                    </div>
                    <p className={`mt-1 ${HH_CELL.wrapText} font-medium text-foreground`} title={merchantDisplay(it.guessed_merchant).title}>{merchantDisplay(it.guessed_merchant).text}</p>
                    {it.guessed_institution ? (
                      <p className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>{it.guessed_institution}</p>
                    ) : null}
                    {/* 카드론 조건(설계 181): 표 셀이라 조각마다 요소를 쌓는다 — 한 노드가 두 줄로 꺾이면 H 위반 */}
                    {it.guessed_loan_terms
                      ? formatLoanTermsParts(it.guessed_loan_terms).map((part) => (
                          <p key={part} className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>{part}</p>
                        ))
                      : null}
                    {it.guessed_loan_terms ? renderLoanRegister(it) : null}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums text-sm">{(it.guessed_amount ?? 0).toLocaleString("ko-KR")}원</p>
                  {isTrash ? (
                    <Badge variant="secondary" className="mt-1">{INBOX_STATUS_LABEL[it.status]}</Badge>
                  ) : null}
                </div>
              </div>

              {editable ? (
                <div className="space-y-2">
                  <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="shrink-0">유형</span>
                    <select className={`${selectClass} w-40`} value={it.guessed_type ?? "expense"} onChange={(e) => changeType(it, e.target.value)}>
                      {TYPE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                    </select>
                  </label>
                  {!isTransfer && !isPayment ? (
                    <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="shrink-0">카테고리</span>
                      <select className={`${selectClass} w-40`} value={it.guessed_category_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_category_id: e.target.value || null })}>
                        <option value="">선택</option>
                        {cats.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                      </select>
                    </label>
                  ) : null}
                  {isTransfer ? (
                    <div className="space-y-1">
                      <select className={`${selectClass} w-full`} value={it.guessed_from_account_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_from_account_id: e.target.value || null })}>
                        <option value="">출금계좌</option>
                        {acctOpts.map((a) => (<option key={a.id} value={a.id}>{acctLabel(a)}</option>))}
                      </select>
                      <select className={`${selectClass} w-full`} value={it.guessed_to_account_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_to_account_id: e.target.value || null })}>
                        <option value="">입금계좌</option>
                        {acctOpts.map((a) => (<option key={a.id} value={a.id}>{acctLabel(a)}</option>))}
                      </select>
                    </div>
                  ) : isPayment ? (
                    <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="shrink-0">출금계좌</span>
                      <select className={`${selectClass} w-40`} value={it.guessed_from_account_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_from_account_id: e.target.value || null })}>
                        <option value="">선택</option>
                        {acctOpts.map((a) => (<option key={a.id} value={a.id}>{acctLabel(a)}</option>))}
                      </select>
                    </label>
                  ) : it.guessed_type === "income" ? (
                    <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="shrink-0">입금계좌</span>
                      <select className={`${selectClass} w-40`} value={it.guessed_account_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_account_id: e.target.value || null })}>
                        <option value="">선택</option>
                        {acctOpts.map((a) => (<option key={a.id} value={a.id}>{acctLabel(a)}</option>))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="shrink-0">결제/출금계좌</span>
                        <select className={`${selectClass} w-40`} value={paymentSelectValue(it)} onChange={(e) => changePayment(it, e.target.value)}>
                          <option value="">선택</option>
                          <optgroup label="결제수단(카드/현금)">
                            {methodOpts.map((m) => (<option key={m.id} value={`pm:${m.id}`}>{methodLabel(m)}</option>))}
                          </optgroup>
                          <optgroup label="출금계좌">
                            {acctOpts.map((a) => (<option key={a.id} value={`ac:${a.id}`}>{acctLabel(a)}</option>))}
                          </optgroup>
                        </select>
                      </label>
                      {it.guessed_type === "installment" ? (
                        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="shrink-0">할부 개월수</span>
                          <input
                            type="number"
                            min={2}
                            // ★select 용 클래스를 쓰면 안 된다 — hh-select 의 배경 화살표가 숫자 입력칸에 붙는다.
                            className={`${inputClass} w-40`}
                            value={it.guessed_installment_months ?? ""}
                            placeholder="개월(2 이상)"
                            onChange={(e) => void patchItem(it.id, { guessed_installment_months: e.target.value ? Math.max(2, parseInt(e.target.value, 10) || 0) : null })}
                          />
                        </label>
                      ) : null}
                    </>
                  )}
                  <input
                    type="text"
                    className="h-11 w-full rounded-md border border-input bg-background px-2 text-base focus-visible:border-ring focus-visible:outline-none"
                    defaultValue={it.user_memo ?? ""}
                    placeholder="사용내역"
                    title={it.raw_text ?? undefined}
                    onBlur={(e) => saveMemo(it, e.target.value)}
                  />
                </div>
              ) : isTrash ? (
                <div className="flex gap-2">
                  <Button variant="outline" className="h-11 flex-1" onClick={() => restoreItem(it)}>
                    <RotateCcw className="h-4 w-4 text-sky-600" /> 복원
                  </Button>
                  <Button variant="outline" className="h-11 flex-1" onClick={() => deleteItem(it)}>
                    <Trash2 className="h-4 w-4 text-destructive" /> 영구삭제
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="space-y-0.5 text-sm text-muted-foreground">
                    <p>유형 · {inboxTypeLabel(it.guessed_type)}</p>
                    {isTransfer ? (
                      <>
                        <p>입금처 · {it.guessed_to_account_id ? accountName(it.guessed_to_account_id) : merchantDisplay(it.guessed_merchant).text}</p>
                        <p>출금계좌 · {accountName(it.guessed_from_account_id)}</p>
                      </>
                    ) : (
                      // ★납부 행은 이 칸에 카테고리가 아니라 **대출 이름**이 온다 — 데스크톱 셀과 같은 함수를 써야
                      //   필터(columnValue)와 목록이 같은 행을 두 이름으로 부르지 않는다.
                      (() => {
                        const c = categoryDisplay(isPayment ? paymentKindDisplay(it) : categoryName(it.guessed_category_id));
                        return <p title={c.title}>카테고리 · {c.text}</p>;
                      })()
                    )}
                    <p className={HH_CELL.wrapText} title={it.raw_text ?? ""}>내역 · {memoDisplay(it.user_memo, it.guessed_merchant).text}</p>
                  </div>
                  {isConfirmed ? (
                    <div className="flex gap-2">
                      {it.guessed_kind === "cancel" ? (
                        <Button variant="outline" className="h-11 flex-1" disabled title="승인취소 확정은 원 거래를 삭제했으므로 되돌릴 수 없습니다.">
                          <Undo2 className="h-4 w-4 text-muted-foreground" /> 복구 불가
                        </Button>
                      ) : (
                        <Button variant="outline" className="h-11 flex-1" onClick={() => void unconfirmItem(it)}>
                          <Undo2 className="h-4 w-4 text-amber-600" /> 검토대기로
                        </Button>
                      )}
                      <Button variant="outline" className="h-11 flex-1" onClick={() => void archiveItem(it)}>
                        <Archive className="h-4 w-4 text-muted-foreground" /> 보관
                      </Button>
                    </div>
                  ) : isArchived ? (
                    <Button variant="outline" className="h-11 w-full" onClick={() => void unarchiveItem(it)}>
                      <RotateCcw className="h-4 w-4 text-sky-600" /> 확정으로 복원
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 데스크톱: 표 */}
      <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-background/40 md:block">
        {/*
          ★휴지통 탭만 A'(슬랙 균등) 판정에서 뺀다. 열 폭은 **탭 전체가 공유**하는데, 휴지통에 남는 건
          광고·중복 같은 부스러기라 가맹점·사용내역이 유난히 짧다(실측: 사용내역 안쪽 186 에 최대 '이바다' 32).
          열을 그 탭에 맞춰 좁히면 **검토대기·확정 탭에서 실제 상호와 메모가 잘린다**(설계 123 위반) —
          즉 폭으로는 풀 수 없고, 팀장이 고른 "두 줄 방지 우선"의 대가다(설계 125에 같은 결론).
          허용치(GAP_TOL_PX)를 또 올리는 대신 이 한 탭만 뺀다 — 올리면 팀장이 실제로 잡아낸
          130~250px 어긋남까지 통과해 검사기가 죽는다.
          ★`data-uniform-exempt` 가 아니라 `data-slack-exempt` 다 — 앞엣것은 **잘림·줄꺾임 검사까지 함께 꺼서**
          이 탭에서 글자가 잘려도 아무도 모르게 된다. 빼는 건 A' 하나뿐이다.

          ★2026-08-09: **검토대기 탭도 같은 사유로 뺀다.** 이 탭에는 아직 확정 안 한 소수 건만 남는데
          (평상시 0~수 건, 실측 시점엔 1건) 그 한 건의 상호가 짧으면 가맹점 열(208)에 136.7px 이 빈다.
          건수가 적을수록 심해지는 구조라 데이터로는 절대 수렴하지 않고, 열을 이 탭에 맞춰 좁히면
          138건이 든 확정 탭에서 상호가 잘린다(오늘 208→112 로 좁혔다가 평범한 상호 수십 개가 꺾였다).
          ⚠️**A' 만 끈다 — 이 탭의 잘림·줄꺾임·헤더꺾임 검사는 그대로 살아 있다.**
        */}
        <table
          className="table-fixed text-[0.8rem]"
          style={{ width: tableMinWidth(colWidths) }}
          {...(isTrash
            ? { "data-slack-exempt": "휴지통 탭은 값이 부스러기라 열 폭(탭 공유)과 슬랙을 함께 맞출 수 없다" }
            : editable
              ? { "data-slack-exempt": "검토대기 탭은 미확정 소수 건만 남아 건수가 적을수록 슬랙이 커진다 — 열 폭은 확정 탭(138건)에 맞춰야 한다" }
              : {})}
        >
          <colgroup>
            {colStyles(colWidths).map((st, i) => <col key={i} style={st} />)}
          </colgroup>
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr className="whitespace-nowrap">
              <th className="px-3 py-2 font-medium">
                {selectable ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                      onChange={() => toggleSelectAll(rows)}
                      aria-label="전체 선택"
                    />
                    <span className="flex items-center gap-1">{filterHeader("source", "수집")}</span>
                  </label>
                ) : (
                  filterHeader("source", "수집")
                )}
              </th>
              <th className="px-3 py-2 font-medium">{filterHeader("date", "날짜")}</th>
              <th className="px-3 py-2 font-medium">{filterHeader("merchant", "가맹점/입금처")}</th>
              <th className="px-3 py-2 font-medium text-right">금액</th>
              <th className="px-3 py-2 font-medium">{filterHeader("type", "유형")}</th>
              <th className="px-3 py-2 font-medium">{filterHeader("category", "카테고리")}</th>
              <th className="px-3 py-2 font-medium">{filterHeader("account", "결제/출금계좌")}</th>
              <th className="px-3 py-2 font-medium">사용내역</th>
              {isTrash ? <th className="px-3 py-2 font-medium">상태</th> : null}
              {/* 액션 열은 오른쪽에 고정한다(설계 138) — 기본 8열 합계가 1160 인데 페이지 가용폭이 1198 이라
                  액션 열은 어떤 폭을 줘도 밖으로 밀려 잘렸다(실측: 버튼 1645~1679 vs 보이는 끝 1655).
                  폭을 줄이면 설계 125 가 고친 줄꺾임이 되살아나므로, 폭은 그대로 두고 위치만 고정한다. */}
              {hasAction ? <th className="sticky right-0 z-20 border-l border-border/50 bg-background px-3 py-2 font-medium"></th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((it, idx) => {
              const cats = categories.filter((c) => c.kind === categoryKindForInbox(it.guessed_type) && (c.is_active || c.id === it.guessed_category_id));
              const acctOpts = accounts.filter((a) => a.is_active || [it.guessed_from_account_id, it.guessed_to_account_id, it.guessed_account_id].includes(a.id));
              const methodOpts = methods.filter((m) => m.is_active || m.id === it.guessed_payment_method_id);
              const isTransfer = it.guessed_type === "transfer";
              const isPayment = it.guessed_type === "payment";
              const merchant = merchantDisplay(it.guessed_merchant);
              const memo = memoDisplay(it.user_memo, it.guessed_merchant);
              return (
                <tr key={it.id} className={`border-b border-border/50 last:border-0 hover:bg-muted/40 ${selectable && selected.has(it.id) ? "bg-primary/5" : ""}`}>
                  <td className="px-3 py-1 align-middle text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      {selectable ? (
                        <input type="checkbox" className="size-4 shrink-0" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} aria-label="선택" />
                      ) : null}
                      <span className="tabular-nums text-foreground">{idx + 1}</span>
                      <span className={HH_CELL.wrapText}>{sourceLabel(it.source)}</span>
                      {isAutoFiltered(it) ? (
                        <Badge variant="outline" className="border-muted-foreground/30 text-[10px] text-muted-foreground">자동</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-1 align-middle">
                    <div className="tabular-nums">{it.guessed_date ?? "-"}</div>
                    {it.guessed_date && it.guessed_time ? (
                      <div className="text-xs tabular-nums text-muted-foreground">{it.guessed_time}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-1 align-middle">
                    {isTransfer && editable ? (
                      // 이체: '입금처'(도착계좌)를 이 칸에서 고른다. 원문 상대처는 아래 보조표기. (설계 docs/household/59 개정)
                      <div className="space-y-1">
                        <select
                          className={`${selectClass} w-full`}
                          value={it.guessed_to_account_id ?? ""}
                          onChange={(e) => void patchItem(it.id, { guessed_to_account_id: e.target.value || null })}
                        >
                          <option value="">입금처(계좌)</option>
                          {acctOpts.map((a) => (
                            <option key={a.id} value={a.id}>{acctLabel(a)}</option>
                          ))}
                        </select>
                        {it.guessed_merchant ? (
                          <div className={`${HH_CELL.wrapText} text-xs text-muted-foreground`} title={merchant.title}>{merchant.text}</div>
                        ) : null}
                      </div>
                    ) : isTransfer ? (
                      // 이체 읽기전용: 입금처 = 도착계좌명(없으면 원문 상대처).
                      <>
                        <div className={HH_CELL.wrapText} title={it.guessed_to_account_id ? undefined : merchant.title}>
                          {it.guessed_to_account_id ? accountName(it.guessed_to_account_id) : merchant.text}
                        </div>
                        {/* ★도착계좌를 못 찾았으면 위 줄이 이미 상대처다 — 보조 줄을 또 그리면 같은 문자열이 두 번 나온다. */}
                        {it.guessed_merchant && it.guessed_to_account_id ? (
                          <div className={`${HH_CELL.wrapText} text-xs text-muted-foreground`} title={merchant.title}>{merchant.text}</div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div className={HH_CELL.wrapText} title={merchant.title}>{merchant.text}</div>
                        {it.guessed_institution ? (
                          <div className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>{it.guessed_institution}</div>
                        ) : null}
                        {it.guessed_loan_terms
                          ? formatLoanTermsParts(it.guessed_loan_terms).map((part) => (
                              <p key={part} className={`${HH_CELL.wrapText} text-xs text-muted-foreground`}>{part}</p>
                            ))
                          : null}
                        {it.guessed_loan_terms ? renderLoanRegister(it) : null}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-1 align-middle text-right tabular-nums whitespace-nowrap">{(it.guessed_amount ?? 0).toLocaleString("ko-KR")}원</td>
                  <td className="px-3 py-1 align-middle">
                    {editable ? (
                      <select className={`${selectClass} w-full`} value={it.guessed_type ?? "expense"} onChange={(e) => changeType(it, e.target.value)}>
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      inboxTypeLabel(it.guessed_type)
                    )}
                  </td>
                  <td className="px-3 py-1 align-middle">
                    {isTransfer ? (
                      // 이체는 카테고리가 없다 — 은행명 대신 '이체'로 표기. 입금처는 '가맹점/입금처' 칸으로 옮김. (설계 docs/household/59 개정)
                      <span className={`block ${HH_CELL.wrapText} text-muted-foreground`}>이체</span>
                    ) : isPayment ? (
                      // 납부는 카테고리 대신 '어느 대출인지'를 고른다 — 이 칸을 그대로 쓴다(컬럼 추가 없음). (설계 94)
                      // 안 고르면 카드대금 등 대출 아닌 납부로 취급(기존 동작). 강제하지 않는 이유는 설계 94 §2 C.
                      editable ? (
                        <select
                          className={`${selectClass} w-full`}
                          value={paymentKindValue(it)}
                          onChange={(e) => changePaymentKind(it, e.target.value)}
                          title="이 납부가 카드대금인지, 어느 대출의 상환인지 고르면 확정할 때 함께 분류됩니다."
                        >
                          <option value="">선택</option>
                          {cardPaymentCatId ? <option value={`cat:${cardPaymentCatId}`}>카드대금</option> : null}
                          {loanOptions(it).map((g) => (
                            <optgroup key={g.label} label={g.label}>
                              {g.loans.map((l) => (
                                <option key={l.id} value={`loan:${l.id}`}>
                                  {l.name}
                                  {l.monthly_payment ? ` (월 ${l.monthly_payment.toLocaleString("ko-KR")}원)` : ""}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      ) : (
                        <span className={`block ${HH_CELL.wrapText} text-muted-foreground`} title={categoryDisplay(paymentKindDisplay(it)).title}>{categoryDisplay(paymentKindDisplay(it)).text}</span>
                      )
                    ) : editable ? (
                      <select className={`${selectClass} w-full`} value={it.guessed_category_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_category_id: e.target.value || null })}>
                        <option value="">선택</option>
                        {cats.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`block ${HH_CELL.wrapText}`} title={categoryDisplay(categoryName(it.guessed_category_id)).title}>{categoryDisplay(categoryName(it.guessed_category_id)).text}</span>
                    )}
                  </td>
                  <td className="px-3 py-1 align-middle">
                    {isTransfer ? (
                      editable ? (
                        // 이 칸은 '출금계좌'(출발). 입금처(도착)는 '가맹점/입금처' 칸으로 옮겼다. (설계 docs/household/59 개정)
                        <select
                          className={`${selectClass} w-full`}
                          value={it.guessed_from_account_id ?? ""}
                          onChange={(e) => void patchItem(it.id, { guessed_from_account_id: e.target.value || null })}
                        >
                          <option value="">출금계좌</option>
                          {acctOpts.map((a) => (
                            <option key={a.id} value={a.id}>{acctLabel(a)}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`block ${HH_CELL.wrapText} text-muted-foreground`}>{accountName(it.guessed_from_account_id) ?? "-"}</span>
                      )
                    ) : isPayment ? (
                      // 납부: 출금계좌(from)만. 카드대금·대출은 이 계좌에서 −금액(지출집계 제외). (설계 docs/household/69)
                      editable ? (
                        <select
                          className={`${selectClass} w-full`}
                          value={it.guessed_from_account_id ?? ""}
                          onChange={(e) => void patchItem(it.id, { guessed_from_account_id: e.target.value || null })}
                        >
                          <option value="">출금계좌</option>
                          {acctOpts.map((a) => (
                            <option key={a.id} value={a.id}>{acctLabel(a)}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`block ${HH_CELL.wrapText} text-muted-foreground`}>{accountName(it.guessed_from_account_id) ?? "-"}</span>
                      )
                    ) : editable ? (
                      it.guessed_type === "income" ? (
                        <select className={`${selectClass} w-full`} value={it.guessed_account_id ?? ""} onChange={(e) => void patchItem(it.id, { guessed_account_id: e.target.value || null })}>
                          <option value="">입금계좌</option>
                          {acctOpts.map((a) => (
                            <option key={a.id} value={a.id}>{acctLabel(a)}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="space-y-1">
                          <select className={`${selectClass} w-full`} value={paymentSelectValue(it)} onChange={(e) => changePayment(it, e.target.value)}>
                            <option value="">선택</option>
                            <optgroup label="결제수단(카드/현금)">
                              {methodOpts.map((m) => (
                                <option key={m.id} value={`pm:${m.id}`}>{methodLabel(m)}</option>
                              ))}
                            </optgroup>
                            <optgroup label="출금계좌">
                              {acctOpts.map((a) => (
                                <option key={a.id} value={`ac:${a.id}`}>{acctLabel(a)}</option>
                              ))}
                            </optgroup>
                          </select>
                          {/* 복합 셀(숫자 입력 + '개월' 라벨) — 입력칸이 셀을 꽉 채울 수 없어 균등 검사에서 면제한다. */}
                          {it.guessed_type === "installment" ? (
                            <div className="flex items-center gap-1" data-uniform-exempt="할부 개월 입력 + '개월' 라벨이 한 셀에 든 복합 셀">
                              <input
                                type="number"
                                min={2}
                                className={`${inputClass} w-16`}
                                value={it.guessed_installment_months ?? ""}
                                placeholder="개월"
                                onChange={(e) => void patchItem(it.id, { guessed_installment_months: e.target.value ? Math.max(2, parseInt(e.target.value, 10) || 0) : null })}
                              />
                              <span className="text-xs text-muted-foreground">개월</span>
                            </div>
                          ) : null}
                        </div>
                      )
                    ) : it.guessed_type !== "income" ? (
                      <span className={`block ${HH_CELL.wrapText} text-muted-foreground`}>
                        {paymentDisplay(it)}
                        {it.guessed_type === "installment" && it.guessed_installment_months ? ` · ${it.guessed_installment_months}개월` : ""}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-1 align-middle">
                    {editable ? (
                      <input
                        key={it.id}
                        type="text"
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-base md:text-xs focus-visible:border-ring focus-visible:outline-none"
                        // ★편집칸에는 **저장 원문**을 넣는다. 축약값을 넣으면 사용자가 한 글자만 고쳐도
                        //   꼬리표가 날아간 값이 그대로 저장돼 표시 전용 축약이 DB 를 오염시킨다.
                        defaultValue={it.user_memo ?? ""}
                        placeholder="사용내역"
                        title={it.raw_text ?? undefined}
                        onBlur={(e) => saveMemo(it, e.target.value)}
                      />
                    ) : (
                      // 축약했으면 원문 메모를, 아니면 종전대로 수집 문자 원문을 툴팁으로 남긴다.
                      <span
                        className={`block w-full ${HH_CELL.wrapText} text-muted-foreground`}
                        title={memo.title && memo.title !== memo.text ? `${memo.title}\n\n${it.raw_text ?? ""}`.trim() : (it.raw_text ?? "")}
                      >
                        {memo.text}
                      </span>
                    )}
                  </td>
                  {isTrash ? (
                    <td className="px-3 py-1 align-middle">
                      <Badge variant="secondary">{INBOX_STATUS_LABEL[it.status]}</Badge>
                    </td>
                  ) : null}
                  {hasAction ? (
                    <td className="sticky right-0 z-10 border-l border-border/50 bg-background px-3 py-1 align-middle">
                      <div className="flex justify-end gap-1">
                        {isTrash ? (
                          <>
                            <Button variant="ghost" size="sm" title="복원" onClick={() => restoreItem(it)}>
                              <RotateCcw className="h-4 w-4 text-sky-600" />
                            </Button>
                            <Button variant="ghost" size="sm" title="영구삭제" onClick={() => deleteItem(it)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        ) : isConfirmed ? (
                          <>
                            {it.guessed_kind === "cancel" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="승인취소 확정은 원 거래를 삭제했으므로 되돌릴 수 없습니다. 필요하면 원 지출을 수기로 다시 등록하세요."
                                disabled
                              >
                                <Undo2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" title="검토대기로 되돌리기" onClick={() => void unconfirmItem(it)}>
                                <Undo2 className="h-4 w-4 text-amber-600" />
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" title="보관(검수완료)" onClick={() => archiveItem(it)}>
                              <Archive className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </>
                        ) : isArchived ? (
                          <Button variant="ghost" size="sm" title="확정으로 복원" onClick={() => unarchiveItem(it)}>
                            <RotateCcw className="h-4 w-4 text-sky-600" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
      </div>
    );
  };

  return (
    <PageShell>
      <HhPageHeader
        title="수집함"
        description="자동·수동으로 모은 거래 후보를 점검하고 확정하면 수입/지출로 반영됩니다."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/dashboard/household/settings">
                <Settings className="h-4 w-4" /> 설정
              </Link>
            </Button>
            {/* 토스 이자 빠른 입력. 며칠 비면 버튼 자체가 경고색으로 바뀌어 눈에 띈다. (설계 172) */}
            <Button
              variant={interestWarn ? "default" : "outline"}
              className={interestWarn ? "bg-amber-600 text-white hover:bg-amber-700" : ""}
              onClick={() => setQuickOpen(true)}
              title={
                interestProbe.failed
                  ? "이자 기록을 확인하지 못했습니다 (조회 실패)"
                  : !worstGap
                    ? "토스 이자 기록이 없습니다"
                    : `가장 오래 빈 계좌: ${worstGap.accountName} — 마지막 ${worstGap.lastDate ?? "?"} (${worstGap.days}일 전)`
              }
            >
              <Coins className="h-4 w-4" /> 토스 이자
              {interestWarn ? (
                <span className="ml-1 rounded-full bg-white/25 px-1.5 py-0.5 text-xs">
                  {interestDays === null ? "기록 없음" : `${interestDays}일째`}
                </span>
              ) : null}
            </Button>
            <Button variant="outline" onClick={() => setUploadOpen(true)}>
              <FileUp className="h-4 w-4" /> 명세서 업로드
            </Button>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> 수동 추가
            </Button>
          </div>
        }
      />

      <HhSearchBar
        compact
        range={range}
        onRangeChange={setRange}
        keyword={search}
        onKeywordChange={setSearch}
        keywordPlaceholder="가맹점·내역·카테고리·계좌로 검색"
        defaultPreset="thisMonth"
      />

      {/* 기간 밖에 숨은 대기 항목 알림 — 기본이 당월이라 지난달 미확정 건이 조용히 사라지는 걸 막는다. */}
      {hiddenPendingCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-2.5 text-sm dark:bg-amber-950/30">
          <span className="text-amber-700 dark:text-amber-400">
            검색 기간 밖에 확정하지 않은 항목이 <span className="font-semibold">{hiddenPendingCount}</span>건 있습니다.
          </span>
          <Button size="sm" variant="outline" onClick={() => setRange({ start: "", end: "" })}>
            전체 기간 보기
          </Button>
        </div>
      ) : null}

      {cardBillDoneCheck.failed ? (
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          카드대금 출금 점검을 불러오지 못했습니다
        </div>
      ) : cardBillDoneCheck.unmatched.length > 0 ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-2.5 text-sm dark:bg-amber-950/30">
          <div className="min-w-0 space-y-1 text-amber-700 dark:text-amber-400">
            <p className="font-medium">
              카드대금 출금완료 안내 {cardBillDoneCheck.unmatched.length}건 — 같은 금액의 은행 출금이 앞뒤 {CARD_BILL_DONE_MATCH_WINDOW_DAYS}일 안에 없습니다.
            </p>
            <p>은행 출금 문자가 안 왔을 수 있습니다 — 휴지통에서 복원해 &apos;납부&apos;로 확정하거나, 이미 따로 처리했으면 휴지통에서 지우세요.</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {cardBillDoneCheck.unmatched.map((notice) => (
                <li key={notice.id} className="[overflow-wrap:anywhere]">
                  {notice.guessed_date} · {Number(notice.guessed_amount).toLocaleString("ko-KR")}원
                </li>
              ))}
            </ul>
          </div>
          <Button size="sm" variant="outline" onClick={() => setTab("trash")}>
            휴지통 보기
          </Button>
        </div>
      ) : null}

      {loading ? (
        <LoadingState label="수집함을 불러오는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchData()} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as InboxTab)}>
          {/* 탭 + 액션 버튼을 한 줄로 (버튼을 위로 올려 세로 공간 절약). overflow-y-hidden으로 군더더기 스크롤바 제거. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 overflow-x-auto overflow-y-hidden">
              <TabsList className="min-w-max">
                <TabsTrigger value="pending" className={HH_TAB_SOLID}>
                  <Inbox className="h-4 w-4" /> 검토대기 {counts.pending > 0 ? `(${counts.pending})` : ""}
                </TabsTrigger>
                <TabsTrigger value="confirmed" className={HH_TAB_SOLID}>
                  <CheckCheck className="h-4 w-4" /> 확정 {counts.confirmed > 0 ? `(${counts.confirmed})` : ""}
                </TabsTrigger>
                <TabsTrigger value="archived" className={HH_TAB_SOLID}>
                  <Archive className="h-4 w-4" /> 보관 {counts.archived > 0 ? `(${counts.archived})` : ""}
                </TabsTrigger>
                <TabsTrigger value="trash" className={HH_TAB_SOLID}>
                  <Trash2 className="h-4 w-4" /> 휴지통 {trashCount > 0 ? `(${trashCount})` : ""}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* 활성 탭별 액션 버튼 (탭 줄 오른쪽) */}
            <div className="flex flex-wrap items-center gap-2">
              {tab === "pending" && counts.pending > 0 ? (
                <>
                  {selectedPendingCount > 0 ? (
                    <span className="text-sm text-muted-foreground">{selectedPendingCount}건 선택됨</span>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => void confirmSelected()} disabled={confirmingAll || selectedPendingCount === 0}>
                    <CheckCheck className="h-4 w-4 text-emerald-600" /> 선택 확정{selectedPendingCount > 0 ? ` (${selectedPendingCount})` : ""}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void trashSelected()} disabled={selectedPendingCount === 0}>
                    <Trash2 className="h-4 w-4" /> 선택 비우기
                  </Button>
                  <Button size="sm" onClick={() => void confirmAll()} disabled={confirmingAll}>
                    <ListChecks className="h-4 w-4" /> {confirmingAll ? "확정 중..." : "전체 확정"}
                  </Button>
                </>
              ) : null}
              {tab === "confirmed" && counts.confirmed > 0 ? (
                <>
                  {selectedConfirmedCount > 0 ? (
                    <span className="text-sm text-muted-foreground">{selectedConfirmedCount}건 선택됨</span>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => void unconfirmSelected()} disabled={selectedConfirmedCount === 0}>
                    <Undo2 className="h-4 w-4 text-amber-600" /> 선택 되돌리기{selectedConfirmedCount > 0 ? ` (${selectedConfirmedCount})` : ""}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void archiveSelected()} disabled={selectedConfirmedCount === 0}>
                    <Archive className="h-4 w-4" /> 선택 보관{selectedConfirmedCount > 0 ? ` (${selectedConfirmedCount})` : ""}
                  </Button>
                </>
              ) : null}
              {tab === "trash" && trashCount > 0 ? (
                <Button variant="outline" size="sm" onClick={() => void emptyTrash()}>
                  <Trash2 className="h-4 w-4" /> 휴지통 비우기
                </Button>
              ) : null}
            </div>
          </div>

          <TabsContent value="pending" className="pt-3">{renderTable("pending")}</TabsContent>
          <TabsContent value="confirmed" className="pt-3">{renderTable("confirmed")}</TabsContent>
          <TabsContent value="archived" className="pt-3">{renderTable("archived")}</TabsContent>
          <TabsContent value="trash" className="pt-3">{renderTable("trash")}</TabsContent>
        </Tabs>
      )}

      {/* 컬럼 헤더 필터 드롭다운(데스크톱). fixed 배치라 표 가로스크롤에 안 잘린다. (설계 69 2차) */}
      {filterMenu ? (() => {
        const { entries, unsetCount, total } = columnOptions(filterMenu.col, activeStatusRows);
        const sel = colFilters[filterMenu.col];
        const pick = (v: string) => { setColFilter(filterMenu.col, v); setFilterMenu(null); };
        const rowCls = (on: boolean) => `flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted ${on ? "font-semibold text-primary" : ""}`;
        const left = Math.min(filterMenu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 240);
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setFilterMenu(null)} />
            <div className="fixed z-50 max-h-80 w-56 overflow-auto rounded-xl border border-border/70 bg-popover p-1 shadow-lg" style={{ left, top: filterMenu.y + 4 }}>
              <button type="button" className={rowCls(!sel)} onClick={() => pick("")}>
                <span>전체</span><span className="text-xs text-muted-foreground">{total}</span>
              </button>
              {unsetCount > 0 ? (
                <button type="button" className={rowCls(sel === UNSET)} onClick={() => pick(UNSET)}>
                  <span className="text-amber-700 dark:text-amber-400">(미지정)</span><span className="text-xs text-muted-foreground">{unsetCount}</span>
                </button>
              ) : null}
              {entries.map(([v, c]) => (
                <button key={v} type="button" className={rowCls(sel === v)} onClick={() => pick(v)}>
                  <span className={HH_CELL.wrapText}>{v}</span><span className="shrink-0 text-xs text-muted-foreground">{c}</span>
                </button>
              ))}
            </div>
          </>
        );
      })() : null}

      <InboxDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={categories}
        accounts={accounts}
        methods={methods}
        onSave={handleAdd}
        guessCategory={(merchant) => matchMerchantCategory(merchant, merchantMap)}
      />

      <LoanDialog
        target={null}
        accounts={accounts}
        preset={loanDialog.preset}
        open={loanDialog.open}
        onOpenChange={(open) => setLoanDialog((s) => ({ ...s, open }))}
        onSaved={() => void fetchData()}
      />

      <QuickInterestDialog
        open={quickOpen}
        onOpenChange={setQuickOpen}
        today={today}
        accounts={quickRefs.candidates}
        defaultAccountId={quickRefs.accountId}
        onSave={handleQuickInterest}
      />

      <StatementUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        existingHashes={existingHashes}
        guessCategory={(merchant) => matchMerchantCategory(merchant, merchantMap)}
        onSave={handleUpload}
      />
    </PageShell>
  );
}
