"use client";

import Link from "next/link";
import { ArrowLeft, PencilLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { ErrorState, LoadingState, PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { useMasking } from "@/components/masking-provider";
import { Button } from "@/components/ui/button";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import type { HhTransaction } from "@/lib/household/types";

type IncomeRow = HhTransaction & {
  hh_category: { name: string } | null;
  hh_account: { name: string } | null;
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/40 py-3 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export default function HouseholdIncomeDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [row, setRow] = useState<IncomeRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data: t } = await supabase.from("hh_transaction").select("*").eq("id", id).eq("type", "income").single();
    if (!t) {
      setRow(null);
      setLoading(false);
      return;
    }
    const [catRes, accRes] = await Promise.all([
      t.category_id ? supabase.from("hh_category").select("name").eq("id", t.category_id).single() : Promise.resolve({ data: null }),
      t.account_id ? supabase.from("hh_account").select("name").eq("id", t.account_id).single() : Promise.resolve({ data: null }),
    ]);
    setRow({ ...(t as HhTransaction), hh_category: catRes.data, hh_account: accRes.data } as IncomeRow);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  const handleDelete = async () => {
    if (!row || deleting) return;
    if (!confirm(`${row.txn_date} · ${row.amount.toLocaleString("ko-KR")}원 수입을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const { error: err } = await supabase.from("hh_transaction").delete().eq("id", id);
    if (err) {
      toast.error(`삭제 실패: ${err.message}`);
      setDeleting(false);
      return;
    }
    sendLog("DELETE_HH_INCOME", `수입 삭제: ${row.amount}원`, { resource: "hh_transaction", resource_id: id });
    toast.success("삭제되었습니다.");
    router.push("/dashboard/household/income");
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!row)
    return (
      <ErrorState
        title="수입 내역을 찾을 수 없습니다."
        description="이미 삭제되었거나 접근할 수 없는 내역입니다."
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard/household/income">목록으로</Link>
          </Button>
        }
      />
    );

  const title = `${row.hh_category?.name ?? "수입"} · ${mask("income_amount", `${row.amount.toLocaleString("ko-KR")}원`)}`;

  return (
    <PageShell>
      <HhPageHeader
        title={title}
        breadcrumbs={[{ label: "가계부" }, { label: "수입", href: "/dashboard/household/income" }, { label: row.txn_date }]}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/dashboard/household/income">
                <ArrowLeft className="h-4 w-4" />
                목록
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/dashboard/household/income/${id}/edit`}>
                <PencilLine className="h-4 w-4" />
                수정
              </Link>
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              <Trash2 className="h-4 w-4" />
              {deleting ? "삭제 중..." : "삭제"}
            </Button>
          </>
        }
      />

      <SectionCard>
        <Field label="날짜" value={row.txn_date} />
        <Field label="항목" value={row.hh_category?.name ?? "-"} />
        <Field label="금액" value={<span className="font-semibold tabular-nums text-blue-600 dark:text-blue-400">{mask("income_amount", `${row.amount.toLocaleString("ko-KR")}원`)}</span>} />
        <Field label="입금처" value={row.counterparty ? mask("merchant", row.counterparty) : "-"} />
        <Field label="입금계좌" value={row.hh_account?.name ? mask("owner_name", row.hh_account.name) : "-"} />
        <Field label="메모" value={row.memo ?? "-"} />
      </SectionCard>
    </PageShell>
  );
}
