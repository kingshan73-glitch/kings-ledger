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
import { syncChargeIncentive } from "@/lib/household/sync-incentive";
import type { HhAccount, HhTransaction } from "@/lib/household/types";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TransferForm({ target }: { target: HhTransaction | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const editing = !!target;

  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  // 비활성 계좌 숨기기(설계 89) — 지금 고른 계좌는 비활성이어도 남긴다(수정 모드 보호).
  const [hideInactiveAccounts] = useHideInactiveAccounts();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    txn_date: target?.txn_date ?? todayLocal(),
    from_account_id: target?.from_account_id ?? "",
    to_account_id: target?.to_account_id ?? "",
    amount: target?.amount ?? 0,
    memo: target?.memo ?? "",
  });

  const loadMasters = useCallback(async () => {
    await supabase.auth.getSession();
    const { data } = await supabase.from("hh_account").select("*").order("sort_order").order("name");
    setAccounts((data ?? []) as HhAccount[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters]);

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

      // 팝업(transfer-edit-dialog)과 같은 공용 구현을 쓴다. 예전엔 이 폼에 인센티브 로직이
      // 아예 없어서, 이 경로로 충전액을 고치면 딸린 인센티브가 옛 금액으로 남아 잔액이 틀어졌다.
      const sync = (txnId: string) =>
        syncChargeIncentive(supabase, {
          txnId,
          owner,
          accounts,
          txnDate: form.txn_date,
          amount: form.amount,
          toAccountId: form.to_account_id,
        });

      if (editing && target) {
        const { error: err } = await supabase.from("hh_transaction").update(payload).eq("id", target.id);
        if (err) return toast.error(`수정 실패: ${err.message}`);
        const r = await sync(target.id);
        if (!r.ok) toast.warning(r.message);
        toast.success(r.ok && r.message ? `수정되었습니다. ${r.message}` : "수정되었습니다.");
        router.push(`/dashboard/household/transfers/${target.id}`);
      } else {
        const { data: ins, error: err } = await supabase.from("hh_transaction").insert({ ...payload, owner_auth_uid: owner, source: "manual" }).select("id").single();
        if (err) return toast.error(`등록 실패: ${err.message}`);
        sendLog("CREATE_HH_TRANSFER", `통장이동: ${form.amount}원`, { resource: "hh_transaction", resource_id: ins.id });
        const r = await sync(ins.id);
        if (!r.ok) toast.warning(r.message);
        toast.success(r.ok && r.message ? `통장이동이 등록되었습니다. ${r.message}` : "통장이동이 등록되었습니다.");
        router.push(`/dashboard/household/transfers/${ins.id}`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  const noAccounts = accounts.length < 2;
  const backHref = editing && target ? `/dashboard/household/transfers/${target.id}` : "/dashboard/household/transfers";

  return (
    <PageShell>
      <HhPageHeader
        title={editing ? "통장이동 수정" : "통장이동 등록"}
        breadcrumbs={[{ label: "가계부" }, { label: "통장이동", href: "/dashboard/household/transfers" }, { label: editing ? "수정" : "등록" }]}
        actions={<Button variant="outline" asChild><Link href={backHref}><ArrowLeft className="h-4 w-4" />취소</Link></Button>}
      />
      <SectionCard>
        {noAccounts ? (
          <p className="text-sm text-muted-foreground">통장이동을 등록하려면 계좌가 2개 이상 필요합니다. 설정에서 계좌를 추가하세요.</p>
        ) : (
          <form onSubmit={submit} className="max-w-2xl space-y-5">
            <div className="space-y-2">
              <Label htmlFor="tr-date">날짜 *</Label>
              <Input id="tr-date" type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="tr-from">출금계좌 *</Label>
                <select id="tr-from" className={selectClass} value={form.from_account_id} onChange={(e) => setForm({ ...form, from_account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.from_account_id]).map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tr-to">입금계좌 *</Label>
                <select id="tr-to" className={selectClass} value={form.to_account_id} onChange={(e) => setForm({ ...form, to_account_id: e.target.value })} required>
                  <option value="">선택</option>
                  {pickVisibleAccounts(accounts, hideInactiveAccounts, [form.to_account_id]).map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tr-amount">금액 (원) *</Label>
              <AmountInput id="tr-amount" value={form.amount} onValueChange={(n) => setForm({ ...form, amount: n })} placeholder="예: 500,000" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tr-memo">메모</Label>
              <Input id="tr-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="이체 사유" />
            </div>
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
