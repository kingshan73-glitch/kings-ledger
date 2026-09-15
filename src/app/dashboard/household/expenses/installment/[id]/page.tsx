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
import { createClient } from "@/lib/supabase/client";
import { installmentProgress } from "@/lib/household/calc";
import { thisMonthKey } from "@/lib/household/month";
import type { HhInstallment } from "@/lib/household/types";

export default function HouseholdInstallmentDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [row, setRow] = useState<HhInstallment | null>(null);
  const [names, setNames] = useState({ category: "-", method: "-" });
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data: t } = await supabase.from("hh_installment").select("*").eq("id", id).single();
    if (!t) {
      setRow(null);
      setLoading(false);
      return;
    }
    const [cat, pm] = await Promise.all([
      t.category_id ? supabase.from("hh_category").select("name").eq("id", t.category_id).single() : Promise.resolve({ data: null }),
      t.payment_method_id ? supabase.from("hh_payment_method").select("name").eq("id", t.payment_method_id).single() : Promise.resolve({ data: null }),
    ]);
    setRow(t as HhInstallment);
    setNames({
      category: (cat.data as { name: string } | null)?.name ?? "-",
      method: (pm.data as { name: string } | null)?.name ?? "-",
    });
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  const handleDelete = async () => {
    if (!row || deleting) return;
    if (!confirm(`'${row.title ?? "할부"}' 할부를 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const { error: err } = await supabase.from("hh_installment").delete().eq("id", id);
    if (err) {
      toast.error(`삭제 실패: ${err.message}`);
      setDeleting(false);
      return;
    }
    toast.success("삭제되었습니다.");
    router.push("/dashboard/household/expenses");
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!row)
    return (
      <ErrorState title="할부를 찾을 수 없습니다." description="이미 삭제되었거나 접근할 수 없는 내역입니다." action={<Button asChild variant="outline"><Link href="/dashboard/household/expenses">목록으로</Link></Button>} />
    );

  const p = installmentProgress(row, thisMonthKey());
  const shownCurrent = Math.min(Math.max(p.current, 0), row.total_count);
  const done = p.current > row.total_count;

  return (
    <PageShell>
      <HhPageHeader
        title={`${row.title ?? "할부"} · ${mask("expense_amount",`${row.total_amount.toLocaleString("ko-KR")}원`)}`}
        breadcrumbs={[{ label: "가계부" }, { label: "지출", href: "/dashboard/household/expenses" }, { label: "할부" }]}
        actions={
          <>
            <Button variant="outline" asChild><Link href="/dashboard/household/expenses"><ArrowLeft className="h-4 w-4" />목록</Link></Button>
            <Button variant="outline" asChild><Link href={`/dashboard/household/expenses/installment/${id}/edit`}><PencilLine className="h-4 w-4" />수정</Link></Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}><Trash2 className="h-4 w-4" />{deleting ? "삭제 중..." : "삭제"}</Button>
          </>
        }
      />
      <SectionCard>
        <HhField label="시작일" value={row.start_date} />
        <HhField label="카드" value={mask("owner_name", names.method)} />
        <HhField label="카테고리" value={names.category} />
        <HhField label="내용" value={row.title ?? "-"} />
        <HhField label="총금액" value={<span className="tabular-nums">{mask("expense_amount",`${row.total_amount.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="월 금액" value={<span className="tabular-nums">{mask("expense_amount",`${p.monthly.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="진행" value={`${shownCurrent} / ${row.total_count}회`} />
        <HhField label="잔액" value={<span className="tabular-nums">{mask("expense_amount",`${p.remaining.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="상태" value={!row.is_active ? <Badge variant="secondary">비활성</Badge> : done ? <Badge variant="secondary">완료</Badge> : <Badge>진행중</Badge>} />
      </SectionCard>
    </PageShell>
  );
}
