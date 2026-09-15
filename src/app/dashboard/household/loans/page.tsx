"use client";

import { Banknote, CalendarClock, ChevronLeft, ChevronRight, Plus, RotateCcw, Search, Settings, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageShell, StatCard, StatsGrid } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HhBoard, HH_COL, HH_CELL, type HhBoardColumn, type HhBoardSort } from "@/components/household/hh-board";
import { LoanDialog } from "@/components/household/loan-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SOLID } from "@/components/ui/tabs";
import { useMasking } from "@/components/masking-provider";
import { accountTintMap, ACCOUNT_TINT_NONE } from "@/lib/household/account-color";
import { createClient } from "@/lib/supabase/client";
import { formatAmountInMan } from "@/lib/utils";
import { buildCardLoanEstimate, estimateMonthlyPayment, firstRepaymentMonth, isCardLoan } from "@/lib/household/loan-estimate";
import { matchLoanPayments } from "@/lib/household/loan-match";
import { rangeOfMonth, shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhAccount, HhLoan, HhTransaction } from "@/lib/household/types";

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

// 대출 표 열 폭 — 순서는 loanColumns 와 1:1. 내용별 척도(설계 122).
// 실측(measure_table_content.mts, 패딩 px-4 환산)으로 필요폭을 재서 배정했다.
// 예전 9열 11.11% 균등은 폐기 — 상환일 44px·이자율 52px 옆에만 80~89px 공백이 남았다.
//
// ★합계 1,192px — 페이지 콘텐츠 한도 1,200px(max-w-7xl 1280 − 좌우 패딩) 안이다.
//   설계 167 에서 '전월 출금'(112) 을 더하며 만기일을 100.2 → 연-월 표기로 줄여 88 에 넣었다.
//   1,216px 이면 껍데기를 넘겨 오른쪽 '잔액'이 잘린다(검사 I). 열을 더 넣으려면 다시 재라.
const LOAN_COL_WIDTHS: (number | undefined)[] = [
  HH_COL.xxwide,    // 대출명 — '현대카드-이바다-카드론(26.05)' 이 160 에서 두 줄로 꺾였다(필요 185, 설계 125)
  HH_COL.wide,      // 출금계좌 (112.8) — 계좌명 ink 80.8
  HH_COL.short,     // 만기일 — '2027-08'(연-월). 일자는 옆 '상환일' 열이 이미 보여준다(설계 167)
  HH_COL.icon,      // 상환일 — 내용 '25일'(56.8)보다 헤더 '상환일'(61.2)이 하한
  HH_COL.wide,      // 대출금액 (114.8)
  HH_COL.short,     // 이자율 (69.5)
  HH_COL.standard,  // 전월 출금 (93.2) — '추정' 배지가 붙는다
  HH_COL.standard,  // 당월 계획 (93.2)
  HH_COL.standard,  // 당월 출금 (93.2) — '추정' 배지가 붙는다
  HH_COL.wide,      // 잔액 (118.2)
];

