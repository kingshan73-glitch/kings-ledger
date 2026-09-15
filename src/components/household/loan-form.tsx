"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { Button } from "@/components/ui/button";
import { LoanFormFields } from "@/components/household/loan-form-fields";
import { createClient } from "@/lib/supabase/client";
import { loanFormFrom, loanFormWarnings, saveLoan, validateLoanForm, type LoanFormState } from "@/lib/household/loan-save";
import type { HhAccount, HhLoan } from "@/lib/household/types";

// 대출 등록·수정 페이지 (`/new`, `/[id]/edit`). 목록에서는 링크하지 않고
// 직접 URL 접근용으로 존치한다(설계 82). 평소 동선은 목록의 팝업(LoanDialog)이다.
//
// 목록을 거치지 않고 진입하므로 계좌를 props 로 받을 수 없어 여기서 직접 조회한다 —
// 규약이 막는 것은 "목록이 이미 들고 있는 마스터를 팝업이 또 조회하는" 중복이다(설계 96).
export function LoanForm({ target }: { target: HhLoan | null }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const editing = !!target;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<LoanFormState>(() => loanFormFrom(target));
  const [accounts, setAccounts] = useState<HhAccount[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.from("hh_account").select("*").order("sort_order", { ascending: true });
      if (!cancelled) setAccounts((data ?? []) as HhAccount[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 무효 폼이면 경고 confirm 을 띄우지 않는다 — saveLoan 의 검증 메시지가 먼저다.
    const warns = validateLoanForm(form) ? [] : loanFormWarnings(form);
    if (warns.length && !window.confirm(warns.join("\n") + "\n\n그대로 저장할까요?")) return;
    setSaving(true);
    try {
      const result = await saveLoan(supabase, form, target);
      if (!result.ok) return toast.error(result.message);
      toast.success(editing ? "수정되었습니다." : "대출이 등록되었습니다.");
      router.push(`/dashboard/household/loans/${result.id}`);
    } finally {
      setSaving(false);
    }
  };

  const backHref = editing && target ? `/dashboard/household/loans/${target.id}` : "/dashboard/household/loans";

  return (
    <PageShell>
      <HhPageHeader
        title={editing ? "대출 수정" : "대출 등록"}
        breadcrumbs={[{ label: "가계부" }, { label: "대출관리", href: "/dashboard/household/loans" }, { label: editing ? "수정" : "등록" }]}
        actions={<Button variant="outline" asChild><Link href={backHref}><ArrowLeft className="h-4 w-4" />취소</Link></Button>}
      />
      <SectionCard>
        <form onSubmit={submit} className="max-w-2xl space-y-5">
          <LoanFormFields form={form} setForm={setForm} accounts={accounts} idPrefix="loan" />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" asChild><Link href={backHref}>취소</Link></Button>
            <Button type="submit" disabled={saving}>{saving ? "저장 중..." : editing ? "수정" : "등록"}</Button>
          </div>
        </form>
      </SectionCard>
    </PageShell>
  );
}
