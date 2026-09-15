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
import type { HhLoan } from "@/lib/household/types";

export default function HouseholdLoanDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [row, setRow] = useState<HhLoan | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data } = await supabase.from("hh_loan").select("*").eq("id", id).single();
    setRow((data as HhLoan) ?? null);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  const handleDelete = async () => {
    if (!row || deleting) return;
    if (!confirm(`'${row.name}' 대출을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const { error: err } = await supabase.from("hh_loan").delete().eq("id", id);
    if (err) {
      toast.error(`삭제 실패: ${err.message}`);
      setDeleting(false);
      return;
    }
    toast.success("삭제되었습니다.");
    router.push("/dashboard/household/loans");
  };

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!row)
    return <ErrorState title="대출을 찾을 수 없습니다." description="이미 삭제되었거나 접근할 수 없는 내역입니다." action={<Button asChild variant="outline"><Link href="/dashboard/household/loans">목록으로</Link></Button>} />;

  const repaid = row.principal > 0 ? Math.min(100, Math.round(((row.principal - row.current_balance) / row.principal) * 100)) : 0;

  return (
    <PageShell>
      <HhPageHeader
        title={mask("owner_name", row.name)}
        breadcrumbs={[{ label: "가계부" }, { label: "대출관리", href: "/dashboard/household/loans" }, { label: mask("owner_name", row.name) }]}
        actions={
          <>
            <Button variant="outline" asChild><Link href="/dashboard/household/loans"><ArrowLeft className="h-4 w-4" />목록</Link></Button>
            <Button variant="outline" asChild><Link href={`/dashboard/household/loans/${id}/edit`}><PencilLine className="h-4 w-4" />수정</Link></Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}><Trash2 className="h-4 w-4" />{deleting ? "삭제 중..." : "삭제"}</Button>
          </>
        }
      />
      <SectionCard>
        <HhField label="상태" value={row.status === "closed" ? <Badge variant="secondary">완료</Badge> : <Badge>상환중</Badge>} />
        <HhField label="대출금액 (원금)" value={<span className="tabular-nums">{mask("expense_amount",`${row.principal.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="현재 잔액" value={<span className="font-semibold tabular-nums">{mask("expense_amount",`${row.current_balance.toLocaleString("ko-KR")}원`)}</span>} />
        <HhField label="상환 진행" value={`${repaid}%`} />
        <HhField label="이자율" value={row.interest_rate != null ? `${row.interest_rate}%` : "-"} />
        <HhField label="월납입금" value={row.monthly_payment != null ? mask("expense_amount",`${row.monthly_payment.toLocaleString("ko-KR")}원`) : "-"} />
        <HhField label="대출일" value={row.origin_date ?? "-"} />
        <HhField label="만기일" value={row.maturity_date ?? "-"} />
        <HhField label="상환일" value={row.payment_day != null ? `매월 ${row.payment_day}일` : "-"} />
      </SectionCard>
    </PageShell>
  );
}
