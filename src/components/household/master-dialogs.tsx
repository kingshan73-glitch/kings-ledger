"use client";
import { toast } from "sonner";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
  HhAccountInsert,
  HhAccountKind,
  HhCategory,
  HhCategoryInsert,
  HhCategoryKind,
  HhPaymentMethod,
  HhPaymentMethodInsert,
  HhPaymentMethodKind,
  HhPerson,
  HhPersonInsert,
} from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

// owner_auth_uid 는 페이지 저장 단계에서 주입하므로 폼 페이로드에서는 제외한다.
type PersonForm = Omit<HhPersonInsert, "owner_auth_uid">;
type AccountForm = Omit<HhAccountInsert, "owner_auth_uid">;
type CategoryForm = Omit<HhCategoryInsert, "owner_auth_uid">;
type PaymentMethodForm = Omit<HhPaymentMethodInsert, "owner_auth_uid">;

// ───────────────────────── 인물 ─────────────────────────

export function PersonDialog({
  open,
  onOpenChange,
  target,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhPerson | null;
  onSave: (data: PersonForm) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(target?.name ?? "");
    setSortOrder(target?.sort_order ?? 0);
    setIsActive(target?.is_active ?? true);
  }, [open, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("이름을 입력해주세요.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), sort_order: sortOrder, is_active: isActive });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target ? "인물 수정" : "인물 등록"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="person-name">이름 *</Label>
            <Input
              id="person-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 김하늘"
              autoFocus
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="person-sort">표시 순서</Label>
              <Input
                id="person-sort"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(parseInt(e.target.value || "0", 10) || 0)}
              />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4"
              />
              활성
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "저장 중..." : target ? "수정" : "등록"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── 계좌·카드 통합 등록 ─────────────────────────
// 설계: docs/household/31. 계좌(hh_account)와 결제수단(hh_payment_method)을
// 한 다이얼로그에서 등록한다. 테이블은 그대로 두고 UI만 통합(마이그레이션 0건).

// 페이지 저장 핸들러로 넘기는 명령. 은행계좌는 결제수단 동기화 정보까지 함께 전달한다.
export type AccountPaymentSave =
  | {
      mode: "account";
      account: AccountForm;
      asPayment: boolean;
      payment:
        | { kind: HhPaymentMethodKind; card_no: string | null; card_expiry: string | null; billing_day: number | null }
        | null;
    }
  | {
      mode: "card";
      method: PaymentMethodForm;
    };

// 수정 대상: 은행계좌(딸린 결제수단 포함) 또는 계좌 없는 결제수단(카드/현금 등).
export type AccountPaymentTarget =
  | { type: "account"; account: HhAccount; linkedMethod: HhPaymentMethod | null }
  | { type: "card"; method: HhPaymentMethod }
  | null;

const EMPTY_ACCOUNT: AccountForm = {
  name: "",
  bank: null,
  account_no: null,
  person_id: null,
  kind: "checking",
  opening_balance: 0,
  sort_order: 0,
  is_active: true,
};

const EMPTY_CARD: PaymentMethodForm = {
  name: "",
  kind: "credit",
  person_id: null,
  linked_account_id: null,
  billing_day: null,
  card_no: null,
  card_expiry: null,
  is_active: true,
  sort_order: 0,
};

export function AccountPaymentDialog({
  open,
  onOpenChange,
  target,
  persons,
  accounts,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AccountPaymentTarget;
  persons: HhPerson[];
  accounts: HhAccount[];
  onSave: (data: AccountPaymentSave) => Promise<void>;
}) {
  const [mode, setMode] = useState<"account" | "card">("account");
  // 은행계좌 모드
  const [acc, setAcc] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [asPayment, setAsPayment] = useState(false);
  const [payKind, setPayKind] = useState<HhPaymentMethodKind>("check");
  const [accCardNo, setAccCardNo] = useState("");
  const [accCardExpiry, setAccCardExpiry] = useState("");
  // 카드·기타 결제수단 모드
  const [card, setCard] = useState<PaymentMethodForm>(EMPTY_CARD);
  const [saving, setSaving] = useState(false);

  const editing = target != null;

  useEffect(() => {
    if (!open) return;
    if (target?.type === "account") {
      setMode("account");
      const a = target.account;
      setAcc({
        name: a.name,
        bank: a.bank,
        account_no: a.account_no,
        person_id: a.person_id,
        kind: a.kind,
        opening_balance: a.opening_balance,
        sort_order: a.sort_order,
        is_active: a.is_active,
      });
      const lm = target.linkedMethod;
      setAsPayment(!!lm && lm.is_active);
      setPayKind(lm?.kind ?? "check");
      setAccCardNo(lm?.card_no ?? "");
      setAccCardExpiry(lm?.card_expiry ?? "");
      setCard(EMPTY_CARD);
    } else if (target?.type === "card") {
      setMode("card");
      const m = target.method;
      setCard({
        name: m.name,
        kind: m.kind,
        person_id: m.person_id,
        linked_account_id: m.linked_account_id,
        billing_day: m.billing_day,
        card_no: m.card_no,
        card_expiry: m.card_expiry,
        is_active: m.is_active,
        sort_order: m.sort_order,
      });
      setAcc(EMPTY_ACCOUNT);
      setAsPayment(false);
    } else {
      setMode("account");
      setAcc(EMPTY_ACCOUNT);
      setAsPayment(false);
      setPayKind("check");
      setAccCardNo("");
      setAccCardExpiry("");
      setCard(EMPTY_CARD);
    }
  }, [open, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "account") {
      if (!acc.name.trim()) {
        toast.error("계좌명을 입력해주세요.");
        return;
      }
      setSaving(true);
      try {
        await onSave({
          mode: "account",
          account: { ...acc, name: acc.name.trim() },
          asPayment,
          payment: asPayment
            ? {
                kind: payKind,
                card_no: payKind === "cash" ? null : accCardNo.trim() || null,
                card_expiry: payKind === "cash" ? null : accCardExpiry.trim() || null,
                billing_day: null,
              }
            : null,
        });
        onOpenChange(false);
      } finally {
        setSaving(false);
      }
    } else {
      if (!card.name.trim()) {
        toast.error("이름을 입력해주세요.");
        return;
      }
      if (card.billing_day != null && (card.billing_day < 1 || card.billing_day > 28)) {
        toast.error("결제일은 1~28 사이여야 합니다.");
        return;
      }
      setSaving(true);
      try {
        await onSave({ mode: "card", method: { ...card, name: card.name.trim() } });
        onOpenChange(false);
      } finally {
        setSaving(false);
      }
    }
  };

  const title = !editing
    ? "계좌·카드 등록"
    : target?.type === "card"
      ? "결제수단 수정"
      : "계좌 수정";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {/* 구분 (신규 등록일 때만 전환 가능) */}
          <div className="space-y-2">
            <Label htmlFor="ap-mode">구분</Label>
            <select
              id="ap-mode"
              className={selectClass}
              value={mode}
              disabled={editing}
              onChange={(e) => setMode(e.target.value as "account" | "card")}
            >
              <option value="account">은행계좌</option>
              <option value="card">카드·기타 결제수단</option>
            </select>
          </div>

          {mode === "account" ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="acc-name">계좌명 *</Label>
                  <Input
                    id="acc-name"
                    value={acc.name}
                    onChange={(e) => setAcc({ ...acc, name: e.target.value })}
                    placeholder="예: 국민은행(김하늘)"
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="acc-bank">은행</Label>
                  <Input
                    id="acc-bank"
                    value={acc.bank ?? ""}
                    onChange={(e) => setAcc({ ...acc, bank: e.target.value || null })}
                    placeholder="예: 토스뱅크"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="acc-no">계좌번호</Label>
                  <Input
                    id="acc-no"
                    value={acc.account_no ?? ""}
                    onChange={(e) => setAcc({ ...acc, account_no: e.target.value || null })}
                    placeholder="끝 4자리로 결제문자 자동매칭"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="acc-person">명의</Label>
                  <select
                    id="acc-person"
                    className={selectClass}
                    value={acc.person_id ?? ""}
                    onChange={(e) => setAcc({ ...acc, person_id: e.target.value || null })}
                  >
                    <option value="">선택</option>
                    {persons.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="acc-kind">종류</Label>
                  <select
                    id="acc-kind"
                    className={selectClass}
                    value={acc.kind}
                    onChange={(e) => setAcc({ ...acc, kind: e.target.value as HhAccountKind })}
                  >
                    <option value="checking">입출금</option>
                    <option value="stock">주식</option>
                    <option value="family">가족</option>
                    <option value="other">기타</option>
                  </select>
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acc.is_active}
                    onChange={(e) => setAcc({ ...acc, is_active: e.target.checked })}
                    className="h-4 w-4"
                  />
                  활성
                </label>
              </div>

              {/* 결제수단으로도 등록 */}
              <div className="space-y-3 rounded-md border border-border/70 bg-muted/30 p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={asPayment}
                    onChange={(e) => setAsPayment(e.target.checked)}
                    className="h-4 w-4"
                  />
                  결제수단으로도 등록 (지출 입력 때 이 계좌를 결제수단으로 고를 수 있습니다)
                </label>
                {asPayment ? (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="acc-paykind">결제종류</Label>
                        <select
                          id="acc-paykind"
                          className={selectClass}
                          value={payKind}
                          onChange={(e) => setPayKind(e.target.value as HhPaymentMethodKind)}
                        >
                          <option value="check">체크카드</option>
                          <option value="cash">현금/계좌이체</option>
                        </select>
                      </div>
                    </div>
                    {payKind !== "cash" ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="acc-cardno">카드번호</Label>
                          <Input
                            id="acc-cardno"
                            value={accCardNo}
                            onChange={(e) => setAccCardNo(e.target.value)}
                            placeholder="1234-5678-9012-3456"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="acc-cardexp">유효기간 (MM/YY)</Label>
                          <Input
                            id="acc-cardexp"
                            value={accCardExpiry}
                            onChange={(e) => setAccCardExpiry(e.target.value)}
                            placeholder="예: 09/27"
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>

              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                보안: 은행 로그인 ID·비밀번호는 저장하지 않습니다. 신용카드는 구분을 &lsquo;카드·기타 결제수단&rsquo;으로 등록하세요.
              </p>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="pm-name">이름 *</Label>
                  <Input
                    id="pm-name"
                    value={card.name}
                    onChange={(e) => setCard({ ...card, name: e.target.value })}
                    placeholder="예: 삼성카드(김하늘)"
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pm-kind">종류</Label>
                  <select
                    id="pm-kind"
                    className={selectClass}
                    value={card.kind}
                    onChange={(e) => setCard({ ...card, kind: e.target.value as HhPaymentMethodKind })}
                  >
                    <option value="credit">신용카드</option>
                    <option value="check">체크카드</option>
                    <option value="installment">할부</option>
                    <option value="cash">현금</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="pm-person">명의</Label>
                  <select
                    id="pm-person"
                    className={selectClass}
                    value={card.person_id ?? ""}
                    onChange={(e) => setCard({ ...card, person_id: e.target.value || null })}
                  >
                    <option value="">선택</option>
                    {persons.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pm-account">출금계좌 (카드대금 결제)</Label>
                  <select
                    id="pm-account"
                    className={selectClass}
                    value={card.linked_account_id ?? ""}
                    onChange={(e) => setCard({ ...card, linked_account_id: e.target.value || null })}
                  >
                    <option value="">선택</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="pm-billing">결제일 (1~28, 신용카드)</Label>
                  <Input
                    id="pm-billing"
                    type="number"
                    min={1}
                    max={28}
                    value={card.billing_day ?? ""}
                    onChange={(e) =>
                      setCard({ ...card, billing_day: e.target.value ? parseInt(e.target.value, 10) : null })
                    }
                    placeholder="예: 25"
                  />
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={card.is_active}
                    onChange={(e) => setCard({ ...card, is_active: e.target.checked })}
                    className="h-4 w-4"
                  />
                  활성
                </label>
              </div>
              {card.kind !== "cash" ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="pm-cardno">카드번호</Label>
                      <Input
                        id="pm-cardno"
                        value={card.card_no ?? ""}
                        onChange={(e) => setCard({ ...card, card_no: e.target.value || null })}
                        placeholder="1234-5678-9012-3456"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pm-expiry">유효기간 (MM/YY)</Label>
                      <Input
                        id="pm-expiry"
                        value={card.card_expiry ?? ""}
                        onChange={(e) => setCard({ ...card, card_expiry: e.target.value || null })}
                        placeholder="예: 09/27"
                      />
                    </div>
                  </div>
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    카드번호 끝 4자리로 결제문자(SMS)가 이 카드에 자동매칭됩니다.
                  </p>
                </>
              ) : null}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "저장 중..." : editing ? "수정" : "등록"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── 카테고리 ─────────────────────────

export function CategoryDialog({
  open,
  onOpenChange,
  target,
  defaultKind,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: HhCategory | null;
  defaultKind: HhCategoryKind;
  onSave: (data: CategoryForm) => Promise<void>;
}) {
  const [form, setForm] = useState<CategoryForm>({
    name: "",
    kind: defaultKind,
    is_fixed: false,
    sort_order: 0,
    is_active: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) {
      setForm({
        name: target.name,
        kind: target.kind,
        is_fixed: target.is_fixed,
        sort_order: target.sort_order,
        is_active: target.is_active,
      });
    } else {
      setForm({ name: "", kind: defaultKind, is_fixed: false, sort_order: 0, is_active: true });
    }
  }, [open, target, defaultKind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("카테고리명을 입력해주세요.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...form, name: form.name.trim() });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target ? "카테고리 수정" : "카테고리 등록"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cat-name">카테고리명 *</Label>
            <Input
              id="cat-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: 외식비"
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-kind">종류</Label>
            <select
              id="cat-kind"
              className={selectClass}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as HhCategoryKind })}
            >
              <option value="expense">지출</option>
              <option value="income">수입</option>
            </select>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.is_fixed}
                onChange={(e) => setForm({ ...form, is_fixed: e.target.checked })}
                className="h-4 w-4"
              />
              고정비
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                className="h-4 w-4"
              />
              활성
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "저장 중..." : target ? "수정" : "등록"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
