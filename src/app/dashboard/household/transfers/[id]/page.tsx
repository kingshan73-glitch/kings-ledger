"use client";

import Link from "next/link";
import { ArrowLeft, PencilLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { ErrorState, LoadingState, PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader, HhField } from "@/components/household/hh-page-header";
import { useMasking } from "@/components/masking-provider";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { HhTransaction } from "@/lib/household/types";

export default function HouseholdTransferDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [row, setRow] = useState<HhTransaction | null>(null);
  const [names, setNames] = useState({ from: "-", to: "-" });
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data: t } = await supabase.from("hh_transaction").select("*").eq("id", id).eq("type", "transfer").single();
    if (!t) {
      setRow(null);
      setLoading(false);
      return;
    }
    const [fr, to] = await Promise.all([
      t.from_account_id ? supabase.from("hh_account").select("name").eq("id", t.from_account_id).single() : Promise.resolve({ data: null }),
      t.to_account_id ? supabase.from("hh_account").select("name").eq("id", t.to_account_id).single() : Promise.resolve({ data: null }),
    ]);
    setRow(t as HhTransaction);
    setNames({
      from: (fr.data as { name: string } | null)?.name ?? "-",
      to: (to.data as { name: string } | null)?.name ?? "-",
    });
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  const handleDelete = async () => {
    if (!row || deleting) return;
    if (!confirm(`${row.txn_date} · ${row.amount.toLocaleString("ko-KR")}원 이체를 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const { error: err } = await supabase.from("hh_transaction").delete().eq("id", id);
    if (err) {
      toast.error(`삭제 실패: ${err.message}`);
      setDeleting(false);
      return;
    }
    toast.success("삭제되었습니다.");
    router.push("/dashboard/household/transfers");
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!row)
    return <ErrorState title="통장이동을 찾을 수 없습니다." description="이미 삭제되었거나 접근할 수 없는 내역입니다." action={<Button asChild variant="outline"><Link href="/dashboard/household/transfers">목록으로</Link></Button>} />;

  return (
    <PageShell>
      <HhPageHeader
        title={`${mask("owner_name", names.from)} → ${mask("owner_name", names.to)}`}
        breadcrumbs={[{ label: "가계부" }, { label: "통장이동", href: "/dashboard/household/transfers" }, { label: "상세" }]}
        actions={
          <>
            <Button variant="outline" asChild><Link href="/dashboard/household/transfers"><ArrowLeft className="h-4 w-4" />목록</Link></Button>
            <Button variant="outline" asChild><Link href={`/dashboard/household/transfers/${id}/edit`}><PencilLine className="h-4 w-4" />수정</Link></Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}><Trash2 className="h-4 w-4" />{deleting ? "삭제 중..." : "삭제"}</Button>
          </>
        }
      />
      <SectionCard>
        <HhField label="날짜" value={row.txn_date} />
        <HhField label="출금계좌" value={mask("owner_name", names.from)} />
        <HhField label="입금계좌" value={mask("owner_name", names.to)} />
        <HhField label="금액" value={<span className="tabular-nums">{mask("amount", `${row.amount.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="메모" value={row.memo ?? "-"} />
      </SectionCard>
    </PageShell>
  );
}
