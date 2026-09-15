"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { InstallmentForm } from "@/components/household/installment-form";
import { ErrorState, LoadingState } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { HhInstallment } from "@/lib/household/types";

export default function HouseholdInstallmentEditPage() {
  const supabase = useMemo(() => createClient(), []);
  const params = useParams();
  const id = params.id as string;
  const [target, setTarget] = useState<HhInstallment | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOne = useCallback(async () => {
    await supabase.auth.getSession();
    const { data } = await supabase.from("hh_installment").select("*").eq("id", id).single();
    setTarget((data as HhInstallment) ?? null);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOne();
  }, [fetchOne]);

  if (loading) return <LoadingState label="불러오는 중..." />;
  if (!target)
    return (
      <ErrorState title="할부를 찾을 수 없습니다." action={<Button asChild variant="outline"><Link href="/dashboard/household/expenses">목록으로</Link></Button>} />
    );
  return <InstallmentForm target={target} />;
}
