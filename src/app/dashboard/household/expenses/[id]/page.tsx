"use client";

import Link from "next/link";
import { ArrowLeft, PencilLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { ErrorState, LoadingState, PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader, HhField } from "@/components/household/hh-page-header";
import { useMasking } from "@/components/masking-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import type { HhTransaction } from "@/lib/household/types";

export default function HouseholdExpenseDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [row, setRow] = useState<HhTransaction | null>(null);
  const [names, setNames] = useState({ category: "-", method: "-", account: "-", person: "" });
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data: t } = await supabase.from("hh_transaction").select("*").eq("id", id).eq("type", "expense").single();
    if (!t) {
      setRow(null);
      setLoading(false);
      return;
    }
    const [cat, pm, acc, per] = await Promise.all([
      t.category_id ? supabase.from("hh_category").select("name").eq("id", t.category_id).single() : Promise.resolve({ data: null }),
      t.payment_method_id ? supabase.from("hh_payment_method").select("name").eq("id", t.payment_method_id).single() : Promise.resolve({ data: null }),
      t.account_id ? supabase.from("hh_account").select("name").eq("id", t.account_id).single() : Promise.resolve({ data: null }),
      t.person_id ? supabase.from("hh_person").select("name").eq("id", t.person_id).single() : Promise.resolve({ data: null }),
    ]);
    setRow(t as HhTransaction);
    setNames({
      category: (cat.data as { name: string } | null)?.name ?? "-",
      method: (pm.data as { name: string } | null)?.name ?? "-",
      account: (acc.data as { name: string } | null)?.name ?? "-",
      person: (per.data as { name: string } | null)?.name ?? "",
    });
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  const handleDelete = async () => {
    if (!row || deleting) return;
    if (!confirm(`${row.txn_date} · ${row.amount.toLocaleString("ko-KR")}원 지출을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const { error: err } = await supabase.from("hh_transaction").delete().eq("id", id);
    if (err) {
      toast.error(`삭제 실패: ${err.message}`);
      setDeleting(false);
      return;
    }
    sendLog("DELETE_HH_EXPENSE", `지출 삭제: ${row.amount}원`, { resource: "hh_transaction", resource_id: id });
    toast.success("삭제되었습니다.");
    router.push("/dashboard/household/expenses");
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!row)
    return (
      <ErrorState title="지출 내역을 찾을 수 없습니다." description="이미 삭제되었거나 접근할 수 없는 내역입니다." action={<Button asChild variant="outline"><Link href="/dashboard/household/expenses">목록으로</Link></Button>} />
    );

  return (
    <PageShell>
      <HhPageHeader
        title={`${names.category} · ${mask("expense_amount",`${row.amount.toLocaleString("ko-KR")}원`)}`}
        breadcrumbs={[{ label: "가계부" }, { label: "지출", href: "/dashboard/household/expenses" }, { label: row.txn_date }]}
        actions={
          <>
            <Button variant="outline" asChild><Link href="/dashboard/household/expenses"><ArrowLeft className="h-4 w-4" />목록</Link></Button>
            <Button variant="outline" asChild><Link href={`/dashboard/household/expenses/${id}/edit`}><PencilLine className="h-4 w-4" />수정</Link></Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}><Trash2 className="h-4 w-4" />{deleting ? "삭제 중..." : "삭제"}</Button>
          </>
        }
      />
      <SectionCard>
        <HhField label="날짜" value={row.txn_date} />
        <HhField label="카테고리" value={names.category} />
        <HhField label="금액" value={<span className="font-semibold tabular-nums">{mask("expense_amount",`${row.amount.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="지불방식" value={mask("owner_name", names.method)} />
        <HhField label="출금계좌" value={row.account_id ? mask("owner_name", names.account) : "-"} />
        <HhField label="가맹점" value={row.counterparty ? mask("merchant", row.counterparty) : "-"} />
        <HhField label="내역" value={row.memo ? mask("merchant", row.memo) : "-"} />
        <HhField label="용돈 귀속" value={names.person ? <Badge variant="secondary">{mask("name", names.person)}</Badge> : "-"} />
      </SectionCard>
    </PageShell>
  );
}
