"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AmountInput } from "@/components/household/amount-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import { getOwnerUid } from "@/lib/household/owner";
import type { HhAccount, HhCategory, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const emptyForm = () => ({
  txn_date: todayLocal(),
  category_id: "",
  account_id: "",
  amount: 0,
  counterparty: "",
  memo: "",
});

// 수입 등록·수정 팝업 (설계 82). target=null 이면 등록, 있으면 그 거래를 수정·삭제.
export function IncomeEditDialog({
  open,
  onOpenChange,
  target,
  categories,
  accounts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhTransaction | null;
  categories: HhCategory[];
  accounts: HhAccount[];
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const editing = !!target;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    if (!open) return;
    setForm(
      target
        ? {
            txn_date: target.txn_date,
            category_id: target.category_id ?? "",
            account_id: target.account_id ?? "",
            amount: target.amount,
            counterparty: target.counterparty ?? "",
            memo: target.memo ?? "",
          }
        : emptyForm()
    );
  }, [open, target]);

  // 등록은 활성 마스터만, 수정은 전부. (설계 82 §B)
  const catOptions = editing ? categories : categories.filter((c) => c.is_active);
  const accOptions = editing ? accounts : accounts.filter((a) => a.is_active);
  const noMaster = catOptions.length === 0 || accOptions.length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.category_id) return toast.error("항목(카테고리)을 선택해주세요.");
    if (!form.account_id) return toast.error("입금계좌를 선택해주세요.");
    if (form.amount <= 0) return toast.error("금액은 1원 이상이어야 합니다.");

    setSaving(true);
    const payload = {
      txn_date: form.txn_date,
      type: "income" as const,
      amount: form.amount,
      category_id: form.category_id,
      account_id: form.account_id,
      counterparty: form.counterparty || null,
      memo: form.memo || null,
    };
    try {
      if (target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        sendLog("UPDATE_HH_INCOME", `수입 수정: ${form.amount}원`, { resource: "hh_transaction", resource_id: target.id });
        toast.success("수정되었습니다.");
      } else {
        const owner = await getOwnerUid(supabase);
        if (!owner) return toast.error("로그인 정보를 확인할 수 없습니다.");
        const { data: ins, error: err } = await supabase
          .from("hh_transaction")
          .insert({ ...payload, owner_auth_uid: owner, source: "manual" })
          .select("id")
          .single();
        if (err) return toast.error(`등록 실패: ${err.message}`);
        sendLog("CREATE_HH_INCOME", `수입 등록: ${form.amount}원`, { resource: "hh_transaction", resource_id: ins.id });
        toast.success("수입이 등록되었습니다.");
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    if (!window.confirm(`${target.txn_date} · ${target.amount.toLocaleString("ko-KR")}원 수입을 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const { error: err } = await supabase.from("hh_transaction").delete().eq("id", target.id);
      if (err) return toast.error(`삭제 실패: ${err.message}`);
      sendLog("DELETE_HH_INCOME", `수입 삭제: ${target.amount}원`, { resource: "hh_transaction", resource_id: target.id });
      toast.success("삭제되었습니다.");
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "수입 수정" : "수입 등록"}</DialogTitle>
        </DialogHeader>
        {noMaster ? (
          <p className="py-4 text-sm text-muted-foreground">
            수입을 등록하려면 먼저 <b>수입 카테고리</b>와 <b>계좌</b>가 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ind-date">날짜 *</Label>
                <Input id="ind-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ind-amount">금액 (원) *</Label>
                <AmountInput id="ind-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} allowFormula placeholder="예: 3,000,000 또는 =3+5+70" required />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ind-category">항목 *</Label>
                <select id="ind-category" className={selectClass} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                  <option value="">선택</option>
                  {catOptions.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ind-account">입금계좌 *</Label>
                <select id="ind-account" className={selectClass} value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {accOptions.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ind-counterparty">입금처</Label>
              <Input id="ind-counterparty" value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder="예: ○○회사 급여" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ind-memo">메모</Label>
              <Input id="ind-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="상세 내역" />
            </div>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {editing ? (
                <Button type="button" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={remove} disabled={saving}>삭제</Button>
              ) : (
                <Button type="button" variant="ghost" asChild>
                  <Link href="/dashboard/household/income/new">여러 건 입력 (엑셀)</Link>
                </Button>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
                <Button type="submit" disabled={saving}>{saving ? "저장 중..." : editing ? "수정" : "등록"}</Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