export default function HouseholdLoansPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [loans, setLoans] = useState<HhLoan[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  const [payments, setPayments] = useState<HhTransaction[]>([]);
  const [month, setMonth] = useState(thisMonthKey);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [dialogLoan, setDialogLoan] = useState<HhLoan | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();
    // 전월·당월을 한 번에 가져온다(설계 167 — '전월 출금' 열). 납부거래는 월 16건 규모라
    // 두 달을 합쳐도 페이징 상한과 거리가 멀다(설계 162 ⑦의 1,000행 잘림과는 규모가 다르다).
    const { end } = rangeOfMonth(month);
    const { start: prevStart } = rangeOfMonth(shiftMonth(month, -1));
    const [loanRes, payRes, acctRes] = await Promise.all([
      supabase.from("hh_loan").select("*").order("current_balance", { ascending: false }),
      // ★정렬을 명시한다 — 잘릴 때 어느 행이 빠질지 정해져야 한다(교차리뷰 Minor).
      supabase.from("hh_transaction").select("*").eq("type", "payment")
        .gte("txn_date", prevStart).lte("txn_date", end).order("txn_date", { ascending: true }),
      supabase.from("hh_account").select("*").order("sort_order", { ascending: true }),
    ]);
    // payRes 가 실패하면 상환 거래가 빈 배열이 되어 '당월 실제 상환'이 0원으로 보인다.
    // acctRes 실패는 출금계좌가 전부 '-'. 셋 다 가드에 넣는다.
    const failed = [loanRes, payRes, acctRes].find((r) => r.error);
    if (failed) {
      console.error("대출 조회 실패:", failed.error);
      toast.error("대출 목록을 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }
    setLoans((loanRes.data ?? []) as HhLoan[]);
    // ★상한에 닿으면 조용히 잘린다 — 이 저장소가 실제로 겪은 사고다(설계 162 ⑦: 1,000행을 넘어
    //   최근 거래가 통째로 날아갔는데 아무도 몰랐다). 두 달 32건이라 여유가 크지만, 침묵보다 낫다.
    const payRows = (payRes.data ?? []) as HhTransaction[];
    if (payRows.length >= 1000) {
      console.error("납부 거래가 조회 상한에 닿았습니다 — 출금 합계가 과소일 수 있습니다:", payRows.length);
      toast.warning("납부 거래가 너무 많아 일부만 불러왔습니다. 출금 합계가 실제보다 작을 수 있습니다.");
    }
    setPayments(payRows);
    setAccounts((acctRes.data ?? []) as HhAccount[]);
    setLoading(false);
  }, [supabase, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 상환중 대출만 — 상단 StatCard 합계와 '상환중' 탭 표 합계의 기준을 맞춘다.
  // 예전엔 plannedMap/actualMap 이 closed 까지 포함해, 조기 완납했지만 만기·월납입금이
  // 남아 있는 대출이 StatCard 에만 더해져 표 합계와 어긋났다.
  const activeLoans = useMemo(() => loans.filter((l) => l.status === "active"), [loans]);
  const activeLoanIds = useMemo(() => new Set(activeLoans.map((l) => l.id)), [activeLoans]);

  // 당월 계획 상환 = 그 달에 상환중(대출일≤말일 && 만기≥1일)인 대출의 월납입금.
  const plannedMap = useMemo(() => {
    const { start, end } = rangeOfMonth(month);
    const m = new Map<string, number>();
    for (const l of activeLoans) {
      if (!l.monthly_payment) continue;
      const originOk = !l.origin_date || l.origin_date <= end;
      const maturityOk = !l.maturity_date || l.maturity_date >= start;
      if (originOk && maturityOk) m.set(l.id, l.monthly_payment);
    }
    return m;
  }, [activeLoans, month]);

  // 조회한 두 달치 납부거래를 달별로 가른다. 매칭은 달마다 독립으로 돌려야 한다 —
  // 한 풀에 넣고 돌리면 전월 거래가 당월 대출에 붙는 오매칭이 생긴다.
  const prevMonth = useMemo(() => shiftMonth(month, -1), [month]);
  const { curPayments, prevPayments } = useMemo(() => {
    const { start } = rangeOfMonth(month);
    const cur: HhTransaction[] = [];
    const prev: HhTransaction[] = [];
    for (const p of payments) (p.txn_date >= start ? cur : prev).push(p);
    return { curPayments: cur, prevPayments: prev };
  }, [payments, month]);

  // 실제 납입액 — ①loan_id 로 연결된 확정분이 먼저, ②남은 것만 추정 매칭한다. (설계 92)
  // 술어 본체는 lib/household/loan-match.ts 에 있다 — 전월·당월이 **같은 술어**를 써야 하고,
  // 화면에 복붙하면 그 순간 둘이 갈린다(설계 167).
  const { actualMap, estimatedIds } = useMemo(
    () => matchLoanPayments(activeLoans, activeLoanIds, curPayments),
    [activeLoans, activeLoanIds, curPayments],
  );
  const { actualMap: prevActualMap, estimatedIds: prevEstimatedIds } = useMemo(
    () => matchLoanPayments(activeLoans, activeLoanIds, prevPayments),
    [activeLoans, activeLoanIds, prevPayments],
  );

  // 카드론 역산 — monthly_payment 가 null 이라 ①~④ 매칭으로는 영원히 안 잡힌다(설계 162 ⑤).
  // 원금·금리·실행일·만기로 원리금균등 월납을 역산해 '계획'에 넣고,
  // '출금'에는 **그 카드의 카드대금이 실제 나갔을 때만** 넣는다(설계 131 — 증거가 있을 때만 '출금됨').
  const curCard = useMemo(() => buildCardLoanEstimate(activeLoans, month, curPayments), [activeLoans, month, curPayments]);
  const prevCard = useMemo(() => buildCardLoanEstimate(activeLoans, prevMonth, prevPayments), [activeLoans, prevMonth, prevPayments]);

  // 당월 상환액 중 확정(loan_id 연결) / 추정이 각각 얼마인지. 설계 92 §4 — 불완전함을 숨기지 않는다.
  const linkQuality = useMemo(() => {
    let confirmed = 0;
    let estimated = 0;
    let confirmedCount = 0;
    let estimatedCount = 0;
    for (const [loanId, amount] of actualMap) {
      if (estimatedIds.has(loanId)) {
        estimated += amount;
        estimatedCount += 1;
      } else {
        confirmed += amount;
        confirmedCount += 1;
      }
    }
    return { confirmed, estimated, confirmedCount, estimatedCount };
  }, [actualMap, estimatedIds]);

  // 출금계좌 표시명 — 계좌명(name)이 이미 은행+소유자를 담고 있어(예: "국민은행(김하늘)") 그대로 쓴다.
  const accountMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);
  // 출금계좌 칸 색 — 현금흐름과 같은 소유자 색(김하늘=연파랑·이바다=연주황, 설계 127).
  // 이 화면은 인물(hh_person)을 안 불러오므로 accountTintMap 이 계좌명으로 소유자를 판별한다.
  const accountTint = useMemo(() => accountTintMap(accounts), [accounts]);

  const active = activeLoans; // 위에서 이미 걸렀다 — 같은 기준을 StatCard·표가 공유한다.
  const closed = loans.filter((l) => l.status === "closed");
  const totalBalance = active.reduce((s, l) => s + l.current_balance, 0);
  const totalPrincipal = active.reduce((s, l) => s + l.principal, 0);
  // 월 상환 부담을 두 갈래로 가른다(설계 167).
  //   ⓐ 통장분 = monthly_payment 가 등록된 대출 — 결제일에 계좌에서 직접 빠진다.
  //   ⓑ 카드분 = 카드론 역산액 — 카드대금에 합산되어 나가므로 계좌에서 따로 빠지지 않는다.
  // ★ⓑ를 현금흐름 출금예정과 더하면 이중계상이다(설계 70·108·162 ⑦ — 카드대금 등록금액에
  //   이미 카드론 월납이 녹아 있다). 이 화면에서 '총 부담'을 보여주는 용도로만 쓴다.
  const bankPlanned = [...plannedMap.values()].reduce((s, v) => s + v, 0);
  const bankActual = [...actualMap.values()].reduce((s, v) => s + v, 0);
  const cardPlanned = [...curCard.estMap.values()].reduce((s, v) => s + v, 0);
  // 실적 쪽 카드분은 **카드대금이 실제 나간 것만** — 계획과 달리 여기는 증거가 있어야 한다(설계 131).
  const cardActual = [...curCard.estMap].reduce((s, [id, v]) => s + (curCard.paidIds.has(id) ? v : 0), 0);

  // ★StatCard 합계 = 표 합계행. 이 화면이 원래부터 지켜 온 규칙이라 어느 한쪽만 카드분을 넣으면
  //   두 숫자가 어긋난다(설계 167 구현 중 실제로 어긋났다: StatCard 2,019,981 vs 표 3,248,350).
  //   내역이 궁금하면 표 아래 '월 상환 부담' 블록이 통장분·카드분을 갈라 준다.
  const totalPlanned = bankPlanned + cardPlanned;
  const totalActual = bankActual + cardActual;

  const kw = search.trim().toLowerCase();
  const filterBySearch = (list: HhLoan[]) => (kw ? list.filter((l) => l.name.toLowerCase().includes(kw)) : list);

  // 요약 블록은 **표 바로 아래**에 있으므로 표와 같은 행(검색 필터 적용)을 센다.
  // StatCard 는 예전부터 전체 기준이라 검색 중에는 요약과 다를 수 있다 — 그래서 제목에 기준을 밝힌다.
  // (교차리뷰 Major: 검색 시 footer 만 필터되고 StatCard·요약은 전체라 세 숫자가 갈렸다.)
  const shownActive = filterBySearch(active);
  const shownBankPlanned = shownActive.reduce((s, l) => s + (plannedMap.get(l.id) ?? 0), 0);
  const shownCardPlanned = shownActive.reduce((s, l) => s + (curCard.estMap.get(l.id) ?? 0), 0);

  const openLoan = (l: HhLoan) => {
    setDialogLoan(l);
    setDialogOpen(true);
  };

  // 등록도 같은 팝업이다 — target=null 이면 등록 모드(설계 82·96).
  const openNewLoan = () => {
    setDialogLoan(null);
    setDialogOpen(true);
  };

  // 카드론은 카드대금 청구서에 얹혀 한 번에 결제된다(개별 출금거래 없음). 월납입금을 비워 예측·출금예정에서 뺀다.
  // (설계 112 addendum — 옛 85, 번호충돌로 이동. 팀장 결정 2026-07-18)
  //
  // ★설계 167 에서 표기가 바뀌었다: 옛 '카드대금 포함' 글자만 있던 칸에 **역산 금액**을 넣는다.
  //   팀장이 대환 판단에 쓰는 '실제 월 상환 부담'이 62%(3,136,337/5,082,359)만 보이고 있었다.
  //   역산이 불가능한 카드론(원금·금리·실행일·만기 중 결손)은 예전대로 글자만 남는다.
  const cardCell = (l: HhLoan, ym: string, est: number | undefined, shown: boolean) => {
    if (!est) {
      // ★'역산 불가'와 '아직 상환기간 밖'을 같은 글자로 말하면 안 된다 — 팀장이 원인을 알 수 없다.
      //   (실측 2026-08-13: 삼성 26.08 은 8/11 실행이라 첫 상환이 9월인데 '카드대금 포함'으로 보였다.)
      const raw = estimateMonthlyPayment(l);
      if (raw) {
        const first = firstRepaymentMonth(l);
        return (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {first && ym < first ? `${first} 시작` : "상환완료"}
          </span>
        );
      }
      return <span className="whitespace-nowrap text-xs text-muted-foreground">카드대금 포함</span>;
    }
    if (!shown) return <span className="whitespace-nowrap tabular-nums text-muted-foreground">-</span>;
    // 배지는 **2글자**여야 한다 — 열 폭 예산(standard 112)이 '금액 + 2글자'로 잡혀 있다(설계 122·125).
    // 매칭으로 맞춘 '추정'과 구별해 '역산'을 쓴다: 추정=실제 거래를 맞춘 것, 역산=거래 없이 계산한 값.
    return (
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {mask("expense_amount", won(est))}
        <span className="ml-1 text-xs font-normal" title="카드대금에 합산되어 나가는 카드론입니다. 원금·금리·기간으로 역산한 값이며, 현금흐름 출금예정과 더하면 이중계상입니다.">역산</span>
      </span>
    );
  };

  // 기본 정렬: 대출금액(원금) 큰 순 → 같은 금액은 잔액 큰 순. (팀장 지시 2026-08-03, 설계 127.
  //  HhBoard 는 sorts[0]을 기본값으로 쓴다 — 예전 기본이던 상환일순은 두 번째로 내려 선택지로 남긴다.)
  // ★네 규칙 모두 **열 key 와 같은 key** 를 쓴다 — 그래야 그 헤더를 눌러 정렬할 수 있다(설계 134).
  //   키를 바꾸면 그 열은 조용히 못 누르게 되니, 열 key 와 짝을 유지할 것.
  const loanSorts: HhBoardSort<HhLoan>[] = [
    { key: "principal", label: "대출금액순", cmp: (a, b) => b.principal - a.principal || b.current_balance - a.current_balance },
    { key: "payment_day", label: "상환일순", cmp: (a, b) => (a.payment_day ?? 99) - (b.payment_day ?? 99) || b.principal - a.principal },
    { key: "balance", label: "잔액순", cmp: (a, b) => b.current_balance - a.current_balance },
    { key: "rate", label: "이자율순", cmp: (a, b) => (b.interest_rate ?? 0) - (a.interest_rate ?? 0) },
  ];

  // 순서: 대출명 · 출금계좌 · 만기일 · 상환일 · 대출금액 · 이자율 · 당월계획 · 당월출금 · 잔액.
  // 컬럼이 9개라 공용 px-4 로는 잔액이 화면 밖으로 밀린다 → 아래에서 px-2 로 일괄 좁혀 한 화면에 맞춘다.
  //
  // 컬럼 비율 폭(합 100%) — CLAUDE.md 표 컬럼 간격 규칙(팀장 요청 2026-07-18).
  // 균등은 11.11%. 대출명만 계좌명+카드론 표기가 들어가 길어서 15%(균등 대비 1.35배, 한도 1.5배 이내),
  // 상환일·이자율은 '5일'·'14.8%' 처럼 짧아 8%. 남는 폭을 한 컬럼에 몰아주지 않는다.
  // ★컬럼을 추가·삭제하면 이 배열의 합이 100인지 다시 맞출 것.
  const loanColumns: HhBoardColumn<HhLoan>[] = ([
    // 긴 이름은 자르지 않고 줄바꿈한다(전역 규칙, 설계 123). 옛 규칙 "truncate + title" 은 폐기 —
    // title 은 마우스를 올려야 보여서 표를 훑을 땐 글자가 그냥 사라진 것과 같다(팀장 지적 2026-08-02).
    { key: "name", header: "대출명", align: "left", cell: (l) => (
      <span className="flex min-w-0 items-center gap-2" title={mask("owner_name", l.name)}>
        <span className={`${HH_CELL.wrapText} font-medium text-foreground`}>{mask("owner_name", l.name)}</span>
      </span>
    ), footer: (rows) => <span className="whitespace-nowrap text-muted-foreground">합계 {rows.length}건</span> },
    { key: "account", header: "출금계좌", align: "left", cell: (l) => {
      const label = l.account_id ? accountMap.get(l.account_id) : null;
      if (!label) return <span className="block text-muted-foreground">-</span>;
      const text = mask("owner_name", label);
      // 소유자 색 상자 — 현금흐름 '출금계좌 / 결제계좌' 칸과 같은 체계(설계 127). 글자색은 tint 가 준다.
      return (
        <span className={`flex w-full min-w-0 items-center rounded-md border px-2 py-1 ${(l.account_id && accountTint.get(l.account_id)) ?? ACCOUNT_TINT_NONE}`} title={text}>
          <span className={HH_CELL.wrapText}>{text}</span>
        </span>
      );
    } },
    // 연-월만 보여준다 — 일자는 바로 옆 '상환일' 열이 이미 말한다(설계 167에서 폭 88 로 줄이며 결정).
    { key: "maturity", header: "만기일", align: "left", cell: (l) => <span className="whitespace-nowrap text-muted-foreground" title={l.maturity_date ?? undefined}>{l.maturity_date?.slice(0, 7) ?? "-"}</span> },
    { key: "payment_day", header: "상환일", align: "left", cell: (l) => <span className="whitespace-nowrap text-muted-foreground">{l.payment_day != null ? `${l.payment_day}일` : "-"}</span> },
    { key: "principal", header: "대출금액", align: "right", cell: (l) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{mask("expense_amount", won(l.principal))}</span>,
      footer: (rows) => <span className="whitespace-nowrap tabular-nums">{mask("expense_amount", won(rows.reduce((s, l) => s + l.principal, 0)))}</span> },
    { key: "rate", header: "이자율", align: "right", cell: (l) => <span className="whitespace-nowrap text-muted-foreground">{l.interest_rate != null ? `${l.interest_rate}%` : "-"}</span> },
    // 전월 출금 — 당월과 견줘 "지난달엔 나갔는데 이번 달은 안 나갔다"를 바로 보게 한다(팀장 요청 2026-08-13).
    // 당월과 **같은 술어**(matchLoanPayments)를 전월 거래에 돌린 값이다.
    { key: "prevActual", header: "전월 출금", align: "right", cell: (l) => {
      if (isCardLoan(l)) return cardCell(l, prevMonth, prevCard.estMap.get(l.id), prevCard.paidIds.has(l.id));
      const v = prevActualMap.get(l.id);
      if (!v) return <span className="whitespace-nowrap tabular-nums text-muted-foreground">-</span>;
      return (
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">
          {mask("expense_amount", won(v))}
          {prevEstimatedIds.has(l.id) && <span className="ml-1 text-xs font-normal" title="대출 연결이 없어 금액·이름·날짜로 맞춘 추정값입니다.">추정</span>}
        </span>
      );
    }, footer: (rows) => <span className="whitespace-nowrap tabular-nums">{mask("expense_amount", won(rows.reduce((s, l) => s + (prevActualMap.get(l.id) ?? (prevCard.paidIds.has(l.id) ? prevCard.estMap.get(l.id) ?? 0 : 0)), 0)))}</span> },
    { key: "planned", header: "당월 계획", align: "right", cell: (l) => {
      // 카드론은 상환기간 안이면 항상 역산액을 보여준다 — '계획'은 예정액이라 결제 전에도 뜻이 있다.
      if (isCardLoan(l)) return cardCell(l, month, curCard.estMap.get(l.id), true);
      const v = plannedMap.get(l.id);
      return <span className="whitespace-nowrap tabular-nums text-muted-foreground">{v ? mask("expense_amount", won(v)) : "-"}</span>;
    }, footer: (rows) => <span className="whitespace-nowrap tabular-nums">{mask("expense_amount", won(rows.reduce((s, l) => s + (plannedMap.get(l.id) ?? curCard.estMap.get(l.id) ?? 0), 0)))}</span> },
    { key: "actual", header: "당월 출금", align: "right", cell: (l) => {
      // 카드론은 **그 카드의 카드대금이 실제 나갔을 때만** 채운다 — 결제일 전이면 아직 안 나간 돈이다.
      // (설계 131 '출금됨 판정은 증거가 있을 때만'. 계획 칸과 달리 여기는 실적이다.)
      if (isCardLoan(l)) return cardCell(l, month, curCard.estMap.get(l.id), curCard.paidIds.has(l.id));
      const v = actualMap.get(l.id);
      if (!v) return <span className="whitespace-nowrap tabular-nums text-muted-foreground">-</span>;
      // 추정값은 그렇다고 말한다 — 확정과 같은 모양으로 보이면 틀린 값을 믿게 된다. (설계 92 §4)
      const isEstimate = estimatedIds.has(l.id);
      return (
        <span className="whitespace-nowrap tabular-nums text-foreground">
          {mask("expense_amount", won(v))}
          {isEstimate && <span className="ml-1 text-xs font-normal text-muted-foreground" title="대출 연결이 없어 금액·이름·날짜로 맞춘 추정값입니다.">추정</span>}
        </span>
      );
    }, footer: (rows) => <span className="whitespace-nowrap tabular-nums">{mask("expense_amount", won(rows.reduce((s, l) => s + (actualMap.get(l.id) ?? (curCard.paidIds.has(l.id) ? curCard.estMap.get(l.id) ?? 0 : 0)), 0)))}</span> },
    { key: "balance", header: "잔액", align: "right", cell: (l) => <span className="whitespace-nowrap font-semibold tabular-nums text-foreground">{mask("expense_amount", won(l.current_balance))}</span>,
      footer: (rows) => <span className="whitespace-nowrap tabular-nums">{mask("expense_amount", won(rows.reduce((s, l) => s + l.current_balance, 0)))}</span> },
  ] as HhBoardColumn<HhLoan>[]).map((c, i) => ({ ...c, width: LOAN_COL_WIDTHS[i] }));

  const renderBoard = (rawList: HhLoan[], statusLabel: string) => (
    <HhBoard<HhLoan>
      rows={filterBySearch(rawList)}
      loading={loading}
      error={error}
      onRetry={() => void fetchData()}
      rowKey={(l) => l.id}
      showCount={false}
      // 대출은 15건씩 끊을 이유가 없다 — 상환중 16건 전부를 한 화면에 놓고 상환일·잔액을 견줘야
      // 뜻이 있고, 표 맨 아래 합계행도 2페이지로 갈리면 눈으로 검산이 안 된다. (팀장 지시 2026-08-02)
      // renderBoard 는 상환완료 탭도 함께 쓴다 — 완료 대출은 쌓이지만 연 몇 건이라 전체 표시로 둔다.
      // 상환완료가 수십 건이 되면 그 탭만 기본값(15)으로 되돌릴 것.
      pageSize={null}
      onRowClick={openLoan}
      emptyText={search ? "검색 결과가 없습니다." : `${statusLabel} 대출이 없습니다.`}
      emptyAction={!search && statusLabel === "상환중인" ? (
        <Button onClick={openNewLoan}><Plus className="h-4 w-4" />대출 등록</Button>
      ) : undefined}
      sorts={loanSorts}
      // 헤더를 눌러 상환일·대출금액·이자율·잔액 순으로 바꿔 본다(다시 누르면 역순). (설계 134, 팀장 지시 2026-08-04)
      sortable
      columns={loanColumns}
    />
  );

  return (
    <PageShell>
      <HhPageHeader
        title="대출관리"
        description="대출별 잔액·이자율·월 상환액을 한곳에서 관리합니다. 전월 출금과 견줘 이번 달 상환이 제대로 나갔는지 볼 수 있고, 표 아래에서 통장분·카드분을 합친 총 대출 부담을 확인합니다. 대출을 클릭하면 상세·수정 창이 열립니다. 표 머리의 상환일·대출금액·이자율·잔액을 누르면 그 순서로 정렬되고, 같은 곳을 다시 누르면 역순이 됩니다."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/dashboard/household/settings"><Settings className="h-4 w-4" />설정</Link></Button>
            <Button onClick={openNewLoan}><Plus className="h-4 w-4" />대출 등록</Button>
          </div>
        }
      />

      <StatsGrid columns={4}>
        <StatCard label="총 잔액" value={won(totalBalance)} mobileValue={formatAmountInMan(totalBalance)} icon={Wallet} sensitive="expense_amount" />
        <StatCard label="총 원금" value={won(totalPrincipal)} mobileValue={formatAmountInMan(totalPrincipal)} icon={Banknote} sensitive="expense_amount" />
        <StatCard label="당월 계획 상환" value={won(totalPlanned)} mobileValue={formatAmountInMan(totalPlanned)} icon={CalendarClock} sensitive="expense_amount" />
        <StatCard label="당월 실제 상환" value={won(totalActual)} mobileValue={formatAmountInMan(totalActual)} sensitive="expense_amount" />
      </StatsGrid>

      {/* 조회 월 + 검색 통합 블록 — 다른 메뉴(HhSearchBar) DART 스타일을 따른다(라벨 그리드 + 검색/초기화). */}
      <div className="rounded-2xl border border-border/70 bg-card/85 p-3 shadow-sm md:p-4">
        <div className="space-y-3">
          {/* 조회 월 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="w-14 shrink-0 text-sm font-semibold text-muted-foreground">조회 월</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="이전 달"><ChevronLeft className="h-4 w-4" /></Button>
              <input
                type="month"
                aria-label="조회 월"
                value={month}
                onChange={(e) => setMonth(e.target.value || month)}
                className="h-9 rounded-lg border border-border/70 bg-background px-2.5 text-base md:text-sm"
              />
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="다음 달"><ChevronRight className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonthKey())}>이번 달</Button>
            </div>
          </div>

          {/* 검색 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="w-14 shrink-0 text-sm font-semibold text-muted-foreground">검색</span>
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="대출명으로 검색" className="pl-10" />
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void fetchData()}><Search className="h-4 w-4" />검색</Button>
              <Button type="button" variant="outline" onClick={() => { setSearch(""); setMonth(thisMonthKey()); }}><RotateCcw className="h-4 w-4" />초기화</Button>
            </div>
          </div>
        </div>
        {/* 당월 출금이 얼마나 믿을 만한지 함께 보여준다 — 연결률이 낮은 걸 숨기면 안 된다. (설계 92 §4) */}
        <p className="mt-3 text-xs text-muted-foreground">
          전월·당월 출금은 통장에서 나간 납부 내역을 대출별로 집계한 값입니다(같은 기준으로 각각 집계).
          카드론은 개별 출금이 없어 원금·금리·기간으로 <b className="text-foreground">역산</b>한 값을 보여주며,
          출금 칸은 그 카드의 카드대금이 실제 나간 뒤에만 채워집니다.
          {linkQuality.estimatedCount > 0 ? (
            <>
              {" "}통장 출금분 중 <b className="text-foreground">{linkQuality.confirmedCount}건 {mask("expense_amount", won(linkQuality.confirmed))}</b>은
              대출에 연결된 확정값, <b className="text-foreground">{linkQuality.estimatedCount}건 {mask("expense_amount", won(linkQuality.estimated))}</b>은
              금액·이름·날짜로 맞춘 <b className="text-foreground">추정값</b>입니다(표에 ‘추정’ 표시). 추정은 틀릴 수 있습니다.
            </>
          ) : linkQuality.confirmedCount > 0 ? (
            <> 이번 달 <b className="text-foreground">{linkQuality.confirmedCount}건 전부 대출에 연결된 확정값</b>입니다.</>
          ) : (
            <> 매칭이 안 된 대출은 ‘-’로 보입니다.</>
          )}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "active" | "closed")}>
        <TabsList>
          <TabsTrigger value="active" className={HH_TAB_SOLID}>상환중 ({active.length})</TabsTrigger>
          <TabsTrigger value="closed" className={HH_TAB_SOLID}>상환완료 ({closed.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="space-y-4 pt-4">
          {renderBoard(active, "상환중인")}
          {/* 월 상환 부담 — 통장분과 카드분을 **갈라서** 보여준다. 합쳐 놓으면 이 숫자를
              현금흐름 출금예정에 더하게 되고, 그건 이중계상이다(설계 70·108·162 ⑦). */}
          {shownCardPlanned > 0 && (
            <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
              <p className="text-sm font-semibold text-foreground">월 상환 부담 ({month}){kw ? ` · 검색 결과 ${shownActive.length}건 기준` : " — 위 ‘당월 계획 상환’ 카드의 내역"}</p>
              <dl className="mt-2 max-w-md space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">통장에서 직접</dt>
                  <dd className="tabular-nums text-foreground">{mask("expense_amount", won(shownBankPlanned))}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">카드대금 포함 <span className="text-xs">(카드론 {shownActive.filter((l) => curCard.estMap.has(l.id)).length}건 역산)</span></dt>
                  <dd className="tabular-nums text-foreground">{mask("expense_amount", won(shownCardPlanned))}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-border/70 pt-1">
                  <dt className="font-semibold text-foreground">총 대출 부담</dt>
                  <dd className="font-semibold tabular-nums text-foreground">{mask("expense_amount", won(shownBankPlanned + shownCardPlanned))}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                카드분은 카드 결제일에 <b className="text-foreground">카드대금에 합산되어</b> 나갑니다 —
                현금흐름의 출금예정 합계에는 이미 카드대금으로 들어 있으므로 <b className="text-foreground">두 숫자를 더하면 이중계상</b>입니다.
                역산은 원금·금리·기간으로 계산한 원리금균등 가정값이라 실제 청구액과 다를 수 있습니다.
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="closed" className="pt-4">{renderBoard(closed, "상환완료된")}</TabsContent>
      </Tabs>

      <LoanDialog target={dialogLoan} accounts={accounts} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={() => void fetchData()} />
    </PageShell>
  );
}
