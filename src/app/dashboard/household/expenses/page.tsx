"use client";

import {
  CalendarRange,
  Plus,
  Settings,
  TrendingDown,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  ErrorState,
  LoadingState,
  PageShell,
  SectionIntro,
  StatCard,
  StatsGrid,
} from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HhTxnTabs } from "@/components/household/hh-txn-tabs";
import { HhSpendBreakdownChart } from "@/components/household/hh-spend-breakdown-chart";
import { HhBoard, HH_COL } from "@/components/household/hh-board";
import { ExpenseEditDialog } from "@/components/household/expense-edit-dialog";
import { InstallmentEditDialog } from "@/components/household/installment-edit-dialog";
import { HhSearchBar, type HhDateRange, type HhAdvancedFilter, EMPTY_ADVANCED_FILTER, passesAdvancedFilter } from "@/components/household/hh-search-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SUB } from "@/components/ui/tabs";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { formatAmountInMan } from "@/lib/utils";
import { installmentEndYm, installmentProgress } from "@/lib/household/calc";
import { groupKeyByMethodId, groupKeyOfMethod } from "@/lib/household/card-group";
import { fetchTxnsPaged } from "@/lib/household/fetch-txns";
import { nextDay, presetRange, shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhAccount, HhCategory, HhInstallment, HhPaymentMethod, HhPaymentMethodKind, HhPerson, HhTransaction } from "@/lib/household/types";

