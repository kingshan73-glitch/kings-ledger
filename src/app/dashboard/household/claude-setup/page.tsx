"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Package, CalendarClock, CalendarDays, Boxes } from "lucide-react";
import { toast } from "sonner";

import { PageShell, StatsGrid, StatCard } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { Badge } from "@/components/ui/badge";
import data from "@/data/claude-installs.json";

type Install = {
  id: string;
  name: string;
  category: string;
  version: string;
  date: string | null;
  source: string | null;
  note: string;
  install: string;
};

// 카테고리별 표시색(라이트·다크 모두 자연스러운 500번대). 뱃지 앞 점으로만 구분.
const CATEGORY_DOT: Record<string, string> = {
  "AI 코딩": "#7c5cff",
  런타임: "#10b981",
  버전관리: "#f59e0b",
  "배포·DB": "#0ea5e9",
  에디터: "#64748b",
  도구: "#f43f5e",
};

function InstallCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copyable = !cmd.startsWith("(");

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      toast.success("설치 명령을 복사했습니다.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("복사에 실패했습니다. 직접 선택해 복사해 주세요.");
    }
  }

  return (
    <div className="flex items-center gap-2 overflow-hidden rounded-xl border border-border/70 bg-muted/50 pl-3 pr-1.5 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground/90">{cmd}</code>
      {copyable ? (
        <button
          type="button"
          onClick={copy}
          aria-label="설치 명령 복사"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </button>
      ) : null}
    </div>
  );
}

export default function ClaudeSetupPage() {
  const items = data.items as Install[];

  // 처음 설치한 것부터(설치일 오름차순) 위→아래로. 날짜 없는 것은 맨 뒤.
  const ordered = useMemo(
    () =>
      [...items].sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      }),
    [items]
  );

  const latest = useMemo(() => items.map((i) => i.date).filter(Boolean).sort().at(-1) ?? "-", [items]);

  return (
    <PageShell>
      <HhPageHeader
        title="클로드코드 설치"
        description="이 노트북에 설치된 개발 도구를 설치일별로 정리했습니다."
        help={
          <div className="space-y-1.5">
            <p>이 노트북(로컬 PC)에 설치된 클로드코드 관련 개발 툴체인의 <b>스냅샷</b>입니다.</p>
            <p>앱은 서버에서 돌아 실시간으로 PC를 읽을 수 없어, <code className="font-mono text-xs">scripts/scan_claudecode_installs.mjs</code> 로 스캔한 결과를 저장해 보여줍니다.</p>
            <p>새로 설치·업데이트한 뒤 <b>&ldquo;설치목록 갱신해&rdquo;</b> 하면 다시 스캔해 갱신됩니다.</p>
          </div>
        }
      />

      <StatsGrid columns={3}>
        <StatCard label="설치 프로그램" value={`${items.length}개`} icon={Boxes} />
        <StatCard label="최근 설치일" value={latest} icon={CalendarClock} />
        <StatCard label="스냅샷 기준일" value={data.scannedAt} icon={Package} />
      </StatsGrid>

      {/* 처음 설치한 것부터 아래로 한 줄씩. 날짜는 각 항목 옆(가운데 여백)에 인라인 표시. */}
      <div className="space-y-3">
        {ordered.map((it) => (
          <div key={it.id} className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
              {/* 좌: 이름·버전·카테고리 + (오른쪽에) 설치일 · 용도 */}
              <div className="min-w-0 md:flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-foreground">{it.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{it.version}</span>
                    <Badge variant="secondary" className="gap-1.5">
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: CATEGORY_DOT[it.category] ?? "#94a3b8" }} />
                      {it.category}
                    </Badge>
                  </div>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    <CalendarDays className="size-3.5" />
                    {it.date ?? "날짜 미상"}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{it.note}</p>
              </div>
              {/* 우: 설치 명령 (넓은 화면에서 오른쪽 고정폭) */}
              <div className="md:w-[440px] md:shrink-0">
                <InstallCommand cmd={it.install} />
                {it.source ? <p className="mt-1.5 text-[11px] text-muted-foreground/80">출처 · {it.source}</p> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
