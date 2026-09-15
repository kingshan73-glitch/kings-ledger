"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoanFormFields } from "@/components/household/loan-form-fields";
import { createClient } from "@/lib/supabase/client";
import { loanFormFrom, loanFormWarnings, saveLoan, validateLoanForm, type LoanFormState } from "@/lib/household/loan-save";
import type { HhAccount, HhLoan } from "@/lib/household/types";

type PayRow = { id: string; txn_date: string; amount: number; counterparty: string | null; memo: string | null };

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

// 대출 등록·수정 팝업 (설계 82 List→Popup, 설계 96).
// target=null 이면 등록, 있으면 수정. 계좌는 목록이 이미 조회한 것을 props 로 받는다(재조회 금지).
export function LoanDialog({
  target,
  accounts,
  open,
  onOpenChange,
  onSaved,
  preset = null,
}: {
  target: HhLoan | null;
  accounts: HhAccount[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** 등록 모드 프리필(설계 182 — 수집함 카드론 행에서 연다). 수정 모드에서는 무시한다. */
  preset?: Partial<LoanFormState> | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const editing = !!target;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<LoanFormState>(() => loanFormFrom(null));
  const [history, setHistory] = useState<PayRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  // ★의존성에 open 이 있어야 한다. [target] 만 보면, 같은 대출을 열어 금액을 고치고 '취소'한 뒤
  //   다시 열 때 부모가 동일 객체를 그대로 넘기므로 effect 가 안 돌고 버린 값이 남는다.
  //   그대로 저장하면 취소했던 금액이 DB 에 들어간다.
  // ★target 이 null 인 등록 모드에서도 반드시 리셋해야 한다(설계 96 (가)) —
  //   빠뜨리면 직전에 수정하던 대출 금액이 등록 폼에 남아 엉뚱한 대출이 생긴다.
  // ★preset 은 등록 모드(target=null)에서만 덮는다 — 수정 모드에서 덮으면 남의 값이 들어간다(설계 182).
  useEffect(() => {
    if (!open) return;
    setForm({ ...loanFormFrom(target), ...(target ? {} : preset ?? {}) });
  }, [open, target, preset]);

  // 상환 내역(추정) — 대출↔거래 DB 연결이 없어(설계 74) payment 거래를 금액(=월납입금) 또는
  // 대출명으로 매칭해 전 기간에서 모은다. 날짜 오름차순 + 누적 합계 표시.
  // 이건 마스터가 아니라 열린 대출 1건에 종속된 상세 데이터라 재조회 금지 대상이 아니다(설계 96 (나)).
  useEffect(() => {
    if (!open || !target) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setHistLoading(true);
      const nm = target.name.trim();
      const nameSafe = nm.length > 0 && /^[0-9A-Za-z가-힣 _-]+$/.test(nm); // or() 파서 안전한 이름만 사용
      const cols = "id,txn_date,amount,counterparty,memo";
      const queries = [];
      if (target.monthly_payment) {
        queries.push(supabase.from("hh_transaction").select(cols).eq("type", "payment").eq("amount", target.monthly_payment));
      }
      if (nameSafe) {
        queries.push(supabase.from("hh_transaction").select(cols).eq("type", "payment").or(`counterparty.ilike.*${nm}*,memo.ilike.*${nm}*`));
      }
      const results = queries.length ? await Promise.all(queries) : [];
      if (cancelled) return;
      const map = new Map<string, PayRow>();
      for (const r of results) for (const row of (r.data ?? []) as PayRow[]) map.set(row.id, row);
      const list = [...map.values()].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
      setHistory(list);
      setHistLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, target, supabase]);

  const historyTotal = history.reduce((s, r) => s + r.amount, 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 무효 폼이면 경고 confirm 을 띄우지 않는다 — saveLoan 의 검증 메시지가 먼저다.
    const warns = validateLoanForm(form) ? [] : loanFormWarnings(form);
    if (warns.length && !window.confirm(warns.join("\n") + "\n\n그대로 저장할까요?")) return;
    setSaving(true);
    try {
      const result = await saveLoan(supabase, form, target);
      if (!result.ok) return toast.error(result.message);
      toast.success(editing ? "수정되었습니다." : "대출이 등록되었습니다.");
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    if (!window.confirm(`"${target.name}" 대출을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setSaving(true);
    try {
      const { error: err } = await supabase.from("hh_loan").delete().eq("id", target.id);
      if (err) return toast.error(`삭제 실패: ${err.message}`);
      toast.success("삭제되었습니다.");
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "대출 상세 · 수정" : "대출 등록"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <LoanFormFields form={form} setForm={setForm} accounts={accounts} idPrefix="led" />
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {editing ? (
              <Button type="button" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={remove} disabled={saving}>삭제</Button>
            ) : (
              <span />
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
              <Button type="submit" disabled={saving}>{saving ? "저장 중..." : editing ? "저장" : "등록"}</Button>
            </div>
          </DialogFooter>
        </form>

        {/* 상환 내역(누적) — 추정 매칭. 등록 모드에는 없다(아직 대출이 없으므로). */}
        {editing ? (
          <div className="mt-1 border-t border-border/60 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-foreground">상환 내역 <span className="text-xs font-normal text-muted-foreground">(추정)</span></h4>
              <span className="text-sm">
                누적 <span className="tabular-nums font-semibold text-emerald-600">{won(historyTotal)}</span>
                <span className="ml-1 text-xs text-muted-foreground">· {history.length}건</span>
              </span>
            </div>
            {histLoading ? (
              <p className="py-4 text-center text-xs text-muted-foreground">불러오는 중...</p>
            ) : history.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">매칭된 상환 거래가 없습니다.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border/50">
                <table className="w-full table-fixed text-xs">
                  <colgroup>
                    <col className="w-[110px]" />
                    <col />
                    <col className="w-[120px]" />
                  </colgroup>
                  <thead className="sticky top-0 bg-muted/70 text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">날짜</th>
                      <th className="px-3 py-1.5 text-right font-medium">상환액</th>
                      <th className="px-3 py-1.5 text-right font-medium">누적</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let run = 0;
                      return history.map((r) => {
                        run += r.amount;
                        return (
                          <tr key={r.id} className="border-t border-border/40">
                            <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{r.txn_date}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{won(r.amount)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{won(run)}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">대출↔거래 연결이 없어 금액·대출명으로 추정 매칭한 내역입니다(실제와 다를 수 있음).</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
