"use client";

import { CalendarRange, Plus, Settings, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  PageShell,
  StatCard,
  StatsGrid,
} from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HhTxnTabs } from "@/components/household/hh-txn-tabs";
import { HhBoard, HH_COL } from "@/components/household/hh-board";
import { IncomeEditDialog } from "@/components/household/income-edit-dialog";
import { HhSearchBar, type HhDateRange, type HhAdvancedFilter, EMPTY_ADVANCED_FILTER, passesAdvancedFilter } from "@/components/household/hh-search-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { formatAmountInMan } from "@/lib/utils";
import { fetchTxnsPaged } from "@/lib/household/fetch-txns";
import { loanIncomeCategoryId } from "@/lib/household/calc";
import { incomeStats } from "@/lib/household/income-split";
import { nextDay, presetRange } from "@/lib/household/month";
import type { HhAccount, HhCategory, HhTransaction } from "@/lib/household/types";

/** 기간이 걸치는 월 수(inclusive). start/end 비면 1. */
function monthsInRange(range: HhDateRange): number {
  if (!range.start || !range.end) return 1;
  const [ay, am] = range.start.slice(0, 7).split("-").map(Number);
  const [by, bm] = range.end.slice(0, 7).split("-").map(Number);
  if (!ay || !am || !by || !bm) return 1;
  return Math.max(1, (by - ay) * 12 + (bm - am) + 1);
}

