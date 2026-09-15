"use client";

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Landmark, RotateCcw, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ErrorState, LoadingState, PageShell, StatCard, StatsGrid } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HH_COL, HH_CELL, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { Button } from "@/components/ui/button";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { cn, formatAmountInMan } from "@/lib/utils";
import { rangeOfMonth, shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhAccount, HhCategory, HhTransaction } from "@/lib/household/types";

const LS_ACCOUNT = "hh_passbook_account";
const PAGE_SIZE = 20;

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

// 문자 원문 찌꺼기 정리 — 파서가 잘못 뽑은 상대처를 표시 단계에서 다듬는다(비파괴적).
function cleanPart(s: string): string {
  let out = s.replace(/^내\s+.*?통장\s*→\s*/, ""); // "내 ○○통장 → " 접두어(토스)
  // 전각 영숫자·기호 → 반각 (２６０６→2606, ＬＧＵ＋→LGU+), 전각 공백 정리
  out = out.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
  out = out.replace(/카드\s+카드/g, "카드"); // "KB카드 카드" → "KB카드"
  out = out.replace(/[([{\s]+$/g, ""); // 끝에 매달린 여는 괄호 제거 "KB카드 (" → "KB카드"
  out = out.replace(/(\S+)\s+\1(?=\s|$)/g, "$1"); // 인접 중복 단어 축약
  return out.trim();
}

// 내역 조각 중복 제거 — 상대처=메모가 같아 같은 말이 두 번 나오거나(예: "당가원 · 외식비 · 당가원"),
// 한 조각이 다른 조각에 포함되면(예: "이자" ⊂ "토스이자") 더 긴(정보 많은) 쪽만 남긴다.
function conciseParts(parts: (string | null | undefined)[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const kept: string[] = [];
  for (const raw of parts) {
    const p = cleanPart((raw ?? "").trim());
    if (!p) continue;
    const np = norm(p);
    let handled = false;
    for (let i = 0; i < kept.length; i++) {
      const nk = norm(kept[i]);
      if (nk === np || nk.includes(np)) { handled = true; break; } // 새 조각이 기존에 포함 → 버림
      if (np.includes(nk)) { kept[i] = p; handled = true; break; } // 새 조각이 더 길다 → 교체
    }
    if (!handled) kept.push(p);
  }
  return kept;
}

// 한 계좌 관점의 거래 한 줄. delta = 이 계좌 기준 증감(+입금 / −출금).
interface LedgerRow {
  txn: HhTransaction;
  delta: number;
  flow: "in" | "out";
  kind: "income" | "expense" | "transfer_in" | "transfer_out" | "payment";
  balanceAfter: number; // 이 거래 반영 후 잔액(누적)
}

const KIND_LABEL: Record<LedgerRow["kind"], string> = {
  income: "입금",
  expense: "출금",
  transfer_in: "이체입금",
  transfer_out: "이체출금",
  payment: "납부",
};

const KIND_BADGE: Record<LedgerRow["kind"], string> = {
  income: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  expense: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  transfer_in: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  transfer_out: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
  payment: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
};

// hh_account_balance 뷰와 동일한 규칙으로 이 계좌 기준 증감을 구한다. 영향 없으면 null.
function ledgerDelta(t: HhTransaction, accId: string): { delta: number; flow: "in" | "out"; kind: LedgerRow["kind"] } | null {
  if (t.type === "income" && t.account_id === accId) return { delta: t.amount, flow: "in", kind: "income" };
  if (t.type === "transfer" && t.to_account_id === accId) return { delta: t.amount, flow: "in", kind: "transfer_in" };
  if (t.type === "transfer" && t.from_account_id === accId) return { delta: -t.amount, flow: "out", kind: "transfer_out" };
  if (t.type === "payment" && t.from_account_id === accId) return { delta: -t.amount, flow: "out", kind: "payment" };
  if (t.type === "expense" && t.account_id === accId) return { delta: -t.amount, flow: "out", kind: "expense" };
  return null;
}

// 첫 화면 조회 기간 = 당월(이번 달 1일 ~ 말일).
function thisMonthRange() {
  return rangeOfMonth(thisMonthKey());
}
// 지난 달 1일 ~ 말일 (다른 조회 화면의 빠른버튼과 통일).
function lastMonthRange() {
  return rangeOfMonth(shiftMonth(thisMonthKey(), -1));
}
// 최근 3개월(이번달 포함) 1일 ~ 이번달 말일.
function recent3Range() {
  return { start: rangeOfMonth(shiftMonth(thisMonthKey(), -2)).start, end: rangeOfMonth(thisMonthKey()).end };
}
const ALL_RANGE = { start: "1900-01-01", end: "2999-12-31" };

// 통장 거래내역 열 폭 — 내용별 척도(설계 122). 실측 필요폭을 주석에 남긴다.
const PASSBOOK_COLS = [
  HH_COL.standard,  // 날짜 `2026-08-01` (95.8)
  HH_COL.short,     // 유형 — 배지 (64.5)
  // 내역 — '씨유(CU)옥길헤일라움점 · 생필품' 이 160 에서 꺾여 xxwide(208)로 올렸는데(설계 125),
  // 208 에서도 '배스킨라빈스부천옥길트레이더스 · …'(221)가 꺾였다(실측 2026-08-09).
  // 표 합계 696 → 760 으로 여유가 크다(상한 1200).
  HH_COL.x4wide,
  HH_COL.short,     // 입금 (49.5)
  HH_COL.short,     // 출금 (72.9)
  HH_COL.standard,  // 거래후 잔액 (82.1, 헤더 51.2)
];

export default function HouseholdPassbookPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 선택 목록에만 적용, 현재 고른 계좌는 항상 남긴다.
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [txns, setTxns] = useState<HhTransaction[]>([]);
  const [range, setRange] = useState(thisMonthRange);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  // 거래 조회 요청 번호 — 계좌 전환 시 이전 계좌의 늦은 응답을 버리는 데 쓴다(fetchTxns 주석 참고).
  const reqRef = useRef(0);

  const accountName = useCallback((id: string | null) => accounts.find((a) => a.id === id)?.name ?? "-", [accounts]);
  const categoryName = useCallback((id: string | null) => categories.find((c) => c.id === id)?.name ?? "", [categories]);
  const account = accounts.find((a) => a.id === accountId) ?? null;

  // 계좌·카테고리 마스터 로드(1회) + 저장된 선택 복원.
  const loadMasters = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();
    const [accRes, catRes] = await Promise.all([
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase.from("hh_category").select("*"),
    ]);
    if (accRes.error) {
      toast.error("계좌를 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }
    const accs = (accRes.data ?? []) as HhAccount[];
    // 정렬용 계좌별 거래 건수(account_id/from/to 어디든 등장하면 카운트).
    const counts = await Promise.all(
      accs.map(async (a) => {
        const { count } = await supabase
          .from("hh_transaction")
          .select("id", { count: "exact", head: true })
          .or(`account_id.eq.${a.id},from_account_id.eq.${a.id},to_account_id.eq.${a.id}`);
        return [a.id, count ?? 0] as const;
      }),
    );
    const countMap = new Map(counts);
    // 활성 먼저(비활성은 맨 아래) → 거래 많은 순 → sort_order/이름.
    const sorted = [...accs].sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      const diff = (countMap.get(b.id) ?? 0) - (countMap.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
    });
    setAccounts(sorted);
    setCategories((catRes.data ?? []) as HhCategory[]);
    const saved = typeof window !== "undefined" ? localStorage.getItem(LS_ACCOUNT) : null;
    const pick = sorted.find((a) => a.id === saved) ?? sorted.find((a) => a.is_active) ?? sorted[0];
    setAccountId(pick?.id ?? "");
    if (!pick) setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMasters();
  }, [loadMasters]);

  // 선택 계좌가 관련된 거래 전체 로드(잔액 누적은 기간과 무관하게 전 기간 기준이어야 정확).
  // ⚠️ PostgREST 기본 한도가 1000행이라, 거래가 많은 계좌(8년 재적재)는 페이지네이션으로 전량 가져와야
  //    누적 잔액이 정확하다. 안전상 최대 5만행까지만 읽는다.
  const fetchTxns = useCallback(async () => {
    if (!accountId) return;
    // ★계좌를 바꾸면 이전 계좌의 조회가 아직 끝나지 않았을 수 있다. 최대 50회 순차 요청이라
    //   그 창이 넓다. 늦게 도착한 이전 응답이 새 계좌의 결과를 덮어쓰면, 아래 누적 잔액이
    //   '이전 계좌의 거래'를 '새 계좌의 개설잔액'에 쌓아 틀린 잔액을 확신에 차서 표시한다.
    //   요청마다 번호를 붙여, 최신 요청이 아니면 결과를 통째로 버린다.
    const reqId = ++reqRef.current;
    const isStale = () => reqRef.current !== reqId;
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();
    const CHUNK = 1000;
    const MAX = 50000;
    const acc: HhTransaction[] = [];
    for (let from = 0; from < MAX; from += CHUNK) {
      const { data, error: err } = await supabase
        .from("hh_transaction")
        .select("*")
        .or(`account_id.eq.${accountId},from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
        .order("txn_date", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + CHUNK - 1);
      // 이미 다른 계좌 조회가 시작됐으면 이 결과는 쓰지 않는다(에러도 그 계좌의 것이 아니다).
      if (isStale()) return;
      if (err) {
        toast.error("거래내역을 불러오지 못했습니다.");
        setError(true);
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as HhTransaction[];
      acc.push(...rows);
      if (rows.length < CHUNK) break;
    }
    if (isStale()) return; // 최신 요청이 loading 을 책임진다 — 여기서 끄면 안 된다.
    setTxns(acc);
    setPage(0);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTxns();
  }, [fetchTxns]);

  const changeAccount = (id: string) => {
    setAccountId(id);
    if (typeof window !== "undefined") localStorage.setItem(LS_ACCOUNT, id);
  };

  // 전 기간 누적 잔액을 계산한 뒤(오름차순), 표시는 최신순으로 뒤집는다.
  const allRows = useMemo<LedgerRow[]>(() => {
    if (!account) return [];
    let bal = account.opening_balance;
    const rows: LedgerRow[] = [];
    for (const t of txns) {
      const d = ledgerDelta(t, account.id);
      if (!d) continue; // 이 계좌에 영향 없는 거래(할부 등)는 제외
      bal += d.delta;
      rows.push({ txn: t, delta: d.delta, flow: d.flow, kind: d.kind, balanceAfter: bal });
    }
    return rows;
  }, [txns, account]);

  const currentBalance = allRows.length ? allRows[allRows.length - 1].balanceAfter : (account?.opening_balance ?? 0);

  // 기간 필터(표시용). 누적 잔액은 이미 계산돼 있으므로 필터는 표시에만 적용.
  const windowRows = useMemo(
    () => allRows.filter((r) => r.txn.txn_date >= range.start && r.txn.txn_date <= range.end).reverse(),
    [allRows, range.start, range.end],
  );

  const periodIn = windowRows.filter((r) => r.flow === "in").reduce((s, r) => s + r.delta, 0);
  const periodOut = windowRows.filter((r) => r.flow === "out").reduce((s, r) => s - r.delta, 0);

  const totalPages = Math.max(1, Math.ceil(windowRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = windowRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // 거래 내역 설명(상대처/상대계좌/카테고리/메모).
  const describe = useCallback(
    (r: LedgerRow): string => {
      const t = r.txn;
      if (r.kind === "transfer_out" || r.kind === "transfer_in") {
        const other = r.kind === "transfer_out" ? accountName(t.to_account_id) : accountName(t.from_account_id);
        const arrow = `${r.kind === "transfer_out" ? "→" : "←"} ${other}`;
        return conciseParts([arrow, t.memo, t.counterparty]).join(" · ");
      }
      const parts = conciseParts([t.counterparty, categoryName(t.category_id), t.memo]);
      return parts.length ? parts.join(" · ") : KIND_LABEL[r.kind];
    },
    [accountName, categoryName],
  );

  return (
    <PageShell>
      <HhPageHeader
        title="통장내역"
        description="계좌별 입금·출금·이체를 날짜순으로 봅니다."
        help={
          <>
            계좌를 고르면 그 통장의 입금·출금·이체를 날짜순으로 보여주고, 각 거래 뒤의 잔액(거래후 잔액)을 함께 표시합니다.
            잔액은 기초잔액에서 전 기간 거래를 누적한 값입니다.
          </>
        }
      />

      <StatsGrid columns={4}>
        <StatCard label="현재 잔액" value={won(currentBalance)} mobileValue={formatAmountInMan(currentBalance)} tone={currentBalance < 0 ? "danger" : "default"} sensitive="amount" icon={Wallet} />
        <StatCard label="기간 입금" value={won(periodIn)} mobileValue={formatAmountInMan(periodIn)} tone="positive" sensitive="amount" icon={ArrowDownLeft} />
        <StatCard label="기간 출금" value={won(periodOut)} mobileValue={formatAmountInMan(periodOut)} tone="default" sensitive="amount" icon={ArrowUpRight} />
        <StatCard label="기간 순증감" value={won(periodIn - periodOut)} mobileValue={formatAmountInMan(periodIn - periodOut)} tone={periodIn - periodOut < 0 ? "danger" : "positive"} sensitive="amount" />
      </StatsGrid>

      {/* 조회바 — 계좌 선택 + 기간 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border/70 bg-card/85 px-4 py-3 text-sm shadow-sm">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" />
          <select
            aria-label="계좌 선택"
            value={accountId}
            onChange={(e) => changeAccount(e.target.value)}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-base font-medium md:text-sm"
          >
            {pickVisibleAccounts(accounts, hideInactiveAccounts, [accountId]).map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.is_active ? "" : " (비활성)"}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">기간</span>
          <input type="date" aria-label="시작일" value={range.start} max={range.end} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value || r.start }))} className="rounded-md border border-border/60 bg-background px-2 py-1 text-base md:text-sm" />
          <span className="text-muted-foreground">~</span>
          <input type="date" aria-label="종료일" value={range.end} min={range.start} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value || r.end }))} className="rounded-md border border-border/60 bg-background px-2 py-1 text-base md:text-sm" />
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setRange(thisMonthRange())}>이번 달</Button>
          <Button variant="outline" size="sm" onClick={() => setRange(lastMonthRange())}>지난 달</Button>
          <Button variant="outline" size="sm" onClick={() => setRange(recent3Range())}>최근 3개월</Button>
          <Button variant="outline" size="sm" onClick={() => setRange(ALL_RANGE)}>전체</Button>
          <Button variant="ghost" size="sm" onClick={() => setRange(thisMonthRange())}><RotateCcw className="h-4 w-4" />초기화</Button>
        </div>
      </div>

      {loading ? (
        <LoadingState label="통장내역을 불러오는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchTxns()} />
      ) : accounts.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-16 text-center text-sm text-muted-foreground shadow-sm">등록된 계좌가 없습니다. 설정에서 계좌를 먼저 만들어 주세요.</div>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{account ? mask("owner_name", account.name) : "-"}</span> · 기간 내 <span className="font-semibold text-foreground">{windowRows.length}</span>건
          </div>

          {/* 데스크톱 표 */}
          <div className="hidden w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm md:block">
            <table className="table-fixed text-[0.8rem]" style={{ width: tableMinWidth(PASSBOOK_COLS) }}>
              {/* 열 폭 = 내용별(설계 122). 정의는 PASSBOOK_COLS 한 곳에만 둔다.
                  예전 6열 16.67% 균등은 폐기 — 입금 열에만 150.2px 공백이 남았다(실측). */}
              <colgroup>
                {colStyles(PASSBOOK_COLS).map((st, i) => <col key={i} style={st} />)}
              </colgroup>
              <thead>
                <tr className="border-b-2 border-border bg-muted/50 text-xs font-semibold text-muted-foreground">
                  <th className="px-4 py-2 text-left">날짜</th>
                  <th className="px-4 py-2 text-left">유형</th>
                  <th className="px-4 py-2 text-left">내역</th>
                  <th className="px-4 py-2 text-right">입금</th>
                  <th className="px-4 py-2 text-right">출금</th>
                  <th className="px-4 py-2 text-right">거래후 잔액</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">선택한 기간에 거래가 없습니다.</td></tr>
                ) : (
                  pageRows.map((r) => (
                    <tr key={r.txn.id} className="border-b border-border/40">
                      <td className="whitespace-nowrap px-4 py-1 text-muted-foreground">{r.txn.txn_date}</td>
                      <td className="px-4 py-1"><span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", KIND_BADGE[r.kind])}>{KIND_LABEL[r.kind]}</span></td>
                      <td className={`${HH_CELL.wrapText} px-4 py-1`} title={describe(r)}>{mask("owner_name", describe(r))}</td>
                      <td className="whitespace-nowrap px-4 py-1 text-right tabular-nums text-blue-600 dark:text-blue-400">{r.flow === "in" ? mask("amount", won(r.delta)) : ""}</td>
                      <td className="whitespace-nowrap px-4 py-1 text-right tabular-nums text-foreground">{r.flow === "out" ? mask("amount", won(-r.delta)) : ""}</td>
                      <td className={cn("whitespace-nowrap px-4 py-1 text-right tabular-nums font-semibold", r.balanceAfter < 0 && "text-rose-600 dark:text-rose-400")}>{mask("amount", won(r.balanceAfter))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="space-y-2 md:hidden">
            {pageRows.length === 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-16 text-center text-sm text-muted-foreground shadow-sm">선택한 기간에 거래가 없습니다.</div>
            ) : (
              pageRows.map((r) => (
                <div key={r.txn.id} className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{r.txn.txn_date}</span>
                    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", KIND_BADGE[r.kind])}>{KIND_LABEL[r.kind]}</span>
                  </div>
                  <div className="mt-1 text-sm">{mask("owner_name", describe(r))}</div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className={cn("tabular-nums text-sm font-semibold", r.flow === "in" ? "text-blue-600 dark:text-blue-400" : "text-foreground")}>
                      {r.flow === "in" ? "+" : "−"}{mask("amount", won(Math.abs(r.delta)))}
                    </span>
                    <span className={cn("tabular-nums text-xs text-muted-foreground", r.balanceAfter < 0 && "text-rose-600 dark:text-rose-400")}>잔액 {mask("amount", won(r.balanceAfter))}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 페이지네이션 */}
          {totalPages > 1 ? (
            <div className="flex items-center justify-center gap-3 text-sm">
              <button type="button" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40">
                <ChevronLeft className="h-4 w-4" /> 이전
              </button>
              <span className="text-muted-foreground">{safePage + 1} / {totalPages}</span>
              <button type="button" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40">
                다음 <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
