"use client";

import { AlertTriangle, Check, ChevronRight, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HH_CELL } from "@/components/household/hh-board";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  IMPROVEMENT_SEVERITY_LABEL,
  type HhImprovement,
  type HhImprovementSeverity,
} from "@/lib/household/types";

// 개선사항 게시판 (설계: docs/household/156_improvement_board.md, 팀장 지시 2026-08-07)
//
// 왜 표가 아니라 카드 목록인가
//   담는 내용이 증상·원인·조치·근거의 **산문**이라 길이 상한이 없다. 표로 만들면 네 개의 긴 열이
//   서로 폭을 다투다 전부 좁아진다(설계 122·123 의 폭 규칙으로도 못 푼다 — 그 규칙은 짧은 값을
//   전제한다). 읽는 화면이므로 카드로 펼친다.
//
// 화면에서 할 수 있는 일은 **확인 처리와 메모까지**다(팀장님 선택). 항목 추가·삭제는
// scripts/add_improvement.mts 한 경로로 좁혔다 — 이력이 화면에서 왜곡되면 게시판의 목적을 잃는다.

const SEVERITY_STYLE: Record<HhImprovementSeverity, string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  mid: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  low: "border-border bg-muted/60 text-muted-foreground",
};

const SEVERITY_RANK: Record<HhImprovementSeverity, number> = { high: 0, mid: 1, low: 2 };

function formatDate(value: string | null): string {
  return value ? value.replaceAll("-", ".") : "-";
}

