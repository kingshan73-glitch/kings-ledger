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
import { incentiveFor, syncChargeIncentive } from "@/lib/household/sync-incentive";
import type { HhAccount, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const emptyForm = () => ({
  txn_date: todayLocal(),
  from_account_id: "",
  to_account_id: "",
  amount: 0,
  memo: "",
});

// 통장이동 등록·수정 팝업 (설계 82). target=null 이면 등록, 있으면 그 이체를 수정·삭제.
export function TransferEditDialog({
  open,
  onOpenChange,
  target,
  accounts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhTransaction | null;
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
            from_account_id: target.from_account_id ?? "",
            to_account_id: target.to_account_id ?? "",
            amount: target.amount,
            memo: target.memo ?? "",
          }
        : emptyForm()
    );
  }, [open, target]);

  // 등록은 활성 계좌만, 수정은 전부. (설계 82 §B)
  const accOptions = editing ? accounts : accounts.filter((a) => a.is_active);
  const noAccounts = accOptions.length < 2;

  // 충전 인센티브 (설계 84): 입금계좌가 지역화폐면 충전액의 10%가 얹힌다.
  // 이체는 금액이 하나라 110,000을 한 건으로 못 넣으므로 '이체 + 인센티브 수입' 2건으로 기록한다.
  const { rule: incentiveRule, incentive, show: showIncentive } = incentiveFor(accounts, form.to_account_id, form.amount);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.from_account_id) return toast.error("출금계좌를 선택해주세요.");
    if (!form.to_account_id) return toast.error("입금계좌를 선택해주세요.");
    if (form.from_account_id === form.to_account_id) return toast.error("출금/입금 계좌가 같을 수 없습니다.");
    if (form.amount <= 0) return toast.error("금액은 1원 이상이어야 합니다.");

    setSaving(true);
    const payload = {
      txn_date: form.txn_date,
      type: "transfer" as const,
      amount: form.amount,
      from_account_id: form.from_account_id,
      to_account_id: form.to_account_id,
      memo: form.memo || null,
    };
    try {
      const owner = await getOwnerUid(supabase);
      if (!owner) return toast.error("로그인 정보를 확인할 수 없습니다.");

      const sync = (txnId: string) =>
        syncChargeIncentive(supabase, {
          txnId,
          owner,
          accounts,
          txnDate: form.txn_date,
          amount: form.amount,
          toAccountId: form.to_account_id,
        });

      if (target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        // 충전액·입금계좌가 바뀌면 딸린 인센티브도 따라가야 한다(안 그러면 잔액이 틀어진다).
        const r = await sync(target.id);
        if (!r.ok) toast.warning(r.message);
        toast.success(r.ok && r.message ? `수정되었습니다. ${r.message}` : "수정되었습니다.");
      } else {
        const { data: ins, error: err } = await supabase
          .from("hh_transaction")
          .insert({ ...payload, owner_auth_uid: owner, source: "manual" })
          .select("id")
          .single();
        if (err) return toast.error(`등록 실패: ${err.message}`);
        sendLog("CREATE_HH_TRANSFER", `통장이동: ${form.amount}원`, { resource: "hh_transaction", resource_id: ins.id });
        const r = await sync(ins.id);
        if (!r.ok) toast.warning(r.message);
        toast.success(r.ok && r.message ? `통장이동이 등록되었습니다. ${r.message}` : "통장이동이 등록되었습니다.");
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // 삭제 — 기존 상세 페이지와 동일하게 로그는 남기지 않는다(현행 재현, 설계 82 §D).
  const remove = async () => {
    if (!target) return;
    if (!window.confirm(`${target.txn_date} · ${target.amount.toLocaleString("ko-KR")}원 이체를 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const { error: err } = await supabase.from("hh_transaction").delete().eq("id", target.id);
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "통장이동 수정" : "통장이동 등록"}</DialogTitle>
        </DialogHeader>
        {noAccounts ? (
          <p className="py-4 text-sm text-muted-foreground">통장이동을 등록하려면 계좌가 2개 이상 필요합니다. 설정에서 계좌를 추가하세요.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="trd-date">날짜 *</Label>
              <Input id="trd-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="trd-from">출금계좌 *</Label>
                <select id="trd-from" className={selectClass} value={form.from_account_id} onChange={(e) => setForm({ ...form, from_account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {accOptions.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="trd-to">입금계좌 *</Label>
                <select id="trd-to" className={selectClass} value={form.to_account_id} onChange={(e) => setForm({ ...form, to_account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {accOptions.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="trd-amount">금액 (원) *</Label>
              <AmountInput id="trd-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} placeholder="예: 500,000" required />
            </div>

            {/* 충전 인센티브 안내 — 저장하면 무슨 일이 벌어지는지 미리 보여준다. (설계 84) */}
            {showIncentive ? (
              <div className="rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 text-sm">
                <p className="font-medium text-foreground">
                  {incentiveRule!.label} {Math.round(incentiveRule!.rate * 100)}% —{" "}
                  <span className="tabular-nums text-blue-600 dark:text-blue-400">+{incentive.toLocaleString("ko-KR")}원</span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {accounts.find((a) => a.id === form.to_account_id)?.name} 잔액은 <span className="tabular-nums font-medium text-foreground">{(form.amount + incentive).toLocaleString("ko-KR")}원</span> 늘어납니다.
                  인센티브는 &lsquo;환급/캐시백&rsquo; 수입으로 함께 기록됩니다(이 이체를 지우면 같이 지워집니다).
                </p>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="trd-memo">메모</Label>
              <Input id="trd-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="이체 사유" />
            </div>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {editing ? (
                <Button type="button" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={remove} disabled={saving}>삭제</Button>
              ) : (
                <Button type="button" variant="ghost" asChild>
                  <Link href="/dashboard/household/transfers/new">여러 건 입력 (엑셀)</Link>
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
