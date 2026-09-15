"use client";

import { Ban, CalendarClock, ChevronDown, ChevronUp, CreditCard, Landmark, Plus, RotateCcw, Scale, Search, Settings, TrendingUp, TriangleAlert, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ErrorState, LoadingState, PageShell, SectionIntro, StatCard, StatsGrid } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HH_COL, HH_CELL, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { MonthMethodDialog } from "@/components/household/month-method-dialog";
import { ScheduledPaymentDialog, type ScheduledPaymentFormData } from "@/components/household/scheduled-payment-dialog";
import { LoanDialog } from "@/components/household/loan-dialog";
import { InstallmentEditDialog } from "@/components/household/installment-edit-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SUB } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { formatAmountInMan } from "@/lib/utils";
import { getOwnerUid } from "@/lib/household/owner";
import { accountTintMap, ACCOUNT_TINT_NONE, CARD_TINT } from "@/lib/household/account-color";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { CALENDAR_KIND_META, outflowsForMatching, projectedBalances, type ActualOutflow } from "@/lib/household/calc";
import { buildVariableSpendInput, fixedCategoryIdsOf, variableSpendOfMonth, type VariableSpendSample } from "@/lib/household/variable-spend";
import { seoulToday } from "@/lib/household/sms";
import { cardGroupOf } from "@/lib/household/card-group";
import { cashflowSnapshot, computeCashMatches, RELEASE_REASON_LABEL, type ClassifiedItem, type NextOutItem, type OutItem } from "@/lib/household/cashflow-snapshot";
import { monthRange, shiftMonth, thisMonthKey } from "@/lib/household/month";
import type {
  HhAccount,
  HhAccountBalance,
  HhCashflowOverride,
  HhCashflowSourceKind,
  HhCategory,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhPerson,
  HhScheduledPayment,
  HhTransaction,
} from "@/lib/household/types";

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

/**
 * 열 폭 — 내용별 척도(설계 122). `undefined` = 가변 열(남는 폭을 그 열들끼리 균등 분배).
 * 폭을 바꿀 때는 `npx tsx scripts/measure_table_content.mts` 로 실측부터 하고,
 * `HH_COL` 에 있는 값만 쓴다(척도 밖 px 를 적으면 npm run test:table-width 가 잡는다).
 */
// 계좌 요약: 계좌명·계좌번호는 길이가 제각각이라 가변, 금액 6열은 척도 고정.
const ACCT_SUM_COLS = [
  HH_COL.xxwide,  // 계좌 — '증권계좌(김하늘)' + 증권 배지가 160 에서 두 줄로 꺾였다(필요 194, 설계 125)
  undefined,      // 계좌번호 (실측 필요 136.5)
  HH_COL.standard,  // 잔액 (98.1)
  HH_COL.standard,  // 실출금(전월) — 이번달과 같은 서식·헤더 폭 (설계 127)
  HH_COL.standard,  // 실출금(이번달) — 헤더 66.4 가 하한 (96.4)
  HH_COL.standard,  // 전체출금예정액 (98.1)
  HH_COL.standard,  // 미출금액 (98.1)
  HH_COL.standard,  // 부족액 (98.1)
];

// 출금 예정 상세: 셀 안이 대부분 w-full 컨트롤이라 ink 는 칸을 꽉 채운다 →
// 폭은 '컨트롤이 안 잘리는 최소치'로 잡는다(select 는 `hh-select pr-6` 화살표 자리까지 필요).
// ★select 에는 `hh-select` 를 꼭 붙여라 — 안 붙이면 Chrome 이 화살표 자리를 padding 바깥에
//   따로 예약해 글자 자리가 16px 줄고 `국민은행(이바다)` 의 닫는 괄호가 잘린다(globals.css 주석).
// ★설계 127 로 '전월 출금' 열이 추가돼 10열이 됐다. 표 폭 합계가 페이지 최대폭 1200 을 넘지 않도록
//   실측(measure_table_content, ROWS=200) 하한까지 좁혔다: 카테고리(필요 68.9)·결제방식(필요 88)과,
//   헤더를 '출금 / 결제금액'(필요 99.7)으로 축약한 출금금액 열. 항목은 208 에서
//   '학원비-국가대표K태권도장 (2/2)' 가 정확히 경계에 걸려 두 줄로 꺾여 240 을 유지한다. 합계 = 1184.
const OUT_COLS = [
  HH_COL.standard,  // 날짜 — '31일' select + 화살표 (필요 101)
  HH_COL.x3wide,  // 항목 — 아이콘 + 이름 + 할부 회차 '(2/2)' 까지 한 줄에(실측: 208 은 경계 겹침, 설계 125·127)
  HH_COL.tight,   // 카테고리 — 텍스트 통일(설계 125) 후 필요 68.9 (헤더 38.9+30)
  HH_COL.short,     // 결제방식 — w-full 배지('현금/카드'), 필요 88 이 하한
  undefined,      // 출금계좌 / 결제계좌 — select + '국민은행(이바다)'
  HH_COL.standard,  // 전월 출금 — 전월 매칭 실출금(필요 98.1, 설계 127)
  HH_COL.standard,  // 예상금액
  HH_COL.standard,  // 출금 / 결제금액 — 헤더 축약(설계 127) 후 필요 99.7. 예전 '출금금액 / 결제금액'(152)은 xwide 강제였다
  HH_COL.standard,  // 출금 후 잔액 (103.3)
  HH_COL.icon,    // 제외 — 체크박스 (60.0)
];

// 다음 달 예정: 출금 예정과 같은 구조에서 금액 열만 둘.
const NEXT_COLS = [
  HH_COL.standard,  // 날짜
  HH_COL.x3wide,  // 항목 — 이름 옆에 '입력함' 배지가 붙어 208 에서 꺾였다(필요 198, 설계 125)
  HH_COL.standard,// 카테고리
  HH_COL.standard,    // 결제방식 (헤더 83 이 하한)
  undefined,      // 출금계좌 / 결제계좌
  HH_COL.wide,      // 당월 출금금액 — 금액 + '추정' 배지가 같이 들어가 112 로는 +16.2px 넘쳤다(실측)
  HH_COL.wide,      // 익월 예상금액 — 같은 열 짝이라 폭을 맞춘다
  HH_COL.icon,    // 제외
];

// 이번 달 쉼 / 종료: 항목·카테고리만 가변.
const HOLD_COLS = [
  HH_COL.xxwide,  // 항목 (설계 123)
  HH_COL.standard,// 카테고리 (실측 80.1px 이 빌 만큼 넓었다)
  HH_COL.standard,  // 예상금액
  HH_COL.standard,    // 되살리기 — w-full 버튼, 헤더 '되살리기' 83 이 하한
];

// 영구 보류: 사유·항목·카테고리가 가변.
const PERM_COLS = [
  undefined,      // 사유
  HH_COL.xxwide,  // 항목 (설계 123)
  HH_COL.standard,// 카테고리 (실측 70.3px 이 빌 만큼 넓었다)
  HH_COL.standard,  // 예상금액
  HH_COL.standard,  // 날짜 지정 — select + 화살표
  HH_COL.wide,    // 복원 — 버튼 글자 '날짜 지정 시 복귀'(74)가 88 에서 꺾였다(설계 125)
];

/**
 * 월별 예상 현금흐름.
 * ★'월' 열을 가변으로 둔 이유가 둘이다:
 *   ① 내용이 `2026-08` 뿐이 아니라 이번 달 행에는 '이번달' 배지가 더 붙어 96px 로는 모자란다.
 *   ② **전 컬럼이 고정폭이면 안 된다** — `w-full` 표에서 고정폭 합이 컨테이너보다 좁으면
 *      브라우저가 남는 폭을 비율로 나눠 붙여 척도가 무의미해진다(슬랙이 열마다 생겨 다시 어긋남).
 *      표마다 최소 한 열은 가변이어야 남는 폭이 그 열로만 간다.
 */
const PROJ_COLS = [
  undefined,      // 월 `2026-08` + '이번달'·'실적' 배지
  // 수입·출금은 당월 행에 둘째 줄(`월 전체 36,129,306원`)이 붙는다 — 실측 자연폭 99px + 좌우 패딩 32
  //   = 131 이라 standard(112) 에서는 **2줄로 꺾였다**(2026-08-15 실측 h=32px). (설계 174 ⑤)
  //   ★금액이 억대가 되면 다시 넘친다 — 그때는 test:table-render 의 D/F 가 잡는다.
  HH_COL.wide,      // 수입 (+ 당월 '월 전체')
  HH_COL.wide,      // 출금 (+ 당월 '월 전체')
  HH_COL.standard,  // 순증감
  // ★월말 현금 — standard(112, 안쪽 80)에서는 천만원대(`34,490,399원` 12자)가 **두 줄로 꺾였다**
  //   (팀장 지적 2026-08-26, 설계 189). 헤더 하한은 109 지만 폭을 정하는 건 내용 쪽이다.
  //   wide(136) 로 올리고 셀에 whitespace-nowrap 을 걸어 한 줄을 보장한다.
  //   표 폭 합계 = 160+136+136+112+136 = 680 < 페이지 최대폭 1200.
  HH_COL.wide,      // 월말 현금
];

// 문자 잔액 대조: 계좌명·확인 시각이 가변.
const SMS_BAL_COLS = [
  undefined,      // 계좌
  HH_COL.standard,  // 문자 잔액
  undefined,      // 확인 시각 `2026-08-01 10:58`
  HH_COL.standard,  // 장부 잔액
  HH_COL.standard,  // 차이
  HH_COL.standard,    // 상태 — 배지
];

function lastDayOfMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function fullMonthPeriod(ym: string) {
  return { start: `${ym}-01`, end: `${ym}-${String(lastDayOfMonth(ym)).padStart(2, "0")}` };
}

// 문자 잔액 확인 시각이 7일 넘게 지났는지 — 오래된 체크포인트의 차이는 '장부 오류'가 아니라
// '그 사이 정상 거래' 가능성이 커서 '확인 필요' 대신 '오래됨'으로 구분 표기한다.
function isStale(date: string | null): boolean {
  if (!date) return true;
  const t = new Date(date).getTime();
  return Number.isNaN(t) || Date.now() - t > 7 * 86_400_000;
}

/**
 * 최근 3개월 실출금 행 — 스냅샷 매칭(ActualOutflow)에 더해, 전월 '계좌별 실출금'(설계 127)을
 * 만들 수 있게 계좌·수단 컬럼까지 받는다. 당월 실출금(withdrawnByAccount)과 같은 규칙을
 * 전월 거래에 적용하려면 지출의 계좌 귀속(account_id ?? 현금/체크 수단의 연결계좌)이 필요하다.
 */
type RecentOutflowRow = ActualOutflow & {
  type: "expense" | "payment" | "transfer";
  account_id: string | null;
  from_account_id: string | null;
  /** 내부 이체 판정용(설계 128) — 없으면 전월 열이 내 통장끼리의 이동을 실출금으로 남긴다. */
  to_account_id: string | null;
  payment_method_id: string | null;
};

type ReportedBalanceRow = {
  reported_balance: number;
  reported_balance_account_id: string;
  guessed_date: string | null;
  guessed_time: string | null;
};

/**
 * 변동 지출 표본 + 전월 실적 — **완료된 직전 3개월**. (설계 173)
 *
 * ★변동 지출은 **정기지출이 쓰지 않는 카테고리의 통장 지출**로 센다.
 *   처음엔 `실제 유출 − 그 달 정기 예정`으로 잡았다가 실화면에서 월 1,538만이라는 엉뚱한 값을 봤다 —
 *   정기지출·대출은 "현재" 상태만 저장돼 있어 **과거 달의 예정을 재현할 수 없기** 때문이다
 *   (5·6월 예정 항목이 5건뿐이었다, 이번 달은 61건). 자세한 근거는 `variableSpendOfMonth` 주석.
 * ★실제 유출은 `outflowsForMatching` 으로 **내부 이체·카드 지출을 뺀** 뒤 센다 — 화면 합계와 같은 기준.
 */
async function fetchVariableSpendSamples(
  supabase: ReturnType<typeof createClient>,
  month: string,
  base: { scheduled: HhScheduledPayment[]; methods: HhPaymentMethod[]; accountIds: string[] },
): Promise<{ samples: VariableSpendSample[]; prev: { ym: string; income: number; outflow: number } | null }> {
  const months = [3, 2, 1].map((k) => shiftMonth(month, -k)); // 완료된 직전 3개월(당월 제외)
  const prevYm = shiftMonth(month, -1);
  const from = `${months[0]}-01`;
  const to = monthRange(month).start; // 당월 시작 = 표본 구간의 끝
  // ★페이징 — 3개월치 전 유형이면 상한 1,000행을 넘길 수 있고, 잘리면 **조용히 과소 집계**된다
  //   (설계 128 후속에서 같은 함정을 밟았다). 실패는 null 로 알려 '0원'과 구분한다.
  const txns: HhTransaction[] = [];
  for (let off = 0; off < 50_000; off += 1000) {
    const { data, error } = await supabase
      .from("hh_transaction")
      .select("*")
      .in("type", ["expense", "income", "payment", "transfer"])
      .gte("txn_date", from)
      .lt("txn_date", to)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) {
      console.error("변동지출 표본 조회 실패:", error);
      return { samples: [], prev: null };
    }
    const rows = (data ?? []) as HhTransaction[];
    txns.push(...rows);
    if (rows.length < 1000) break;
  }
  const fixedCats = fixedCategoryIdsOf(base.scheduled);
  const cardIds = base.methods.filter((m) => m.kind === "credit" || m.kind === "installment").map((m) => m.id);
  // ★수입을 먼저 뺀다 — outflowsForMatching 은 내부이체·카드지출만 거르고 income 은 그대로 통과시킨다.
  //   안 빼면 전월 '출금'에 수입이 더해져 2,428만처럼 튄다(2026-08-14 실화면에서 잡았다).
  const outTxns = txns.filter((t) => t.type !== "income") as unknown as ActualOutflow[];
  const pool = outflowsForMatching(outTxns, base.accountIds, cardIds);

  // ★표본도 **pool**(내부이체·신용/할부 카드지출 제외)로 센다 — 원본 txns 로 세면 카드 지출이 섞여
  //   카드대금 예정과 **이중계상**된다(교차리뷰 2026-08-14, Codex).
  // ★거래가 아예 없는 달은 표본에서 뺀다 — 0원 표본이 섞이면 중앙값이 0 쪽으로 끌려가
  //   진짜 실적 월이 '이상치'로 제외되고 월평균이 0이 된다(같은 리뷰).
  const poolAll = pool as unknown as HhTransaction[];
  const samples = months
    .filter((ym) => txns.some((t) => t.txn_date.slice(0, 7) === ym))
    .map((ym) => ({ ym, amount: variableSpendOfMonth(poolAll, ym, fixedCats) }));
  // 전월 실적(확정) — 최상단 요약에서 이번 달 예상과 나란히 놓는다. (설계 173 ③)
  // ★출금 기준을 이번 달과 **같게** 맞춘다: 내부 이체·카드 지출을 뺀 실제 통장유출.
  const prev = {
    ym: prevYm,
    income: txns.filter((t) => t.type === "income" && t.txn_date.slice(0, 7) === prevYm).reduce((s2, t) => s2 + Number(t.amount), 0),
    outflow: pool.filter((t) => t.txn_date.slice(0, 7) === prevYm).reduce((s2, t) => s2 + Number(t.amount), 0),
  };
  return { samples, prev };
}

/**
 * 문자·알림이 알려준 계좌 잔액 전량 로드(설계 71). 실패하면 null.
 *
 * ★페이징 필수 — 예전엔 페이징 없이 select 해서 1,000행 상한에 걸렸다.
 *   호출부는 계좌별 '최신' 한 건을 고르는데, 상한에 잘려 애초에 안 가져온 행은 고를 수 없다.
 *   그러면 몇 달 전 잔액과 장부를 대조해 없는 불일치를 경고하거나 있는 불일치를 놓친다 —
 *   수집 누락을 잡으라고 만든 기능이 정확히 반대로 동작한다.
 *   (제대로 하려면 계좌별 DISTINCT ON 뷰가 맞지만 마이그레이션이 필요해 여기서는 전량 로드로 둔다.
 *    수집함은 문자 1건당 1행이라 규모가 작다.)
 */
