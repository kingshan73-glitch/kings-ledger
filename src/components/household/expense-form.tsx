"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { LoadingState, PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { Button } from "@/components/ui/button";
import { AmountInput } from "@/components/household/amount-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import { useHideInactiveAccounts, visibleAccounts as pickVisibleAccounts } from "@/lib/household/account-visibility";
import { getOwnerUid } from "@/lib/household/owner";
import { matchMerchantCategory } from "@/lib/household/defaults";
import type { HhAccount, HhCategory, HhPaymentMethod, HhPerson, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ExpenseForm({ target }: { target: HhTransaction | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const editing = !!target;

  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 지금 고른 계좌는 비활성이어도 남긴다(수정 모드 보호).
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [persons, setPersons] = useState<HhPerson[]>([]);
  const [merchantMap, setMerchantMap] = useState<{ merchant_key: string; category_id: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    txn_date: target?.txn_date ?? todayLocal(),
    category_id: target?.category_id ?? "",
    payment_method_id: target?.payment_method_id ?? "",
    account_id: target?.account_id ?? "",
    amount: target?.amount ?? 0,
    counterparty: target?.counterparty ?? "",
    memo: target?.memo ?? "",
    person_id: target?.person_id ?? "",
  });

  const loadMasters = useCallback(async () => {
    await supabase.auth.getSession();
    const [catRes, mRes, accRes, perRes, mapRes] = await Promise.all([
      supabase.from("hh_category").select("*").eq("kind", "expense").order("sort_order").order("name"),
      supabase.from("hh_payment_method").select("*").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase.from("hh_person").select("*").order("sort_order").order("name"),
      supabase.from("hh_merchant_map").select("merchant_key,category_id"),
    ]);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setMethods((mRes.data ?? []) as HhPaymentMethod[]);
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setPersons((perRes.data ?? []) as HhPerson[]);
    setMerchantMap((mapRes.data ?? []) as { merchant_key: string; category_id: string | null }[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

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
      if (editing && target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        toast.success("수정되었습니다.");
        router.push(`/dashboard/household/expenses/${target.id}`);
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
        router.push(`/dashboard/household/expenses/${ins.id}`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  const noMaster = categories.length === 0 || methods.length === 0;
  const backHref = editing && target ? `/dashboard/household/expenses/${target.id}` : "/dashboard/household/expenses";

  return (
    <PageShell>
      <HhPageHeader
        title={editing ? "지출 수정" : "지출 등록 (일시불)"}
        breadcrumbs={[{ label: "가계부" }, { label: "지출", href: "/dashboard/household/expenses" }, { label: editing ? "수정" : "등록" }]}
        actions={
          <Button variant="outline" asChild>
            <Link href={backHref}><ArrowLeft className="h-4 w-4" />취소</Link>
          </Button>
        }
      />
      <SectionCard>
        {noMaster ? (
          <p className="text-sm text-muted-foreground">
            지출을 등록하려면 먼저 <b>지출 카테고리</b>와 <b>결제수단</b>이 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="max-w-2xl space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exp-date">날짜 *</Label>
                <Input id="exp-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="exp-amount">금액 (원) *</Label>
                <AmountInput id="exp-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} placeholder="예: 12,000" required />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exp-category">카테고리 *</Label>
                <select id="exp-category" className={selectClass} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                  <option value="">선택</option>
                  {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exp-method">지불방식 *</Label>
                <select id="exp-method" className={selectClass} value={form.payment_method_id} onChange={(e) => setForm({ ...form, payment_method_id: e.target.value })} required>
                  <option value="">선택</option>
                  {methods.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exp-account">출금계좌 (현금·체크)</Label>
                <select id="exp-account" className={selectClass} value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                  <option value="">없음 (신용카드 등)</option>
                  {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.account_id]).map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exp-person">용돈 귀속 (인물)</Label>
                <select id="exp-person" className={selectClass} value={form.person_id} onChange={(e) => setForm({ ...form, person_id: e.target.value })}>
                  <option value="">해당 없음</option>
                  {persons.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="exp-counterparty">가맹점</Label>
                <Input id="exp-counterparty" value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} onBlur={(e) => autoFillCategory(e.target.value)} placeholder="예: 스타벅스 (카테고리 자동분류)" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="exp-memo">내역</Label>
                <Input id="exp-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="상세 내역" />
              </div>
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              신용카드 지출은 결제 시점이 아니라 <b>카드대금 납부일</b>에 계좌에서 빠집니다. 출금계좌는 현금·체크일 때만 지정하세요.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" asChild><Link href={backHref}>취소</Link></Button>
              <Button type="submit" disabled={saving}>{saving ? "저장 중..." : editing ? "수정" : "등록"}</Button>
            </div>
          </form>
        )}
      </SectionCard>
    </PageShell>
  );
}