/** 증상 → 원인 → 조치 → 근거. 값이 없는 칸은 아예 그리지 않는다(빈 라벨은 소음이다). */
function DetailRows({ item }: { item: HhImprovement }) {
  const rows: [string, string | null][] = [
    ["증상", item.symptom],
    ["원인", item.root_cause],
    [item.kind === "check" ? "정해야 할 것" : "조치", item.action],
    ["근거", item.evidence],
  ];
  const filled = rows.filter(([, v]) => v && v.trim());
  if (filled.length === 0) return null;
  return (
    <dl className="mt-3 space-y-2 border-t border-border/50 pt-3 text-[0.8rem]">
      {filled.map(([label, value]) => (
        <div key={label} className="flex gap-3">
          <dt className="w-20 shrink-0 font-semibold text-muted-foreground">{label}</dt>
          <dd className={cn("min-w-0 flex-1 whitespace-pre-line text-foreground/90", HH_CELL.wrapText)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 팀장님 확인 필요 — 한 건. 메모는 확인 처리와 함께 저장된다. */
function CheckCard({
  item,
  onResolve,
}: {
  item: HhImprovement;
  onResolve: (id: string, memo: string, status: "done" | "dropped") => Promise<void>;
}) {
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (status: "done" | "dropped") => {
    setBusy(true);
    try {
      await onResolve(item.id, memo, status);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("shrink-0", SEVERITY_STYLE[item.severity])}>
          {IMPROVEMENT_SEVERITY_LABEL[item.severity]}
        </Badge>
        <span className={cn("min-w-0 flex-1 text-sm font-semibold", HH_CELL.wrapText)}>{item.title}</span>
        {item.design_no != null && (
          <Badge variant="outline" className="shrink-0 text-[0.7rem] text-muted-foreground">
            설계 {item.design_no}
          </Badge>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{formatDate(item.occurred_on)}</span>
      </div>

      <DetailRows item={item} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="결정·메모 (선택)"
          className="h-8 min-w-0 flex-1 text-[0.8rem]"
          disabled={busy}
        />
        <Button size="sm" className="h-8 shrink-0 gap-1" onClick={() => run("done")} disabled={busy}>
          <Check className="size-3.5" /> 확인완료
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          onClick={() => run("dropped")}
          disabled={busy}
        >
          해당없음
        </Button>
      </div>
    </li>
  );
}

/** 개선 이력 — 접힌 상태로 제목만, 펼치면 4단 서술. */
function HistoryCard({ item }: { item: HhImprovement }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-2xl border border-border/70 bg-card/85 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-4 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatDate(item.occurred_on)}
        </span>
        <span className={cn("min-w-0 flex-1 text-sm font-medium", HH_CELL.wrapText)}>{item.title}</span>
        {item.status === "dropped" && (
          <Badge variant="outline" className="shrink-0 text-[0.7rem] text-muted-foreground">
            해당없음
          </Badge>
        )}
        {item.design_no != null && (
          <Badge variant="outline" className="shrink-0 text-[0.7rem] text-muted-foreground">
            설계 {item.design_no}
          </Badge>
        )}
      </button>
      {open && (
        <div className="px-4 pb-4">
          <DetailRows item={item} />
          {item.checked_memo && (
            <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-[0.8rem]">
              <span className="font-semibold text-muted-foreground">팀장 메모 </span>
              <span className={HH_CELL.wrapText}>{item.checked_memo}</span>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ImprovementBoard() {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<HhImprovement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("hh_improvement")
      .select("*")
      // ★nullsFirst: false — Postgres 의 DESC 기본은 NULLS FIRST 라, 날짜 없는 항목이
      //   최신순 목록 맨 위에 고정된다(`occurred_on` 은 nullable 이다).
      .order("occurred_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) {
      // 조용히 빈 목록으로 떨어뜨리지 않는다 — 빈 게시판과 로드 실패는 다른 상태다.
      setError(error.message);
      setItems([]);
      return;
    }
    setError(null);
    setItems((data ?? []) as HhImprovement[]);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, memo: string, status: "done" | "dropped") => {
      // ★.select() 로 **바뀐 행 수**까지 본다 — RLS 에 걸리거나 행이 이미 사라졌으면
      //   PostgREST 는 에러 없이 0행을 돌려준다. 그대로 두면 "확인 처리했습니다" 를 띄운 뒤
      //   load() 가 옛 상태를 다시 그려 토스트와 화면이 모순된다(2026-08-08 리뷰 지적).
      const { data, error } = await supabase
        .from("hh_improvement")
        .update({
          status,
          checked_at: new Date().toISOString(),
          checked_memo: memo.trim() || null,
        })
        .eq("id", id)
        .select("id");
      if (error) {
        toast.error(`저장하지 못했습니다: ${error.message}`);
        return;
      }
      if ((data ?? []).length !== 1) {
        toast.error("저장되지 않았습니다 — 항목이 사라졌거나 권한이 없습니다. 새로고침해 주세요.");
        await load();
        return;
      }
      toast.success(status === "done" ? "확인 처리했습니다." : "해당없음으로 내렸습니다.");
      await load();
    },
    [supabase, load]
  );

  const pending = useMemo(
    () =>
      (items ?? [])
        .filter((i) => i.kind === "check" && i.status === "open")
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [items]
  );
  // 개선 이력 = fix 전부 + 확인이 끝난 check(결정도 이력이다).
  const history = useMemo(
    () => (items ?? []).filter((i) => i.kind === "fix" || i.status !== "open"),
    [items]
  );

  if (items === null) {
    return <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          목록을 불러오지 못했습니다 — {error}
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-500" />
          <h3 className="text-sm font-semibold">팀장님 확인 필요</h3>
          <Badge variant="outline" className="text-[0.7rem]">
            {pending.length}건
          </Badge>
        </div>
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            확인이 필요한 항목이 없습니다.
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.map((item) => (
              <CheckCard key={item.id} item={item} onResolve={resolve} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">개선 이력</h3>
          <Badge variant="outline" className="text-[0.7rem]">
            {history.length}건
          </Badge>
          <span className="text-xs text-muted-foreground">오판·재점검·개선의 과정을 남깁니다.</span>
        </div>
        {history.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            아직 쌓인 이력이 없습니다.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((item) => (
              <HistoryCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