async function fetchReportedBalances(
  supabase: ReturnType<typeof createClient>
): Promise<ReportedBalanceRow[] | null> {
  const CHUNK = 1000;
  const MAX = 50000;
  const out: ReportedBalanceRow[] = [];
  for (let from = 0; from < MAX; from += CHUNK) {
    const { data, error } = await supabase
      .from("hh_transaction_inbox")
      .select("reported_balance, reported_balance_account_id, guessed_date, guessed_time")
      .not("reported_balance", "is", null)
      .not("reported_balance_account_id", "is", null)
      .order("guessed_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false }) // 페이지 경계 안정용 2차 키
      .range(from, from + CHUNK - 1);
    if (error) {
      console.error("문자 잔액 조회 실패:", error);
      return null;
    }
    const rows = (data ?? []) as ReportedBalanceRow[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

/**
 * 최근 3개월 실제 출금(expense·payment·transfer) — 예정 vs 실제 대조(설계 65)와
 * 전월 계좌별 실출금(설계 127)·내부 이체 판정(설계 128)의 공통 원천이다.
 *
 * ★PostgREST 는 한 번에 1,000행까지만 준다 — 넘어도 **에러가 아니라 조용히 잘린다.**
 *   잘리면 전월 열만 과소 집계돼 당월 열과 **다른 자(尺)** 가 된다(설계 127·128 의 전제가 무너진다).
 *   설계 128 후속에서는 경고만 남겼었는데, 경고는 ⓐ1,000 에 **닿아야** 울리고(그땐 이미 틀린 값이 그려진 뒤)
 *   ⓑ브라우저 콘솔이라 쓰는 사람 눈에 안 띈다. 실측 2026-08-03 에 748행(상한의 75%)이라 여유도 없었다.
 *   → 경고가 아니라 **페이지로 나눠 전부 받는다.**(fetchReportedBalances 와 같은 관용구)
 *
 * ★정렬은 페이지 경계를 안정시키기 위한 것이다 — `range()` 는 정렬이 없으면 페이지마다
 *   행 순서가 달라져 중복·누락이 난다. 2차 키 `id` 까지 줘야 같은 날짜 안에서도 순서가 고정된다.
 *   (부수효과: `matchOutflowActuals` 는 점수·차이가 같을 때 **배열 순서가 앞선 쪽**을 고른다.
 *    종전에는 DB 물리 순서라 사실상 임의였고, 이제 날짜·id 순으로 **재현 가능**해진다.)
 */
async function fetchRecentOutflows(
  supabase: ReturnType<typeof createClient>,
  fromDate: string,
  toDate: string
): Promise<RecentOutflowRow[] | null> {
  const CHUNK = 1000;
  const MAX = 50000;
  const out: RecentOutflowRow[] = [];
  for (let from = 0; from < MAX; from += CHUNK) {
    const { data, error } = await supabase
      .from("hh_transaction")
      // 계좌·수단 컬럼은 전월 '계좌별 실출금'(설계 127) 계산용 — 매칭(ActualOutflow)은 앞 3개만 쓴다.
      // to_account_id 는 내부 이체 판정용(설계 128) — 빠지면 전월 열만 내 통장끼리의 이동을 실출금으로 남긴다.
      .select("amount,counterparty,txn_date,type,account_id,from_account_id,to_account_id,payment_method_id")
      .in("type", ["expense", "payment", "transfer"])
      .gte("txn_date", fromDate)
      .lt("txn_date", toDate)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true }) // 페이지 경계 안정용 2차 키
      .range(from, from + CHUNK - 1);
    if (error) {
      console.error("최근 출금 조회 실패:", error);
      return null;
    }
    const rows = (data ?? []) as RecentOutflowRow[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

// OutItem·ClassifiedItem·RELEASE_REASON_LABEL은 현황(홈)과 공유하는
// cashflow-snapshot.ts로 이동(설계 79).

export default function HouseholdCashPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask, enabled: maskEnabled } = useMasking();

  // 조회 기간(시작~종료일) + 출금계좌 필터. 월 단위 데이터는 시작일의 '월'을 기준으로 한다. (설계 docs/household/46)
  const [period, setPeriod] = useState(() => fullMonthPeriod(thisMonthKey()));
  const [accountFilter, setAccountFilter] = useState<string>("");
  // 비활성 계좌 숨기기(설계 89). 표시용 설정이라 금액 계산에는 쓰지 않는다.
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const month = period.start.slice(0, 7);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  const [persons, setPersons] = useState<HhPerson[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  // 정기지출(고정비) 추가/수정 다이얼로그 — target=null이면 추가, 있으면 그 정기지출 세부 내용 수정.
  const [spDialog, setSpDialog] = useState<{ open: boolean; target: HhScheduledPayment | null }>({ open: false, target: null });
  // 대출·할부도 팝업으로 연다. 예전엔 router.push 로 편집 **페이지**로 튀어 현금흐름 맥락(기간 필터·
  // 스크롤 위치·펼친 탭)이 통째로 날아갔다 — 목록→팝업 규칙(설계 82) 위반이었다. (설계 124)
  const [loanDialog, setLoanDialog] = useState<{ open: boolean; target: HhLoan | null }>({ open: false, target: null });
  const [instDialog, setInstDialog] = useState<{ open: boolean; target: HhInstallment | null }>({ open: false, target: null });
  const [balances, setBalances] = useState<Record<string, number>>({});
  // 수집 메시지가 알려준 계좌별 잔액(장부 대조용, 설계 71).
  const [reportedBalances, setReportedBalances] = useState<{ account_id: string; balance: number; date: string | null; time: string | null }[]>([]);
  const [monthTxns, setMonthTxns] = useState<HhTransaction[]>([]);
  // 당월 수입 — 스냅샷의 '이미 받은 정기수입' 판정(receivedInflowIds)에만 쓴다.
  // ★monthTxns 에 합치지 말 것: expenseByAccount 가 monthTxns 를 타입 검사 없이 전부 더해
  //   수입이 계좌별 지출로 잡힌다. 스냅샷에 넘길 때만 합친다.
  const [monthIncome, setMonthIncome] = useState<HhTransaction[]>([]);
  const [monthTransfers, setMonthTransfers] = useState<HhTransaction[]>([]);
  // 최근 3개월 실제 출금(expense·payment·transfer) — 예정 vs 실제 대조(설계 65) + 전월 실출금(설계 127).
  const [recentOutflows, setRecentOutflows] = useState<RecentOutflowRow[]>([]);
  const [scheduled, setScheduled] = useState<HhScheduledPayment[]>([]);
  const [loans, setLoans] = useState<HhLoan[]>([]);
  const [installments, setInstallments] = useState<HhInstallment[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  const [overrides, setOverrides] = useState<HhCashflowOverride[]>([]);
  const [nextOverrides, setNextOverrides] = useState<HhCashflowOverride[]>([]); // 익월 출금 탭 입력값(설계 81)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [amountDraft, setAmountDraft] = useState<Record<string, string>>({});
  const [paidDraft, setPaidDraft] = useState<Record<string, string>>({});
  // '이 달의 결제수단' 팝업 대상(설계 203). ym 을 같이 들고 다닌다 — 당월 표와 익월 탭이 같은 팝업을 쓴다.
  const [methodTarget, setMethodTarget] = useState<{
    sourceKind: HhCashflowSourceKind;
    sourceId: string;
    label: string;
    ym: string;
    value: string | null;
    baseMethodId: string | null;
  } | null>(null);
  const [nextAmountDraft, setNextAmountDraft] = useState<Record<string, string>>({}); // 익월 예상금액 편집 중 값(설계 81)
  // 여러 달 앞 예측(설계 64) — 예측기간·여유선은 단일사용자용이라 localStorage에 저장.
  const [horizon, setHorizon] = useState<number>(3);
  // 변동 지출(생활비) 보정 — 표본은 조회로, 켜기/조정값은 localStorage. (설계 173)
  const [vsSamples, setVsSamples] = useState<VariableSpendSample[]>([]);
  const [vsEnabled, setVsEnabled] = useState<boolean>(true);
  const [vsOverride, setVsOverride] = useState<number | null>(null);
  const [prevActual, setPrevActual] = useState<{ ym: string; income: number; outflow: number } | null>(null);
  const [bufferLine, setBufferLine] = useState<number>(1_000_000);
  const [bufferDraft, setBufferDraft] = useState<string | null>(null);

  const personName = useCallback((id: string | null) => persons.find((p) => p.id === id)?.name ?? "-", [persons]);
  const categoryName = useCallback((id: string | null) => (id ? categories.find((c) => c.id === id)?.name ?? null : null), [categories]);
  // 텍스트 어디에 박혀 있든(괄호·하이픈·단독) 인물명을 가명으로. 출금예정 항목명("현대카드-이바다")·select 옵션 등. (설계 docs/household/39)
  const maskOwnerText = useCallback(
    (s: string | null | undefined): string => {
      if (s == null) return "";
      if (!maskEnabled) return s;
      let out = s;
      for (const p of persons) if (p.name) out = out.split(p.name).join(mask("name", p.name));
      return out;
    },
    [maskEnabled, persons, mask]
  );

  // 조회 초기화 — 기간=이번 달 전체, 출금계좌=전체.
  const resetFilters = useCallback(() => {
    setPeriod(fullMonthPeriod(thisMonthKey()));
    setAccountFilter("");
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    const { start, end } = monthRange(month);
    const win3Start = `${shiftMonth(month, -2)}-01`; // 최근 3개월(당월 포함) 시작

    const [accRes, balRes, mtRes, miRes, mtrRes, spRes, loanRes, insRes, perRes, pmRes, ovRes, roRes, catRes, rbRes] = await Promise.all([
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase.from("hh_account_balance").select("*"),
      supabase.from("hh_transaction").select("*").eq("type", "expense").gte("txn_date", start).lt("txn_date", end),
      // 당월 수입 — 이미 입금된 정기수입을 첫 달 예상에서 빼기 위함(설계 65 수입 대칭).
      // 이게 없으면 receivedInflowIds 가 영구히 빈 집합이 되어 받은 급여를 또 더한다.
      supabase.from("hh_transaction").select("*").eq("type", "income").gte("txn_date", start).lt("txn_date", end),
      supabase.from("hh_transaction").select("*").eq("type", "transfer").gte("txn_date", start).lt("txn_date", end),
      supabase.from("hh_scheduled_payment").select("*"),
      supabase.from("hh_loan").select("*"),
      supabase.from("hh_installment").select("*"),
      supabase.from("hh_person").select("*").order("sort_order").order("name"),
      supabase.from("hh_payment_method").select("*"),
      // 당월 + 익월(익월 출금 탭). 한 번에 받아 년월로 가른다. (설계 81)
      supabase.from("hh_cashflow_override").select("*").in("year_month", [month, shiftMonth(month, 1)]),
      // ★페이징 조회다(설계 128 후속 2차) — 상한에 걸려 조용히 잘리면 전월 열만 과소 집계된다.
      fetchRecentOutflows(supabase, win3Start, end),
      supabase.from("hh_category").select("*").order("sort_order").order("name"),
      fetchReportedBalances(supabase),
    ]);

    // ★13개 조회 중 2개만 보고 있었다 — 정기지출(spRes)·대출(loanRes)·할부(insRes)가
    //   실패하면 출금 예정이 통째로 비어 "이번 달 나갈 돈 없음"으로 보인다. 전부 가드에 넣는다.
    // roRes 는 페이징 헬퍼라 실패를 `null` 로 알린다(rbRes 와 같은 규약) — `.error` 배열에 넣지 않는다.
    const failed = [accRes, balRes, mtRes, miRes, mtrRes, spRes, loanRes, insRes, perRes, pmRes, ovRes, catRes].find((r) => r.error);
    if (rbRes === null || roRes === null || failed) {
      console.error("현금흐름 조회 실패:", failed?.error);
      toast.error("계좌 정보를 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }

    const balMap: Record<string, number> = {};
    for (const b of (balRes.data ?? []) as HhAccountBalance[]) balMap[b.account_id] = b.current_balance;

    setOwnerUid(await getOwnerUid(supabase));
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setPersons((perRes.data ?? []) as HhPerson[]);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setBalances(balMap);
    setMonthTxns((mtRes.data ?? []) as HhTransaction[]);
    setMonthIncome((miRes.data ?? []) as HhTransaction[]);
    setMonthTransfers((mtrRes.data ?? []) as HhTransaction[]);
    setScheduled((spRes.data ?? []) as HhScheduledPayment[]);
    setLoans((loanRes.data ?? []) as HhLoan[]);
    setInstallments((insRes.data ?? []) as HhInstallment[]);
    setMethods((pmRes.data ?? []) as HhPaymentMethod[]);
    const allOv = (ovRes.data ?? []) as HhCashflowOverride[];
    const nextYm = shiftMonth(month, 1);
    setOverrides(allOv.filter((o) => o.year_month === month));
    setNextOverrides(allOv.filter((o) => o.year_month === nextYm));
    // 상한 절단 위험은 fetchRecentOutflows 의 페이징이 없앴다(설계 128 후속 2차).
    setRecentOutflows(roRes);
    setReportedBalances(
      rbRes.map((r) => ({ account_id: r.reported_balance_account_id, balance: r.reported_balance, date: r.guessed_date, time: r.guessed_time }))
    );
    setAmountDraft({});
    setNextAmountDraft({});
    setLoading(false);

    // 변동 지출 표본 — 화면을 먼저 그린 뒤 채운다(부가 정보라 로딩을 잡아두지 않는다). (설계 173)
    void fetchVariableSpendSamples(supabase, month, {
      scheduled: (spRes.data ?? []) as HhScheduledPayment[],
      methods: (pmRes.data ?? []) as HhPaymentMethod[],
      accountIds: ((accRes.data ?? []) as HhAccount[]).map((a) => a.id),
    }).then((r) => {
      setVsSamples(r.samples);
      setPrevActual(r.prev); // null = 조회 실패 → 요약 줄을 아예 그리지 않는다('0원'으로 거짓말하지 않기 위해)
    });
  }, [supabase, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 예측기간·여유선 복원(localStorage). 마운트 1회. (SSR 기본값과 맞추려 effect에서 세팅)
  useEffect(() => {
    const h = Number(localStorage.getItem("hh_cash_forecast_horizon"));
    // ★키가 없으면 Number(null) === 0 이라 기본값(100만원)이 0으로 덮어써진다. 현황(홈)과 동일 처리.
    const vsOn = localStorage.getItem("hh_cash_varspend_on");
    const vsOv = localStorage.getItem("hh_cash_varspend_override");
    const vsOvNum = vsOv != null && vsOv !== "" && Number.isFinite(Number(vsOv)) ? Number(vsOv) : null;
    const bRaw = localStorage.getItem("hh_cash_buffer_line");
    const b = bRaw === null ? NaN : Number(bRaw);
    /* eslint-disable react-hooks/set-state-in-effect */
    if (h === 3 || h === 6 || h === 12) setHorizon(h);
    if (Number.isFinite(b) && b >= 0) setBufferLine(b);
    if (vsOn != null) setVsEnabled(vsOn === "1"); // 변동 지출 켜기 (설계 173)
    if (vsOvNum != null) setVsOverride(vsOvNum);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const changeHorizon = useCallback((h: number) => {
    setHorizon(h);
    localStorage.setItem("hh_cash_forecast_horizon", String(h));
  }, []);
  const commitBuffer = useCallback(() => {
    setBufferDraft((draft) => {
      if (draft == null) return null;
      const n = draft === "" ? 0 : Math.round(Number(draft));
      if (Number.isFinite(n) && n >= 0) {
        setBufferLine(n);
        localStorage.setItem("hh_cash_buffer_line", String(n));
      }
      return null;
    });
  }, []);

  const todayDay = useMemo(() => {
    const now = new Date();
    const nowYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return nowYm === month ? now.getDate() : 1;
  }, [month]);

  const methodById = useMemo(() => new Map(methods.map((m) => [m.id, m])), [methods]);
  const overrideMap = useMemo(() => {
    const m = new Map<string, HhCashflowOverride>();
    for (const o of overrides) m.set(`${o.source_kind}:${o.source_id}`, o);
    return m;
  }, [overrides]);
  const nextOverrideMap = useMemo(() => {
    const m = new Map<string, HhCashflowOverride>();
    for (const o of nextOverrides) m.set(`${o.source_kind}:${o.source_id}`, o);
    return m;
  }, [nextOverrides]);

  // 현금성 잔액 합(주식 제외) — 스냅샷(예측 시작잔액)과 상단 카드 공용.
  const cashAccounts = accounts.filter((a) => a.kind !== "stock");
  const totalCash = cashAccounts.reduce((s, a) => s + (balances[a.id] ?? 0), 0);

  // 이번 달 **이미 나간** 변동 지출(비정기 소비) — 전월 실적과 기준을 맞추는 데만 쓴다.
  // ★예측(monthEndCash)에는 넣지 않는다 — 이미 잔액에 반영돼 있어 또 빼면 이중차감이다.
  const variableSpentSoFar = useMemo(() => {
    const fixedCats = fixedCategoryIdsOf(scheduled);
    const cardIds = methods.filter((m) => m.kind === "credit" || m.kind === "installment").map((m) => m.id);
    const pool = outflowsForMatching(monthTxns as unknown as ActualOutflow[], accounts.map((a) => a.id), cardIds);
    return variableSpendOfMonth(pool as unknown as HhTransaction[], month, fixedCats);
  }, [monthTxns, scheduled, methods, accounts, month]);

  // 변동 지출 보정값 — 이번 달이면 남은 일수만큼만 더한다(이미 나간 몫을 두 번 빼지 않기 위해). (설계 173)
  const todayYmd = seoulToday();
  const isCurrentMonth = todayYmd.slice(0, 7) === month;
  const variableSpend = useMemo(
    () => buildVariableSpendInput(vsSamples, month, isCurrentMonth ? Number(todayYmd.slice(8, 10)) : 1, vsEnabled, vsOverride),
    [vsSamples, month, isCurrentMonth, todayYmd, vsEnabled, vsOverride],
  );

  // ★공유 계산(설계 79) — 당월 출금예정·이번 달 잔액·여러 달 예측을 현황(홈)과 같은 함수로.
  const snap = cashflowSnapshot(month, {
    scheduled,
    loans,
    installments,
    // 지출 + 수입을 함께 넘긴다 — 수입이 빠지면 '이미 받은 급여'를 예상수입으로 또 더한다(이중계상).
    txns: [...monthTxns, ...monthIncome],
    methods,
    overrides,
    nextOverrides,
    recentOutflows,
    // 내부 이체를 매칭 풀에서 빼기 위한 등록 계좌 목록(설계 131). 비활성 계좌도 우리 것이라 전부 넘긴다.
    accountIds: accounts.map((a) => a.id),
    totalCash,
    horizon,
    variableSpend: variableSpend.input,
  });
  const { nextMonth, nextOutTotal, nextForecastOut } = snap;

  // 정렬: **1차 날짜 → 2차 항목명 가나다순.** (팀장 지시 2026-08-04)
  //
  // ★2026-07-23 의 "같은 날짜 안에서는 카테고리끼리 모아 보여준다"는 **폐기**다. 카테고리 묶음은
  //   같은 날 안에서 순서가 카테고리 sort_order 에 끌려다녀, 항목을 이름으로 찾을 때 눈이 표를
  //   위아래로 훑어야 했다. 날짜 안에서는 **이름 순서가 예측 가능한 것**이 우선이다.
  // activeItems 를 여기서 정렬해 두면 filteredActive(렌더)와 projectedBalances(출금 후 잔액 누적)가 같은 순서를 써
  // '출금 후 잔액' 열이 위→아래로 매끄럽게 읽힌다(projectedBalances 는 day 안정정렬이라 입력 순서를 보존).
  const groupCompare = <T extends { day: number | null; label: string }>(a: T, b: T) =>
    (a.day ?? 99) - (b.day ?? 99) || a.label.localeCompare(b.label, "ko");
  const activeItems = [...snap.activeItems].sort(groupCompare);
  const releasedItems = [...snap.releasedItems].sort(groupCompare);
  const monthlyHeld = releasedItems.filter((i) => i.reason === "manual");        // 당월보류
  const needsCheck = releasedItems.filter((i) => i.reason === "undated" || i.reason === "no-recent"); // 확인필요(자동)
  const permanentlyHeld = snap.permanentlyHeld;                                   // 영구보류
  const nextActiveItems = [...snap.nextActiveItems].sort(groupCompare);

  // 일자 기간 필터(당월 한정) — 조회 기간의 시작일~종료일을 '월' 안의 일자로 환산. 다른 달 경계는 1일/말일로 클램프.
  const lastDay = lastDayOfMonth(month);
  const startD = period.start.slice(0, 7) === month ? Number(period.start.slice(8, 10)) : 1;
  const endD = period.end.slice(0, 7) === month ? Number(period.end.slice(8, 10)) : lastDay;
  const effStart = Math.max(1, Math.min(startD || 1, lastDay));
  const effEnd = Math.min(Math.max(endD || lastDay, effStart), lastDay);
  const inDayRange = (d: number | null) => d == null || (d >= effStart && d <= effEnd);
  const isFullMonth = effStart <= 1 && effEnd >= lastDay;
  // 출금예정 목록: 일자 기간 + 출금계좌 필터.
  const filteredActive = activeItems.filter((i) => inDayRange(i.day) && (!accountFilter || i.accountId === accountFilter));
  // '출금 후 잔액'은 단일 계좌 필터일 때만 표시(팀장 결정 2026-07-16) — 전체 보기에선 행마다
  // 다른 계좌의 누적 잔액이 섞여 위아래 값이 널뛰어 오독을 유발하기 때문. 한 통장을 고르면
  // 그 통장의 흐름(누적 차감)으로 자연스럽게 읽힌다.
  const showRunningBalance = Boolean(accountFilter);
  // 카드로 결제되는 고정비는 그날 통장에서 안 빠진다(카드대금일에 함께 나감) → 현금 합계·잔액 계산에서 제외. (설계 108)
  const filteredCashOut = filteredActive.filter((i) => !i.cardCharge);
  const paidOut = filteredCashOut.reduce((s, i) => s + (i.paidAmount ?? 0), 0); // 이미 지급됨
  const pendingOut = filteredCashOut.reduce((s, i) => s + (i.paidAmount ? 0 : i.amount), 0); // 아직 안 나감(예상). 출금금액 비움/0 = 미출금
  const cardChargeCount = filteredActive.length - filteredCashOut.length;
  // 익월 탭도 같은 안내가 필요하다 — 행에는 카드결제가 보이는데 합계에선 빠지기 때문. (설계 108 교차리뷰)
  const nextCardChargeCount = nextActiveItems.filter((i) => i.cardCharge).length;

  // 항목별 '전월 출금금액'(설계 127) — 스냅샷의 당월 매칭(paidThisMonth)과 **같은 규칙·같은 항목 풀**로
  // 전월 거래만 대조한다. 카드 결제분은 은행 실출금이 없어 매칭 풀에서 빼는 것도 동일(설계 108 후속 —
  // 넣으면 근사 매칭이 남의 전월 거래를 훔친다).
  const prevYm = shiftMonth(month, -1);
  // 전월 열 + 카드 결제분 매칭 — 컴포넌트 밖 순수 함수(computeCashMatches). cashflowSnapshot 과
  // 같은 "불투명 호출" 패턴이다: 컴포넌트 안 useMemo 로 감싸면 React Compiler 가 스냅샷(snap)을
  // 동결값으로 증명 못 해 preserve-manual-memoization 에러로 컴파일을 통째로 건너뛴다(2026-08-12 실측).
  // ★prevYm 을 인자로 넘기지 마라 — 불투명 호출에 넘긴 값은 컴파일러가 '변형 가능'으로 오염시켜
  //   prevYm 을 의존성으로 쓰는 아래 prevWithdrawnByAccount useMemo 가 같은 에러로 죽는다(실측).
  //   함수가 month 에서 스스로 계산한다.
  const { prevPaidByKey, cardPaidByKey, prevCardPaidByKey } = computeCashMatches({
    month,
    classified: snap.classified,
    paidThisMonth: snap.paidThisMonth,
    recentOutflows,
    accounts,
    methods,
  });
  // 표 하단 합계용 — 표시 중인(필터 반영) 행의 전월 매칭 합. 카드 행 결제 매칭은 통장 출금이
  // 아니라 이 합계에 넣지 않는다(설계 108 모수 유지).
  const prevPaidOut = filteredActive.reduce((s, i) => s + (prevPaidByKey.get(i.key)?.amount ?? 0), 0);
  // 매칭 거래의 결제 수단 설명 — 카드명/체크·지갑/이체. title 로만 보여 준다(칸은 금액만).
  const paidViaLabel = useCallback(
    (t: { payment_method_id?: string | null; type?: string | null; account_id?: string | null; from_account_id?: string | null }) => {
      const pm = t.payment_method_id ? methodById.get(t.payment_method_id) : null;
      if (pm) return pm.name;
      if (t.type === "transfer") return "이체";
      const acc = accounts.find((a) => a.id === (t.account_id ?? t.from_account_id));
      return acc ? `${acc.name} 출금` : "출금";
    },
    [methodById, accounts]
  );

  // 카테고리 인라인 드롭다운 옵션 — 지출 카테고리(활성)만. 조회 순서(sort_order→name) 유지.
  const expenseCategories = categories.filter((c) => c.kind === "expense" && c.is_active);
  // 항목의 카테고리 라벨(카테고리명 우선, 없으면 종류: 대출/카드결제 등).
  const itemCategoryLabel = (i: OutItem) => categoryName(i.categoryId) ?? CALENDAR_KIND_META[i.kind].name;
  // 카테고리별 출금 예정 합계(가로 막대 차트) — 표와 같은 기간·계좌 필터 반영, 예상금액 기준.
  // 카드 결제분은 카드대금 항목이 대표하므로 여기서도 빼야 상단 '출금 예정'과 같은 모수가 된다. (설계 108 교차리뷰)
  const outflowByCategory = (() => {
    const m = new Map<string, number>();
    for (const i of filteredCashOut) {
      const k = itemCategoryLabel(i);
      m.set(k, (m.get(k) ?? 0) + i.amount);
    }
    return [...m.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  })();
  const outflowByCategoryTotal = outflowByCategory.reduce((s, d) => s + d.amount, 0);

  // 계좌별 누적 차감 예상잔액 — 활성 항목 중 '미지급'만 예상금액으로 차감(지급분은 잔액에 이미 반영됨, 이중차감 방지).
  // 카드 결제분은 계좌에서 그날 안 빠지므로 차감 대상이 아니다(카드대금 항목이 대표). (설계 108)
  const projected = projectedBalances(
    balances,
    activeItems
      .filter((i) => !i.cardCharge)
      .map((i) => ({ key: i.key, accountId: i.accountId, amount: i.paidAmount ? 0 : i.amount, day: i.day }))
  );

  // 상단 요약: 출금예정(미지급)/출금액(이미 지급) — 공유 스냅샷 값(현황과 동일, 설계 79).
  const { pendingOutAll, paidOutAll } = snap;

  // 계좌별 이번달 지출(현금·체크카드 즉시출금만; 신용카드는 대금일 출금이라 제외)·이체출금.
  const expenseByAccount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of monthTxns) {
      let acc = t.account_id;
      if (!acc && t.payment_method_id) {
        const pm = methodById.get(t.payment_method_id);
        if (pm && (pm.kind === "cash" || pm.kind === "check")) acc = pm.linked_account_id;
      }
      if (acc) m[acc] = (m[acc] ?? 0) + t.amount;
    }
    return m;
  }, [monthTxns, methodById]);
  // 내부 이체(우리 통장끼리의 이동) 판정 — 실출금에서 뺀다. (설계 128)
  // 도착 계좌까지 **우리 계좌 목록에 있으면** 가계 밖으로 나간 돈이 아니다. 소유자(person_id)로
  // 판정하지 않는다 — 소유자 미지정 계좌가 실재해서, 사람 기준으로 짜면 그 계좌가 낀 이체만
  // 조용히 실출금에 남는다. 비활성 계좌도 우리 것이므로 accounts(전체)로 판정한다.
  const accountIdSet = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const isInternalTransfer = useCallback(
    (fromId: string | null, toId: string | null) =>
      Boolean(fromId && toId && accountIdSet.has(fromId) && accountIdSet.has(toId)),
    [accountIdSet]
  );
  const transferOutByAccount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of monthTransfers) {
      if (!t.from_account_id) continue;
      if (isInternalTransfer(t.from_account_id, t.to_account_id)) continue; // 내 돈의 자리바꿈
      m[t.from_account_id] = (m[t.from_account_id] ?? 0) + t.amount;
    }
    return m;
  }, [monthTransfers, isInternalTransfer]);
  /**
   * 계좌별 이번 달 `payment`(카드대금·대출상환) — **통장에서 실제로 나가는 돈**이다. (설계 177)
   *
   * ★이게 빠져 있어서 계좌별 '실출금' 이 실제보다 훨씬 작게 나왔다(팀장 지적 2026-08-15).
   *   2026-08 어느 은행 계좌가 347,480원으로 보였지만 실제로는 19,619,157원이었다(약 56배).
   *   같은 화면 최상단 요약·예측은 `outflowsForMatching` 을 써서 payment 를 포함하는데,
   *   계좌별 표만 expense+transfer 로 세고 있었다 — 한 화면에서 두 숫자가 갈려 있었다.
   * ★귀속은 `account_id ?? from_account_id` — 실측상 payment 는 `from_account_id` 에만 계좌가 있다.
   * ★조회를 늘리지 않는다: `recentOutflows`(최근 3개월·페이징 완료)에 당월 payment 가 이미 들어 있다.
   * ★내부 이체 판정은 하지 않는다 — 카드대금·대출상환은 가계 **밖으로** 나가는 지급이다.
   */
  const paymentByAccount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of recentOutflows) {
      if (t.type !== "payment") continue;
      if (t.txn_date.slice(0, 7) !== month) continue;
      const acc = t.account_id ?? t.from_account_id;
      if (acc) m[acc] = (m[acc] ?? 0) + t.amount;
    }
    return m;
  }, [recentOutflows, month]);

  /** 이번 달 이체가 오간 계좌(보낸 쪽·받은 쪽 모두, 내부 이체 포함) — 계좌 목록 접힘 판정용. */
  const transferTouchedAccounts = useMemo(() => {
    const s = new Set<string>();
    for (const t of monthTransfers) {
      if (t.from_account_id) s.add(t.from_account_id);
      if (t.to_account_id) s.add(t.to_account_id);
    }
    return s;
  }, [monthTransfers]);

  // 계좌별 전월 실출금(설계 127) — 실출금(이번달)과 **같은 규칙**을 전월 거래에 적용한다:
  // 지출(현금·체크 즉시출금만 계좌 귀속) + 이체출금. payment(카드대금·대출상환)를 빼는 것도 동일 —
  // 한쪽만 payment 를 넣으면 전월/이번달 열이 다른 자(尺)가 되어 비교가 거짓말이 된다.
  const prevWithdrawnByAccount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of recentOutflows) {
      if (t.txn_date.slice(0, 7) !== prevYm) continue;
      if (t.type === "expense") {
        let acc = t.account_id;
        if (!acc && t.payment_method_id) {
          const pm = methodById.get(t.payment_method_id);
          if (pm && (pm.kind === "cash" || pm.kind === "check")) acc = pm.linked_account_id;
        }
        if (acc) m[acc] = (m[acc] ?? 0) + t.amount;
      } else if (t.type === "transfer" && t.from_account_id) {
        // 내부 이체 제외 — 당월과 **같은 규칙**이어야 두 열이 같은 자(尺)가 된다. (설계 128)
        if (isInternalTransfer(t.from_account_id, t.to_account_id)) continue;
        m[t.from_account_id] = (m[t.from_account_id] ?? 0) + t.amount;
      } else if (t.type === "payment") {
        // 카드대금·대출상환 — 통장에서 실제로 나간다. **당월(paymentByAccount)과 같은 규칙**으로 센다.
        // ★한쪽만 넣으면 전월/이번달이 다른 자(尺)가 되어 비교가 거짓말이 된다(설계 127·177).
        const acc = t.account_id ?? t.from_account_id;
        if (acc) m[acc] = (m[acc] ?? 0) + t.amount;
      }
    }
    return m;
  }, [recentOutflows, prevYm, methodById, isInternalTransfer]);

  // 계좌별 전체출금예정액(=당월 출금 예정 '예상금액' 합)과 정기 지급분(=지급금액 합) — 기간 필터 반영, 계좌 지정 활성 항목만.
  const scheduledOutByAccount: Record<string, number> = {}; // 전체출금예정액 = Σ 예상금액
  // 정기지출 중 이미 지급된 합. 화면 컬럼은 없어졌지만(설계 102, '실출금'으로 대체) 미출금액 계산에 쓰인다.
  const paidOutByAccount: Record<string, number> = {};      // 정기 지급분 = Σ 지급금액(paidAmount)
  for (const i of filteredCashOut) {
    if (!i.accountId) continue;
    scheduledOutByAccount[i.accountId] = (scheduledOutByAccount[i.accountId] ?? 0) + i.amount;
    if (i.paidAmount) paidOutByAccount[i.accountId] = (paidOutByAccount[i.accountId] ?? 0) + i.paidAmount;
  }
  // 미출금액 = 전체출금예정액 − 출금금액(음수는 0, 이미 다 나감). 부족액 = 미출금액이 현재 잔액을 넘는 만큼(잔액 부족분).
  const unpaidOutOf = (id: string): number => Math.max(0, (scheduledOutByAccount[id] ?? 0) - (paidOutByAccount[id] ?? 0));
  // 부족액: 미출금액이 있을 때만, 현재 잔액으로 감당 못하는 만큼(미출금 0이면 0 — 마이너스 잔액이 부족액으로 새지 않게).
  const shortfallOf = (id: string): number => { const u = unpaidOutOf(id); return u === 0 ? 0 : Math.max(0, u - (balances[id] ?? 0)); };

  // 당월 출금 예정 표 하단 '합계' 행(팀장 요청 2026-07-19): 예상금액 합·출금금액 합(paidOut)·계좌잔액 합.
  const totalAmount = filteredActive.reduce((s, i) => s + i.amount, 0); // 예상금액 컬럼 전체 합
  // 전체 보기 합계 = 이 표 계좌들의 '모든 출금 후' 총 현금 = Σ잔액 − 총 미지급 예정(pendingOut). 단일계좌 필터면 그 계좌 값과 같다. (설계 104)
  const scopeAccIds = [...new Set(filteredActive.map((i) => i.accountId).filter((x): x is string => Boolean(x)))];
  const totalScopeEnd = scopeAccIds.reduce((s, id) => s + (balances[id] ?? 0), 0) - pendingOut;
  // 단일 계좌 필터일 때 '출금 후 잔액' 열의 최종값 = 현재 잔액 − 미출금 예상 합.
  const runningEndBalance = accountFilter ? (balances[accountFilter] ?? 0) - pendingOut : 0;

  // 계좌별 출금액 = 이번달 지출(소비) + 이체출금 (통장에서 실제로 빠져나간 합계).
  const withdrawnByAccount: Record<string, number> = {};
  for (const a of accounts) {
    // payment(카드대금·대출상환)를 반드시 함께 센다 — 빠지면 실출금이 실제의 몇 분의 일로 나온다. (설계 177)
    const w = (expenseByAccount[a.id] ?? 0) + (transferOutByAccount[a.id] ?? 0) + (paymentByAccount[a.id] ?? 0);
    if (w) withdrawnByAccount[a.id] = w;
  }

  // 비활성 계좌 숨기기(설계 89) — 목록·필터·드롭다운에만 적용한다.
  // 이미 데이터가 참조 중인 계좌는 비활성이어도 남긴다(하나저축은행 대출의 '하나은행(김하늘)1' 등).
  const referencedAccountIds = useMemo(() => {
    const ids: (string | null | undefined)[] = [];
    // ★잔액이 0이 아니면 비활성이어도 표에 남긴다 — 표 합계가 상단 '현금 보유' 카드·통계 '계좌 잔액'과
    //   어긋나 보이던 유일한 원인이었다(해지한 신한은행에 470,171원이 남아 표에서만 빠져 있었다).
    //   돈이 남아 있는데 화면에서만 사라지는 쪽이 훨씬 위험하다: 있는 줄 모르는 현금이 되거나,
    //   반대로 유령 잔액이면 아무도 못 보고 계속 총액을 부풀린다. (설계 116)
    for (const a of accounts) if ((balances[a.id] ?? 0) !== 0) ids.push(a.id);
    // 비활성 정기지출·상환완료 대출은 '쓰고 있는' 게 아니다 — 이걸 참조로 치면
    // 방금 비활성화한 유령 항목이 그 계좌를 목록에 되살려 놓는다.
    for (const s of scheduled) if (s.is_active) ids.push(s.account_id);
    for (const l of loans) if (l.status === "active") ids.push(l.account_id);
    for (const t of monthTxns) ids.push(t.account_id, t.from_account_id, t.to_account_id);
    for (const t of monthTransfers) ids.push(t.from_account_id, t.to_account_id);
    // ★payment 로만 돈이 나간 계좌도 남긴다 (설계 177, 교차리뷰 2026-08-15).
    //   안 넣으면 '잔액 0 + 활성 예정/대출 없음 + 당월 payment 만 있는 비활성 계좌'가
    //   **실출금이 잡히는데도 목록에서 사라지고 합계에서도 빠진다** — 돈이 나갔는데 화면에 없는 쪽이
    //   가장 위험하다(설계 116 에서 같은 이유로 잔액 0이 아닌 계좌를 남기기로 했다).
    for (const id of Object.keys(paymentByAccount)) ids.push(id);
    return ids;
  }, [accounts, balances, scheduled, loans, monthTxns, monthTransfers, paymentByAccount]);
  const listAccounts = pickVisibleAccounts(accounts, hideInactiveAccounts, referencedAccountIds);
  // 카드로 결제되는 고정비의 카드명 — '결제방식' 칸에 뱃지와 함께 보여준다. (설계 108 → 118)
  const methodLabel = (id: string | null) => (id ? methodById.get(id)?.name ?? "카드" : "카드");
  // 카드 결제분의 **결제계좌** = 그 카드대금이 실제로 빠지는 통장(카드의 연결계좌).
  // 출금계좌 열이 '출금계좌 / 결제계좌' 로 바뀌면서 카드 행이 여기를 채운다. (설계 118)
  // 카드에 연결계좌가 없으면 null — 화면은 '결제계좌 미지정' 경고를 띄운다(카드대금이 어느
  // 통장에서 빠지는지 모른다는 뜻이고, 예측·부족액 계산에서 그 항목이 통째로 빠진다).
  const settleAccountId = (methodId: string | null): string | null =>
    (methodId ? methodById.get(methodId)?.linked_account_id ?? null : null);
  const settleAccountName = (methodId: string | null): string | null => {
    const accId = settleAccountId(methodId);
    return accId ? accounts.find((a) => a.id === accId)?.name ?? null : null;
  };

  // '출금계좌 / 결제계좌' 칸 색 — **소유자 단위**(김하늘=연파랑·이바다=연주황, 설계 127, 팀장 지시 2026-08-03).
  // 색은 계좌의 person_id/이름으로 정해지므로 마스킹으로 이름이 가려져도 구분이 남는다.
  const accountTint = useMemo(() => accountTintMap(accounts, persons), [accounts, persons]);
  // 계좌가 안 정해진 칸은 무채색 — 색이 붙었다는 건 '어느 통장인지 정해졌다'는 뜻이어야 한다.
  const acctTint = (accountId: string | null | undefined) => (accountId ? accountTint.get(accountId) ?? ACCOUNT_TINT_NONE : ACCOUNT_TINT_NONE);

  // '카테고리' 셀 — **텍스트로 통일**. 당월·익월 표 공용. (설계 125, 팀장 지시 2026-08-02)
  //
  // 왜 통일했나: 같은 열인데 정기지출만 select, 대출·할부는 회색 텍스트라 모양이 갈렸다.
  //   원인은 데이터 쪽이다 — `hh_scheduled_payment`·`hh_installment` 에는 `category_id` 가 있지만
  //   **`hh_loan` 에는 없다.** 대출의 카테고리는 언제나 '대출상환'이라 고를 것이 없다.
  //   → 대출에 select 를 주면 **고를 수 없는 칸**이 되고(거짓 약속), 열 하나에 질문 하나 원칙에도 어긋난다.
  //   카테고리 변경은 항목명을 눌러 뜨는 팝업에서 한다(설계 124 로 전 종류가 팝업으로 열린다).
  const categoryCell = (i: { sourceKind: OutItem["sourceKind"]; categoryId: string | null; kind: OutItem["kind"] }) => {
    const name = i.sourceKind === "fixed" ? (categoryName(i.categoryId) ?? "미분류") : CALENDAR_KIND_META[i.kind].name;
    return <span className="block text-xs text-muted-foreground">{name}</span>;
  };

  // '결제방식' 셀 — 현금(그날 통장에서 바로) vs 카드(카드대금일에 함께). 당월·익월·모바일 공용. (설계 118)
  type PayCellItem = {
    cardCharge?: boolean;
    paymentMethodId: string | null;
    /** 그 달만 결제수단을 지정해 둔 행인가 — 배지 옆 점으로 표시한다. (설계 203) */
    methodOverridden?: boolean;
    /** 있으면 배지가 버튼이 되어 '이 달의 결제수단' 팝업을 연다. 없으면 읽기전용. (설계 203) */
    onPickMethod?: () => void;
  };
  // 결제방식은 **순수한 구분자**다 — 현금이냐 카드냐만 답한다. 무엇으로 냈는지(카드명·계좌)는
  // 옆 '출금계좌 / 결제계좌' 칸의 몫이다. 열 하나에 질문 하나. (설계 119, 팀장 지시)
  // ★배지를 칸 폭으로 채운다(w-full). 자연폭 배지를 왼쪽에 붙여 두면 오른쪽에 79.2px 빈 공간이 남아
  //   그 칸만 이웃과의 간격이 94.2px(다른 칸은 30px)이 된다 — 팀장 지적 2026-08-01 5차, 실측값.
  // 항목 자체에 등록된 결제수단(= 팝업의 '자동'이 따르는 값). 화면의 i.paymentMethodId 는
  // 그 달 오버라이드가 이미 반영된 **결과**라, '자동'의 뜻을 보여주려면 원본을 따로 읽어야 한다. (설계 203)
  const baseMethodIdOf = (sourceKind: HhCashflowSourceKind, sourceId: string): string | null => {
    if (sourceKind === "fixed") return scheduled.find((x) => x.id === sourceId)?.payment_method_id ?? null;
    if (sourceKind === "installment") return installments.find((x) => x.id === sourceId)?.payment_method_id ?? null;
    return null; // 대출·카드대금은 결제수단 개념이 없다
  };
  // 그 달 결제수단을 고를 수 있는 항목인가 — 정기지출·할부만. (설계 203)
  const canPickMethod = (sourceKind: HhCashflowSourceKind) => sourceKind === "fixed" || sourceKind === "installment";

  const payMethodCell = (i: PayCellItem) => {
    const overridden = i.methodOverridden === true;
    // ★점(·)은 배지 **안**에 넣는다. Badge 는 cva 기본에 `shrink-0` 이 있어 호출부가 w-full 을 얹어도
    //   줄지 않는다(tailwind-merge 가 바꾸는 건 w-fit 뿐) — 배지 밖에 두면 88px 칸을 넘겨 옆 '출금계좌'
    //   열 위로 그려진다(2026-09-04 교차리뷰 M3, 검사 D 칸 넘침).
    const dot = overridden ? <span aria-hidden className="ml-0.5">·</span> : null;
    const badge = i.cardCharge ? (
      <Badge variant="outline" className="w-full justify-center text-[0.7rem]">카드{dot}</Badge>
    ) : (
      <Badge variant="secondary" className="w-full justify-center font-normal text-[0.7rem]">현금{dot}</Badge>
    );
    const why = i.cardCharge
      ? "카드 결제 — 현금은 카드대금일에 함께 빠집니다"
      : "현금 결제 — 그날 통장에서 바로 빠집니다";
    // 그 달만 다른 수단으로 낸 항목(설계 203)은 눌러서 고칠 수 있다는 걸 점(·)으로 알린다.
    const title = overridden ? `${why} — 이 달만 지정한 결제수단입니다(눌러서 변경)` : `${why} (눌러서 이 달만 변경)`;
    // 열기 핸들러가 없는 행(대출·카드대금 — 결제수단 개념이 없다)은 종전대로 읽기 전용 배지다.
    // ※모바일 카드 뷰는 이 함수를 쓰지 않는다(자체 배지를 인라인으로 그린다) — 설계 203 §5 한계.
    if (!i.onPickMethod) {
      return (
        <span className="flex min-w-0 items-center" title={why}>
          {badge}
        </span>
      );
    }
    return (
      // L5: 누를 수 있다는 신호를 툴팁 말고도 준다(Tailwind v4 는 button 에 cursor 를 안 준다).
      //     스크린리더에는 "현금/카드"만으로는 무슨 버튼인지 모르므로 aria-label 을 따로 준다.
      <button
        type="button"
        onClick={i.onPickMethod}
        title={title}
        aria-label={`${i.cardCharge ? "카드" : "현금"} — 이 달의 결제수단 변경`}
        className="flex w-full min-w-0 cursor-pointer items-center rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {badge}
      </button>
    );
  };

  // 카드 행의 수단 셀 — **실제 결제되는 카드명**을 보여준다(설계 119, 팀장 지시).
  // 카드명은 묶음명('삼성카드(이바다)')으로 줄인다: 상품명까지 넣으면 열 안에서 잘려 못 읽는다.
  // 그 카드의 결제계좌(카드대금이 빠지는 통장)는 버리지 않고 title 로 남긴다.
  // 고르는 칸이 아니라 보여주는 칸이다 — 카드 행에서 계좌를 고르게 두면 신용카드 지출에
  // 출금계좌가 붙어 이중차감되는 길(설계 70 위반)을 화면이 유도한다. (설계 118 유지)
  //
  // 색은 **카드 전용 회색(CARD_TINT)** 로 통일한다(설계 127·131, 팀장 지시 2026-08-04) — 카드 행은
  // "그날 통장에서 안 빠지는" 별종이라, 소유자 색(연파랑·연주황)과 색부터 갈라야 훑을 때 섞이지 않는다.
  // 결제계좌 정보는 버리지 않고 title 로 남기고, 결제계좌 없는 카드는 ⚠ 로 계속 표시한다.
  const settleAccountCell = (i: PayCellItem) => {
    const full = methodLabel(i.paymentMethodId);
    const short = cardGroupOf(full) ?? full;
    const settle = settleAccountName(i.paymentMethodId);
    return (
      <span
        // 셀 폭을 꽉 채운다(w-full) — 옆 행의 select 와 색 블록 크기가 같아야 열이 정렬돼 보인다.
        className={`flex w-full min-w-0 items-center gap-1 rounded-md border px-2 py-1 ${CARD_TINT}`}
        title={settle ? `${maskOwnerText(full)} — 카드대금은 ${maskOwnerText(settle)}에서 빠집니다` : `${maskOwnerText(full)} — 이 카드에 결제계좌가 없어 카드대금이 어느 통장에서 빠지는지 알 수 없습니다`}
      >
        {/* 색이 붙은 칸은 글자색도 그 색 계열이다 — text-muted-foreground 를 같이 주면 그게 이긴다. */}
        <span className={HH_CELL.wrapText}>{maskOwnerText(short)}</span>
        {settle ? null : <span className="shrink-0 text-xs text-amber-600">⚠</span>}
      </span>
    );
  };

  // 카드 행의 '결제금액' 셀 — 그 달 실제 결제와 매칭된 금액(설계 119, 매칭 복구는 설계 166).
  // ⚠️ 이 열의 합계는 '통장에서 나간 현금'이라 카드 결제분은 안 든다(설계 108) →
  //    회색·읽기전용으로 두어 합계와 성격이 다름을 눈으로 알게 한다.
  //    무엇으로 냈는지(카드/체크/이체 — 팀장 지시 2026-08-12)는 title 로 남긴다.
  const cardPaidCell = (paid: number | null, via?: string | null) =>
    paid != null ? (
      <span
        className="text-muted-foreground"
        title={`${via ? `${maskOwnerText(via)}(으)로 ` : ""}결제된 금액 — 통장 출금이 아니라서 이 열 합계에는 들어가지 않습니다`}
      >
        {mask("expense_amount", won(paid))}
      </span>
    ) : (
      <span className="text-xs text-muted-foreground" title="이번 달 이 항목에 매칭되는 결제 기록이 아직 없습니다">-</span>
    );

  // 출금계좌 필터(전체 또는 단일 계좌) — 계좌 잔액 표·당월 출금예정 양쪽에 적용. (설계 docs/household/46)
  const acctScope = accountFilter ? listAccounts.filter((a) => a.id === accountFilter) : listAccounts;
  // 합계 범위 = 표시 범위에서 증권계좌(kind="stock")만 뺀 것. 증권 잔액은 당장 꺼내 쓸 현금이 아니라
  // 출금 감당 여부(부족액)를 왜곡한다 → 행에는 그대로 보여주되 합계에서만 뺀다(팀장 지시 2026-07-31, 설계 115).
  // 상단 '현금 보유' 카드(totalCash)도 같은 기준이라 두 값의 모수가 일치한다.
  const totalScope = acctScope.filter((a) => a.kind !== "stock");
  const scopeIds = new Set(totalScope.map((a) => a.id));

  // 계좌 잔액 표 열별 합계 — 필터된 계좌 범위(증권 제외)만 합산.
  const sumScoped = (m: Record<string, number>) => Object.entries(m).reduce((s, [id, n]) => (scopeIds.has(id) ? s + n : s), 0);
  const totalScheduledAll = sumScoped(scheduledOutByAccount);
  const totalWithdrawnAll = sumScoped(withdrawnByAccount);
  const totalPrevWithdrawnAll = sumScoped(prevWithdrawnByAccount); // 실출금(전월) 합계 (설계 127)

  const tableTotalBalance = totalScope.reduce((s, a) => s + (balances[a.id] ?? 0), 0); // 계좌표 합계: 필터 기준
  const totalUnpaidOut = totalScope.reduce((s, a) => s + unpaidOutOf(a.id), 0); // 미출금액 합계
  const totalShortfall = totalScope.reduce((s, a) => s + shortfallOf(a.id), 0); // 부족액 합계
  // 증권계좌만 골라 보는 중이면 합산할 현금계좌가 없다 → 0원 대신 "-"(합계 없음)로 표기해 오독을 막는다.
  const hasCashInScope = totalScope.length > 0;

  // 문자 잔액 대조(설계 71): 계좌별 최신 문자 잔액 vs 장부 잔액. 차이=수집 누락/미확정 의심.
  const balanceChecks = (() => {
    const latest = new Map<string, { account_id: string; balance: number; date: string | null; time: string | null }>();
    const sortKey = (x: { date: string | null; time: string | null }) => `${x.date ?? ""} ${x.time ?? ""}`;
    for (const r of reportedBalances) {
      const prev = latest.get(r.account_id);
      if (!prev || sortKey(r) >= sortKey(prev)) latest.set(r.account_id, r);
    }
    return [...latest.values()]
      .map((r) => {
        const acc = accounts.find((a) => a.id === r.account_id);
        const ledger = balances[r.account_id] ?? 0;
        return { accountId: r.account_id, name: acc?.name ?? "?", active: acc?.is_active ?? false, reported: r.balance, ledger, diff: r.balance - ledger, date: r.date, time: r.time };
      })
      .filter((c) => c.active)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  })();

  // 여러 달 앞 예측(설계 64)·이번 달 잔액 — 공유 스냅샷 값(현황과 동일, 설계 79).
  const { hasScheduledIncome, projection, pendingIn, monthEndCash } = snap;
  const firstRiskIdx = projection.findIndex((p) => p.closingCash < bufferLine);
  const firstRisk = firstRiskIdx >= 0 ? projection[firstRiskIdx] : null;
  const nowYm = thisMonthKey();
  const bufferInputValue = bufferDraft != null ? (bufferDraft === "" ? "" : Number(bufferDraft).toLocaleString("ko-KR")) : bufferLine.toLocaleString("ko-KR");

  // 금액(잔액·지출·출금액·출금예정 중 하나라도)이 있는 계좌만 먼저 펼쳐 보이고, 전부 빈 계좌는 더보기로 접는다.
  // ⚠️ 이체 참여도 '활동'으로 센다(설계 128) — 내부 이체를 실출금에서 빼면서 withdrawnByAccount 가
  //    0이 된 계좌가 생겼는데, 그 계좌가 통째로 '내역 없는 계좌'로 접혀 사라져 보였다(배포 전 리뷰).
  //    돈이 오간 통장은 실출금 값이 0이어도 보여야 한다. 전월만 움직인 계좌도 같은 이유로 포함.
  const hasActivity = (a: HhAccount) =>
    (balances[a.id] ?? 0) !== 0 ||
    (expenseByAccount[a.id] ?? 0) !== 0 ||
    (withdrawnByAccount[a.id] ?? 0) !== 0 ||
    (prevWithdrawnByAccount[a.id] ?? 0) !== 0 ||
    transferTouchedAccounts.has(a.id) ||
    (scheduledOutByAccount[a.id] ?? 0) !== 0;
  const fundedAccounts = acctScope.filter(hasActivity);
  const emptyAccounts = acctScope.filter((a) => !hasActivity(a));
  const visibleAccounts = accountFilter ? acctScope : showAllAccounts ? [...fundedAccounts, ...emptyAccounts] : fundedAccounts;
  // 증권계좌가 실제로 보일 때만 합계 라벨에 '증권 제외'를 붙인다 — 행 잔액을 더한 값과 합계가 다른 이유를 그 자리에서 설명.
  const totalLabel = `${accountFilter ? "선택 계좌" : "전체"}${visibleAccounts.some((a) => a.kind === "stock") ? " · 증권 제외" : ""}`;

  // 오버라이드 저장(해당 월·항목). 기존 값과 병합 후 upsert → 당월·익월 오버라이드를 재조회.
  // ym 을 넘기면 그 달에 저장한다(익월 출금 탭은 ym=익월). 기본값은 당월. (설계 81 §A)
  const saveOverride = useCallback(
    async (
      sourceKind: HhCashflowSourceKind,
      sourceId: string,
      patch: Partial<
        Pick<
          HhCashflowOverride,
          "amount_override" | "account_id" | "released" | "day_override" | "paid_override" | "payment_method_id"
        >
      >,
      ym: string = month
    ) => {
      if (!ownerUid) return false;
      const existing = (ym === month ? overrideMap : nextOverrideMap).get(`${sourceKind}:${sourceId}`);
      const payload = {
        owner_auth_uid: ownerUid,
        year_month: ym,
        source_kind: sourceKind,
        source_id: sourceId,
        amount_override: existing?.amount_override ?? null,
        account_id: existing?.account_id ?? null,
        released: existing?.released ?? false,
        day_override: existing?.day_override ?? null,
        paid_override: existing?.paid_override ?? null,
        // ★새 컬럼을 이 보존 목록에 안 넣으면, 금액·날짜를 저장하는 순간 그 달 결제수단이
        //   조용히 NULL 로 지워진다 — payload 가 컬럼을 전부 명시 나열하기 때문. (설계 203)
        payment_method_id: existing?.payment_method_id ?? null,
        ...patch,
      };
      setSaveState("saving");
      const { error: upErr } = await supabase
        .from("hh_cashflow_override")
        .upsert(payload, { onConflict: "owner_auth_uid,year_month,source_kind,source_id" });
      if (upErr) {
        toast.error(`저장 실패: ${upErr.message}`);
        setSaveState("idle");
        return false; // 실패를 호출부가 알아야 팝업을 열어 둘 수 있다(설계 203, 교차리뷰 L6)
      }
      const nextYm = shiftMonth(month, 1);
      const { data, error: selErr } = await supabase
        .from("hh_cashflow_override")
        .select("*")
        .in("year_month", [month, nextYm]);
      // ★재조회 실패를 삼키면 안 된다(2026-09-05 교차리뷰 — 양쪽이 지적).
      //   `data ?? []` 로 상태를 덮으면 **화면에서 오버라이드가 통째로 사라지고**, 그 상태로 같은 행의
      //   금액·날짜를 다시 저장하면 `existing` 을 못 찾아 payload 가 전 컬럼을 null 로 명시 나열해
      //   upsert 한다 → 방금 저장한 payment_method_id 를 포함해 그 행의 오버라이드가 **DB 에서 지워진다.**
      //   저장 자체는 성공했으므로 true 를 돌려주되, **상태는 덮지 않고** 새로고침을 안내한다.
      if (selErr) {
        toast.error(`저장은 됐지만 화면 갱신에 실패했습니다 — 새로고침해 주세요: ${selErr.message}`);
        setSaveState("idle");
        return true;
      }
      const rows = (data ?? []) as HhCashflowOverride[];
      setOverrides(rows.filter((o) => o.year_month === month));
      setNextOverrides(rows.filter((o) => o.year_month === nextYm));
      setSaveState("saved");
      return true;
    },
    [ownerUid, month, overrideMap, nextOverrideMap, supabase]
  );

  // 정기지출(고정비) 추가 — 새 항목은 최근 3개월 실적이 없어 기본은 '이번 달 쉼'으로 빠지므로,
  // 출금(out)이고 pay_day가 있으면 이번 달 day_override로 확정해 '출금 예정'에 바로 올린다.
  const addScheduled = useCallback(
    async (data: ScheduledPaymentFormData) => {
      if (!ownerUid) { toast.error("로그인 정보를 확인할 수 없습니다."); return; }
      const { data: inserted, error: insErr } = await supabase
        .from("hh_scheduled_payment")
        .insert({ owner_auth_uid: ownerUid, ...data })
        .select("id")
        .single();
      if (insErr) { toast.error(`추가 실패: ${insErr.message}`); return; }
      if (data.direction === "out" && data.pay_day != null && inserted?.id) {
        await saveOverride("fixed", inserted.id, { day_override: data.pay_day });
      }
      toast.success("정기지출을 추가했습니다. 이번 달 출금 예정에 반영됩니다.");
      await fetchData();
    },
    [ownerUid, supabase, saveOverride, fetchData]
  );

  // 정기지출 저장 — 다이얼로그에 target이 있으면 그 항목의 원본 세부 내용을 수정, 없으면 신규 추가.
  const saveScheduled = useCallback(
    async (data: ScheduledPaymentFormData) => {
      const target = spDialog.target;
      if (!target) { await addScheduled(data); return; }
      // 활성으로 저장하면 영구보류 마커를 해제한다(재개=활성이므로). 비활성 유지 땐 기존 값 보존. (설계 98)
      const patch = { ...data, permanent_hold: data.is_active ? false : (target.permanent_hold ?? false) };
      const { error: upErr } = await supabase.from("hh_scheduled_payment").update(patch).eq("id", target.id);
      if (upErr) { toast.error(`수정 실패: ${upErr.message}`); return; }
      toast.success("정기지출을 수정했습니다.");
      await fetchData();
    },
    [spDialog.target, supabase, addScheduled, fetchData]
  );

  // 당월 출금 예정 행의 카테고리 인라인 변경 — 정기지출(fixed) 원본의 category_id를 직접 수정한다(모든 달 반영, 팀장 결정 2026-07-17).
  // 카테고리는 매달 달라지지 않는 항목 고유 속성이라 그 달만 바꾸는 오버라이드가 아니라 원본을 고친다.
  // 대출·카드 대금 등은 원본에 카테고리 속성이 없어 여기서 바꾸지 않는다(종류 라벨만 표시).
  // (익월 출금 탭도 같은 함수를 쓴다 — 카테고리는 월별 값이 아니라 항목 속성이므로.)
  const saveItemCategory = useCallback(
    async (i: Pick<OutItem, "sourceKind" | "sourceId">, categoryId: string | null) => {
      if (i.sourceKind !== "fixed") return;
      setSaveState("saving");
      const { error: upErr } = await supabase.from("hh_scheduled_payment").update({ category_id: categoryId }).eq("id", i.sourceId);
      if (upErr) { toast.error(`저장 실패: ${upErr.message}`); setSaveState("idle"); return; }
      const { data } = await supabase.from("hh_scheduled_payment").select("*");
      setScheduled((data ?? []) as HhScheduledPayment[]);
      setSaveState("saved");
    },
    [supabase]
  );

  // 영구 보류 — 정기지출을 무기한 세워둔다(is_active=false + permanent_hold=true).
  // is_active=false 라 계산엔 자동 제외되고, '보류' 탭 영구보류 그룹에 표시된다(되살리기 가능). (설계 98)
  const holdPermanent = useCallback(
    async (sourceKind: string, sourceId: string) => {
      if (sourceKind !== "fixed") { toast.info("정기지출만 영구 보류할 수 있습니다."); return; }
      setSaveState("saving");
      const { error } = await supabase
        .from("hh_scheduled_payment")
        .update({ is_active: false, permanent_hold: true })
        .eq("id", sourceId);
      if (error) { toast.error(`영구 보류 실패: ${error.message}`); setSaveState("idle"); return; }
      const { data } = await supabase.from("hh_scheduled_payment").select("*");
      setScheduled((data ?? []) as HhScheduledPayment[]);
      setSaveState("saved");
    },
    [supabase]
  );

  // 영구보류 되살리기 — 다시 활성으로(is_active=true, permanent_hold=false). (설계 98)
  const reactivatePermanent = useCallback(
    async (id: string) => {
      setSaveState("saving");
      const { error } = await supabase
        .from("hh_scheduled_payment")
        .update({ is_active: true, permanent_hold: false })
        .eq("id", id);
      if (error) { toast.error(`되살리기 실패: ${error.message}`); setSaveState("idle"); return; }
      const { data } = await supabase.from("hh_scheduled_payment").select("*");
      setScheduled((data ?? []) as HhScheduledPayment[]);
      setSaveState("saved");
    },
    [supabase]
  );

  // 당월 출금 예정 항목 클릭 → 세부 내용 수정. 종류별로 편집 경로가 다르다:
  // 정기지출(fixed)=다이얼로그, 대출(loan)·할부(installment)=편집 페이지, 카드 대금(card)=계산 항목이라 개별 거래에서.
  const openItemEdit = useCallback(
    (i: OutItem) => {
      if (i.sourceKind === "fixed") {
        const sp = scheduled.find((s) => s.id === i.sourceId);
        if (sp) setSpDialog({ open: true, target: sp });
        else toast.error("정기지출 정보를 찾을 수 없습니다.");
      } else if (i.sourceKind === "loan") {
        const l = loans.find((x) => x.id === i.sourceId);
        if (l) setLoanDialog({ open: true, target: l });
        else toast.error("대출 정보를 찾을 수 없습니다.");
      } else if (i.sourceKind === "installment") {
        const ins = installments.find((x) => x.id === i.sourceId);
        if (ins) setInstDialog({ open: true, target: ins });
        else toast.error("할부 정보를 찾을 수 없습니다.");
      } else {
        // 자동 카드대금(설계 108)은 카드 승인건에서 **계산되는** 값이라 고칠 원본 행이 없다.
        // 팝업을 띄울 대상 자체가 없으므로, 어디를 고쳐야 하는지 알려 주는 쪽이 맞다.
        toast.info("카드 대금은 카드 승인 내역에서 자동 계산됩니다 — 금액을 바꾸려면 이 달 칸에 직접 입력하거나, 해당 카드 승인 거래를 수정하세요.");
      }
    },
    [scheduled, loans, installments]
  );

  // 증권계좌는 '증권' 배지로 구분한다 — 합계에서 빠지는 행임을 표에서 바로 알 수 있게. (설계 115)
  const accountCell = (a: HhAccount) => (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Landmark className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={HH_CELL.wrapText}>{mask("owner_name", a.name)}</span>
      {a.kind === "stock" ? (
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal" title="증권계좌는 당장의 현금이 아니라 합계에서 제외합니다">증권</Badge>
      ) : null}
      {/* 비활성인데도 잔액이 남아 표에 남은 계좌 — 왜 보이는지 알 수 있게 표시한다. (설계 116) */}
      {!a.is_active ? (
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal text-muted-foreground" title="비활성 계좌지만 잔액이 남아 있어 표시합니다 — 잔액이 0이 되면 자동으로 숨겨집니다">비활성</Badge>
      ) : null}
    </span>
  );

  // 금액 입력 표시값(콤마 표기). 편집 중이면 draft(숫자만)를, 아니면 현재 금액을 콤마로.
  const amountDisplay = (i: OutItem) => {
    const raw = amountDraft[i.key];
    const n = raw != null ? Number(raw) : i.amount;
    return Number.isNaN(n) ? "" : n.toLocaleString("ko-KR");
  };
  const commitAmount = (i: OutItem) => {
    const raw = (amountDraft[i.key] ?? "").trim();
    const had = amountDraft[i.key] != null;
    if (!had) return; // 편집 안 했으면 저장 안 함
    const n = raw === "" ? null : Math.round(Number(raw));
    if (n != null && (Number.isNaN(n) || n < 0)) return;
    if ((n ?? null) !== i.amount || raw === "") void saveOverride(i.sourceKind, i.sourceId, { amount_override: n });
  };
  // 출금금액 표시값 — 편집 중이면 draft, 아니면 수기값/자동매칭. 명시적으로 비운 값(paid_override=0)은 공란.
  const paidDisplay = (i: ClassifiedItem) => {
    const raw = paidDraft[i.key];
    if (raw != null) return raw === "" ? "" : Number(raw).toLocaleString("ko-KR");
    if (i.paidOverride === 0) return ""; // 사용자가 비운 값 → 공란 유지(자동매칭으로 되돌아가지 않음)
    return i.paidAmount ? i.paidAmount.toLocaleString("ko-KR") : "";
  };
  // 출금금액 커밋 — 입력하거나 지우면 그대로 저장(빈 값=0=미출금). 값이 바뀐 경우에만 저장.
  const commitPaid = (i: ClassifiedItem) => {
    if (paidDraft[i.key] == null) return; // 편집 안 했으면 저장 안 함
    const raw = paidDraft[i.key].trim();
    const n = raw === "" ? 0 : Math.round(Number(raw)); // 지우면 0(미출금)으로 저장 → 공란으로 유지됨
    if (Number.isNaN(n) || n < 0) return;
    if (n !== (i.paidOverride ?? null)) void saveOverride(i.sourceKind, i.sourceId, { paid_override: n });
  };
  // 날짜(일자) 편집기 — 빈 값이면 자동(원래 계산일)로 되돌림.
  const dayEditor = (i: OutItem, className: string) => (
    <select
      aria-label="납부일"
      value={i.day ?? ""}
      onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { day_override: e.target.value ? Number(e.target.value) : null })}
      className={className}
    >
      <option value="">자동</option>
      {Array.from({ length: lastDay }, (_, k) => k + 1).map((d) => <option key={d} value={d}>{d}일</option>)}
    </select>
  );

  // ── 익월 출금 탭 인라인 편집 (설계 81 §G) — 당월과 같은 방식이되 저장 대상 월이 익월이다.
  const nextLastDay = lastDayOfMonth(nextMonth);
  const nextAmountDisplay = (i: NextOutItem) => {
    const raw = nextAmountDraft[i.key];
    const n = raw != null ? Number(raw) : i.amount;
    return Number.isNaN(n) ? "" : n.toLocaleString("ko-KR");
  };
  // 익월 금액 커밋 — 비우면 오버라이드를 지워 당월 기준값(baseAmount)으로 되돌아간다.
  const commitNextAmount = (i: NextOutItem) => {
    const raw = nextAmountDraft[i.key];
    if (raw == null) return; // 편집 안 했으면 저장 안 함
    const trimmed = raw.trim();
    const n = trimmed === "" ? null : Math.round(Number(trimmed));
    if (n != null && (Number.isNaN(n) || n < 0)) return;
    const current = i.amountOverridden ? i.amount : null;
    if (n !== current) void saveOverride(i.sourceKind, i.sourceId, { amount_override: n }, nextMonth);
    setNextAmountDraft((d) => {
      if (!(i.key in d)) return d;
      const rest = { ...d };
      delete rest[i.key];
      return rest;
    });
  };
  const nextDayEditor = (i: NextOutItem, className: string) => (
    <select
      aria-label="익월 납부일"
      value={i.day ?? ""}
      onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { day_override: e.target.value ? Number(e.target.value) : null }, nextMonth)}
      className={className}
    >
      <option value="">자동</option>
      {Array.from({ length: nextLastDay }, (_, k) => k + 1).map((d) => <option key={d} value={d}>{d}일</option>)}
    </select>
  );

  // 이번 달 **월 전체** 수입·출금 — 전월 실적과 견줄 수 있는 유일한 값. (설계 173 ③ · 174)
  // ★예측 표의 당월 출금(projection[0].outflow)과 **다른 수**다: 예측은 현재 잔액에서 출발하므로
  //   '아직 안 나간 몫'만 센다(설계 110). 그래서 전월 실적 옆에 그대로 놓으면 "이번 달은 확 줄었다"로
  //   읽힌다 — 두 곳(최상단 카드·예측 표)이 같은 값을 쓰도록 여기 한 곳에서만 만든다(설계 79 정신).
  const curMonthIn = pendingIn + monthIncome.reduce((s2, t) => s2 + Number(t.amount), 0);
  const curMonthOut = paidOutAll + pendingOutAll + variableSpentSoFar + variableSpend.input.firstMonth;

  return (
    <PageShell>
      <HhPageHeader
        title="현금흐름"
        description="통장에서 빠지는 돈과 계좌 잔액을 봅니다."
        help={
          <>
            카드대금·대출 상환·고정비처럼 <b>통장에서 빠져나가는 돈</b>과 계좌별 잔액·부족액을 봅니다.
            소비지출(실제 쓴 돈)은 <b>지출</b> 메뉴에서 봅니다. 통장이동은 자산 총액을 바꾸지 않습니다.
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/dashboard/household/settings"><Settings className="h-4 w-4" />설정</Link></Button>
            <Button asChild><Link href="/dashboard/household/transfers/new"><Plus className="h-4 w-4" />통장이동</Link></Button>
          </div>
        }
      />

      <StatsGrid columns={5}>
        <StatCard label="현금 보유" value={won(totalCash)} mobileValue={formatAmountInMan(totalCash)} icon={Wallet} tone="default" sensitive="amount" />
        <StatCard label="입금 예정" value={won(pendingIn)} mobileValue={formatAmountInMan(pendingIn)} icon={TrendingUp} tone="positive" sensitive="income_amount" />
        <StatCard label="출금 예정" value={won(pendingOutAll)} mobileValue={formatAmountInMan(pendingOutAll)} icon={CalendarClock} tone="default" sensitive="expense_amount" />
        <StatCard label="출금금액" value={won(paidOutAll)} mobileValue={formatAmountInMan(paidOutAll)} icon={CreditCard} tone="default" sensitive="expense_amount" />
        <StatCard label={monthEndCash < bufferLine ? "이번 달 잔액 (부족)" : "이번 달 잔액"} value={won(monthEndCash)} mobileValue={formatAmountInMan(monthEndCash)} icon={Scale} tone={monthEndCash < bufferLine ? "danger" : "positive"} sensitive="amount" />
      </StatsGrid>

      {/* 전월 실적 ↔ 이번 달 예상 (설계 173 ③)
          ★출금 기준을 둘이 같게 맞춘다 — 전월은 실제 통장유출, 이번 달은 실지급+미지급+변동지출.
            기준이 다르면 나란히 놓는 의미가 없다(설계 166 에서 같은 실수를 했다). */}
      {prevActual ? (() => {
        const prevNet = prevActual.income - prevActual.outflow;
        // ★전월과 견주려면 **월 전체** 기준이어야 한다 — 값은 위에서 한 번만 만든다(설계 174).
        //   단 '같은 기준'이라고까지는 못 한다: 변동지출 몫이 정기 카테고리의 비정기 지출을 빼고 세서
        //   전월 실적보다 구조적으로 조금 작다(교차리뷰 2026-08-15).
        const curIn = curMonthIn;
        const curOut = curMonthOut;
        const curNet = curIn - curOut;
        const cell = (v: number, positive?: boolean) => (
          <span className={`font-semibold tabular-nums ${positive === undefined ? "" : v < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
            {won(v)}
          </span>
        );
        return (
          <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-3 shadow-sm">
            <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {prevActual.ym} 실적
                </span>
                <span className="text-muted-foreground" title="그 달 실제 입금 전액. 대출 실행금 같은 일회성 입금도 포함됩니다.">수입 {cell(prevActual.income)}</span>
                <span className="text-muted-foreground">출금 {cell(prevActual.outflow)}</span>
                <span className="text-muted-foreground">순증감 {cell(prevNet, true)}</span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">{month} 예상</span>
                <span className="text-muted-foreground" title="이미 받은 수입 + 아직 받을 정기수입. 대출 실행금 같은 일회성 입금도 실제로 들어왔다면 포함됩니다.">수입 {cell(curIn)}</span>
                <span className="text-muted-foreground">출금 {cell(curOut)}</span>
                <span className="text-muted-foreground">순증감 {cell(curNet, true)}</span>
              </div>
            </div>
            {/* 변동 지출 — 왜 이 금액인지 밝히고, 끄거나 조정할 수 있게 한다. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={vsEnabled} onChange={(e) => { setVsEnabled(e.target.checked); localStorage.setItem("hh_cash_varspend_on", e.target.checked ? "1" : "0"); }} />
                변동 지출(생활비) 반영
              </label>
              {vsEnabled ? (
                <>
                  <span>
                    월 <strong className="text-foreground tabular-nums">{won(variableSpend.input.monthly)}</strong>
                    {" · "}이번 달 남은 몫 <strong className="text-foreground tabular-nums">{won(variableSpend.input.firstMonth)}</strong>
                  </span>
                  <span>
                    (근거: {variableSpend.estimate.used.map((u) => u.ym).join("·") || "표본 없음"} 평균
                    {variableSpend.estimate.excluded.length ? ` · ${variableSpend.estimate.excluded.map((e) => e.ym).join("·")} 은 일회성 거액으로 제외` : ""})
                  </span>
                  <label className="flex items-center gap-1">
                    직접 지정
                    <input
                      type="number"
                      className="w-28 rounded-md border border-border/60 bg-background px-2 py-0.5 text-right text-base md:text-xs"
                      placeholder="자동"
                      value={vsOverride ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value === "" ? null : Number(e.target.value);
                        // 유한하고 0 이상인 값만 받는다 — Infinity/음수가 예측에 들어가면 숫자가 통째로 깨진다.
                        const v = raw == null || !Number.isFinite(raw) || raw < 0 ? null : raw;
                        setVsOverride(v);
                        if (v == null) localStorage.removeItem("hh_cash_varspend_override");
                        else localStorage.setItem("hh_cash_varspend_override", String(v));
                      }}
                    />
                  </label>
                </>
              ) : (
                <span>끄면 고정비·대출·카드대금만으로 예측합니다(실제보다 낙관적일 수 있습니다).</span>
              )}
            </div>
          </div>
        );
      })() : null}

      {/* 조회바 — 기간(시작~종료일) + 출금계좌. 고르는 즉시 적용. (설계 docs/household/46) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-border/70 bg-card/85 px-4 py-2 text-sm shadow-sm">
        <div className="flex items-center gap-2">
          {/* whitespace-nowrap: 모바일에서 라벨이 "기/간" 세로 줄바꿈되던 것 방지 (설계 99 G) */}
          <span className="whitespace-nowrap text-muted-foreground">기간</span>
          <input
            type="date"
            aria-label="시작일"
            value={period.start}
            max={period.end}
            onChange={(e) => setPeriod((p) => ({ ...p, start: e.target.value || p.start }))}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-base md:text-sm"
          />
          <span className="text-muted-foreground">~</span>
          <input
            type="date"
            aria-label="종료일"
            value={period.end}
            min={period.start}
            onChange={(e) => setPeriod((p) => ({ ...p, end: e.target.value || p.end }))}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-base md:text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-muted-foreground">출금계좌</span>
          <select
            aria-label="출금계좌"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="min-w-36 rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-base md:text-sm"
          >
            <option value="">전체</option>
            {listAccounts.map((a) => (
              <option key={a.id} value={a.id}>{maskOwnerText(a.name)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void fetchData()}><Search className="h-4 w-4" />검색</Button>
          <Button variant="outline" size="sm" onClick={resetFilters}><RotateCcw className="h-4 w-4" />초기화</Button>
        </div>
        <span className="ml-auto">
          {saveState === "saving" ? <span className="text-xs text-muted-foreground">저장 중…</span> : saveState === "saved" ? <span className="text-xs text-emerald-600">저장됨</span> : null}
        </span>
      </div>

      {loading ? (
        <LoadingState label="계좌 정보를 불러오는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchData()} />
      ) : (
        <>
          {/* ① 계좌 잔액 */}
          <FoldSection id="accounts" title="계좌 잔액" description="계좌별 잔액·실출금(가계 밖으로 나간 돈 = 지출+외부 이체 — 전월과 이번 달을 나란히)·전체출금예정액·미출금액(예정−지급)·부족액(잔액이 미출금액보다 모자란 금액)을 함께 봅니다. 내 통장끼리의 이체는 실출금에서 뺍니다 — 자산 총액을 바꾸지 않기 때문입니다. 증권계좌는 당장 쓸 수 있는 현금이 아니므로 표에는 그대로 보여주되 아래 합계에서는 뺍니다(상단 '현금 보유' 카드와 같은 기준).">
            {accounts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                <p className="text-sm text-muted-foreground">등록된 계좌가 없습니다. 설정에서 계좌를 추가하세요.</p>
              </div>
            ) : (
              <>
              <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
                <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(ACCT_SUM_COLS) }}>
                  {/* 열 폭 = 내용별(설계 122). 금액 5열은 척도 고정, 계좌명·계좌번호는 길이를 예측할 수 없어
                      폭을 주지 않는다 → table-fixed 가 남는 폭을 두 열이 균등 분배한다.
                      (예전 규칙인 7열 14.29% 균등은 폐기 — 금액 열에 130px 씩 공백이 남았다. 실측 근거는 설계 122) */}
                  <colgroup>
                    {colStyles(ACCT_SUM_COLS).map((st, i) => <col key={i} style={st} />)}
                  </colgroup>
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border/60 [&>th]:py-2">
                      <th className="px-4 py-3 font-medium">계좌</th>
                      <th className="px-4 py-3 font-medium">계좌번호</th>{/* 명의 컬럼은 계좌명에 이미 포함돼 제거 */}
                      <th className="px-4 py-3 text-right font-medium">잔액</th>
                      <th className="px-4 py-3 text-right font-medium" title={`지난달(${prevYm})에 가계 밖으로 나간 돈 — 지출 + 외부 이체. 내 통장끼리의 이체는 뺀다`}>실출금(전월)</th>
                      <th className="px-4 py-3 text-right font-medium" title="이번 달 가계 밖으로 나간 돈 — 지출 + 외부 이체. 내 통장끼리의 이체는 뺀다">실출금(이번달)</th>
                      <th className="px-4 py-3 text-right font-medium">전체출금예정액</th>
                      <th className="px-4 py-3 text-right font-medium">미출금액</th>
                      <th className="px-4 py-3 text-right font-medium">부족액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAccounts.map((a) => (
                      <tr key={a.id} className="border-b border-border/40 last:border-0 transition-colors hover:bg-muted/30 [&>td]:py-1">
                        {/* title도 마스킹을 거친다 — 원본이면 마스킹 모드에서 툴팁으로 실명이 새어나간다(코드리뷰 지적). */}
                        <td className="px-4 py-3 font-medium text-foreground" title={maskOwnerText(a.name)}>{accountCell(a)}</td>
                        <td className="truncate px-4 py-3 tabular-nums text-xs text-muted-foreground" title={a.account_no?.trim() ? a.account_no : undefined}>{a.account_no?.trim() ? a.account_no : "-"}</td>
                        <td className="truncate px-4 py-3 text-right tabular-nums text-foreground">{mask("amount", won(balances[a.id] ?? 0))}</td>
                        {/* 전월은 참고값이라 회색 — 이번 달(진한 색)과 눈으로 갈리게. (설계 127) */}
                        <td className="truncate px-4 py-3 text-right tabular-nums text-muted-foreground">{prevWithdrawnByAccount[a.id] ? mask("expense_amount", won(prevWithdrawnByAccount[a.id])) : "-"}</td>
                        <td className="truncate px-4 py-3 text-right tabular-nums text-foreground">{withdrawnByAccount[a.id] ? mask("expense_amount", won(withdrawnByAccount[a.id])) : "-"}</td>
                        <td className="truncate px-4 py-3 text-right tabular-nums text-muted-foreground">{scheduledOutByAccount[a.id] ? mask("expense_amount", won(scheduledOutByAccount[a.id])) : "-"}</td>
                        <td className="truncate px-4 py-3 text-right tabular-nums text-foreground">{unpaidOutOf(a.id) ? mask("expense_amount", won(unpaidOutOf(a.id))) : "-"}</td>
                        <td className="truncate px-4 py-3 text-right tabular-nums">{shortfallOf(a.id) ? <span className="text-rose-600">{mask("expense_amount", won(shortfallOf(a.id)))}</span> : <span className="text-muted-foreground">-</span>}</td>
                      </tr>
                    ))}
                    {emptyAccounts.length > 0 && !accountFilter ? (
                      <tr className="border-b border-border/40">
                        <td colSpan={8} className="px-4 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => setShowAllAccounts((v) => !v)}
                            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                          >
                            {showAllAccounts ? (
                              <><ChevronUp className="size-3.5" />내역 없는 계좌 접기</>
                            ) : (
                              <><ChevronDown className="size-3.5" />내역 없는 계좌 더보기 ({emptyAccounts.length})</>
                            )}
                          </button>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border/70 bg-muted/50 font-semibold [&>td]:py-2">
                      <td className="px-4 py-3 text-foreground" colSpan={2}>합계 ({totalLabel})</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">{hasCashInScope ? mask("amount", won(tableTotalBalance)) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">{totalPrevWithdrawnAll ? mask("expense_amount", won(totalPrevWithdrawnAll)) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">{totalWithdrawnAll ? mask("expense_amount", won(totalWithdrawnAll)) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">{totalScheduledAll ? mask("expense_amount", won(totalScheduledAll)) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">{totalUnpaidOut ? mask("expense_amount", won(totalUnpaidOut)) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{totalShortfall ? <span className="text-rose-600">{mask("expense_amount", won(totalShortfall))}</span> : <span className="text-muted-foreground">-</span>}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {/* 모바일 카드 */}
              <div className="space-y-1.5 md:hidden">
                {visibleAccounts.map((a) => (
                  <div key={a.id} className="rounded-xl border border-border/70 bg-card/85 p-2 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">{accountCell(a)}</span>
                      <span className="shrink-0 tabular-nums font-semibold text-foreground">{mask("amount", won(balances[a.id] ?? 0))}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{mask("name", personName(a.person_id))}</span>
                      {a.account_no?.trim() ? <span className="tabular-nums">{a.account_no}</span> : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted-foreground">실출금(전월) <span className="tabular-nums">{prevWithdrawnByAccount[a.id] ? mask("expense_amount", won(prevWithdrawnByAccount[a.id])) : "-"}</span></span>
                      <span className="text-muted-foreground">실출금 <span className="tabular-nums text-foreground">{withdrawnByAccount[a.id] ? mask("expense_amount", won(withdrawnByAccount[a.id])) : "-"}</span></span>
                      <span className="text-muted-foreground">전체출금예정 <span className="tabular-nums">{scheduledOutByAccount[a.id] ? mask("expense_amount", won(scheduledOutByAccount[a.id])) : "-"}</span></span>
                      <span className="text-muted-foreground">미출금액 <span className="tabular-nums text-foreground">{unpaidOutOf(a.id) ? mask("expense_amount", won(unpaidOutOf(a.id))) : "-"}</span></span>
                      {shortfallOf(a.id) ? <span className="text-muted-foreground">부족액 <span className="tabular-nums text-rose-600">{mask("expense_amount", won(shortfallOf(a.id)))}</span></span> : null}
                    </div>
                  </div>
                ))}
                {emptyAccounts.length > 0 && !accountFilter ? (
                  <button
                    type="button"
                    onClick={() => setShowAllAccounts((v) => !v)}
                    className="flex w-full items-center justify-center gap-1 rounded-xl border border-border/60 py-2.5 text-xs font-medium text-muted-foreground"
                  >
                    {showAllAccounts ? (
                      <><ChevronUp className="size-3.5" />내역 없는 계좌 접기</>
                    ) : (
                      <><ChevronDown className="size-3.5" />내역 없는 계좌 더보기 ({emptyAccounts.length})</>
                    )}
                  </button>
                ) : null}
                <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5 text-sm font-semibold">
                  <span>합계 ({totalLabel})</span>
                  <span className="tabular-nums">{hasCashInScope ? mask("amount", won(tableTotalBalance)) : "-"}</span>
                </div>
              </div>
              </>
            )}
          </FoldSection>

          {/* ② 당월 출금 예정 — 출금 예정 / 이번 달 쉼 탭 (item 6) */}
          <FoldSection
            id="outflow"
            title="당월 출금 예정"
            description="전월에 실제 나간 금액(전월 출금)·예상금액·이번 달 실제 출금금액을 나란히 대조하고, 그 옆에 각 항목 출금계좌의 잔액(감당 못하면 부족액)을 함께 봅니다 — 부족액은 아직 안 나간(날짜 안 지난) 미출금만으로 계산합니다. 출금계좌 칸 색은 소유자 구분입니다(파랑=김하늘, 주황=이바다, 회색=카드 — 카드는 그날 통장에서 안 빠집니다). 출금금액은 직접 입력·삭제 가능(비우면 미출금), 항목명을 클릭하면 세부 내용(이름·금액·카테고리·납부일·명의 등)을 수정할 수 있습니다. 위 조회바에서 출금계좌를 하나 고르면 그 통장의 누적 '출금 후 잔액' 흐름으로 바뀝니다. 날짜 확인이 필요하거나 최근 출금 기록이 없던 항목은 '이번 달 쉼' 탭으로 빠집니다. '익월 출금' 탭에서는 당월 출금금액을 기본값으로 가져와 카드값처럼 매달 바뀌는 금액을 미리 확정해 둘 수 있습니다."
            headerAction={
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setSpDialog({ open: true, target: null })}>
                <Plus className="h-4 w-4" /> 항목 추가
              </Button>
            }
          >
            <Tabs defaultValue="active">
              <TabsList>
                <TabsTrigger value="active" className={HH_TAB_SUB}>출금 예정 ({activeItems.length})</TabsTrigger>
                <TabsTrigger value="next" className={HH_TAB_SUB}>익월 출금 ({nextActiveItems.length})</TabsTrigger>
                <TabsTrigger value="released" className={HH_TAB_SUB}>보류 ({releasedItems.length + permanentlyHeld.length})</TabsTrigger>
              </TabsList>

              {/* 출금 예정 */}
              <TabsContent value="active" className="space-y-3 pt-3">
                {activeItems.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                    <p className="text-sm text-muted-foreground">이번 달 예정된 출금이 없습니다. 최근 3개월 실적이 있는 정기지출이 여기 표시됩니다. (‘이번 달 쉼’ 탭에서 날짜를 지정해 되살릴 수 있습니다.)</p>
                  </div>
                ) : (
                  <>
                  <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
                    <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(OUT_COLS) }}>
                      {/* 열 폭 = 내용별(설계 122, 팀장 6차 지적). 폭 정의는 OUT_COLS 한 곳에만 있다.
                          ★예전 규칙(9열 11.11% 균등)은 폐기 — 날짜 44px·체크박스 16px 옆에만 130~160px 공백이
                          남아 오히려 사이 공간이 들쭉날쭉했다. 이제 '내용 필요폭 + 패딩 32px' 로 잡고,
                          길이를 예측할 수 없는 열(항목·카테고리·계좌)만 남는 폭을 균등 분배한다.
                          검사: npm run test:table-width(척도 준수) · npm run test:table-render(내용 사이 간격) */}
                      <colgroup>
                        {colStyles(OUT_COLS).map((st, i) => <col key={i} style={st} />)}
                      </colgroup>
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr className="border-b border-border/60 [&>th]:py-2">
                          <th className="px-4 py-3 font-medium">날짜</th>
                          <th className="px-4 py-3 font-medium">항목</th>
                          <th className="px-4 py-3 font-medium">카테고리</th>
                          <th className="px-4 py-3 text-center font-medium" title="현금 = 그날 통장에서 바로 / 카드 = 카드대금일에 함께">결제방식</th>
                          <th className="px-4 py-3 font-medium" title="현금 행은 그날 빠지는 출금계좌, 카드 행은 카드대금이 빠지는 결제계좌">출금계좌 / 결제계좌</th>
                          <th className="px-4 py-3 text-right font-medium" title={`지난달(${prevYm})에 이 항목으로 매칭된 실제 출금금액`}>전월 출금</th>
                          <th className="px-4 py-3 text-right font-medium">예상금액</th>
                          {/* 헤더는 '출금 / 결제금액' 으로 줄였다(설계 127) — '전월 출금' 열이 늘며 표 폭 1200 을 지키기 위함. 뜻은 title 이 보존한다. */}
                          <th className="px-4 py-3 text-right font-medium" title="현금 행은 통장에서 나간 출금금액, 카드 행은 카드로 결제된 금액(합계에는 현금만 듭니다)">출금 / 결제금액</th>
                          <th className="px-4 py-3 text-right font-medium">출금 후 잔액</th>
                          <th className="px-4 py-3 text-center font-medium">제외</th>
                        </tr>
                      </thead>
                      <tbody className="text-[0.8rem]">
                        {filteredActive.length === 0 ? (
                          <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">선택한 기간({effStart}~{effEnd}일)에 출금 예정이 없습니다.</td></tr>
                        ) : filteredActive.map((i) => {
                          const past = i.day != null && i.day < todayDay;
                          const paid = !!i.paidAmount;
                          // 지난 날짜는 흐리게만 한다. ★`grayscale` 을 쓰지 마라 — CSS filter 라
                          // 자손 전부의 채도를 없애 계좌별 색(설계 126)이 통째로 죽는다. 달 후반에는
                          // 대부분의 행이 past 라 색 구분이 사실상 사라진다(교차리뷰 2026-08-02 지적).
                          return (
                            <tr key={i.key} className={`border-b border-border/40 last:border-0 [&>td]:py-1 ${past ? "opacity-60" : paid ? "bg-emerald-50/30 dark:bg-emerald-950/10" : ""}`}>
                              <td className="whitespace-nowrap px-4 py-2.5">
                                {/* 셀 안 컨트롤은 전부 w-full — 열 폭이 같아도 컨트롤 폭이 제각각이면 좌우 여백이 어긋난다(팀장 지적 2026-08-01). */}
                                {dayEditor(i, "w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-base md:text-[0.8rem]")}
                              </td>
                              <td className="px-4 py-2.5">
                                {/* ★w-full 필수 — <button> 은 flex 로 바꿔도 폭이 fit-content 라 긴 항목명이 옆 칸을 침범한다(실측 +44px). */}
                                <button
                                  type="button"
                                  onClick={() => openItemEdit(i)}
                                  title={`${maskOwnerText(i.label)} — 클릭해 세부 내용 수정`}
                                  className="flex w-full min-w-0 items-center gap-1.5 text-left text-foreground transition-colors hover:text-primary hover:underline"
                                >
                                  <span aria-hidden className="shrink-0">{CALENDAR_KIND_META[i.kind].icon}</span>
                                  <span className={`min-w-0 flex-1 ${HH_CELL.wrapText}`}>{maskOwnerText(i.label)}</span>
                                </button>
                              </td>
                              <td className="px-4 py-2.5">
                                {categoryCell(i)}
                              </td>
                              {/* 결제방식 — 현금/카드 구분자. 카드명은 여기로 옮겨왔다(설계 118, 팀장 요청).
                                  눌러서 '이 달의 결제수단'을 바꾼다(설계 203). */}
                              <td className="px-4 py-2.5">
                                {payMethodCell({
                                  ...i,
                                  methodOverridden: overrideMap.get(i.key)?.payment_method_id != null,
                                  onPickMethod: canPickMethod(i.sourceKind)
                                    ? () =>
                                        setMethodTarget({
                                          sourceKind: i.sourceKind,
                                          sourceId: i.sourceId,
                                          label: i.label,
                                          ym: month,
                                          value: overrideMap.get(i.key)?.payment_method_id ?? null,
                                          baseMethodId: baseMethodIdOf(i.sourceKind, i.sourceId),
                                        })
                                    : undefined,
                                })}
                              </td>
                              <td className="px-4 py-2.5">
                                {/* 카드 행은 그 카드대금이 빠지는 '결제계좌'를 보여준다(고르는 칸 아님). (설계 118) */}
                                {i.cardCharge ? (
                                  settleAccountCell(i)
                                ) : (
                                  <select
                                    aria-label="출금계좌"
                                    value={i.accountId ?? ""}
                                    onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { account_id: e.target.value || null })}
                                    // 계좌별 색(설계 126). ★border/bg/text 는 acctTint 가 통째로 준다 —
                                    //   여기에 border-border/60·bg-background 를 같이 적으면 뒤에 출력되는 쪽이 이겨 색이 죽는다.
                                    className={`w-full rounded-md border hh-select pl-2 pr-6 py-1 text-base md:text-[0.8rem] ${acctTint(i.accountId)}`}
                                  >
                                    <option value="">계좌 선택…</option>
                                    {listAccounts.map((a) => (
                                      <option key={a.id} value={a.id}>{maskOwnerText(a.name)}</option>
                                    ))}
                                  </select>
                                )}
                              </td>
                              {/* 전월 출금 — 지난달 실거래에 같은 매칭 규칙으로 대조한 참고값(읽기전용, 설계 127).
                                  카드 행은 통장 출금이 아니라 합계엔 안 들지만, 결제 여부는 보여야 한다(설계 166) →
                                  매칭된 결제금액을 작은 글씨 '결제 N원' 으로 표시. */}
                              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                                {/* ★전월 열은 **등록값**(baseCardCharge)으로 분기한다 — 계산 쪽
                                    (computeCashMatches)이 등록값으로 두 맵을 채우기 때문이다(설계 203 §4-1 ⓔ).
                                    그 달 값(cardCharge)으로 고르면 오버라이드가 걸린 행이 **값이 든 맵을
                                    절대 안 보게 되어** 전월 금액이 양방향으로 사라진다(2026-09-05 교차리뷰 High).
                                    합계(prevPaidOut)도 prevPaidByKey 를 쓰므로 여기서 갈리면 행과 합계가 어긋난다. */}
                                {i.baseCardCharge ? (
                                  prevCardPaidByKey.get(i.key) ? (
                                    <span
                                      className="text-xs"
                                      title={`지난달 ${maskOwnerText(paidViaLabel(prevCardPaidByKey.get(i.key)!))}(으)로 결제 — 통장 출금이 아니라 합계에는 들어가지 않습니다`}
                                    >
                                      결제 {mask("expense_amount", won(prevCardPaidByKey.get(i.key)!.amount))}
                                    </span>
                                  ) : (
                                    <span className="text-xs" title={`지난달(${prevYm})에 매칭되는 결제 기록이 없습니다`}>-</span>
                                  )
                                ) : prevPaidByKey.get(i.key) ? (
                                  mask("expense_amount", won(prevPaidByKey.get(i.key)!.amount))
                                ) : (
                                  <span title={`지난달(${prevYm})에 매칭되는 출금 기록이 없습니다`}>-</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={amountDisplay(i)}
                                  onChange={(e) => setAmountDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                                  onBlur={() => commitAmount(i)}
                                  className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-right tabular-nums text-base md:text-[0.8rem]"
                                />
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {/* 카드 결제분은 '통장 출금'이 아니라 이 열의 합계에 안 들어간다 →
                                    입력받으면 행 값과 합계가 어긋나므로 입력칸을 두지 않는다. (설계 108 교차리뷰)
                                    다만 무조건 '-' 로 비워 두던 것을, 매칭된 **결제금액**이 있으면 보여준다. (설계 119) */}
                                {i.cardCharge ? (
                                  cardPaidCell(
                                    i.paidAmount ?? cardPaidByKey.get(i.key)?.amount ?? null,
                                    cardPaidByKey.get(i.key) ? paidViaLabel(cardPaidByKey.get(i.key)!) : null
                                  )
                                ) : (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={paidDisplay(i)}
                                    onChange={(e) => setPaidDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                                    onBlur={() => commitPaid(i)}
                                    placeholder="-"
                                    title="실제 출금금액. 자동 매칭값이 채워지며, 직접 입력하거나 비우면(=미출금) 그대로 저장됩니다."
                                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-right tabular-nums text-base font-medium text-foreground placeholder:font-sans placeholder:font-normal placeholder:text-muted-foreground md:text-[0.8rem]"
                                  />
                                )}
                              </td>
                              {/* 출금 후 잔액 = 그 계좌의 그 날짜까지 반영한 누적 잔액(projected). 전체·단일계좌 동일. (설계 104) */}
                              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                                {i.cardCharge ? (
                                  // 카드 결제분은 이 날 통장 잔액이 안 변한다 — 카드대금 항목이 그 유출을 대표한다. (설계 108)
                                  <span className="text-xs text-muted-foreground">카드대금일 반영</span>
                                ) : i.accountId == null ? (
                                  <span className="text-xs text-amber-600">계좌 지정 필요</span>
                                ) : projected[i.key] != null ? (
                                  <span className={!maskEnabled && projected[i.key] < 0 ? "text-rose-600" : "text-foreground"}>{mask("expense_amount", won(maskEnabled ? Math.abs(projected[i.key]) : projected[i.key]))}</span>
                                ) : (
                                  "-"
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-center">
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label="보류"
                                      title="이번 달만 보류 / 영구 보류"
                                      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600"
                                    >
                                      <X className="size-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => void saveOverride(i.sourceKind, i.sourceId, { released: true })}>
                                      <RotateCcw className="mr-2 size-4" />
                                      <span>이번 달만 보류<span className="block text-xs text-muted-foreground">다음 달 자동 재개</span></span>
                                    </DropdownMenuItem>
                                    {i.sourceKind === "fixed" ? (
                                      <DropdownMenuItem onClick={() => void holdPermanent(i.sourceKind, i.sourceId)}>
                                        <Ban className="mr-2 size-4" />
                                        <span>영구 보류<span className="block text-xs text-muted-foreground">수동 재개까지 세워둠</span></span>
                                      </DropdownMenuItem>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border/70 bg-muted/50 font-semibold [&>td]:py-2">
                          {/* 10열(설계 127 로 '전월 출금' 추가) — 라벨 5 + 전월 + 예상 + 출금 + 잔액 + 제외 = 10 */}
                          <td className="px-4 py-3 text-foreground" colSpan={5}>
                            {isFullMonth ? "이번 달 합계" : `선택 기간(${effStart}~${effEnd}일) 합계`}
                            {/* 카드로 결제되는 고정비는 예상금액 합에는 있지만 통장에서 그날 빠지지 않는다 — 오독 방지. (설계 108) */}
                            {cardChargeCount > 0 ? (
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                카드결제 {cardChargeCount}건 포함 — 예상금액엔 들어가지만 출금금액 합계엔 안 듭니다(통장 출금은 카드대금일)
                              </span>
                            ) : null}
                          </td>
                          {/* 전월 출금 합계 — 참고값이라 회색(행과 같은 톤). 카드 행 매칭이 없어 현금 합계와 같은 모수다. */}
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">{prevPaidOut ? mask("expense_amount", won(prevPaidOut)) : "-"}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums font-semibold text-foreground">{mask("expense_amount", won(totalAmount))}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums font-semibold text-foreground">{paidOut ? mask("expense_amount", won(paidOut)) : "-"}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            {showRunningBalance ? (
                              accountFilter ? (
                                <span className={!maskEnabled && runningEndBalance < 0 ? "text-rose-600" : "text-foreground"}>{mask("expense_amount", won(maskEnabled ? Math.abs(runningEndBalance) : runningEndBalance))}</span>
                              ) : "-"
                            ) : (
                              <span className={!maskEnabled && totalScopeEnd < 0 ? "text-rose-600" : "text-foreground"}>{mask("expense_amount", won(maskEnabled ? Math.abs(totalScopeEnd) : totalScopeEnd))}</span>
                            )}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {/* 모바일 카드 */}
                  <div className="space-y-1.5 md:hidden">
                    {filteredActive.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border/70 bg-background/40 p-6 text-center text-sm text-muted-foreground">선택한 기간({effStart}~{effEnd}일)에 출금 예정이 없습니다.</div>
                    ) : filteredActive.map((i) => {
                      const past = i.day != null && i.day < todayDay;
                      const paid = i.paidAmount != null;
                      // 데스크톱 표와 같은 이유로 grayscale 금지 — 계좌 색이 죽는다. (설계 126)
                      return (
                        <div key={i.key} className={`rounded-xl border bg-card/85 p-2 shadow-sm ${past ? "border-border/70 opacity-60" : paid ? "border-emerald-300/60 bg-emerald-50/20 dark:bg-emerald-950/10" : "border-border/70"}`}>
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
                              <button
                                type="button"
                                onClick={() => openItemEdit(i)}
                                className="inline-flex min-w-0 items-center gap-1.5 text-left text-foreground transition-colors hover:text-primary hover:underline"
                              >
                                <span aria-hidden>{CALENDAR_KIND_META[i.kind].icon}</span>
                                <span className={`${HH_CELL.wrapText} font-semibold`}>{maskOwnerText(i.label)}</span>
                              </button>
                              {i.sourceKind !== "fixed" ? (
                                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal">{CALENDAR_KIND_META[i.kind].name}</Badge>
                              ) : null}
                              {/* 결제방식 구분자 — 현금/카드만. 카드명은 아래 수단 칸으로. (설계 119) */}
                              {i.cardCharge ? (
                                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal" title="카드 결제 — 현금은 카드대금일에 함께 빠집니다">카드</Badge>
                              ) : (
                                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal" title="현금 결제 — 그날 통장에서 바로 빠집니다">현금</Badge>
                              )}
                            </span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label="보류"
                                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                                >
                                  <X className="size-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => void saveOverride(i.sourceKind, i.sourceId, { released: true })}>
                                  <RotateCcw className="mr-2 size-4" />
                                  <span>이번 달만 보류<span className="block text-xs text-muted-foreground">다음 달 자동 재개</span></span>
                                </DropdownMenuItem>
                                {i.sourceKind === "fixed" ? (
                                  <DropdownMenuItem onClick={() => void holdPermanent(i.sourceKind, i.sourceId)}>
                                    <Ban className="mr-2 size-4" />
                                    <span>영구 보류<span className="block text-xs text-muted-foreground">수동 재개까지 세워둠</span></span>
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          {/* 날짜·예상금액·출금계좌·(카테고리)를 2열 그리드로 — 라벨 없이 값/placeholder로 구분해 카드 높이를 더 줄인다(모바일 스크롤 단축).
                              정기지출만 카테고리가 있어 2×2가 되고, 대출·카드대금은 카테고리가 없어 출금계좌가 아래 줄 전체를 쓴다. */}
                          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                            {dayEditor(i, "w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-sm")}
                            <input
                              type="text"
                              inputMode="numeric"
                              aria-label="예상금액"
                              placeholder="예상금액"
                              value={amountDisplay(i)}
                              onChange={(e) => setAmountDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                              onBlur={() => commitAmount(i)}
                              className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-right tabular-nums text-sm"
                            />
                            {/* 카드 행은 계좌 선택 대신 '결제계좌'(카드대금이 빠지는 통장)를 보여준다.
                                결제방식(현금/카드)·카드명은 카드 머리줄에 뱃지로 따로 붙는다. (설계 118) */}
                            {i.cardCharge ? (
                              // 테두리·배경은 settleAccountCell 이 계좌 색으로 직접 그린다 — 여기서 또 주면 겹친다. (설계 126)
                              <span className={`flex w-full items-center text-sm ${i.sourceKind === "fixed" ? "" : "col-span-2"}`}>
                                {settleAccountCell(i)}
                              </span>
                            ) : (
                              <select
                                aria-label="출금계좌"
                                value={i.accountId ?? ""}
                                onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { account_id: e.target.value || null })}
                                className={`w-full rounded-md border hh-select pl-2 pr-6 py-1 text-sm ${i.sourceKind === "fixed" ? "" : "col-span-2"} ${acctTint(i.accountId)} ${i.accountId ? "" : "text-muted-foreground"}`}
                              >
                                <option value="">출금계좌 선택…</option>
                                {listAccounts.map((a) => (
                                  <option key={a.id} value={a.id}>{maskOwnerText(a.name)}</option>
                                ))}
                              </select>
                            )}
                            {i.sourceKind === "fixed" ? (
                              <select
                                aria-label="카테고리"
                                value={i.categoryId ?? ""}
                                onChange={(e) => void saveItemCategory(i, e.target.value || null)}
                                className={`w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-sm ${i.categoryId ? "" : "text-muted-foreground"}`}
                              >
                                <option value="">미분류</option>
                                {expenseCategories.map((c) => (
                                  <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                              </select>
                            ) : null}
                          </div>
                          {/* 전월 출금 — 데스크톱 표의 '전월 출금' 열과 같은 값(참고용, 설계 127). 매칭이 있을 때만 보여 카드 높이를 지킨다.
                              카드 행은 '전월 결제'로 갈아 표기(설계 166) — 통장 출금이 아님을 라벨로 가른다. */}
                          {/* 전월 열 분기는 데스크톱과 같이 **등록값**으로 (설계 203 §4-1 ⓔ). */}
                          {!i.baseCardCharge && prevPaidByKey.get(i.key) ? (
                            <div className="mt-1.5 text-xs text-muted-foreground">
                              전월 출금 <span className="tabular-nums">{mask("expense_amount", won(prevPaidByKey.get(i.key)!.amount))}</span>
                            </div>
                          ) : i.baseCardCharge && prevCardPaidByKey.get(i.key) ? (
                            <div className="mt-1.5 text-xs text-muted-foreground" title={`지난달 ${maskOwnerText(paidViaLabel(prevCardPaidByKey.get(i.key)!))}(으)로 결제`}>
                              전월 결제 <span className="tabular-nums">{mask("expense_amount", won(prevCardPaidByKey.get(i.key)!.amount))}</span>
                            </div>
                          ) : null}
                          {/* 출금금액 + 계좌잔액/부족액을 한 줄에 — 잔액·부족액은 오른쪽에 작게(text-[0.7rem]) 붙여 줄바꿈을 막는다(팀장 요청 2026-07-23). */}
                          <div className="mt-1.5 flex flex-nowrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
                            {/* 카드 결제분은 출금금액 합계에 안 들어가므로 입력칸을 두지 않는다(데스크톱과 동일). (설계 108)
                                라벨은 '결제금액'으로 갈고 매칭된 금액을 보여준다. (설계 119) */}
                            {i.cardCharge ? (
                              <span className="shrink-0">결제금액 {cardPaidCell(
                                i.paidAmount ?? cardPaidByKey.get(i.key)?.amount ?? null,
                                cardPaidByKey.get(i.key) ? paidViaLabel(cardPaidByKey.get(i.key)!) : null
                              )}</span>
                            ) : (
                              <label className="inline-flex shrink-0 items-center gap-1.5">출금금액
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={paidDisplay(i)}
                                  onChange={(e) => setPaidDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                                  onBlur={() => commitPaid(i)}
                                  placeholder="-"
                                  className="w-20 rounded-md border border-border/60 bg-background px-2 py-1 text-right tabular-nums text-sm font-medium text-foreground placeholder:font-sans placeholder:text-muted-foreground"
                                />
                              </label>
                            )}
                            <span className="whitespace-nowrap text-right text-[0.7rem] leading-tight">출금 후 잔액 <span className="tabular-nums">
                              {i.cardCharge ? (
                                // 카드 결제분은 이 날 통장 잔액이 안 변한다 — 데스크톱 표와 동일. (설계 108)
                                <span className="text-muted-foreground">카드대금일 반영</span>
                              ) : i.accountId == null ? (
                                <span className="text-amber-600">계좌 지정 필요</span>
                              ) : projected[i.key] != null ? (
                                <span className={!maskEnabled && projected[i.key] < 0 ? "text-rose-600" : "text-foreground"}>{mask("expense_amount", won(maskEnabled ? Math.abs(projected[i.key]) : projected[i.key]))}</span>
                              ) : (
                                "-"
                              )}
                            </span></span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="rounded-xl bg-muted/50 px-3 py-2.5 text-sm font-semibold">
                      <span>{isFullMonth ? "이번 달 합계" : `기간(${effStart}~${effEnd}일) 합계`}</span>
                      {cardChargeCount > 0 ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">카드결제 {cardChargeCount}건 포함 (통장 출금은 카드대금일)</span>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground">
                        <span>예상금액 <span className="tabular-nums font-semibold text-foreground">{mask("expense_amount", won(totalAmount))}</span></span>
                        <span>출금금액 <span className="tabular-nums font-semibold text-foreground">{paidOut ? mask("expense_amount", won(paidOut)) : "-"}</span></span>
                        {showRunningBalance ? (
                          accountFilter ? (
                            <span>출금 후 잔액 <span className="tabular-nums font-semibold text-foreground">{mask("expense_amount", won(runningEndBalance))}</span></span>
                          ) : null
                        ) : (
                          <span>출금 후 잔액 <span className={`tabular-nums font-semibold ${!maskEnabled && totalScopeEnd < 0 ? "text-rose-600" : "text-foreground"}`}>{mask("expense_amount", won(maskEnabled ? Math.abs(totalScopeEnd) : totalScopeEnd))}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  </>
                )}
                <p className="hidden text-xs text-muted-foreground md:block">※ 예상금액과 이번 달 매칭된 실제 지급을 대조합니다(금액 정확일치+상대처). 지급된 항목은 잔액에 이미 반영돼 재차감하지 않습니다. 수정·제외·날짜변경은 이번 달({month})에만 적용됩니다.</p>
              </TabsContent>

              {/* 익월 출금 — 당월 출금금액을 끌어와 카드값·변동금액을 미리 확정한다. (설계 81) */}
              <TabsContent value="next" className="space-y-3 pt-3">
                {nextActiveItems.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                    <p className="text-sm text-muted-foreground">익월({nextMonth})에 예정된 출금이 없습니다.</p>
                  </div>
                ) : (
                  <>
                  <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
                    <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(NEXT_COLS) }}>
                      {/* 열 폭 = 내용별(설계 122). 정의는 NEXT_COLS 한 곳에만 둔다. */}
                      <colgroup>
                        {colStyles(NEXT_COLS).map((st, i) => <col key={i} style={st} />)}
                      </colgroup>
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr className="border-b border-border/60 [&>th]:py-2">
                          <th className="px-4 py-3 font-medium">날짜</th>
                          <th className="px-4 py-3 font-medium">항목</th>
                          <th className="px-4 py-3 font-medium">카테고리</th>
                          <th className="px-4 py-3 text-center font-medium" title="현금 = 그날 통장에서 바로 / 카드 = 카드대금일에 함께">결제방식</th>
                          <th className="px-4 py-3 font-medium" title="현금 행은 그날 빠지는 출금계좌, 카드 행은 카드대금이 빠지는 결제계좌">출금계좌 / 결제계좌</th>
                          <th className="px-4 py-3 text-right font-medium">당월 출금금액</th>
                          <th className="px-4 py-3 text-right font-medium">익월 예상금액</th>
                          <th className="px-4 py-3 text-center font-medium">제외</th>
                        </tr>
                      </thead>
                      <tbody className="text-[0.8rem]">
                        {nextActiveItems.map((i) => (
                          <tr key={i.key} className="border-b border-border/40 last:border-0 [&>td]:py-1">
                            <td className="whitespace-nowrap px-4 py-2.5">
                              {nextDayEditor(i, "w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-base md:text-[0.8rem]")}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span aria-hidden className="shrink-0">{CALENDAR_KIND_META[i.kind].icon}</span>
                                <span className={`min-w-0 flex-1 ${HH_CELL.wrapText}`} title={maskOwnerText(i.label)}>{maskOwnerText(i.label)}</span>
                                {i.amountOverridden ? <Badge variant="secondary" className="shrink-0 font-normal">입력함</Badge> : null}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              {categoryCell(i)}
                            </td>
                            {/* 결제방식 — 당월 표와 같은 셀을 쓴다. (설계 118)
                                익월 결제수단은 **익월 오버라이드로만** 정해진다 — 당월 것을 안 물려받는다(설계 203 §4). */}
                            <td className="px-4 py-2.5">
                              {payMethodCell({
                                ...i,
                                methodOverridden: nextOverrideMap.get(i.key)?.payment_method_id != null,
                                onPickMethod: canPickMethod(i.sourceKind)
                                  ? () =>
                                      setMethodTarget({
                                        sourceKind: i.sourceKind,
                                        sourceId: i.sourceId,
                                        label: i.label,
                                        ym: nextMonth,
                                        value: nextOverrideMap.get(i.key)?.payment_method_id ?? null,
                                        baseMethodId: baseMethodIdOf(i.sourceKind, i.sourceId),
                                      })
                                  : undefined,
                              })}
                            </td>
                            <td className="px-4 py-2.5">
                              {/* 카드 행은 그 카드대금이 빠지는 '결제계좌'를 보여준다(당월 표와 동일). (설계 118) */}
                              {i.cardCharge ? (
                                settleAccountCell(i)
                              ) : (
                                <select
                                  aria-label="출금계좌"
                                  value={i.accountId ?? ""}
                                  onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { account_id: e.target.value || null }, nextMonth)}
                                  className={`w-full rounded-md border hh-select pl-2 pr-6 py-1 text-base md:text-[0.8rem] ${acctTint(i.accountId)}`}
                                >
                                  <option value="">계좌 선택…</option>
                                  {listAccounts.map((a) => (
                                    <option key={a.id} value={a.id}>{maskOwnerText(a.name)}</option>
                                  ))}
                                </select>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                              {i.currentPaid != null ? (
                                mask("expense_amount", won(i.currentPaid))
                              ) : i.currentAmount != null ? (
                                <span title="당월에 아직 출금 기록이 없어 당월 예상금액을 가져왔습니다.">{mask("expense_amount", won(i.currentAmount))} <span className="text-xs">(예상)</span></span>
                              ) : (
                                <span title="당월에 없던 신규 항목입니다.">-</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <input
                                type="text"
                                inputMode="numeric"
                                value={nextAmountDisplay(i)}
                                onChange={(e) => setNextAmountDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                                onBlur={() => commitNextAmount(i)}
                                title="익월에 나갈 금액. 카드값처럼 매달 변하는 값을 직접 입력하세요. 비우면 당월 값으로 되돌아갑니다."
                                className={`w-full rounded-md border bg-background px-2 py-1 text-right tabular-nums text-base md:text-[0.8rem] ${i.amountOverridden ? "border-primary/60 font-medium text-foreground" : "border-border/60"}`}
                              />
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <button
                                type="button"
                                aria-label="익월 일시정지"
                                title="익월만 건너뜁니다 — 그 다음 달은 자동으로 다시 잡힙니다"
                                onClick={() => void saveOverride(i.sourceKind, i.sourceId, { released: true }, nextMonth)}
                                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                              >
                                <X className="size-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border/70 bg-muted/50 font-semibold [&>td]:py-2">
                          {/* 8열(설계 118 로 '결제방식' 추가) — 라벨 6 + 익월 예상금액 + 제외 = 8 */}
                          <td className="px-4 py-3 text-foreground" colSpan={6}>
                            익월({nextMonth}) 출금 합계
                            {nextCardChargeCount > 0 ? (
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                카드결제 {nextCardChargeCount}건 제외 (통장 출금은 카드대금일)
                              </span>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums font-semibold text-foreground">-{mask("expense_amount", won(nextOutTotal))}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {/* 모바일 카드 */}
                  <div className="space-y-1.5 md:hidden">
                    {nextActiveItems.map((i) => (
                      <div key={i.key} className="rounded-xl border border-border/70 bg-card/85 p-2 shadow-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
                            <span aria-hidden>{CALENDAR_KIND_META[i.kind].icon}</span>
                            <span className={`${HH_CELL.wrapText} font-semibold`}>{maskOwnerText(i.label)}</span>
                            {i.sourceKind !== "fixed" ? (
                              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal">{CALENDAR_KIND_META[i.kind].name}</Badge>
                            ) : null}
                            {/* 결제방식 구분자 — 현금/카드만. 카드명은 아래 수단 칸으로. (설계 119) */}
                            {i.cardCharge ? (
                              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal" title="카드 결제 — 현금은 카드대금일에 함께 빠집니다">카드</Badge>
                            ) : (
                              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal" title="현금 결제 — 그날 통장에서 바로 빠집니다">현금</Badge>
                            )}
                          </span>
                          <button
                            type="button"
                            aria-label="익월 일시정지"
                            title="익월만 건너뜁니다 — 그 다음 달은 자동으로 다시 잡힙니다"
                            onClick={() => void saveOverride(i.sourceKind, i.sourceId, { released: true }, nextMonth)}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                        {/* 라벨 없이 값/placeholder로 구분해 카드 높이를 더 줄인다(당월 탭과 동일 기준). */}
                        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                          {nextDayEditor(i, "w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-sm")}
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label="익월 예상금액"
                            placeholder="익월 예상금액"
                            value={nextAmountDisplay(i)}
                            onChange={(e) => setNextAmountDraft((d) => ({ ...d, [i.key]: e.target.value.replace(/[^\d]/g, "") }))}
                            onBlur={() => commitNextAmount(i)}
                            className={`w-full rounded-md border bg-background px-2 py-1 text-right tabular-nums text-sm ${i.amountOverridden ? "border-primary/60 font-medium" : "border-border/60"}`}
                          />
                          {/* 카드 행은 계좌를 고르는 의미가 없다(합계에서 계속 제외됨) → 결제계좌를 보여준다. (설계 118) */}
                          {i.cardCharge ? (
                            // 테두리·배경은 settleAccountCell 이 계좌 색으로 직접 그린다. (설계 126)
                            <span className="col-span-2 flex w-full items-center text-sm">
                              {settleAccountCell(i)}
                            </span>
                          ) : (
                            <select
                              aria-label="출금계좌"
                              value={i.accountId ?? ""}
                              onChange={(e) => void saveOverride(i.sourceKind, i.sourceId, { account_id: e.target.value || null }, nextMonth)}
                              className={`col-span-2 w-full rounded-md border hh-select pl-2 pr-6 py-1 text-sm ${acctTint(i.accountId)} ${i.accountId ? "" : "text-muted-foreground"}`}
                            >
                              <option value="">출금계좌 선택…</option>
                              {listAccounts.map((a) => (
                                <option key={a.id} value={a.id}>{maskOwnerText(a.name)}</option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div className="mt-1.5 text-xs text-muted-foreground">
                          당월 출금금액{" "}
                          <span className="tabular-nums text-foreground">
                            {i.currentPaid != null ? mask("expense_amount", won(i.currentPaid)) : i.currentAmount != null ? `${mask("expense_amount", won(i.currentAmount))} (예상)` : "-"}
                          </span>
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5 text-sm font-semibold">
                      <span>
                        익월({nextMonth}) 출금 합계
                        {nextCardChargeCount > 0 ? (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">카드결제 {nextCardChargeCount}건 제외</span>
                        ) : null}
                      </span>
                      <span className="tabular-nums font-semibold text-foreground">-{mask("expense_amount", won(nextOutTotal))}</span>
                    </div>
                  </div>
                  </>
                )}
                <p className="hidden text-xs text-muted-foreground md:block">※ 익월 예상금액은 <b>당월 출금금액</b>(없으면 당월 예상금액)을 기본값으로 가져옵니다. 카드값처럼 매달 바뀌는 값을 미리 입력해 두면 아래 ③ 여러 달 예측의 익월({nextMonth})에 그대로 반영됩니다. 입력·제외·날짜변경은 <b>익월({nextMonth})에만</b> 적용되며 당월 숫자는 바뀌지 않습니다. 금액을 비우면 당월 값 기준으로 되돌아갑니다.</p>
                {nextForecastOut !== nextOutTotal ? (
                  <p className="hidden text-xs text-muted-foreground md:block">※ ③ 예측의 익월 출금은 <b>{mask("expense_amount", won(nextForecastOut))}</b>으로 위 합계와 다릅니다 — <b>날짜 미정</b>이라 이 표에선 빠진 항목(주간 고정비 등)도 월 단위 예측에는 들어가기 때문입니다. 당월 탭과 ③ 예측 사이에도 같은 차이가 있습니다.</p>
                ) : null}
              </TabsContent>

              {/* 보류 — 당월보류/영구보류/확인필요 3그룹. 날짜 지정 또는 되살리기하면 다시 '출금 예정'으로. (설계 98) */}
              <TabsContent value="released" className="pt-3 space-y-5">
                {monthlyHeld.length === 0 && permanentlyHeld.length === 0 && needsCheck.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                    <p className="text-sm text-muted-foreground">보류 중인 항목이 없습니다.</p>
                  </div>
                ) : null}

                {/* 1. 당월 보류 — 이번 달만, 다음 달 자동 재개 */}
                {monthlyHeld.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">당월 보류 <span className="text-xs font-normal text-muted-foreground">· 이번 달만 · 다음 달 자동 재개 ({monthlyHeld.length})</span></h4>
                    <div className="overflow-x-auto rounded-2xl border border-dashed border-border/70 bg-background/40 shadow-sm">
                      {/* table-fixed 필수 — 없으면 colgroup 폭이 무시되고 내용 긴 열이 남는 폭을 먹는다. (설계 122) */}
                      <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(HOLD_COLS) }}>
                        {/* 열 폭 = 내용별(설계 122). 정의는 HOLD_COLS 한 곳에만 둔다. */}
                        <colgroup>
                          {colStyles(HOLD_COLS).map((st, i) => <col key={i} style={st} />)}
                        </colgroup>
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr className="border-b border-border/50">
                            <th className="px-4 py-2.5 font-medium">항목</th>
                            <th className="px-4 py-2.5 font-medium">카테고리</th>
                            <th className="px-4 py-2.5 text-right font-medium">예상금액</th>
                            <th className="px-4 py-2.5 text-center font-medium">되살리기</th>
                          </tr>
                        </thead>
                        <tbody>
                          {monthlyHeld.map((i) => (
                            <tr key={i.key} className="border-b border-border/40 last:border-0">
                              <td className="px-4 py-2.5">
                                <button type="button" onClick={() => openItemEdit(i)} title={maskOwnerText(i.label)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-primary hover:underline">
                                  <span aria-hidden className="shrink-0">{CALENDAR_KIND_META[i.kind].icon}</span><span className={`min-w-0 flex-1 ${HH_CELL.wrapText}`}>{maskOwnerText(i.label)}</span>
                                </button>
                              </td>
                              <td className="px-4 py-2.5">
                                {categoryName(i.categoryId) ? <Badge variant="secondary" className="font-normal">{categoryName(i.categoryId)}</Badge> : <span className="text-xs text-muted-foreground">{CALENDAR_KIND_META[i.kind].name}</span>}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">{mask("expense_amount", won(i.amount))}</td>
                              <td className="px-4 py-2.5 text-center">
                                <button type="button" title="되살리기" onClick={() => void saveOverride(i.sourceKind, i.sourceId, { released: false })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-50">
                                  <RotateCcw className="size-3.5" />되살리기
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {/* 2. 영구 보류 — 무기한, 수동 재개 (설계 98) */}
                {permanentlyHeld.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">영구 보류 <span className="text-xs font-normal text-muted-foreground">· 무기한 · 수동 재개 ({permanentlyHeld.length})</span></h4>
                    <div className="overflow-x-auto rounded-2xl border border-dashed border-border/70 bg-background/40 shadow-sm">
                      <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(HOLD_COLS) }}>
                        {/* 열 폭 = 내용별(설계 122). 정의는 HOLD_COLS 한 곳에만 둔다. */}
                        <colgroup>
                          {colStyles(HOLD_COLS).map((st, i) => <col key={i} style={st} />)}
                        </colgroup>
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr className="border-b border-border/50">
                            <th className="px-4 py-2.5 font-medium">항목</th>
                            <th className="px-4 py-2.5 font-medium">카테고리</th>
                            <th className="px-4 py-2.5 text-right font-medium">예상금액</th>
                            <th className="px-4 py-2.5 text-center font-medium">되살리기</th>
                          </tr>
                        </thead>
                        <tbody>
                          {permanentlyHeld.map((s) => (
                            <tr key={s.id} className="border-b border-border/40 last:border-0">
                              <td className="px-4 py-2.5">
                                <button type="button" onClick={() => setSpDialog({ open: true, target: s })} title={maskOwnerText(s.title)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-primary hover:underline">
                                  <span aria-hidden className="shrink-0">⏸️</span><span className={`min-w-0 flex-1 ${HH_CELL.wrapText}`}>{maskOwnerText(s.title)}</span>
                                </button>
                              </td>
                              <td className="px-4 py-2.5">
                                {categoryName(s.category_id) ? <Badge variant="secondary" className="font-normal">{categoryName(s.category_id)}</Badge> : <span className="text-xs text-muted-foreground">정기지출</span>}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">{mask("expense_amount", won(s.amount ?? 0))}</td>
                              <td className="px-4 py-2.5 text-center">
                                <button type="button" title="되살리기(다시 활성)" onClick={() => void reactivatePermanent(s.id)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-50">
                                  <RotateCcw className="size-3.5" />되살리기
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                {/* 3. 확인 필요 — 시스템 자동분류(날짜 미정 / 최근 실적 없음) */}
                {needsCheck.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-foreground">확인 필요 <span className="text-xs font-normal text-muted-foreground">· 자동 분류 ({needsCheck.length})</span></h4>
                    <p className="hidden text-xs text-muted-foreground md:block">이번 달 계산에서 제외된 항목입니다. 진짜 나가는 항목이면 <b>날짜를 지정</b>해 예정으로 되살리세요(카드로 내는 학원비 등은 실적 매칭이 안 돼 여기로 빠질 수 있습니다).</p>
                    <div className="overflow-x-auto rounded-2xl border border-dashed border-border/70 bg-background/40 shadow-sm">
                      <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(PERM_COLS) }}>
                        {/* 열 폭 = 내용별(설계 122). 정의는 PERM_COLS 한 곳에만 둔다. */}
                        <colgroup>
                          {colStyles(PERM_COLS).map((st, i) => <col key={i} style={st} />)}
                        </colgroup>
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr className="border-b border-border/50">
                            <th className="px-4 py-2.5 font-medium">사유</th>
                            <th className="px-4 py-2.5 font-medium">항목</th>
                            <th className="px-4 py-2.5 font-medium">카테고리</th>
                            <th className="px-4 py-2.5 text-right font-medium">예상금액</th>
                            <th className="px-4 py-2.5 font-medium">날짜 지정</th>
                            <th className="px-4 py-2.5 text-center font-medium">복원</th>
                          </tr>
                        </thead>
                        <tbody>
                          {needsCheck.map((i) => (
                            <tr key={i.key} className="border-b border-border/40 last:border-0">
                              <td className="whitespace-nowrap px-4 py-2.5">
                                <Badge variant={i.reason === "no-recent" ? "outline" : "secondary"}>{i.reason ? RELEASE_REASON_LABEL[i.reason] : ""}</Badge>
                              </td>
                              <td className="px-4 py-2.5">
                                <button type="button" onClick={() => openItemEdit(i)} title={`${maskOwnerText(i.label)} — 클릭해 세부 내용 수정`} className="flex w-full min-w-0 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-primary hover:underline">
                                  <span aria-hidden className="shrink-0">{CALENDAR_KIND_META[i.kind].icon}</span><span className={`min-w-0 flex-1 ${HH_CELL.wrapText}`}>{maskOwnerText(i.label)}</span>
                                </button>
                              </td>
                              <td className="px-4 py-2.5">
                                {categoryName(i.categoryId) ? <Badge variant="secondary" className="font-normal">{categoryName(i.categoryId)}</Badge> : <span className="text-xs text-muted-foreground">{CALENDAR_KIND_META[i.kind].name}</span>}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">{mask("expense_amount", won(i.amount))}</td>
                              <td className="px-4 py-2.5">
                                {dayEditor(i, "w-full rounded-md border border-border/60 bg-background hh-select pl-2 pr-6 py-1 text-base md:text-sm")}
                              </td>
                              <td className="px-4 py-2.5 text-center">
                                {i.reason === "no-recent" && i.day != null ? (
                                  <button type="button" title="복원(이 달 출금 예정으로)" onClick={() => void saveOverride(i.sourceKind, i.sourceId, { day_override: i.day })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-50">
                                    <RotateCcw className="size-3.5" />복원
                                  </button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">날짜 지정 시 복귀</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </TabsContent>
            </Tabs>

            {/* 카테고리별 출금 예정 그래프는 페이지 맨 아래로 내렸다 (팀장 지시 2026-08-26, 설계 189). */}
          </FoldSection>

          {/* ③ 여러 달 앞 예측 (설계 64) */}
          <FoldSection id="forecast" title="여러 달 앞 예측" description="정기수입·고정비·대출·할부를 미래로 굴려 월말 예상현금을 봅니다. 여유선 아래로 떨어지는 달을 경고합니다. (신용카드로 결제되는 고정비·할부는 카드대금 항목이 대표하므로 따로 세지 않습니다)">

            {/* 예측기간 토글 + 여유선 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
                {[3, 6, 12].map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => changeHorizon(h)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${horizon === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60"}`}
                  >
                    {h}개월
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-2 text-muted-foreground">
                여유선
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="여유선 금액"
                  value={bufferInputValue}
                  onFocus={() => setBufferDraft(String(bufferLine))}
                  onChange={(e) => setBufferDraft(e.target.value.replace(/[^\d]/g, ""))}
                  onBlur={commitBuffer}
                  className="w-28 rounded-md border border-border/60 bg-background px-2 py-1 text-right tabular-nums text-base md:text-sm"
                />
                <span>원 밑이면 경고</span>
              </label>
            </div>

            {!hasScheduledIncome ? (
              <div className="rounded-2xl border border-dashed border-amber-300/70 bg-amber-50/50 p-6 text-center dark:bg-amber-950/20">
                <p className="text-sm text-foreground">예상 수입이 없어 여러 달 예측이 무의미합니다.</p>
                <p className="mt-1 text-xs text-muted-foreground">급여 등 고정수입을 <b>정기지출/수입</b>에서 방향 &quot;예상 수입&quot;으로 등록하면 예측이 켜집니다.</p>
                <Button variant="outline" size="sm" className="mt-3" asChild>
                  <Link href="/dashboard/household/settings"><Settings className="h-4 w-4" />설정에서 정기수입 등록</Link>
                </Button>
              </div>
            ) : (
              <>
                {firstRisk ? (
                  <div className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${firstRisk.closingCash < 0 ? "border-rose-300/70 bg-rose-50/60 text-rose-700 dark:bg-rose-950/20 dark:text-rose-300" : "border-amber-300/70 bg-amber-50/60 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300"}`}>
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p>
                        <b>{firstRiskIdx === 0 ? "이번 달" : `${firstRiskIdx}개월 뒤`}({firstRisk.ym})</b> 월말 예상현금이 {mask("expense_amount", won(firstRisk.closingCash))}으로 여유선({mask("expense_amount", won(bufferLine))}) 밑으로 떨어질 전망입니다.
                      </p>
                      {/* 원인 안내(설계 70, 덱스 리뷰 3.5): 이번 달 출금 예정 상위 카테고리를 함께 보여준다. */}
                      {!maskEnabled && outflowByCategory.length > 0 ? (
                        <p className="mt-1 text-xs opacity-90">
                          주요 원인 — {outflowByCategory.slice(0, 3).map((c) => `${c.name} ${won(c.amount)}`).join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-emerald-600">향후 {horizon}개월간 여유선 아래로 떨어지는 달이 없습니다.</p>
                )}

                {/* 데스크톱 표 */}
                <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
                  <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(PROJ_COLS) }}>
                    {/* 열 폭 = 내용별(설계 122). 정의는 PROJ_COLS 한 곳에만 둔다. */}
                    <colgroup>
                      {colStyles(PROJ_COLS).map((st, i) => <col key={i} style={st} />)}
                    </colgroup>
                    {/* 헤더에서 '예상'을 뗀다 — 첫 줄이 전월 **실적**이라 행마다 성격이 다르다.
                        성격은 행 배지(실적/이번달)와 아래 ※ 문구가 말한다. (설계 174 ②) */}
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr className="border-b border-border/60">
                        <th className="px-4 py-3 font-medium">월</th>
                        <th className="px-4 py-3 text-right font-medium">수입</th>
                        <th className="px-4 py-3 text-right font-medium">출금</th>
                        <th className="px-4 py-3 text-right font-medium">순증감</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right font-medium">월말 현금</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* 전월 실적 — 비교 기준을 표 안에 둔다. (설계 174)
                          ★projection 배열에는 넣지 않는다: firstRiskIdx 가 배열 인덱스라 섞으면
                            '0개월 뒤 = 이번 달' 계산이 통째로 밀린다. 표시 전용으로만 앞에 그린다. */}
                      {prevActual ? (
                        <tr className="border-b border-border/40 bg-muted/30">
                          <td className="whitespace-nowrap px-4 py-2.5 font-medium text-muted-foreground">
                            {prevActual.ym}
                            <Badge variant="outline" className="ml-2">실적</Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-blue-600 dark:text-blue-400" title="그 달 실제 입금 전액. 대출 실행금 같은 일회성 입금도 포함됩니다.">{mask("amount", won(prevActual.income))}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground" title="그 달 실제 통장유출(내부 이체·신용/할부 카드 지출 제외). 이번 달과 견줄 때는 이번 달 줄의 '월 전체' 값과 보세요.">{mask("expense_amount", won(prevActual.outflow))}</td>
                          <td className={`px-4 py-2.5 text-right tabular-nums ${!maskEnabled && prevActual.income - prevActual.outflow < 0 ? "text-amber-600" : "text-foreground"}`}>{mask("expense_amount", `${!maskEnabled && prevActual.income - prevActual.outflow > 0 ? "+" : ""}${won(maskEnabled ? Math.abs(prevActual.income - prevActual.outflow) : prevActual.income - prevActual.outflow)}`)}</td>
                          {/* 과거 시점 잔액은 저장하지 않는다 — 현재잔액에서 역산하면 드리프트가 실적처럼 보인다. (설계 174 ①) */}
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground" title="과거 시점의 잔액은 저장하지 않아 표시하지 않습니다.">–</td>
                        </tr>
                      ) : null}
                      {projection.map((p, idx) => (
                        <tr key={p.ym} className={`border-b border-border/40 last:border-0 ${idx === firstRiskIdx ? "bg-rose-50/40 dark:bg-rose-950/10" : ""}`}>
                          <td className="whitespace-nowrap px-4 py-2.5 font-medium text-foreground">
                            {p.ym}
                            {p.ym === nowYm ? <Badge variant="secondary" className="ml-2">이번달</Badge> : null}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-blue-600 dark:text-blue-400">
                            {p.inflow ? mask("amount", won(p.inflow)) : "-"}
                            {/* 당월은 '아직 안 들어온 정기수입'만 센다 — 전월 실적(월 전체)과 견주려면
                                월 전체 값을 함께 보여야 한다. (설계 174) */}
                            {p.ym === nowYm ? <span className="block whitespace-nowrap text-[0.7rem] font-normal text-muted-foreground" title="이미 받은 수입까지 더한 이번 달 전체 — 윗줄 전월 실적과 견주라고 놓은 값입니다.">월 전체 {mask("amount", won(curMonthIn))}</span> : null}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                            {p.outflow ? mask("expense_amount", won(p.outflow)) : "-"}
                            {/* ★당월 예측 출금은 '아직 안 나간 몫'뿐이다(설계 110) — 이미 나간 돈은 현재
                                잔액에 반영돼 있어 또 빼면 이중차감이기 때문. 그래서 전월 실적과 그대로
                                비교하면 "이번 달은 확 줄었다"는 오독이 생긴다. 월 전체를 함께 적는다. */}
                            {p.ym === nowYm ? <span className="block whitespace-nowrap text-[0.7rem] font-normal text-muted-foreground" title="이미 나간 출금까지 더한 이번 달 전체. 예측은 이 중 아직 안 나간 몫만 씁니다(이미 나간 돈은 현재 잔액에 반영돼 있어 또 빼면 이중차감). ※전월 실적과 완전히 같은 잣대는 아닙니다 — 이 값의 변동 지출 몫은 '정기지출이 쓰지 않는 카테고리'만 세므로, 정기지출과 같은 카테고리에서 난 비정기 지출은 빠집니다(그만큼 작게 잡힙니다).">월 전체 {mask("expense_amount", won(curMonthOut))}</span> : null}
                          </td>
                          <td className={`px-4 py-2.5 text-right tabular-nums ${!maskEnabled && p.net < 0 ? "text-amber-600" : "text-foreground"}`}>{mask("expense_amount", `${!maskEnabled && p.net > 0 ? "+" : ""}${won(maskEnabled ? Math.abs(p.net) : p.net)}`)}</td>
                          <td className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums font-semibold ${!maskEnabled ? (p.closingCash < 0 ? "text-rose-600" : p.closingCash < bufferLine ? "text-amber-600" : "text-foreground") : "text-foreground"}`}>{mask("amount", won(maskEnabled ? Math.abs(p.closingCash) : p.closingCash))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* 모바일 카드 */}
                <div className="space-y-2 md:hidden">
                  {/* 전월 실적 — 데스크톱 표와 같은 값·같은 순서. (설계 174) */}
                  {prevActual ? (
                    <div className="rounded-xl border border-border/70 bg-muted/30 p-3 shadow-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-muted-foreground">{prevActual.ym}<Badge variant="outline" className="ml-2">실적</Badge></span>
                        <span className="tabular-nums text-muted-foreground">–</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                        <span>수입 <span className="tabular-nums text-blue-600 dark:text-blue-400">{mask("amount", won(prevActual.income))}</span></span>
                        <span>출금 <span className="tabular-nums">{mask("expense_amount", won(prevActual.outflow))}</span></span>
                        <span>순증감 <span className={`tabular-nums ${!maskEnabled && prevActual.income - prevActual.outflow < 0 ? "text-amber-600" : ""}`}>{mask("expense_amount", won(maskEnabled ? Math.abs(prevActual.income - prevActual.outflow) : prevActual.income - prevActual.outflow))}</span></span>
                      </div>
                    </div>
                  ) : null}
                  {projection.map((p, idx) => (
                    <div key={p.ym} className={`rounded-xl border bg-card/85 p-3 shadow-sm ${idx === firstRiskIdx ? "border-rose-300/70" : "border-border/70"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{p.ym}{p.ym === nowYm ? <Badge variant="secondary" className="ml-2">이번달</Badge> : null}</span>
                        <span className={`tabular-nums font-semibold ${!maskEnabled ? (p.closingCash < 0 ? "text-rose-600" : p.closingCash < bufferLine ? "text-amber-600" : "text-foreground") : "text-foreground"}`}>{mask("amount", won(maskEnabled ? Math.abs(p.closingCash) : p.closingCash))}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                        <span>수입 <span className="tabular-nums text-blue-600 dark:text-blue-400">{p.inflow ? mask("amount", won(p.inflow)) : "-"}</span></span>
                        <span>출금 <span className="tabular-nums">{p.outflow ? mask("expense_amount", won(p.outflow)) : "-"}</span></span>
                        <span>순증감 <span className={`tabular-nums ${!maskEnabled && p.net < 0 ? "text-amber-600" : ""}`}>{mask("expense_amount", won(maskEnabled ? Math.abs(p.net) : p.net))}</span></span>
                      </div>
                      {/* 당월은 '아직 안 나간 몫'뿐이라 전월 실적과 기준이 다르다 — 월 전체를 함께. (설계 174) */}
                      {p.ym === nowYm ? (
                        <div className="mt-1 text-[0.7rem] text-muted-foreground">월 전체 — 수입 {mask("amount", won(curMonthIn))} · 출금 {mask("expense_amount", won(curMonthOut))}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {/* ★전월 행이 없으면(조회 실패·표본 없는 계정) 이 문구도 내린다 — 없는 줄을 있다고 설명하면 안 된다. */}
                {prevActual ? (
                  <p className="hidden text-xs text-muted-foreground md:block">※ 맨 윗줄 <b>{prevActual.ym} 실적</b>은 예상이 아니라 <b>그 달에 실제로 오간 돈</b>입니다(출금은 내부 이체·신용카드 지출을 뺀 통장유출). 과거 시점 잔액은 저장하지 않아 월말 현금은 비워 둡니다. 변동 지출을 꺼도 이 줄은 바뀌지 않습니다. <b>이번 달 줄의 수입·출금은 아직 안 들어온/안 나간 몫만</b>이라(이미 오간 돈은 현재 잔액에 이미 반영) 전월과 견주려면 그 아래 <b>월 전체</b> 값을 보세요 — 다만 월 전체의 변동 지출 몫은 <b>정기지출이 쓰지 않는 카테고리만</b> 세므로 전월 실적보다 <b>조금 작게</b> 잡힙니다(잣대가 완전히 같지는 않습니다).</p>
                ) : null}
                <p className="hidden text-xs text-muted-foreground md:block">※ 정기수입 + 당월 출금예정과 같은 기준(최근 3개월 실적 있거나 날짜 확정된 고정비)으로 계산합니다. ‘이번 달 쉼’ 탭에서 항목을 되살리면 예측에도 반영됩니다. 첫 달은 <b>이미 입금된 급여·이미 나간 출금을 뺀 남은 예정</b>으로 계산합니다(현재 잔액에 이미 반영돼 있어 또 세면 이중계상). 일회성 큰 지출·통장이동은 반영되지 않습니다.</p>
                <p className="hidden text-xs text-muted-foreground md:block">※ <b>이번 달과 익월({nextMonth})</b>은 각 탭에서 <b>확정한 금액</b>(카드 실청구액 등)을 씁니다. 익익월 이후는 등록된 기준 금액이고 카드대금이 빠져 있어 앞의 두 달과 단순 비교하면 안 됩니다.</p>
              </>
            )}
          </FoldSection>

          {/* 문자 잔액 대조(설계 71) — 계좌별 최신 문자 잔액 vs 장부 잔액 */}
          {balanceChecks.length > 0 ? (
            <FoldSection id="balance-check" title="문자 잔액 대조" description="수집 문자·알림이 알려준 계좌 잔액과 장부(거래 누적) 잔액을 비교합니다. 차이가 나면 수집 안 된 거래가 있거나, 검토대기 항목이 아직 확정되지 않은 것일 수 있습니다.">
              <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm">
                <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(SMS_BAL_COLS) }}>
                  {/* 열 폭 = 내용별(설계 122). 정의는 SMS_BAL_COLS 한 곳에만 둔다. */}
                  <colgroup>
                    {colStyles(SMS_BAL_COLS).map((st, i) => <col key={i} style={st} />)}
                  </colgroup>
                  <thead className="border-b border-border/70 text-left text-muted-foreground">
                    <tr>
                      {/* ⚠️옛 주석("전 컬럼 균등 16.67% + 잘리면 truncate", 설계 120)은 두 번 다 폐기됐다 —
                          균등 분할은 설계 122 에서, "잘림은 truncate 로 푼다"는 설계 123 에서.
                          지금은 폭을 내용별로(SMS_BAL_COLS) 주고, 계좌명은 자르지 않고 줄바꿈한다.
                          '확인 시각'은 `2026-08-02 10:58` 고정 서식이라 길이가 늘지 않아 그대로 둔다.
                          table-fixed 가 있어야 <colgroup> 폭이 실제로 지켜진다. */}
                      <th className="px-4 py-2.5 font-medium">계좌</th>
                      <th className="px-4 py-2.5 font-medium text-right">문자 잔액</th>
                      <th className="px-4 py-2.5 font-medium">확인 시각</th>
                      <th className="px-4 py-2.5 font-medium text-right">장부 잔액</th>
                      <th className="px-4 py-2.5 font-medium text-right">차이</th>
                      <th className="px-4 py-2.5 font-medium">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balanceChecks.map((c) => (
                      <tr key={c.accountId} className="border-b border-border/50 last:border-0">
                        <td className={`${HH_CELL.wrapText} px-4 py-2.5`}>{mask("owner_name", c.name)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{mask("amount", won(c.reported))}</td>
                        {/* 주석대로 truncate 로 푼다 — 이게 없어 좁은 화면에서 '장부 잔액' 칸을 침범했다(교차리뷰 지적). */}
                        <td className="truncate px-4 py-2.5 text-xs tabular-nums text-muted-foreground" title={`${c.date ?? "-"}${c.time ? ` ${c.time}` : ""}`}>{c.date ?? "-"}{c.time ? ` ${c.time}` : ""}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{mask("amount", won(c.ledger))}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${c.diff !== 0 && !maskEnabled ? "text-amber-600" : ""}`}>{maskEnabled ? mask("amount", won(Math.abs(c.diff))) : `${c.diff > 0 ? "+" : ""}${won(c.diff)}`}</td>
                        <td className="px-4 py-2.5">
                          {c.diff === 0 ? (
                            <Badge variant="outline" className="border-emerald-300/70 text-emerald-600">일치</Badge>
                          ) : isStale(c.date) ? (
                            // 문자 잔액이 7일 넘게 오래됨 — '장부가 틀림'이 아니라 '최신 정보 없음' 신호.
                            <Badge variant="outline" className="text-muted-foreground">오래됨</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-amber-700">확인 필요</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </FoldSection>
          ) : null}

          {/* 카테고리별 출금 예정 — 가로 막대(단일 색). 표와 같은 기간·계좌 필터·예상금액 기준.
              ★페이지 맨 아래에 둔다(팀장 지시 2026-08-26, 설계 189). 원래는 ② 출금 예정 섹션 안 표 밑에
              있었는데, 표를 읽는 흐름을 그래프가 끊었다. 값은 여전히 ② 표의 기간·계좌 필터를 따른다. */}
          {outflowByCategory.length > 0 ? (
            <FoldSection
              id="outflow-by-category"
              title="카테고리별 출금 예정"
              description="위 ② 출금 예정 표와 같은 기간·계좌 필터·예상금액 기준입니다. 대출상환·카드대금은 카테고리가 없어 종류(대출상환/카드결제)로 묶입니다."
            >
              <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
                <div className="mb-2 flex items-baseline justify-end gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isFullMonth ? "이번 달" : `${effStart}~${effEnd}일`} · 합계 {mask("expense_amount", won(outflowByCategoryTotal))}
                  </span>
                </div>
                <div style={{ width: "100%", height: Math.max(150, outflowByCategory.length * 40 + 24) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={outflowByCategory} layout="vertical" margin={{ top: 4, right: maskEnabled ? 12 : 72, bottom: 4, left: 8 }}>
                      <XAxis type="number" hide domain={[0, "dataMax"]} />
                      <YAxis type="category" dataKey="name" width={96} tickLine={false} axisLine={false} fontSize={12} tickMargin={10} />
                      {!maskEnabled ? <Tooltip cursor={{ fill: "rgba(148,163,184,0.12)" }} formatter={(value) => [won(Number(value)), "출금 예정"]} /> : null}
                      <Bar dataKey="amount" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={16}>
                        {!maskEnabled ? (
                          <LabelList dataKey="amount" position="right" fontSize={11} formatter={(v) => formatAmountInMan(Number(v))} />
                        ) : null}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-1 hidden text-xs text-muted-foreground md:block">※ 대출상환·카드대금은 카테고리가 없어 종류(대출상환/카드결제)로 묶입니다. 금액은 예상금액 기준입니다.</p>
              </div>
            </FoldSection>
          ) : null}

        </>
      )}

      {/* 이 달의 결제수단 — 학원비처럼 달마다 카드↔지갑이 바뀌는 항목용. (설계 203) */}
      <MonthMethodDialog
        open={methodTarget != null}
        onOpenChange={(open) => { if (!open) setMethodTarget(null); }}
        yearMonth={methodTarget?.ym ?? month}
        itemLabel={methodTarget ? maskOwnerText(methodTarget.label) : ""}
        value={methodTarget?.value ?? null}
        baseMethodId={methodTarget?.baseMethodId ?? null}
        methods={methods}
        maskName={maskOwnerText}
        onSave={async (methodId) => {
          if (!methodTarget) return false;
          return await saveOverride(
            methodTarget.sourceKind,
            methodTarget.sourceId,
            { payment_method_id: methodId },
            methodTarget.ym
          );
        }}
      />

      {/* 정기지출(고정비) 추가·수정 — 추가는 이번 달 출금 예정에 바로 반영, 수정은 원본 항목 세부 내용 변경 */}
      <ScheduledPaymentDialog
        open={spDialog.open}
        onOpenChange={(open) => setSpDialog((s) => ({ ...s, open }))}
        target={spDialog.target}
        accounts={accounts}
        methods={methods}
        categories={categories}
        persons={persons}
        onSave={saveScheduled}
      />
      {/* 대출·할부 팝업 — 목록→팝업 규칙(설계 82). 저장하면 현금흐름을 다시 읽어 표에 바로 반영한다. */}
      <LoanDialog
        open={loanDialog.open}
        onOpenChange={(open) => setLoanDialog((s) => ({ ...s, open }))}
        target={loanDialog.target}
        accounts={accounts}
        onSaved={() => void fetchData()}
      />
      <InstallmentEditDialog
        open={instDialog.open}
        onOpenChange={(open) => setInstDialog((s) => ({ ...s, open }))}
        target={instDialog.target}
        categories={categories}
        methods={methods}
        onSaved={() => void fetchData()}
      />
    </PageShell>
  );
}

// buildOutItem은 cashflow-snapshot.ts로 이동(설계 79).

// 접을 수 있는 섹션 — 제목줄 클릭으로 접기/펼치기, 상태는 localStorage에 기억.
// 현금흐름은 5개 섹션이 한 페이지(모바일 세로 1만px+)라 안 보는 섹션을 접어 과밀을 줄인다.
function FoldSection({ id, title, description, headerAction, children }: {
  id: string;
  title: string;
  description: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  // 로딩 후 클라이언트에서만 마운트되는 위치라 lazy 초기화로 저장값 복원(SSR 불일치 없음).
  const [folded, setFolded] = useState(() => typeof window !== "undefined" && localStorage.getItem(`hh_cash_fold:${id}`) === "1");
  const toggle = () => setFolded((v) => {
    localStorage.setItem(`hh_cash_fold:${id}`, v ? "0" : "1");
    return !v;
  });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* 클릭 영역은 제목+화살표까지만 둔다 — 예전엔 버튼이 헤더 전폭이라 오른쪽 빈 공간을
            지나가다 눌러 섹션이 제멋대로 접혔다(팀장 지적 2026-08-01). */}
        <div className="min-w-0 flex-1">
          <SectionIntro
            title={
              <button
                type="button"
                onClick={toggle}
                aria-expanded={!folded}
                className="inline-flex items-center gap-1.5 rounded text-left transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {title}
                <ChevronDown className={`size-4 text-muted-foreground transition-transform ${folded ? "-rotate-90" : ""}`} />
              </button>
            }
            description={folded ? undefined : <span className="hidden md:inline">{description}</span>}
          />
        </div>
        {headerAction}
      </div>
      {folded ? null : children}
    </section>
  );
}
