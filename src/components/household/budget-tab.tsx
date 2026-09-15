"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AmountInput } from "@/components/household/amount-input";
import { HH_COL, HH_TABLE, tableMinWidth, colStyles } from "@/components/household/hh-board";

// 예산 표 열 폭 — 내용별 척도(설계 122). 괄호 안은 실측 필요폭.
const BUDGET_COLS = [
  HH_COL.standard,  // 적요 — 카테고리명 (85.9)
  HH_COL.standard,  // 3개월 전 실적 (87.7)
  HH_COL.standard,  // 2개월 전 실적 (87.7)
  HH_COL.standard,  // 전월 실적 (87.7, 헤더 '7월(전월)' 44.4)
  undefined,        // 예산 — w-full 입력칸이라 가변(표에 가변 열이 최소 1개는 있어야 한다)
];
import { Input } from "@/components/ui/input";
import { useMasking } from "@/components/masking-provider";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { getOwnerUid } from "@/lib/household/owner";
import { shiftMonth, thisMonthKey } from "@/lib/household/month";
import { categorySpending } from "@/lib/household/calc";
import type { HhCategory, HhInstallment, HhTransaction } from "@/lib/household/types";

// 월별·지출카테고리별 예산 입력 (설계: docs/household/19, 38).
// 빈칸/0 = 무예산(초과경고 비대상). 저장 시 upsert + 빈칸은 delete.
// 각 적요(카테고리) 줄에 최근 3개월(전전전월·전전월·전월) 실제 지출을 함께 표시한다. (설계 38)
export function BudgetTab({ categories }: { categories: HhCategory[] }) {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const expenseCats = useMemo(
    () =>
      categories
        .filter((c) => c.kind === "expense" && c.is_active)
        .sort((a, b) => a.sort_order - b.sort_order),
    [categories]
  );

  const [ym, setYm] = useState(thisMonthKey());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // 예산 로드 실패 여부. 실패한 그리드는 전 칸이 빈칸(=무예산)으로 보이는데,
  // 저장은 빈칸을 '삭제 대상'으로 처리하므로 그대로 저장하면 그 달 예산이 통째로 지워진다.
  // 로드가 성공했을 때만 저장을 허용한다.
  const [loadFailed, setLoadFailed] = useState(false);
  // 최근 3개월 카테고리별 실제 지출: recent[delta][categoryId] = 금액 (delta = -1/-2/-3)
  const [recent, setRecent] = useState<Record<number, Map<string, number>>>({});

  const load = useCallback(
    async (targetYm: string) => {
      const { data, error } = await supabase.from("hh_budget").select("category_id, amount").eq("ym", targetYm);
      if (error) {
        // 빈 그리드로 강등하면 안 된다 — 사용자가 '예산을 안 짰다'고 오인해 저장을 누르는 순간
        // 빈칸 전부가 삭제 대상이 되어 그 달 예산이 사라진다.
        console.error("예산 조회 실패:", error);
        toast.error(`예산을 불러오지 못했습니다: ${error.message}`);
        setAmounts({});
        setLoadFailed(true);
        return;
      }
      const map: Record<string, string> = {};
      for (const r of (data ?? []) as { category_id: string; amount: number }[]) map[r.category_id] = String(r.amount);
      setAmounts(map);
      setLoadFailed(false);
    },
    [supabase]
  );

  // 기준월 직전 3개월(전전전월~전월) 지출 거래 + 활성 할부를 읽어 카테고리별 실제 지출을 계산. (설계 38)
  const loadRecent = useCallback(
    async (targetYm: string) => {
      const start = `${shiftMonth(targetYm, -3)}-01`; // 전전전월 1일
      const endExclusive = `${targetYm}-01`; // 기준월 1일(미포함)
      const [txnRes, insRes] = await Promise.all([
        supabase
          .from("hh_transaction")
          .select("type, txn_date, category_id, amount")
          .eq("type", "expense")
          .gte("txn_date", start)
          .lt("txn_date", endExclusive),
        supabase.from("hh_installment").select("*").eq("is_active", true),
      ]);
      const txns = (txnRes.data ?? []) as HhTransaction[];
      const installments = (insRes.data ?? []) as HhInstallment[];
      const next: Record<number, Map<string, number>> = {};
      for (const delta of [-3, -2, -1]) {
        next[delta] = categorySpending(shiftMonth(targetYm, delta), txns, installments);
      }
      setRecent(next);
    },
    [supabase]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ym);
    void loadRecent(ym);
  }, [ym, load, loadRecent]);

  const copyPrev = useCallback(async () => {
    const prev = shiftMonth(ym, -1);
    const { data } = await supabase.from("hh_budget").select("category_id, amount").eq("ym", prev);
    if (!data || data.length === 0) {
      toast.info(`${prev} 예산이 없습니다.`);
      return;
    }
    const map: Record<string, string> = {};
    for (const r of data as { category_id: string; amount: number }[]) map[r.category_id] = String(r.amount);
    setAmounts(map);
    toast.success(`${prev} 예산을 불러왔습니다. '예산 저장'을 눌러 적용하세요.`);
  }, [supabase, ym]);

  const save = useCallback(async () => {
    if (loadFailed) {
      toast.error("예산을 불러오지 못한 상태에서는 저장할 수 없습니다. 월을 다시 선택해 주세요.");
      return;
    }
    setSaving(true);
    const owner = await getOwnerUid(supabase);
    if (!owner) {
      toast.error("로그인이 필요합니다.");
      setSaving(false);
      return;
    }
    const upserts: { owner_auth_uid: string; ym: string; category_id: string; amount: number }[] = [];
    const deletes: string[] = [];
    for (const c of expenseCats) {
      const raw = (amounts[c.id] ?? "").replace(/[,\s]/g, "");
      const n = raw === "" ? null : Number(raw);
      if (n != null && Number.isFinite(n) && n > 0) {
        upserts.push({ owner_auth_uid: owner, ym, category_id: c.id, amount: Math.round(n) });
      } else {
        deletes.push(c.id);
      }
    }
    if (upserts.length) {
      const { error } = await supabase.from("hh_budget").upsert(upserts, { onConflict: "owner_auth_uid,ym,category_id" });
      if (error) {
        toast.error(`저장 실패: ${error.message}`);
        setSaving(false);
        return;
      }
    }
    if (deletes.length) {
      // 무예산(빈칸)으로 바뀐 항목은 해당 월에서 제거
      const { error } = await supabase.from("hh_budget").delete().eq("ym", ym).in("category_id", deletes);
      if (error) {
        toast.error(`저장 실패: ${error.message}`);
        setSaving(false);
        return;
      }
    }
    toast.success(`${ym} 예산을 저장했습니다.`);
    setSaving(false);
  }, [supabase, ym, expenseCats, amounts, loadFailed]);

  // 전월(ym-1) 실제 지출을 예산 입력칸에 일괄 채움. 저장은 '예산 저장'으로. (설계 38)
  const fillFromLastMonth = useCallback(() => {
    const prevMap = recent[-1];
    if (!prevMap || prevMap.size === 0) {
      toast.info(`${shiftMonth(ym, -1)} 실제 지출이 없습니다.`);
      return;
    }
    setAmounts((p) => {
      const next = { ...p };
      for (const c of expenseCats) {
        const spent = prevMap.get(c.id) ?? 0;
        if (spent > 0) next[c.id] = String(Math.round(spent));
      }
      return next;
    });
    toast.success(`${shiftMonth(ym, -1)} 실제 지출로 채웠습니다. '예산 저장'을 눌러 적용하세요.`);
  }, [recent, ym, expenseCats]);

  // 표시용 월 라벨(MM월) — 전전전월/전전월/전월
  const monthLabel = (delta: number) => `${Number(shiftMonth(ym, delta).slice(5, 7))}월`;
  const recentCell = (categoryId: string, delta: number) => {
    const v = recent[delta]?.get(categoryId) ?? 0;
    return mask("expense_amount", v.toLocaleString("ko-KR"));
  };

  const total = expenseCats.reduce((s, c) => s + (Number((amounts[c.id] ?? "").replace(/[,\s]/g, "")) || 0), 0);
  // 월별 실제 지출 합계(표 하단 합계 행용)
  const monthTotal = (delta: number) =>
    expenseCats.reduce((s, c) => s + (recent[delta]?.get(c.id) ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="month"
          value={ym}
          onChange={(e) => setYm(e.target.value)}
          className="h-9 w-40 text-base md:text-sm"
          aria-label="예산 월"
        />
        <Button variant="outline" size="sm" onClick={() => void copyPrev()}>
          지난달 예산 복사
        </Button>
        <Button variant="outline" size="sm" onClick={fillFromLastMonth}>
          전월 실적으로 채우기
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          월 예산 합계 <b className="tabular-nums text-foreground">{mask("expense_amount", `${total.toLocaleString("ko-KR")}원`)}</b>
        </span>
      </div>

      {expenseCats.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
          지출 카테고리가 없습니다. 먼저 카테고리 탭에서 기본값을 생성하세요.
        </p>
      ) : (
        // 공통 게시판 룩(HH_TABLE)을 그대로 쓴다 — 예전엔 스타일을 복붙해 행높이가 갈라졌었다. (설계 38 / 80)
        <div className={HH_TABLE.shell}>
          {/* 열 폭 = 내용별(설계 122). '예산'은 w-full 입력칸이라 가변으로 두고,
              적요·월별 실적은 척도 고정. (예전 5열 20% 균등은 폐기 — 153.7px 씩 공백이 남았다) */}
          <table className={HH_TABLE.table} style={{ width: tableMinWidth(BUDGET_COLS) }}>
            <colgroup>
              {colStyles(BUDGET_COLS).map((st, i) => <col key={i} style={st} />)}
            </colgroup>
            <thead>
              <tr className={HH_TABLE.headRow}>
                {/* 전 컬럼 동일 폭(20%×5) — CLAUDE.md 표 컬럼 간격 규칙(팀장 요청 2026-07-18). */}
                <th className={cn(HH_TABLE.th, "text-left")}>적요</th>
                <th className={cn(HH_TABLE.th, "text-right")}>{monthLabel(-3)}</th>
                <th className={cn(HH_TABLE.th, "text-right")}>{monthLabel(-2)}</th>
                <th className={cn(HH_TABLE.th, "text-right")}>{monthLabel(-1)}(전월)</th>
                <th className={cn(HH_TABLE.th, "text-right")}>예산</th>
              </tr>
            </thead>
            <tbody>
              {expenseCats.map((c) => (
                <tr key={c.id} className={cn(HH_TABLE.row, "hover:bg-muted/40")}>
                  <td className={HH_TABLE.td}>{c.name}</td>
                  <td className={cn(HH_TABLE.td, "text-right tabular-nums text-muted-foreground")}>{recentCell(c.id, -3)}</td>
                  <td className={cn(HH_TABLE.td, "text-right tabular-nums text-muted-foreground")}>{recentCell(c.id, -2)}</td>
                  <td className={cn(HH_TABLE.td, "text-right tabular-nums text-foreground/80")}>{recentCell(c.id, -1)}</td>
                  <td className={cn(HH_TABLE.td, "text-right")}>
                    <AmountInput
                      value={amounts[c.id] ? Number(amounts[c.id]) || 0 : 0}
                      placeholder="무예산"
                      onValueChange={(n) => setAmounts((p) => ({ ...p, [c.id]: n === 0 ? "" : String(n) }))}
                      // w-full — 셀 안 입력칸은 열 폭을 꽉 채운다(w-28 이면 옆 열과 좌우 여백이 어긋난다).
                      className="h-9 w-full text-right text-base md:text-sm"
                      aria-label={`${c.name} 예산`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-border bg-muted/50 font-medium">
              <tr>
                <td className={HH_TABLE.td}>합계</td>
                <td className={cn(HH_TABLE.td, "text-right tabular-nums text-muted-foreground")}>{mask("expense_amount", monthTotal(-3).toLocaleString("ko-KR"))}</td>
                <td className={cn(HH_TABLE.td, "text-right tabular-nums text-muted-foreground")}>{mask("expense_amount", monthTotal(-2).toLocaleString("ko-KR"))}</td>
                <td className={cn(HH_TABLE.td, "text-right tabular-nums text-foreground/80")}>{mask("expense_amount", monthTotal(-1).toLocaleString("ko-KR"))}</td>
                <td className={cn(HH_TABLE.td, "text-right tabular-nums")}>{mask("expense_amount", total.toLocaleString("ko-KR"))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} disabled={saving || loadFailed}>
          {saving ? "저장 중..." : "예산 저장"}
        </Button>
        <span className={cn("text-xs", loadFailed ? "text-destructive" : "text-muted-foreground")}>
          {loadFailed
            ? "예산을 불러오지 못했습니다. 저장하면 기존 예산이 지워질 수 있어 저장을 막았습니다 — 월을 다시 선택해 주세요."
            : "빈칸은 예산 없음(초과 경고 제외)으로 저장됩니다."}
        </span>
      </div>
    </div>
  );
}
