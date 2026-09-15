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
import { matchMerchantCategory } from "@/lib/household/defaults";
import type { HhAccount, HhCategory, HhPaymentMethod, HhPerson, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const emptyForm = () => ({
  txn_date: todayLocal(),
  category_id: "",
  payment_method_id: "",
  account_id: "",
  amount: 0,
  counterparty: "",
  memo: "",
  person_id: "",
});

// 지출 등록·수정 팝업 (설계 82). target=null 이면 등록, 있으면 그 거래를 수정·삭제.
// 마스터는 목록이 이미 들고 있는 것을 받아 쓴다(재조회 없음).
export function ExpenseEditDialog({
  open,
  onOpenChange,
  target,
  categories,
  methods,
  accounts,
  persons,
  merchantMap,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhTransaction | null;
  categories: HhCategory[];
  methods: HhPaymentMethod[];
  accounts: HhAccount[];
  persons: HhPerson[];
  merchantMap: { merchant_key: string; category_id: string | null }[];
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const editing = !!target;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  // 열릴 때마다 리셋 — 등록이면 빈 폼, 수정이면 대상 값.
  useEffect(() => {
    if (!open) return;
    setForm(
      target
        ? {
            txn_date: target.txn_date,
            category_id: target.category_id ?? "",
            payment_method_id: target.payment_method_id ?? "",
            account_id: target.account_id ?? "",
            amount: target.amount,
            counterparty: target.counterparty ?? "",
            memo: target.memo ?? "",
            person_id: target.person_id ?? "",
          }
        : emptyForm()
    );
  }, [open, target]);

  // 등록은 활성 마스터만, 수정은 전부(이미 비활성 마스터를 참조 중일 수 있다). (설계 82 §B)
  const catOptions = editing ? categories : categories.filter((c) => c.is_active);
  const methodOptions = editing ? methods : methods.filter((m) => m.is_active);
  const noMaster = catOptions.length === 0 || methodOptions.length === 0;

  const autoFillCategory = (merchant: string) => {
    if (form.category_id) return;
    const guessed = matchMerchantCategory(merchant.trim(), merchantMap);
    if (guessed) setForm((f) => (f.category_id ? f : { ...f, category_id: guessed }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.category_id) return toast.error("카테고리를 선택해주세요.");
    if (!form.payment_method_id) return toast.error("지불방식을 선택해주세요.");
    if (form.amount <= 0) return toast.error("금액은 1원 이상이어야 합니다.");

    setSaving(true);
    const payload = {
      txn_date: form.txn_date,
      type: "expense" as const,
      amount: form.amount,
      category_id: form.category_id,
      payment_method_id: form.payment_method_id,
      account_id: form.account_id || null,
      counterparty: form.counterparty || null,
      memo: form.memo || null,
      person_id: form.person_id || null,
    };
    try {
      if (target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
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
        sendLog("CREATE_HH_EXPENSE", `지출 등록: ${form.amount}원`, { resource: "hh_transaction", resource_id: ins.id });
        toast.success("지출이 등록되었습니다.");
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    if (!window.confirm(`${target.txn_date} · ${target.amount.toLocaleString("ko-KR")}원 지출을 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const { error: err } = await supabase.from("hh_transaction").delete().eq("id", target.id);
      if (err) return toast.error(`삭제 실패: ${err.message}`);
      sendLog("DELETE_HH_EXPENSE", `지출 삭제: ${target.amount}원`, { resource: "hh_transaction", resource_id: target.id });
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
          <DialogTitle>{editing ? "지출 수정" : "지출 등록 (일시불)"}</DialogTitle>
        </DialogHeader>
        {noMaster ? (
          <p className="py-4 text-sm text-muted-foreground">
            지출을 등록하려면 먼저 <b>지출 카테고리</b>와 <b>결제수단</b>이 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exd-date">날짜 *</Label>
                <Input id="exd-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="exd-amount">금액 (원) *</Label>
                <AmountInput id="exd-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} placeholder="예: 12,000" required />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exd-category">카테고리 *</Label>
                <select id="exd-category" className={selectClass} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                  <option value="">선택</option>
                  {catOptions.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exd-method">지불방식 *</Label>
                <select id="exd-method" className={selectClass} value={form.payment_method_id} onChange={(e) => setForm({ ...form, payment_method_id: e.target.value })} required>
                  <option value="">선택</option>
                  {methodOptions.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exd-account">출금계좌 (현금·체크)</Label>
                <select id="exd-account" className={selectClass} value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                  <option value="">없음 (신용카드 등)</option>
                  {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exd-person">용돈 귀속 (인물)</Label>
                <select id="exd-person" className={selectClass} value={form.person_id} onChange={(e) => setForm({ ...form, person_id: e.target.value })}>
                  <option value="">해당 없음</option>
                  {persons.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exd-counterparty">가맹점</Label>
                <Input id="exd-counterparty" value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} onBlur={(e) => autoFillCategory(e.target.value)} placeholder="예: 스타벅스 (카테고리 자동분류)" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="exd-memo">내역</Label>
                <Input id="exd-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="상세 내역" />
              </div>
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              신용카드 지출은 결제 시점이 아니라 <b>카드대금 납부일</b>에 계좌에서 빠집니다. 출금계좌는 현금·체크일 때만 지정하세요.
            </p>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {editing ? (
                <Button type="button" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={remove} disabled={saving}>삭제</Button>
              ) : (
                <Button type="button" variant="ghost" asChild>
                  <Link href="/dashboard/household/expenses/new">여러 건 입력 (엑셀)</Link>
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