export default function HouseholdIncomePage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [range, setRange] = useState<HhDateRange>(() => presetRange("thisMonth"));
  const [rows, setRows] = useState<HhTransaction[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 선택 목록에만 적용, 현재 고른 계좌는 항상 남긴다.
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<HhAdvancedFilter>(EMPTY_ADVANCED_FILTER);
  // 등록·수정 팝업 (설계 82). target=null 이면 등록.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<HhTransaction | null>(null);
  const openCreate = useCallback(() => { setDialogTarget(null); setDialogOpen(true); }, []);
  const openEdit = useCallback((r: HhTransaction) => { setDialogTarget(r); setDialogOpen(true); }, []);

  const categoryName = useCallback((id: string | null) => categories.find((c) => c.id === id)?.name ?? "-", [categories]);
  const accountName = useCallback((id: string | null) => accounts.find((a) => a.id === id)?.name ?? "-", [accounts]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    // ★1,000행 무언절단 방지 — 지출 화면과 같은 이유(설계 90 §4).
    const [list, catRes, accRes] = await Promise.all([
      fetchTxnsPaged(supabase, range.start, range.end ? nextDay(range.end) : null, { type: "income" }),
      supabase.from("hh_category").select("*").eq("kind", "income").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
    ]);

    if (list === null || catRes.error || accRes.error) {
      console.error("수입 조회 실패:", catRes.error ?? accRes.error);
      toast.error("수입 목록을 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }

    // fetchTxnsPaged 는 날짜 오름차순 — 목록은 최신순이라 뒤집는다.
    setRows([...list].reverse());
    setCategories((catRes.data ?? []) as HhCategory[]);
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setLoading(false);
  }, [supabase, range.start, range.end]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!passesAdvancedFilter(r, filter)) return false;
      if (!kw) return true;
      return `${categoryName(r.category_id)}\n${r.counterparty ?? ""}\n${accountName(r.account_id)}`.toLowerCase().includes(kw);
    });
  }, [rows, search, filter, categoryName, accountName]);

  // 통계카드 = 검색결과 연동. 수입은 급여처럼 월 단위 덩어리로 들어와 '일평균'이 무의미
  // → '월평균'(기간 합계 ÷ 걸친 월 수)으로 표기. 최근 3개월/올해 조회 때 유용.
  // ★판정·합계·월평균은 income-split.ts 의 incomeStats 가 계산한다(테스트가 못박는 자리, 설계 190 §9 ③).
  //   대출 행이 있으면 첫 카드·월평균은 **대출 제외** 기준이고 라벨도 그렇게 붙인다.
  const loanIncomeCatId = useMemo(() => loanIncomeCategoryId(categories), [categories]);
  const { hasBorrowed, statIncomeTotal, borrowedTotal, monthlyAvg } = useMemo(
    () => incomeStats(filtered, loanIncomeCatId, monthsInRange(range)),
    [filtered, loanIncomeCatId, range]
  );

  return (
    <PageShell>
      <HhPageHeader
        title="수입"
        description="급여·용돈·이자 등 들어오는 돈을 기록하고 조회합니다."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/dashboard/household/settings">
                <Settings className="h-4 w-4" />
                설정
              </Link>
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              수입 등록
            </Button>
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
        keywordPlaceholder="입금처로 검색"
        onSearch={() => void fetchData()}
        advanced={{
          value: filter,
          onChange: setFilter,
          categories: categories.map((c) => ({ id: c.id, name: c.name })),
          accounts: pickVisibleAccounts(accounts, hideInactiveAccounts, [filter.accountId]).map((a) => ({ id: a.id, name: a.name, isActive: a.is_active })),
        }}
      />

      <StatsGrid columns={hasBorrowed ? 3 : 2}>
        <StatCard label={hasBorrowed ? "기간 수입(대출 제외)" : "기간 수입 합계"} value={`${statIncomeTotal.toLocaleString("ko-KR")}원`} mobileValue={formatAmountInMan(statIncomeTotal)} icon={Wallet} tone="positive" sensitive="income_amount" />
        {hasBorrowed && (
          <StatCard label="대출실행(빌린 돈)" value={`${borrowedTotal.toLocaleString("ko-KR")}원`} mobileValue={formatAmountInMan(borrowedTotal)} icon={Wallet} tone="info" sensitive="income_amount" />
        )}
        <StatCard label={hasBorrowed ? "월평균(대출 제외)" : "월평균"} value={`${monthlyAvg.toLocaleString("ko-KR")}원`} mobileValue={formatAmountInMan(monthlyAvg)} icon={CalendarRange} sensitive="income_amount" />
      </StatsGrid>

      <HhBoard<HhTransaction>
        rows={filtered}
        loading={loading}
        error={error}
        onRetry={() => void fetchData()}
        rowKey={(r) => r.id}
        onRowClick={openEdit}
        emptyText={search ? "검색 결과가 없습니다." : "이 기간에 등록된 수입이 없습니다."}
        emptyAction={search ? undefined : (
          <Button onClick={openCreate}><Plus className="h-4 w-4" />수입 등록</Button>
        )}
        sorts={[
          { key: "date", label: "날짜순", cmp: (a, b) => b.txn_date.localeCompare(a.txn_date) },
          { key: "amount", label: "금액순", cmp: (a, b) => b.amount - a.amount },
          { key: "category", label: "항목순", cmp: (a, b) => categoryName(a.category_id).localeCompare(categoryName(b.category_id)) },
        ]}
        columns={[
          // 폭은 HH_COL 척도에서 내용별로 고른다(설계 122 — 옛 '전 컬럼 20%×5' 규칙은 폐기).
          // mobile 힌트(설계 99 E): 모바일 카드 "입금처↔금액 / 날짜·항목·입금계좌" 2줄 압축.
          { key: "date", header: "날짜", align: "left", width: HH_COL.standard, mobile: "meta", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{r.txn_date}</span> },
          // 항목: 배지(px-2+테두리)가 short(88, 안쪽 58)를 1.7px 넘쳤다. 같은 배지 열인 지출 '카테고리'도
          // standard 다 — 둘을 맞춘다(설계 122: 필요폭 이상인 가장 작은 슬롯).
          { key: "category", header: "항목", align: "left", width: HH_COL.standard, mobile: "meta", cell: (r) => <Badge variant="secondary">{categoryName(r.category_id)}</Badge> },
          // 입금처 — '카카오T주차_카카오페이 (토스뱅크 체크카드)'(214)가 xxwide(208)에서 꺾였고
          // x3wide(240)로도 4px 모자랐다(안쪽 210). x4wide(272)라야 한 줄에 들어간다(실측 2026-08-09).
          // 표 합계 680 → 744 로 여유가 크다(상한 1200).
          { key: "counterparty", header: "입금처", align: "left", width: HH_COL.x4wide, mobile: "title", cell: (r) => <span className="font-medium text-foreground">{r.counterparty ? mask("merchant", r.counterparty) : "-"}</span> },
          { key: "account", header: "입금계좌", align: "left", width: HH_COL.wide, mobile: "meta", cell: (r) => <span className="text-muted-foreground">{mask("owner_name", accountName(r.account_id))}</span> },
          // 금액: short(88)에서 8자리(`15,000,000원` 실측 94)가 잘렸다 — 2026-08-02 카드론 1,500만원 수입에서
          // 처음 드러났다(1440·768px 양쪽). 척도상 필요폭 이상인 가장 작은 슬롯 = standard(112). (설계 122·123)
          { key: "amount", header: "금액", align: "right", width: HH_COL.standard, mobile: "amount", cell: (r) => <span className="whitespace-nowrap font-semibold tabular-nums text-blue-600 dark:text-blue-400">{mask("income_amount", `${r.amount.toLocaleString("ko-KR")}원`)}</span> },
        ]}
      />

      <IncomeEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={dialogTarget}
        categories={categories}
        accounts={accounts}
        onSaved={() => void fetchData()}
      />
    </PageShell>
  );
}
