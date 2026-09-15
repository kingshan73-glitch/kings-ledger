"use client";
import { toast } from "sonner";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
import type { HhAccount, HhCategory, HhPaymentMethod } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

type InboxType = "income" | "expense" | "transfer" | "payment" | "installment";

export interface InboxFormData {
  guessed_type: InboxType;
  guessed_date: string;
  guessed_merchant: string;
  guessed_amount: number;
  guessed_category_id: string | null;
  guessed_account_id: string | null;
  guessed_payment_method_id: string | null;
  guessed_from_account_id: string | null;
  guessed_to_account_id: string | null;
  guessed_installment_months: number | null;
  raw_text: string | null;
}

function emptyForm(): InboxFormData {
  return {
    guessed_type: "expense",
    guessed_date: new Date().toISOString().slice(0, 10),
    guessed_merchant: "",
    guessed_amount: 0,
    guessed_category_id: null,
    guessed_account_id: null,
    guessed_payment_method_id: null,
    guessed_from_account_id: null,
    guessed_to_account_id: null,
    guessed_installment_months: null,
    raw_text: null,
  };
}

const TYPE_OPTIONS: { value: InboxType; label: string }[] = [
  { value: "expense", label: "지출" },
  { value: "income", label: "수입" },
  { value: "transfer", label: "이체" },
  { value: "payment", label: "납부" },
  { value: "installment", label: "할부" },
];

