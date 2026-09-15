"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shiftMonth, thisMonthKey } from "@/lib/household/month";
import { cn } from "@/lib/utils";

type Crumb = { label: string; href?: string };

/**
 * 가계부 전용 경량 헤더. 공통 PageHeader(테두리 카드)보다 얇게 — 수신공문 화면처럼
 * 제목 + 옆 설명 + 우측 액션만. 상단 여백을 줄인다.
 * 색 규율(설계 80): 긴 안내문은 상시 노출하지 않고 `help`(ⓘ 팝오버)로 접는다.
 * `description`은 한 줄 이내 요약만.
 */
export function HhPageHeader({
  title,
  description,
  help,
  breadcrumbs,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  /** 긴 설명·계산 규칙. ⓘ 아이콘을 눌렀을 때만 보인다. */
  help?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {breadcrumbs.map((c, i) => (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 ? <ChevronRight className="size-3.5 shrink-0" /> : null}
                {c.href ? (
                  <Link href={c.href} className="transition-colors hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          {/* 모바일에선 부제(설명글)를 숨긴다 — 같은 내용이 ⓘ 도움말에 있어 중복이라 화면을 아낀다. */}
          {description ? <p className="hidden text-sm text-muted-foreground md:block">{description}</p> : null}
          {help ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="화면 설명 보기"
                  className="inline-flex size-5 items-center justify-center self-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <CircleHelp className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 text-sm leading-6 text-muted-foreground">
                {help}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * 가계부 표준 월 네비게이션. 결제관리 화면의 컨트롤을 공용화한 것 —
 * 가계부의 월 단위 화면(수입·지출·현금·결제관리)은 모두 이걸 헤더 바로 아래에 둔다.
 * `status` 슬롯에는 우측 배지/저장표시 등을 넣는다.
 */
export function HhMonthNav({
  month,
  onChange,
  status,
  className,
}: {
  month: string;
  onChange: (next: string) => void;
  status?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onChange(shiftMonth(month, -1))} aria-label="이전 달">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="inline-flex min-w-28 items-center justify-center gap-1.5 text-base font-semibold">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          {month}
        </span>
        <Button variant="outline" size="sm" onClick={() => onChange(shiftMonth(month, 1))} aria-label="다음 달">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(thisMonthKey())}>
          이번 달
        </Button>
      </div>
      {status ? <div className="flex items-center gap-2">{status}</div> : null}
    </div>
  );
}

/** 상세 페이지 본문의 한 줄 필드(라벨 - 값). */
export function HhField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/40 py-3 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
