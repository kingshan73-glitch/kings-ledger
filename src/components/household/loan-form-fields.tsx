"use client";

import { AmountInput } from "@/components/household/amount-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import type { LoanFormState } from "@/lib/household/loan-save";
import type { HhAccount } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

// 대출 입력 필드 10개 (설계 96). 조회하지 않고 저장하지 않는다 —
// 계좌 목록은 위에서 내려주고, 저장은 loan-save.ts 가 맡는다.
// 팝업과 페이지가 같은 화면에 뜨는 일은 없지만 id 충돌을 피하려고 prefix 를 받는다.
export function LoanFormFields({
  form,
  setForm,
  accounts,
  idPrefix,
}: {
  form: LoanFormState;
  setForm: (next: LoanFormState) => void;
  accounts: HhAccount[];
  idPrefix: string;
}) {
  // 비활성 계좌 숨기기(설계 89) — 지금 고른 계좌는 비활성이어도 남긴다(수정 모드 보호).
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const id = (k: string) => `${idPrefix}-${k}`;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={id("name")}>대출명 *</Label>
        <Input
          id={id("name")}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="예: 디딤돌대출"
          required
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("principal")}>대출금액 (원금) *</Label>
          <AmountInput
            id={id("principal")}
            value={form.principal}
            onValueChange={(n) => setForm({ ...form, principal: n })}
            placeholder="예: 50,000,000"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("balance")}>현재 잔액</Label>
          <AmountInput
            id={id("balance")}
            value={form.current_balance}
            onValueChange={(n) => setForm({ ...form, current_balance: n })}
            placeholder="현재 남은 원금"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("origin")}>대출일</Label>
          <Input
            id={id("origin")}
            type="date"
            value={form.origin_date}
            onChange={(e) => setForm({ ...form, origin_date: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("maturity")}>만기일</Label>
          <Input
            id={id("maturity")}
            type="date"
            value={form.maturity_date}
            onChange={(e) => setForm({ ...form, maturity_date: e.target.value })}
          />
        </div>
      </div>

      {/* 3개 항목이므로 3열이다. 2열에 넣으면 상환일 혼자 남아 오른쪽 절반이 빈다
          — 항목 사이 공간은 균일해야 한다(CLAUDE.md 전역 규칙). */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={id("rate")}>이자율 (%)</Label>
          <Input
            id={id("rate")}
            type="number"
            step="0.01"
            min={0}
            value={form.interest_rate}
            onChange={(e) => setForm({ ...form, interest_rate: e.target.value === "" ? "" : parseFloat(e.target.value) })}
            placeholder="3.5"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("monthly")}>월납입금</Label>
          <AmountInput
            id={id("monthly")}
            value={form.monthly_payment === "" ? 0 : form.monthly_payment}
            onValueChange={(n) => setForm({ ...form, monthly_payment: n === 0 ? "" : n })}
            placeholder="540,000"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("day")}>상환일 (1~28)</Label>
          <Input
            id={id("day")}
            type="number"
            min={1}
            max={28}
            value={form.payment_day}
            onChange={(e) => setForm({ ...form, payment_day: e.target.value === "" ? "" : parseInt(e.target.value, 10) })}
            placeholder="25"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("account")}>출금계좌</Label>
          <select
            id={id("account")}
            className={selectClass}
            value={form.account_id}
            onChange={(e) => setForm({ ...form, account_id: e.target.value })}
          >
            <option value="">미지정</option>
            {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.account_id]).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {/* 설계 168 — 비워 두면 원리금균등으로 가정한다. 확인하지 못한 것을 확인한 것처럼
              굳히지 않으려고 '미지정'을 남긴다(카드론 월납 역산 공식이 여기서 갈린다). */}
          <Label htmlFor={id("repayment")}>상환방식</Label>
          <select
            id={id("repayment")}
            className={selectClass}
            value={form.repayment_type}
            onChange={(e) => setForm({ ...form, repayment_type: e.target.value as LoanFormState["repayment_type"] })}
          >
            <option value="">미지정 (원리금균등으로 가정)</option>
            <option value="annuity">원리금균등 (확인함)</option>
            <option value="equal_principal">원금균등</option>
            <option value="interest_only">만기일시 (매달 이자만)</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("status")}>상태</Label>
          <select
            id={id("status")}
            className={selectClass}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "closed" })}
          >
            <option value="active">상환중</option>
            <option value="closed">완료</option>
          </select>
        </div>
      </div>
    </>
  );
}
