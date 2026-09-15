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
import type { HhAccount, HhCategory, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

// 로컬 기준 오늘(YYYY-MM-DD). toISOString()은 UTC라 밤시간 하루 밀림 방지.
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function IncomeForm({ target }: { target: HhTransaction | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const editing = !!target;

  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 지금 고른 계좌는 비활성이어도 남긴다(수정 모드 보호).
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    txn_date: target?.txn_date ?? todayLocal(),
    category_id: target?.category_id ?? "",
    account_id: target?.account_id ?? "",
    amount: target?.amount ?? 0,
    counterparty: target?.counterparty ?? "",
    memo: target?.memo ?? "",
  });

  const loadMasters = useCallback(async () => {
    await supabase.auth.getSession();
    const [catRes, accRes] = await Promise.all([
      supabase.from("hh_category").select("*").eq("kind", "income").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
    ]);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setAccounts((accRes.data ?? []) as HhAccount[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

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
      if (editing && target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        sendLog("UPDATE_HH_INCOME", `수입 수정: ${form.amount}원`, { resource: "hh_transaction", resource_id: target.id });
        toast.success("수정되었습니다.");
        router.push(`/dashboard/household/income/${target.id}`);
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
        router.push(`/dashboard/household/income/${ins.id}`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="불러오는 중..." />;

  const noMaster = categories.length === 0 || accounts.length === 0;

  return (
    <PageShell>
      <HhPageHeader
        title={editing ? "수입 수정" : "수입 등록"}
        breadcrumbs={[
          { label: "가계부" },
          { label: "수입", href: "/dashboard/household/income" },
          { label: editing ? "수정" : "등록" },
        ]}
        actions={
          <Button variant="outline" asChild>
            <Link href={editing && target ? `/dashboard/household/income/${target.id}` : "/dashboard/household/income"}>
              <ArrowLeft className="h-4 w-4" />
              취소
            </Link>
          </Button>
        }
      />

      <SectionCard>
        {noMaster ? (
          <p className="text-sm text-muted-foreground">
            수입을 등록하려면 먼저 <b>수입 카테고리</b>와 <b>계좌</b>가 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="max-w-2xl space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="inc-date">날짜 *</Label>
                <Input id="inc-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inc-amount">금액 (원) *</Label>
                <AmountInput id="inc-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} allowFormula placeholder="예: 3,000,000 또는 =3+5+70" required />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="inc-category">항목 *</Label>
                <select id="inc-category" className={selectClass} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
                  <option value="">선택</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="inc-account">입금계좌 *</Label>
                <select id="inc-account" className={selectClass} value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.account_id]).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inc-counterparty">입금처</Label>
              <Input id="inc-counterparty" value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder="예: ○○회사 급여" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inc-memo">메모</Label>
              <Input id="inc-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="상세 내역" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" asChild>
                <Link href={editing && target ? `/dashboard/household/income/${target.id}` : "/dashboard/household/income"}>취소</Link>
              </Button>
              <Button type="submit" disabled={saving}>{saving ? "저장 중..." : editing ? "수정" : "등록"}</Button>
            </div>
          </form>
        )}
      </SectionCard>
    </PageShell>
  );
}