/** 기간(inclusive) 일수. start/end 비면 1. */
function daysInRange(range: HhDateRange): number {
  if (!range.start || !range.end) return 1;
  const a = new Date(range.start).getTime();
  const b = new Date(range.end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** 기간이 걸치는 'YYYY-MM' 목록. 할부 청구분을 월별로 합산하는 데 쓴다. */
function monthsInRange(range: HhDateRange): string[] {
  const startYm = (range.start || thisMonthKey()).slice(0, 7);
  const endYm = (range.end || thisMonthKey()).slice(0, 7);
  const out: string[] = [];
  let cur = startYm;
  for (let guard = 0; cur <= endYm && guard < 120; guard++) {
    out.push(cur);
    cur = shiftMonth(cur, 1);
  }
  return out;
}

export default function HouseholdExpensesPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [range, setRange] = useState<HhDateRange>(() => presetRange("thisMonth"));
  const [rows, setRows] = useState<HhTransaction[]>([]);
  const [installments, setInstallments] = useState<HhInstallment[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 선택 목록에만 적용, 현재 고른 계좌는 항상 남긴다.
  const [hideInactiveAccounts] = useHideInactiveAccounts(); // 계좌/카드 드롭다운의 '계좌' 그룹용 (설계 83)
  const [persons, setPersons] = useState<HhPerson[]>([]); // 지출 팝업 '용돈 귀속' (설계 82)
  const [merchantMap, setMerchantMap] = useState<{ merchant_key: string; category_id: string | null }[]>([]); // 지출 팝업 가맹점 자동분류
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<HhAdvancedFilter>(EMPTY_ADVANCED_FILTER);
  const [showAllIns, setShowAllIns] = useState(false);
  // 등록·수정 팝업 (설계 82). 지출/할부 각각. target=null 이면 등록.
  const [expDialogOpen, setExpDialogOpen] = useState(false);
  const [expDialogTarget, setExpDialogTarget] = useState<HhTransaction | null>(null);
  const [insDialogOpen, setInsDialogOpen] = useState(false);
  const [insDialogTarget, setInsDialogTarget] = useState<HhInstallment | null>(null);
  const openExpCreate = useCallback(() => { setExpDialogTarget(null); setExpDialogOpen(true); }, []);
  const openExpEdit = useCallback((r: HhTransaction) => { setExpDialogTarget(r); setExpDialogOpen(true); }, []);
  const openInsCreate = useCallback(() => { setInsDialogTarget(null); setInsDialogOpen(true); }, []);
  const openInsEdit = useCallback((r: HhInstallment) => { setInsDialogTarget(r); setInsDialogOpen(true); }, []);

  const categoryName = useCallback((id: string | null) => categories.find((c) => c.id === id)?.name ?? "-", [categories]);
  const methodName = useCallback((id: string | null) => methods.find((m) => m.id === id)?.name ?? "-", [methods]);
  const accountName = useCallback((id: string | null) => accounts.find((a) => a.id === id)?.name ?? "-", [accounts]);
  const methodKind = useCallback((id: string | null): HhPaymentMethodKind | null => methods.find((m) => m.id === id)?.kind ?? null, [methods]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    // ★.select() 를 그냥 쓰면 1,000행에서 조용히 잘려 합계·일평균이 틀린다(설계 90 §4).
    //   '올해' 프리셋이나 기간을 비운 조회는 연 1,000건을 쉽게 넘는다.
    const [list, insRes, catRes, mRes, accRes, perRes, mapRes] = await Promise.all([
      fetchTxnsPaged(supabase, range.start, range.end ? nextDay(range.end) : null, { type: "expense" }),
      supabase.from("hh_installment").select("*").order("start_date", { ascending: false }),
      supabase.from("hh_category").select("*").eq("kind", "expense").order("sort_order").order("name"),
      supabase.from("hh_payment_method").select("*").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      // 지출 팝업용(용돈 귀속 인물 · 가맹점→카테고리 자동분류). (설계 82 §B)
      supabase.from("hh_person").select("*").order("sort_order").order("name"),
      supabase.from("hh_merchant_map").select("merchant_key,category_id"),
    ]);

    if (list === null || insRes.error || catRes.error || mRes.error || accRes.error) {
      console.error("지출 조회 실패:", insRes.error ?? catRes.error ?? mRes.error ?? accRes.error);
      toast.error("지출 목록을 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }

    // fetchTxnsPaged 는 날짜 오름차순 — 목록은 최신순이라 뒤집는다.
    setRows([...list].reverse());
    setInstallments((insRes.data ?? []) as HhInstallment[]);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setMethods((mRes.data ?? []) as HhPaymentMethod[]);
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setPersons((perRes.data ?? []) as HhPerson[]);
    setMerchantMap((mapRes.data ?? []) as { merchant_key: string; category_id: string | null }[]);
    setLoading(false);
  }, [supabase, range.start, range.end]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 키워드 필터 적용된 일시불 거래(전체 = 현금+카드 소비지출. 카드대금 납부·대출 상환은 여기 없음 — 거래 type=expense 만 조회)
  const kwRows = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!passesAdvancedFilter(r, filter)) return false;
      if (!kw) return true;
      return `${categoryName(r.category_id)}\n${r.memo ?? ""}\n${r.counterparty ?? ""}\n${methodName(r.payment_method_id)}\n${accountName(r.account_id)}`.toLowerCase().includes(kw);
    });
  }, [rows, search, filter, categoryName, methodName, accountName]);

  // 카드 = 결제수단 kind ∈ {credit, installment}. 현금 = 그 외(현금/체크/미지정).
  const isCard = useCallback((r: HhTransaction) => {
    const k = methodKind(r.payment_method_id);
    return k === "credit" || k === "installment";
  }, [methodKind]);

  const cardRows = useMemo(() => kwRows.filter(isCard), [kwRows, isCard]);
  const cashRows = useMemo(() => kwRows.filter((r) => !isCard(r)), [kwRows, isCard]);

  // 카드사·명의별 합계 — 결제수단 병합 없이 화면에서만 묶어 '카드로 얼마 썼나'를 한눈에. (설계 86)
  // 조회 조건이 반영된 cardRows 기준이라 표 합계와 항상 일치. 클릭하면 그 묶음으로 필터.
  const cardGroupSums = useMemo(() => {
    const gk = groupKeyByMethodId(methods);
    const sums = new Map<string, { amount: number; count: number }>();
    for (const r of cardRows) {
      const key = r.payment_method_id ? gk.get(r.payment_method_id) : null;
      if (!key) continue;
      const cur = sums.get(key) ?? { amount: 0, count: 0 };
      cur.amount += r.amount;
      cur.count += 1;
      sums.set(key, cur);
    }
    return [...sums.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [cardRows, methods]);
  // 현금·체크 지출의 '계좌별 합계' — 카드 탭의 카드별 합계와 짝을 이루는 값. (설계 144)
  // 조회 조건이 반영된 cashRows 기준이라 표 합계와 항상 일치. 계좌가 안 붙은 행은 '(계좌 미지정)'으로 묶는다.
  const cashAccountSums = useMemo(() => {
    const sums = new Map<string, { amount: number; count: number }>();
    for (const r of cashRows) {
      const key = r.account_id ?? "";
      const cur = sums.get(key) ?? { amount: 0, count: 0 };
      cur.amount += r.amount;
      cur.count += 1;
      sums.set(key, cur);
    }
    return [...sums.entries()]
      .map(([key, v]) => ({ key, label: key ? accountName(key) : "(계좌 미지정)", ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [cashRows, accountName]);

  // 계좌 막대를 누르면 그 계좌로 필터(다시 누르면 해제). 카드 묶음 필터와 상호배타.
  const toggleCashAccount = useCallback((key: string) => {
    if (!key) return; // '(계좌 미지정)'은 필터 대상이 아니다
    setFilter((f) => (f.accountId === key
      ? { ...f, accountId: "" }
      : { ...f, accountId: key, methodId: "", methodIds: undefined, methodGroup: undefined }));
  }, []);

  const selectCardGroup = useCallback(
    (key: string) => {
      const ids = methods.filter((m) => groupKeyOfMethod(m) === key).map((m) => m.id);
      setFilter((f) => ({ ...f, methodId: "", accountId: "", methodIds: ids, methodGroup: key }));
    },
    [methods]
  );

  // 할부에도 항목·결제수단 필터를 적용한다 — 상시 노출 드롭다운(설계 83)에서 고른 조건이
  // 할부 탭만 무시되면 버그로 보인다. 금액범위·계좌는 할부에 대응 개념이 없어 제외(할부는 총액·회차 구조).
  const filteredIns = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return installments.filter((i) => {
      if (filter.categoryId && i.category_id !== filter.categoryId) return false;
      if (filter.methodId && i.payment_method_id !== filter.methodId) return false;
      if (filter.accountId) return false; // 계좌로 좁히면 할부는 해당 없음
      if (!kw) return true;
      return `${categoryName(i.category_id)}\n${i.title ?? ""}\n${methodName(i.payment_method_id)}`.toLowerCase().includes(kw);
    });
  }, [installments, search, filter, categoryName, methodName]);

  // 기간이 걸치는 달의 할부 청구분 합계 (소비지출 통계에 합산).
  // 검색/필터를 탄 filteredIns 기준 — 일시불(txnTotal)은 필터를 타는데 여기만 전체를 더하면
  // '외식비 1건 41,700원'인데 소비지출은 92만'처럼 카드 숫자가 목록과 어긋난다. (설계 83)
  const insBillingInRange = useMemo(() => {
    const months = monthsInRange(range);
    return filteredIns.reduce((s, ins) => {
      if (!ins.is_active) return s;
      return s + months.reduce((m, ym) => {
        const p = installmentProgress(ins, ym);
        return m + (p.activeInMonth ? p.monthly : 0);
      }, 0);
    }, 0);
  }, [filteredIns, range]);

  // 진행 중 할부(활성 + 미완료). 할부 탭 배지·기본 목록 기준 — 8년치 완료분(460건)이 전체/현금/카드 건수와 섞여 보이던 혼란 방지.
  const activeIns = useMemo(
    () =>
      filteredIns.filter((ins) => {
        if (!ins.is_active) return false;
        const p = installmentProgress(ins, thisMonthKey());
        return p.current <= ins.total_count; // 미완료
      }),
    [filteredIns]
  );
  const displayIns = showAllIns ? filteredIns : activeIns;
  const completedInsCount = filteredIns.length - activeIns.length;

  // 통계카드 = 검색결과(기간) 연동. 소비지출 = 일시불 거래 + 기간 할부 청구분.
  const txnTotal = useMemo(() => kwRows.reduce((s, r) => s + r.amount, 0), [kwRows]);
  const spendingTotal = txnTotal + insBillingInRange;
  const dailyAvg = Math.round(spendingTotal / daysInRange(range));

  // 날짜 구분줄(설계 80 규칙 5): 행마다 반복되던 날짜 열 대신 "7월 15일 화요일 · N건 · 합계"로 묶는다.
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const renderDateGroup = (key: string, groupRows: HhTransaction[]) => {
    const d = new Date(`${key}T00:00:00`);
    const label = Number.isNaN(d.getTime()) ? key : `${d.getMonth() + 1}월 ${d.getDate()}일 ${weekdays[d.getDay()]}요일`;
    const total = groupRows.reduce((s, r) => s + r.amount, 0);
    return (
      <span>
        {label} <span className="font-normal text-muted-foreground/70">· {groupRows.length}건 · <span className="tabular-nums">{mask("expense_amount", `${total.toLocaleString("ko-KR")}원`)}</span></span>
      </span>
    );
  };

  // ★★2026-08-11 2단 보기를 껐다 (설계 162 ⑨, 팀장 결정) — 설계 145 는 폐기다.
  //
  // 설계 145 가 2단을 넣을 때의 전제는 "표가 592px 라 1200px 페이지에서 오른쪽 606px 가 빈다"였다.
  // 그 뒤 지불방식 열이 160 → 208 로 커져 표가 640px 이 되면서 전제가 깨졌는데 2단은 그대로 남았고,
  // **그때부터 모든 화면에서 '금액' 열이 잘리고 있었다**(실측: 1280px 에서 125px · 1920px 에서 47px).
  // 껍데기가 overflow-x:auto 라 가로 스크롤로 숨겨져 검사 D 가 못 잡았고, 뷰포트도 768/1920 만
  // 보던 탓에 초록인 채로 넘어갔다 — 팀장이 화면에서 발견할 때까지.
  //
  // ★두 목표는 양립하지 않는다: 단 폭 594px 안에 4열을 넣으려면 어느 열이든 줄꺾임이 난다
  //   (지불방식은 「국민카드(이바다) The Easy카드」 때문에 208 이 필요하다). 실제로 160 으로 줄여
  //   보니 잘림은 사라졌지만 줄꺾임 6건이 새로 생겼다. **잘림도 꺾임도 없는 조합은 1단뿐이다.**
  // 대가: 한 화면에 보이는 건수가 절반이다. 팀장이 그 대가를 알고 1단을 택했다.
  //
  // ⚠️`twoUp` 기능 자체는 HhBoard 에 남겨 뒀다(다른 화면이 쓸 수 있다). 다만 쓰기 전에
  //   **표 폭 ≤ 단 폭**인지 반드시 확인할 것 — `npm run test:table-render` 의 검사 I 가 잡아 준다.
  const renderTxnTable = (list: HhTransaction[], emptyLabel: string, twoUp = false) => (
    <HhBoard<HhTransaction>
      twoUp={twoUp}
      rows={list}
      rowKey={(r) => r.id}
      showCount={false}
      onRowClick={openExpEdit}
      emptyText={search ? "검색 결과가 없습니다." : emptyLabel}
      emptyAction={search ? undefined : (
        <Button onClick={openExpCreate}><Plus className="h-4 w-4" />지출 등록</Button>
      )}
      sorts={[
        { key: "date", label: "날짜순", cmp: (a, b) => b.txn_date.localeCompare(a.txn_date) },
        { key: "amount", label: "금액순", cmp: (a, b) => b.amount - a.amount },
        { key: "category", label: "항목순", cmp: (a, b) => categoryName(a.category_id).localeCompare(categoryName(b.category_id)) },
      ]}
      groupBy={{ key: (r) => r.txn_date, render: renderDateGroup }}
      columns={[
        // 열 폭 = 내용별(설계 122). 카테고리 배지·금액은 척도 고정, 내역·지불방식은 길이가 제각각이라 가변.
        // (예전 25%×4 균등은 폐기 — 금액 열에만 209.7px 공백이 남았다. 실측: measure_table_content.mts)
        // mobile 힌트(설계 99 E): 모바일 카드를 "내역↔금액 / 카테고리·지불방식" 2줄로 압축 — 한 화면에 보이는 건수 2배.
        { key: "category", header: "카테고리", align: "left", width: HH_COL.standard, mobile: "meta", cell: (r) => <Badge variant="secondary">{categoryName(r.category_id)}</Badge> },
        // 내역 — 폭을 생략하면 기준폭 160 인데 '배스킨라빈스부천옥길트레이더스'(156)가 두 줄로 꺾였다
        // (실측 2026-08-09). 표 합계 592 → 640 으로 여유가 크다(상한 1200).
        { key: "memo", header: "내역", align: "left", width: HH_COL.xxwide, mobile: "title", cell: (r) => { const v = r.memo ?? r.counterparty; return <span className="font-medium text-foreground">{v ? mask("merchant", v) : "-"}</span>; } },
        // 지불방식: 결제수단이 있으면 결제수단명, 없으면 출금계좌명(체크카드·페이·지로 등 계좌 직출금은 '어디서 나갔나'를 계좌로 보여준다).
        // ★이 열은 208(xxwide)이어야 한다 — 2026-08-11 실측: 「국민카드(이바다) The Easy카드」가
        //   한 줄에 151px 필요하고 패딩(px-4 좌우 32) 을 더하면 183px 이라 160 슬롯으로는 두 줄로 꺾인다.
        //   한때 160 으로 줄여 표를 592px 로 만드는 안을 시도했으나, 그 대가가 줄꺾임이었다.
        //   대신 **2단 보기를 껐다**(아래 설계 145 주석 참고) — 1단이면 표 640px 이 여유롭게 들어간다.
        { key: "method", header: "지불방식", align: "left", width: HH_COL.xxwide, mobile: "meta", cell: (r) => {
          const label = r.payment_method_id ? methodName(r.payment_method_id) : r.account_id ? accountName(r.account_id) : null;
          return <span className="text-muted-foreground">{label ? mask("owner_name", label) : "-"}</span>;
        } },
        // 지출 화면은 모든 행이 지출 — 빨강은 정보가 아니라 소음(설계 80 규칙 2). 검정+tabular-nums로.
        { key: "amount", header: "금액", align: "right", width: HH_COL.standard, mobile: "amount", cell: (r) => <span className="whitespace-nowrap font-semibold tabular-nums text-foreground">{mask("expense_amount", `${r.amount.toLocaleString("ko-KR")}원`)}</span> },
      ]}
    />
  );

  return (
    <PageShell>
      <HhPageHeader
        title="지출"
        description="실제로 쓴 돈(소비지출)만 모읍니다."
        help={
          <>
            신용카드 대금 납부·대출 상환은 소비가 아니라 <b>출금</b>이라 여기가 아니라 <b>현금흐름</b>에서 봅니다.
            기간 소비지출은 일시불 거래에 기간 할부 청구분을 더한 값입니다(카드대금·대출 납부 제외).
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/dashboard/household/settings"><Settings className="h-4 w-4" />설정</Link></Button>
            <Button variant="outline" onClick={openInsCreate}><Plus className="h-4 w-4" />할부 등록</Button>
            <Button onClick={openExpCreate}><Plus className="h-4 w-4" />지출 등록</Button>
          </div>
        }
      />

      <HhTxnTabs />

      <HhSearchBar
        compact
        range={range}
        onRangeChange={setRange}
        keyword={search}
        onKeywordChange={setSearch}
        keywordPlaceholder="내역·가맹점으로 검색"
        onSearch={() => void fetchData()}
        advanced={{
          value: filter,
          onChange: setFilter,
          categories: categories.map((c) => ({ id: c.id, name: c.name })),
          methods: methods.map((m) => ({ id: m.id, name: m.name, isActive: m.is_active, groupKey: groupKeyOfMethod(m) })),
          accounts: pickVisibleAccounts(accounts, hideInactiveAccounts, [filter.accountId]).map((a) => ({ id: a.id, name: a.name, isActive: a.is_active })),
        }}
      />

      <StatsGrid columns={2}>
        <StatCard label="기간 소비지출" value={`${spendingTotal.toLocaleString("ko-KR")}원`} mobileValue={formatAmountInMan(spendingTotal)} icon={TrendingDown} sensitive="expense_amount" />
        <StatCard label="일평균" value={`${dailyAvg.toLocaleString("ko-KR")}원`} mobileValue={formatAmountInMan(dailyAvg)} icon={CalendarRange} sensitive="expense_amount" />
      </StatsGrid>

      {loading ? (
        <LoadingState label="지출을 불러오는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchData()} />
      ) : (
        <div className="space-y-6">
        <Tabs defaultValue="all">
          {/* overflow-x-auto 단독이면 overflow-y가 auto로 승격돼 1px 초과에도 세로 스크롤바(▲▼)가 생긴다 → overflow-y-hidden 병기(설계 59 교훈). */}
          <div className="-mx-4 overflow-x-auto overflow-y-hidden px-4 md:mx-0 md:px-0">
          <TabsList className="min-w-max">
            <TabsTrigger value="all" className={HH_TAB_SUB}>전체 <Badge variant="secondary" className="ml-1.5">{kwRows.length}</Badge></TabsTrigger>
            <TabsTrigger value="cash" className={HH_TAB_SUB}>현금 <Badge variant="secondary" className="ml-1.5">{cashRows.length}</Badge></TabsTrigger>
            <TabsTrigger value="card" className={HH_TAB_SUB}>카드 <Badge variant="secondary" className="ml-1.5">{cardRows.length}</Badge></TabsTrigger>
          </TabsList>
          </div>

          <TabsContent value="all" className="pt-4">{renderTxnTable(kwRows, "이 기간에 등록된 지출이 없습니다.")}</TabsContent>
          {/* 현금 탭: 탭 바로 아래에 '계좌별' 그래프 → 그 아래 표. (설계 144, 팀장 지시) */}
          <TabsContent value="cash" className="space-y-3 pt-4">
            <HhSpendBreakdownChart
              items={cashAccountSums}
              selectedKey={filter.accountId || undefined}
              onSelect={toggleCashAccount}
              emptyText="이 기간에 현금/체크 지출이 없습니다."
            />
            {renderTxnTable(cashRows, "이 기간에 현금/체크 지출이 없습니다.")}
          </TabsContent>
          {/* 카드 탭: 옛 '버튼 나열'을 현금 탭과 같은 그래프로 통일. 누르면 그 묶음으로 필터(재클릭 해제). (설계 144) */}
          <TabsContent value="card" className="space-y-3 pt-4">
            <HhSpendBreakdownChart
              items={cardGroupSums.map((g) => ({ key: g.key, label: g.key, amount: g.amount, count: g.count }))}
              selectedKey={filter.methodGroup}
              onSelect={(key) =>
                filter.methodGroup === key
                  ? setFilter((f) => ({ ...f, methodIds: undefined, methodGroup: undefined }))
                  : selectCardGroup(key)
              }
              emptyText="이 기간에 카드 지출이 없습니다."
            />
            {renderTxnTable(cardRows, "이 기간에 카드 지출이 없습니다.")}
          </TabsContent>

        </Tabs>

        {/* 할부 — 탭이 아니라 지출 목록 아래 상시 섹션(팀장 요청 2026-07-18). 종료 예정 컬럼이 있어 '곧 끝나는 할부' 블록은 제거. */}
        <section className="space-y-3">
          <SectionIntro
            title={<span className="inline-flex items-center gap-2">할부 <Badge variant="secondary">{activeIns.length}</Badge></span>}
            description={`위 지출 목록(기간 거래)과 다른 목록입니다. 시작일 기준이라 기간 필터 영향 없이 ${showAllIns ? "전체 할부" : "진행 중 할부"}를 보여줍니다(키워드 검색만 적용).`}
            action={completedInsCount > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setShowAllIns((v) => !v)}>
                {showAllIns ? "진행 중만 보기" : `완료·비활성 포함 (${completedInsCount})`}
              </Button>
            ) : undefined}
          />
          <HhBoard<HhInstallment>
              rows={displayIns}
              rowKey={(ins) => ins.id}
              showCount={false}
              onRowClick={openInsEdit}
              emptyText={search ? "검색 결과가 없습니다." : showAllIns ? "등록된 할부가 없습니다." : "진행 중인 할부가 없습니다."}
              
              sorts={[
                { key: "start", label: "시작일순", cmp: (a, b) => b.start_date.localeCompare(a.start_date) },
                { key: "monthly", label: "월금액순", cmp: (a, b) => installmentProgress(b, thisMonthKey()).monthly - installmentProgress(a, thisMonthKey()).monthly },
              ]}
              columns={[
                // 전 컬럼 동일 폭(12.5%×8) — 컬럼 시작 위치가 등간격이라 어느 화면 폭에서도 사이 공간이 균일(팀장 요청 2026-07-18, CLAUDE.md 표 컬럼 간격 규칙).
                { key: "start", header: "시작일", align: "left", width: HH_COL.standard, cell: (ins) => <span className="whitespace-nowrap text-muted-foreground">{ins.start_date}</span> },
                { key: "cat", header: "카테고리", align: "left", width: HH_COL.standard, cell: (ins) => <Badge variant="secondary">{categoryName(ins.category_id)}</Badge> },
                { key: "title", header: "내용", align: "left", width: HH_COL.xwide, cell: (ins) => <span className="font-medium text-foreground">{ins.title ?? "-"}</span> },
                { key: "progress", header: "진행", align: "left", width: HH_COL.num, cell: (ins) => { const p = installmentProgress(ins, thisMonthKey()); return <span className="whitespace-nowrap text-muted-foreground">{Math.min(Math.max(p.current, 0), ins.total_count)}/{ins.total_count}</span>; } },
                { key: "end", header: "종료 예정", align: "left", width: HH_COL.short, cell: (ins) => { const endYm = installmentEndYm(ins); return thisMonthKey() > endYm ? <span className="text-muted-foreground/70">완료</span> : <span className="text-muted-foreground">{endYm}</span>; } },
                { key: "total", header: "전체 결제금액", align: "right", width: HH_COL.standard, cell: (ins) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{mask("expense_amount", `${ins.total_amount.toLocaleString("ko-KR")}원`)}</span> },
                { key: "monthly", header: "월금액", align: "right", width: HH_COL.standard, cell: (ins) => <span className="whitespace-nowrap font-semibold tabular-nums">{mask("expense_amount", `${installmentProgress(ins, thisMonthKey()).monthly.toLocaleString("ko-KR")}원`)}</span> },
                { key: "status", header: "상태", align: "left", width: HH_COL.short, cell: (ins) => { const p = installmentProgress(ins, thisMonthKey()); const done = p.current > ins.total_count; return !ins.is_active ? <Badge variant="secondary">비활성</Badge> : done ? <Badge variant="secondary">완료</Badge> : <Badge>진행중</Badge>; } },
              ]}
            />
        </section>
        </div>
      )}

      <ExpenseEditDialog
        open={expDialogOpen}
        onOpenChange={setExpDialogOpen}
        target={expDialogTarget}
        categories={categories}
        methods={methods}
        accounts={accounts}
        persons={persons}
        merchantMap={merchantMap}
        onSaved={() => void fetchData()}
      />
      <InstallmentEditDialog
        open={insDialogOpen}
        onOpenChange={setInsDialogOpen}
        target={insDialogTarget}
        categories={categories}
        methods={methods}
        onSaved={() => void fetchData()}
      />
    </PageShell>
  );
}
