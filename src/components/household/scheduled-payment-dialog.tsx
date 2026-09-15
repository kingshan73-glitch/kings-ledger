"use client";
import { toast } from "sonner";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { AmountInput } from "@/components/household/amount-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  HhAccount,
  HhCategory,
  HhPaymentMethod,
  HhPerson,
  HhScheduledPayment,
  HhScheduledPaymentKind,
} from "@/lib/household/types";
import { SCHEDULED_KIND_LABEL } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type ScheduledPaymentFormData = {
  title: string;
  kind: HhScheduledPaymentKind;
  amount: number | null;
  frequency: "monthly" | "weekly" | "bimonthly";
  pay_day: number | null;
  account_id: string | null;
  /** 카드로 결제되는 고정비의 카드(설계 108). 신용카드면 현금은 카드대금일에 빠진다. */
  payment_method_id: string | null;
  category_id: string | null;
  person_id: string | null;
  direction: "out" | "in";
  is_active: boolean;
  start_date: string | null;
  end_date: string | null;
};

function emptyForm(): ScheduledPaymentFormData {
  return {
    title: "",
    kind: "autopay",
    amount: null,
    frequency: "monthly",
    pay_day: 1,
    account_id: null,
    payment_method_id: null,
    category_id: null,
    person_id: null,
    direction: "out",
    is_active: true,
    start_date: null,
    end_date: null,
  };
}

export function ScheduledPaymentDialog({
  open,
  onOpenChange,
  target,
  accounts,
  methods,
  categories,
  persons,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhScheduledPayment | null;
  accounts: HhAccount[];
  /** 결제수단 마스터 — 카드로 결제되는 고정비 지정용(설계 108). 목록이 이미 로드한 것을 내려받는다(설계 82). */
  methods: HhPaymentMethod[];
  categories: HhCategory[];
  persons: HhPerson[];
  onSave: (data: ScheduledPaymentFormData) => Promise<void>;
}) {
  const [form, setForm] = useState<ScheduledPaymentFormData>(emptyForm());
  // 비활성 계좌 숨기기(설계 89) — 지금 고른 계좌는 비활성이어도 남긴다(수정 모드 보호).
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) {
      setForm({
        title: target.title,
        kind: target.kind,
        amount: target.amount,
        frequency: target.frequency,
        pay_day: target.pay_day,
        account_id: target.account_id,
        payment_method_id: target.payment_method_id,
        category_id: target.category_id,
        person_id: target.person_id,
        direction: target.direction,
        is_active: target.is_active,
        start_date: target.start_date,
        end_date: target.end_date,
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return toast.error("이름을 입력해주세요.");
    if (form.frequency !== "weekly" && form.pay_day != null && (form.pay_day < 1 || form.pay_day > 28)) {
      return toast.error("납부일은 1~28 사이여야 합니다.");
    }
    setSaving(true);
    try {
      await onSave({ ...form, title: form.title.trim() });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const weekly = form.frequency === "weekly";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{target ? "정기지출 수정" : "정기지출 등록"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-title">이름 *</Label>
              <Input id="sp-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="예: 실손보험" autoFocus required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-kind">종류</Label>
              <select id="sp-kind" className={selectClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as HhScheduledPaymentKind })}>
                {Object.entries(SCHEDULED_KIND_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-amount">금액 (원)</Label>
              <AmountInput id="sp-amount" value={form.amount ?? 0} onValueChange={(n) => setForm({ ...form, amount: n === 0 ? null : n })} placeholder="고정 금액" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-freq">주기</Label>
              <select id="sp-freq" className={selectClass} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as ScheduledPaymentFormData["frequency"] })}>
                <option value="monthly">매월</option>
                <option value="weekly">매주</option>
                <option value="bimonthly">격월</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-day">{weekly ? "요일 (0=일)" : "납부일 (1~28)"}</Label>
              <Input id="sp-day" type="number" min={weekly ? 0 : 1} max={weekly ? 6 : 28} value={form.pay_day ?? ""} onChange={(e) => setForm({ ...form, pay_day: e.target.value ? parseInt(e.target.value, 10) : null })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-direction">방향</Label>
              <select id="sp-direction" className={selectClass} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as "out" | "in" })}>
                <option value="out">지출 (나가는 돈)</option>
                <option value="in">예상 수입 (들어오는 돈)</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-account">출금/입금 계좌</Label>
              <select id="sp-account" className={selectClass} value={form.account_id ?? ""} onChange={(e) => setForm({ ...form, account_id: e.target.value || null })}>
                <option value="">선택</option>
                {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.account_id]).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-category">카테고리</Label>
              <select id="sp-category" className={selectClass} value={form.category_id ?? ""} onChange={(e) => setForm({ ...form, category_id: e.target.value || null })}>
                <option value="">선택</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.kind === "income" ? "수입" : "지출"})</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-person">명의</Label>
              <select id="sp-person" className={selectClass} value={form.person_id ?? ""} onChange={(e) => setForm({ ...form, person_id: e.target.value || null })}>
                <option value="">선택</option>
                {persons.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          {/* 카드로 결제되는 고정비(학원비·통신비 등) — 신용카드를 고르면 현금은 카드대금일에 빠진다. (설계 108) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-method">결제수단</Label>
              <select
                id="sp-method"
                className={selectClass}
                value={form.payment_method_id ?? ""}
                onChange={(e) => setForm({ ...form, payment_method_id: e.target.value || null })}
              >
                <option value="">계좌에서 바로 출금</option>
                {methods
                  .filter((m) => m.is_active || m.id === form.payment_method_id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">참고</Label>
              <p className="text-sm text-muted-foreground">
                신용카드를 고르면 이 금액은 통장에서 그날 빠지지 않고 <b>카드대금일</b>에 함께 나갑니다(이중 계산 방지).
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sp-start">시작일</Label>
              <Input id="sp-start" type="date" value={form.start_date ?? ""} onChange={(e) => setForm({ ...form, start_date: e.target.value || null })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-end">종료일</Label>
              <Input id="sp-end" type="date" value={form.end_date ?? ""} onChange={(e) => setForm({ ...form, end_date: e.target.value || null })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="h-4 w-4" />
            활성 (현금흐름 예측에 반영)
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
            <Button type="submit" disabled={saving}>{saving ? "저장 중..." : target ? "수정" : "등록"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