export function InboxDialog({
  open,
  onOpenChange,
  categories,
  accounts,
  methods,
  onSave,
  guessCategory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: HhCategory[];
  accounts: HhAccount[];
  methods: HhPaymentMethod[];
  onSave: (data: InboxFormData) => Promise<unknown>;
  // 가맹점명으로 카테고리 id 를 추정한다(매핑 사전 기반). 못 찾으면 null.
  guessCategory?: (merchant: string) => string | null;
}) {
  const [form, setForm] = useState<InboxFormData>(emptyForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm());
  }, [open]);

  const t = form.guessed_type;
  const isTransfer = t === "transfer";
  const isPayment = t === "payment";
  const isInstallment = t === "installment";
  const isIncome = t === "income";
  // 가맹점/입금처가 필수인 유형(이체·납부는 상대처가 없거나 선택).
  const merchantRequired = t === "expense" || t === "income" || t === "installment";

  // 유형을 바꾸면 유형에 안 맞는 필드는 비워 오염을 막는다.
  const changeType = (next: InboxType) => {
    setForm((f) => ({
      ...f,
      guessed_type: next,
      guessed_category_id: null,
      guessed_payment_method_id: next === "expense" || next === "installment" ? f.guessed_payment_method_id : null,
      guessed_installment_months: next === "installment" ? f.guessed_installment_months : null,
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.guessed_amount <= 0) return toast.error("금액은 1원 이상이어야 합니다.");
    if (merchantRequired && !form.guessed_merchant.trim()) return toast.error("가맹점/입금처를 입력해주세요.");
    if (isTransfer) {
      if (!form.guessed_from_account_id || !form.guessed_to_account_id) return toast.error("이체는 출금·입금 계좌가 필요합니다.");
      if (form.guessed_from_account_id === form.guessed_to_account_id) return toast.error("출금·입금 계좌가 같을 수 없습니다.");
    }
    if (isPayment && !form.guessed_from_account_id) return toast.error("납부는 출금계좌가 필요합니다.");
    if (isInstallment && (!form.guessed_installment_months || form.guessed_installment_months < 2)) {
      return toast.error("할부 개월수(2 이상)를 입력해주세요.");
    }
    setSaving(true);
    try {
      await onSave({ ...form, guessed_merchant: form.guessed_merchant.trim() });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // 가맹점 입력이 끝나면 매핑 사전으로 카테고리를 추정해 비어 있을 때만 자동 채움.
  const autoFillCategory = (merchant: string) => {
    if (!guessCategory || (t !== "expense" && t !== "installment") || form.guessed_category_id) return;
    const guessed = guessCategory(merchant.trim());
    if (guessed) setForm((f) => (f.guessed_category_id ? f : { ...f, guessed_category_id: guessed }));
  };

  const cats = categories.filter((c) => c.kind === (isIncome ? "income" : "expense"));
  const acctOpts = accounts.filter((a) => a.is_active);
  const methodOpts = methods.filter((m) => m.is_active);

  // 상대처(가맹점/입금처) 필드 라벨은 유형에 따라 달라진다.
  const merchantLabel = isIncome ? "입금처" : isTransfer ? "메모(선택)" : isPayment ? "납부처(선택)" : "가맹점";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>수집함에 수동 추가</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ib-type">유형</Label>
              <select id="ib-type" className={selectClass} value={t} onChange={(e) => changeType(e.target.value as InboxType)}>
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ib-date">날짜</Label>
              <Input id="ib-date" type="date" value={form.guessed_date} onChange={(e) => setForm({ ...form, guessed_date: e.target.value })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ib-merchant">{merchantLabel}{merchantRequired ? " *" : ""}</Label>
              <Input
                id="ib-merchant"
                value={form.guessed_merchant}
                onChange={(e) => setForm({ ...form, guessed_merchant: e.target.value })}
                onBlur={(e) => autoFillCategory(e.target.value)}
                placeholder={isIncome ? "예: ○○회사 급여" : isTransfer ? "예: 생활비 이체" : isPayment ? "예: 삼성카드" : "예: 스타벅스"}
                autoFocus
                required={merchantRequired}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ib-amount">금액 (원) *</Label>
              <AmountInput id="ib-amount" value={form.guessed_amount} onValueChange={(n) => setForm({ ...form, guessed_amount: n })} allowFormula placeholder="예: 12,000 또는 =3+5+70" required />
            </div>
          </div>

          {/* 이체: 출금계좌 → 입금계좌 */}
          {isTransfer ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ib-from">출금계좌 *</Label>
                <select id="ib-from" className={selectClass} value={form.guessed_from_account_id ?? ""} onChange={(e) => setForm({ ...form, guessed_from_account_id: e.target.value || null })}>
                  <option value="">선택</option>
                  {acctOpts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ib-to">입금계좌 *</Label>
                <select id="ib-to" className={selectClass} value={form.guessed_to_account_id ?? ""} onChange={(e) => setForm({ ...form, guessed_to_account_id: e.target.value || null })}>
                  <option value="">선택</option>
                  {acctOpts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
            </div>
          ) : null}

          {/* 납부(카드대금·대출 원리금): 출금계좌만 */}
          {isPayment ? (
            <div className="space-y-2">
              <Label htmlFor="ib-pay-from">출금계좌 *</Label>
              <select id="ib-pay-from" className={selectClass} value={form.guessed_from_account_id ?? ""} onChange={(e) => setForm({ ...form, guessed_from_account_id: e.target.value || null })}>
                <option value="">선택</option>
                {acctOpts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
              </select>
            </div>
          ) : null}

          {/* 지출·수입·할부: 카테고리 + 결제수단/입금계좌 */}
          {!isTransfer && !isPayment ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ib-category">{isIncome ? "카테고리" : "추정 카테고리"}</Label>
                  <select id="ib-category" className={selectClass} value={form.guessed_category_id ?? ""} onChange={(e) => setForm({ ...form, guessed_category_id: e.target.value || null })}>
                    <option value="">선택</option>
                    {cats.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                  </select>
                </div>
                {isIncome ? (
                  <div className="space-y-2">
                    <Label htmlFor="ib-account">입금계좌</Label>
                    <select id="ib-account" className={selectClass} value={form.guessed_account_id ?? ""} onChange={(e) => setForm({ ...form, guessed_account_id: e.target.value || null })}>
                      <option value="">선택</option>
                      {acctOpts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                    </select>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="ib-method">{isInstallment ? "결제수단(카드)" : "추정 결제수단"}</Label>
                    <select id="ib-method" className={selectClass} value={form.guessed_payment_method_id ?? ""} onChange={(e) => setForm({ ...form, guessed_payment_method_id: e.target.value || null })}>
                      <option value="">선택</option>
                      {methodOpts.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                    </select>
                  </div>
                )}
              </div>

              {/* 할부: 개월수 */}
              {isInstallment ? (
                <div className="space-y-2">
                  <Label htmlFor="ib-months">할부 개월수 *</Label>
                  <Input
                    id="ib-months"
                    type="number"
                    min={2}
                    value={form.guessed_installment_months ?? ""}
                    onChange={(e) => setForm({ ...form, guessed_installment_months: e.target.value ? parseInt(e.target.value, 10) : null })}
                    placeholder="예: 3"
                  />
                </div>
              ) : null}

              {/* 지출: 현금·체크 출금계좌(선택) */}
              {t === "expense" ? (
                <div className="space-y-2">
                  <Label htmlFor="ib-account2">출금계좌 (현금·체크)</Label>
                  <select id="ib-account2" className={selectClass} value={form.guessed_account_id ?? ""} onChange={(e) => setForm({ ...form, guessed_account_id: e.target.value || null })}>
                    <option value="">없음 (신용카드 등)</option>
                    {acctOpts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                  </select>
                </div>
              ) : null}
            </>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
            <Button type="submit" disabled={saving}>{saving ? "저장 중..." : "수집함에 추가"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
