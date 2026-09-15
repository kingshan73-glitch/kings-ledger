"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AmountInput } from "@/components/household/amount-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { getOwnerUid } from "@/lib/household/owner";
import { installmentMonthly } from "@/lib/household/calc";
import { validateInstallmentCounts } from "@/lib/household/installment-validate";
import type { HhCategory, HhInstallment, HhPaymentMethod } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const emptyForm = () => ({
  start_date: todayLocal(),
  payment_method_id: "",
  category_id: "",
  title: "",
  total_amount: 0,
  total_count: 3,
  start_installment: 1,
  is_active: true,
});

// 할부 등록·수정 팝업 (설계 82). target=null 이면 등록, 있으면 그 할부를 수정·삭제.
export function InstallmentEditDialog({
  open,
  onOpenChange,
  target,
  categories,
  methods,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhInstallment | null;
  categories: HhCategory[];
  methods: HhPaymentMethod[];
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
            start_date: target.start_date,
            payment_method_id: target.payment_method_id ?? "",
            category_id: target.category_id ?? "",
            title: target.title ?? "",
            total_amount: target.total_amount,
            total_count: target.total_count,
            start_installment: target.start_installment ?? 1,
            is_active: target.is_active,
          }
        : emptyForm()
    );
  }, [open, target]);

  // 등록은 활성 마스터만, 수정은 전부. (설계 82 §B)
  const catOptions = editing ? categories : categories.filter((c) => c.is_active);
  const methodOptions = editing ? methods : methods.filter((m) => m.is_active);
  const noMaster = catOptions.length === 0 || methodOptions.length === 0;
  const monthly = installmentMonthly(form.total_amount, form.total_count);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.category_id) return toast.error("카테고리를 선택해주세요.");
    if (!form.payment_method_id) return toast.error("사용카드를 선택해주세요.");
    if (form.total_amount <= 0) return toast.error("총금액은 1원 이상이어야 합니다.");
    const err = validateInstallmentCounts(form.total_count, form.start_installment);
    if (err) return toast.error(err);

    setSaving(true);
    const payload = {
      start_date: form.start_date,
      payment_method_id: form.payment_method_id || null,
      category_id: form.category_id,
      title: form.title || null,
      total_amount: form.total_amount,
      total_count: form.total_count,
      start_installment: form.start_installment,
      is_active: form.is_active,
    };
    try {
      if (target) {
        const { error: err } = await supabase.from("hh_installment").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        toast.success("수정되었습니다.");
      } else {
        const owner = await getOwnerUid(supabase);
        if (!owner) return toast.error("로그인 정보를 확인할 수 없습니다.");
        const { error: err } = await supabase.from("hh_installment").insert({ ...payload, owner_auth_uid: owner });
        if (err) return toast.error(`등록 실패: ${err.message}`);
        toast.success("할부가 등록되었습니다.");
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
    if (!window.confirm(`'${target.title ?? "할부"}' 할부를 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const { error: err } = await supabase.from("hh_installment").delete().eq("id", target.id);
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
          <DialogTitle>{editing ? "할부 수정" : "할부 등록"}</DialogTitle>
        </DialogHeader>
        {noMaster ? (
          <p className="py-4 text-sm text-muted-foreground">
            할부를 등록하려면 먼저 <b>지출 카테고리</b>와 <b>카드(결제수단)</b>가 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="isd-date">시작일 *</Label>
                <Input id="isd-date" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="isd-method">사용카드 *</Label>
                <select id="isd-method" className={selectClass} value={form.payment_method_id} onChange={(e) => setForm({ ...form, payment_method_id: e.target.value })} required>
                  <option value="">선택</option>
                  {methodOptions.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="isd-category">카테고리 *</Label>
                <select id="isd-category" className={selectClass} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                  <option value="">선택</option>
                  {catOptions.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="isd-title">내용</Label>
                <Input id="isd-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="예: 노트북 구매" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="isd-total">총금액 (원) *</Label>
                <AmountInput id="isd-total" value={form.total_amount} onValueChange={(n) => setForm({ ...form, total_amount: n })} placeholder="예: 1,200,000" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="isd-count">총 회차 *</Label>
                <Input id="isd-count" type="number" min={1} value={form.total_count} onChange={(e) => setForm({ ...form, total_count: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="isd-start">시작 회차</Label>
                <Input id="isd-start" type="number" min={1} max={form.total_count} value={form.start_installment} onChange={(e) => setForm({ ...form, start_installment: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })} />
              </div>
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              월 금액 ≈ <b>{monthly.toLocaleString("ko-KR")}원</b> (총금액 ÷ 총회차, 끝수는 마지막 회차 보정)
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="h-4 w-4" />
              활성 (진행 중)
            </label>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {editing ? (
                <Button type="button" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={remove} disabled={saving}>삭제</Button>
              ) : (
                <Button type="button" variant="ghost" asChild>
                  <Link href="/dashboard/household/expenses/installment/new">여러 건 입력 (엑셀)</Link>
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
