"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Info } from "lucide-react";

import { SectionIntro } from "@/components/page-shell";
import { createClient } from "@/lib/supabase/client";
import { computeDataHealth, type DataHealth, type HealthLevel } from "@/lib/household/data-health";
import { fetchTxnsPaged } from "@/lib/household/fetch-txns";
import { seoulToday } from "@/lib/household/sms";
import type { HhCategory, HhPaymentMethod } from "@/lib/household/types";

const LEVEL_STYLE: Record<HealthLevel, { dot: string; text: string }> = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  warn: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  bad: { dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-400" },
};

/**
 * 데이터 건강도 — 지금 보는 숫자를 얼마나 믿어도 되는지 먼저 알려준다. (설계 91 §4)
 * 통계 요약 맨 위에 둔다. 숫자가 틀렸을 때 조용히 틀리는 게 가장 위험하기 때문이다.
 * 집계 범위는 올해 — 과거 8년치까지 매번 훑으면 요약 진입이 느려진다.
 */
export function DataHealthCard() {
  const supabase = createClient();
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [open, setOpen] = useState(false);

  const fetchData = useCallback(async () => {
    const today = seoulToday();
    const from = `${today.slice(0, 4)}-01-01`;
    const [txns, catRes, pmRes, ingestRes] = await Promise.all([
      fetchTxnsPaged(supabase, from, today),
      supabase.from("hh_category").select("*"),
      supabase.from("hh_payment_method").select("*"),
      supabase.from("hh_transaction_inbox").select("created_at").order("created_at", { ascending: false }).limit(1),
    ]);
    // 거래 로드 실패면 건강도를 그리지 않는다 — 빈 데이터로 "문제 없음"을 띄우면 거짓 안심이 된다.
    if (!txns) return;
    setHealth(
      computeDataHealth({
        txns,
        categories: (catRes.data ?? []) as HhCategory[],
        paymentMethods: (pmRes.data ?? []) as HhPaymentMethod[],
        lastIngestAt: ingestRes.data?.[0]?.created_at ?? null,
        today,
      })
    );
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  if (!health) return null;

  const problems = health.items.filter((i) => i.level !== "ok");
  const headline =
    health.worst === "ok"
      ? "올해 데이터에서 발견된 공백이 없습니다. 통계를 그대로 보셔도 됩니다."
      : `확인이 필요한 항목이 ${problems.length}가지 있습니다. 아래 숫자는 그만큼 덜 정확할 수 있습니다.`;

  return (
    <section className="space-y-3">
      <SectionIntro
        title="데이터 건강도"
        description="통계를 보기 전에, 지금 데이터에 빠진 곳이 있는지 먼저 확인합니다. (올해 기준)"
      />
      <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
        <div className="flex items-start gap-2">
          {health.worst === "ok" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${LEVEL_STYLE[health.worst].text}`} />
          )}
          <p className="text-sm font-medium text-foreground">{headline}</p>
        </div>

        {/* 항목은 폭을 균등 분할해 간격을 고르게 둔다 (CLAUDE.md 전역 규칙) */}
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {health.items.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/50 px-3 py-2"
            >
              <span className={`size-2 shrink-0 rounded-full ${LEVEL_STYLE[item.level].dot}`} aria-hidden />
              {/* truncate 금지 — "대출 미연결 상환"이 "대출 미..."로 잘려 지표 의미가 사라졌다. 긴 라벨은 단어 단위로 줄바꿈. (설계 99 B) */}
              <span className="min-w-0 flex-1 break-keep text-sm leading-tight text-muted-foreground">{item.label}</span>
              <span className={`shrink-0 text-sm font-semibold tabular-nums ${LEVEL_STYLE[item.level].text}`}>
                {item.value}
              </span>
            </li>
          ))}
        </ul>

        {problems.length > 0 ? (
          <>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <Info className="size-3.5" />
              왜 확인이 필요한가요?
              <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open ? (
              <dl className="mt-2 space-y-2 rounded-xl bg-muted/40 p-3">
                {problems.map((item) => (
                  <div key={item.key}>
                    <dt className="text-sm font-medium text-foreground">{item.label}</dt>
                    <dd className="text-sm text-muted-foreground">{item.hint}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
