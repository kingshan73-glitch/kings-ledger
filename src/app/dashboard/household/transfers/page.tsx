"use client";

import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Plus, Repeat } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ErrorState, LoadingState, PageShell, StatCard, StatsGrid } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HhTxnTabs } from "@/components/household/hh-txn-tabs";
import { HH_COL, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { HhSearchBar } from "@/components/household/hh-search-bar";
import { TransferEditDialog } from "@/components/household/transfer-edit-dialog";
import { Button } from "@/components/ui/button";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { cn, formatAmountInMan } from "@/lib/utils";
import { rangeOfMonth, thisMonthKey } from "@/lib/household/month";
import type { HhAccount, HhTransaction } from "@/lib/household/types";

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

// 기본 조회 기간 = 해당월 1일 ~ 말일(다른 조회 화면과 통일). (설계 docs/household/53)
function defaultPeriod() {
  return rangeOfMonth(thisMonthKey());
}

// 같은 (출금·입금·금액·날짜) 거래를 하나로 묶은 표시 그룹. (설계 docs/household/49)
interface TransferGroup {
  key: string;
  items: HhTransaction[];
  rep: HhTransaction;
  count: number;
  from_account_id: string | null;
  to_account_id: string | null;
  amount: number;
  txn_date: string;
}

const PAGE_SIZE = 15;
type SortKey = "date" | "amount";

// 통장이동 열 폭 — 내용별 척도(설계 122).
const TRANSFER_COLS = [
  HH_COL.standard,  // 날짜 `2026-08-01`
  // 출금 → 입금 — 계좌명 2개 + 화살표. 기준폭 160(안쪽 130)에서는 inline-flex 가 두 이름을
  // 쥐어짜 **계좌명이 글자 단위로 꺾였다**("국민은행(이바다)" 한 줄에 81px 필요, 실측 2026-08-02).
  // 필요폭 = 81+81+화살표 14+간격 12 ≈ 188, 가장 긴 계좌명(카카오페이(김하늘)) 기준 ≈ 208 →
  // 안쪽 242 인 x4wide. (설계 122·123 — 표 폭 합계는 아래 '메모' 주석 한 곳에만 적는다)
  HH_COL.x4wide,
  // 금액 — standard(112)에서 큰 금액이 잘렸다(실측 2026-08-09: 2칸에서 +13px 부족).
  // wide(136)로도 span 이 +3.7px 넘쳤다 — ink 가 아니라 span 상자 기준이라 한 슬롯 더 필요했다.
  HH_COL.xwide,
  // 메모 — 길이 제각각. 기준폭 160(안쪽 130)에서 "코나아이(주)(경기지역화폐)"(한 줄에 131px 필요)가
  // **1px 차이로 두 줄로 꺾였다**(실측 2026-08-04, 지역화폐 충전이 쌓이며 드러남) → 한 슬롯 위로.
  // ★표 폭 합계(여기 한 곳에만 적는다 — 여러 곳에 적으면 폭을 고칠 때 낡은 값이 남는다.
  //   2026-08-09 교차리뷰 지적): 112+272+160+208 = **752**, 페이지 최대폭 1200 에 여유가 있다.
  HH_COL.xxwide,    // 메모
];

export default function HouseholdTransfersPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [period, setPeriod] = useState(defaultPeriod);
  const [keyword, setKeyword] = useState("");
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  const [transfers, setTransfers] = useState<HhTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 등록·수정 팝업 (설계 82). target=null 이면 등록.
  // 그룹 행은 표시용 병합(설계 49)이라 대표행(rep)만 수정 — 기존 상세 이동과 동일 동작.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<HhTransaction | null>(null);
  const openCreate = useCallback(() => { setDialogTarget(null); setDialogOpen(true); }, []);
  const openEdit = useCallback((r: HhTransaction) => { setDialogTarget(r); setDialogOpen(true); }, []);

  const accountName = useCallback((id: string | null) => accounts.find((a) => a.id === id)?.name ?? "-", [accounts]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();
    const [accRes, trRes] = await Promise.all([
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase
        .from("hh_transaction")
        .select("*")
        .eq("type", "transfer")
        .gte("txn_date", period.start)
        .lte("txn_date", period.end)
        .order("txn_date", { ascending: false }),
    ]);
    if (accRes.error || trRes.error) {
      console.error("통장이동 조회 실패:", accRes.error ?? trRes.error);
      toast.error("통장이동 내역을 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setTransfers((trRes.data ?? []) as HhTransaction[]);
    setPage(0);
    setExpanded(new Set());
    setLoading(false);
  }, [supabase, period.start, period.end]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 키워드 필터(실시간, 다른 조회 화면과 동일 UX) — 메모·출금/입금 계좌명·금액 매칭.
  const filteredTransfers = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return transfers;
    return transfers.filter((t) => {
      const fields = [t.memo ?? "", accountName(t.from_account_id), accountName(t.to_account_id), String(t.amount)];
      return fields.some((f) => f.toLowerCase().includes(kw));
    });
  }, [transfers, keyword, accountName]);

  // (출금·입금·금액·날짜) 병합 그룹화. 정렬은 그룹 단위(날짜/금액).
  const groups = useMemo(() => {
    const map = new Map<string, HhTransaction[]>();
    for (const t of filteredTransfers) {
      const k = `${t.from_account_id ?? ""}|${t.to_account_id ?? ""}|${t.amount}|${t.txn_date}`;
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    const list: TransferGroup[] = Array.from(map.entries()).map(([key, items]) => ({
      key,
      items,
      rep: items[0],
      count: items.length,
      from_account_id: items[0].from_account_id,
      to_account_id: items[0].to_account_id,
      amount: items[0].amount,
      txn_date: items[0].txn_date,
    }));
    list.sort((a, b) => (sortKey === "amount" ? b.amount - a.amount || b.txn_date.localeCompare(a.txn_date) : b.txn_date.localeCompare(a.txn_date) || b.amount - a.amount));
    return list;
  }, [filteredTransfers, sortKey]);

  // 합계 — 이동 건수(그룹 수), 이동액 합계(개별 거래 합). 전부 키워드 필터 반영.
  const groupCount = groups.length;
  const totalAmount = useMemo(() => filteredTransfers.reduce((s, t) => s + t.amount, 0), [filteredTransfers]);

  const totalPages = Math.max(1, Math.ceil(groupCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageGroups = groups.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const fromTo = (g: TransferGroup | HhTransaction) => (
    <span className="inline-flex items-center gap-1.5">
      <span>{mask("owner_name", accountName(g.from_account_id))}</span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
      <span>{mask("owner_name", accountName(g.to_account_id))}</span>
    </span>
  );

  return (
    <PageShell>
      <HhPageHeader
        title="통장이동"
        description="내 계좌·가족 계좌 사이의 자금 이동입니다."
        help={
          <>
            통장이동은 자산 총액은 그대로 두고 계좌별 잔액만 바꿉니다(수입·지출에 집계되지 않음).
            같은 날 같은 금액의 출금·입금 문자는 한 이체로 묶어 보여줍니다.
          </>
        }
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" />통장이동 등록</Button>}
      />

      <HhTxnTabs />

      {/* '원거래 건수' 카드는 개발 개념(문자 2건=이체 1건 병합)이라 제거 — 개별 거래는 행의 'N건' 배지로 확인. */}
      <StatsGrid columns={2}>
        <StatCard label="이동 건수" value={`${groupCount}건`} icon={Repeat} />
        <StatCard label="이동액 합계" value={won(totalAmount)} mobileValue={formatAmountInMan(totalAmount)} sensitive="amount" />
      </StatsGrid>

      {/* 조회바 — 다른 조회 화면과 동일한 공통 검색바(기간+키워드, 설계 30). 정렬은 우측 슬롯. */}
      <HhSearchBar
        compact
        range={period}
        onRangeChange={(r) => setPeriod({ start: r.start || period.start, end: r.end || period.end })}
        keyword={keyword}
        onKeywordChange={setKeyword}
        keywordPlaceholder="메모·계좌·금액으로 검색"
        onSearch={() => void fetchData()}
        rightSlot={
          <select
            aria-label="정렬"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="h-9 rounded-lg border border-border/70 bg-background px-2.5 text-base md:text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="date">날짜순</option>
            <option value="amount">금액순</option>
          </select>
        }
      />

      {loading ? (
        <LoadingState label="통장이동 내역을 불러오는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchData()} />
      ) : (
        <div className="space-y-3">
          {/* 건수는 상단 StatCard 한 곳에만(중복 표기 제거). */}
          {/* 데스크톱 표 (DART 스타일) */}
          <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
            {/* ★table-fixed 가 빠져 있어 예전 w-[25%] 는 아예 무시되고 있었다(설계 122 에서 발견). */}
            <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(TRANSFER_COLS) }}>
              <colgroup>
                {colStyles(TRANSFER_COLS).map((st, i) => <col key={i} style={st} />)}
              </colgroup>
              <thead>
                <tr className="border-b-2 border-border bg-muted/50 text-xs font-semibold text-muted-foreground">
                  <th className="px-4 py-2 text-left">날짜</th>
                  <th className="px-4 py-2 text-left">출금 → 입금</th>
                  <th className="px-4 py-2 text-right">금액</th>
                  <th className="px-4 py-2 text-left">메모</th>
                </tr>
              </thead>
              <tbody>
                {pageGroups.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-16 text-center text-sm text-muted-foreground">선택한 기간에 통장이동 내역이 없습니다.</td></tr>
                ) : (
                  pageGroups.map((g) => {
                    const isOpen = expanded.has(g.key);
                    return (
                      <Fragment key={g.key}>
                        <tr
                          onClick={() => openEdit(g.rep)}
                          className="cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/40"
                        >
                          <td className="whitespace-nowrap px-4 py-1 text-muted-foreground">{g.txn_date}</td>
                          <td className="px-4 py-1">{fromTo(g)}</td>
                          <td className="whitespace-nowrap px-4 py-1 text-right">
                            <span className="inline-flex items-center justify-end gap-2">
                              <span className="tabular-nums">{mask("amount", won(g.amount))}</span>
                              {g.count > 1 ? (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); toggleExpand(g.key); }}
                                  className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                                  aria-expanded={isOpen}
                                  title="개별 거래 펼치기"
                                >
                                  {g.count}건
                                  <ChevronDown className={cn("size-3 transition-transform", isOpen && "rotate-180")} />
                                </button>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-4 py-1 text-muted-foreground">{g.rep.memo ?? "-"}</td>
                        </tr>
                        {isOpen && g.count > 1
                          ? g.items.map((it) => (
                              <tr
                                key={it.id}
                                onClick={() => openEdit(it)}
                                className="cursor-pointer border-b border-border/30 bg-muted/20 text-xs transition-colors hover:bg-muted/50"
                              >
                                <td className="whitespace-nowrap px-4 py-2 pl-8 text-muted-foreground">└ {it.txn_date}</td>
                                <td className="px-4 py-2 text-muted-foreground">{fromTo(it)}</td>
                                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground">{mask("amount", won(it.amount))}</td>
                                <td className="px-4 py-2 text-muted-foreground">{it.memo ?? "-"}</td>
                              </tr>
                            ))
                          : null}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="space-y-2 md:hidden">
            {pageGroups.length === 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-16 text-center text-sm text-muted-foreground shadow-sm">선택한 기간에 통장이동 내역이 없습니다.</div>
            ) : (
              pageGroups.map((g) => {
                const isOpen = expanded.has(g.key);
                return (
                  <div key={g.key} className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
                    <div
                      onClick={() => openEdit(g.rep)}
                      className="cursor-pointer space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{g.txn_date}</span>
                        <span className="tabular-nums text-sm font-semibold">{mask("amount", won(g.amount))}</span>
                      </div>
                      <div className="text-sm">{fromTo(g)}</div>
                      {g.rep.memo ? <div className="text-xs text-muted-foreground">{g.rep.memo}</div> : null}
                    </div>
                    {g.count > 1 ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(g.key)}
                        className="mt-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                        aria-expanded={isOpen}
                      >
                        개별 거래 {g.count}건 {isOpen ? "접기" : "보기"}
                        <ChevronDown className={cn("size-3 transition-transform", isOpen && "rotate-180")} />
                      </button>
                    ) : null}
                    {isOpen && g.count > 1 ? (
                      <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2">
                        {g.items.map((it) => (
                          <div
                            key={it.id}
                            onClick={() => openEdit(it)}
                            className="flex cursor-pointer items-center justify-between gap-2 rounded-lg bg-muted/30 px-2 py-1.5 text-xs"
                          >
                            <span className="min-w-0 truncate text-muted-foreground">{it.memo ?? "메모 없음"}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{mask("amount", won(it.amount))}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          {/* 페이지네이션 */}
          {totalPages > 1 ? (
            <div className="flex items-center justify-center gap-3 text-sm">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> 이전
              </button>
              <span className="text-muted-foreground">{safePage + 1} / {totalPages}</span>
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
              >
                다음 <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      )}

      <TransferEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={dialogTarget}
        accounts={accounts}
        onSaved={() => void fetchData()}
      />
    </PageShell>
  );
}
