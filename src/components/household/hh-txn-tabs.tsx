"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 수입·지출·통장이동 세 화면을 하나의 메뉴('거래관리')로 묶는 탭 바. (설계 141)
 *
 * 왜 라우트를 합치지 않았나: 세 화면은 각자 목록·필터·팝업·엑셀 일괄등록(`/new`)을 갖고 있어
 * 한 페이지로 합치면 위험이 크다. **주소는 그대로 두고 이동 수단만 탭으로 바꿨다** —
 * 기존 링크·북마크·'여러 건 입력' 경로가 전부 그대로 산다.
 *
 * 탭 순서 = 수입(들어옴) · 지출(나감) · 통장이동(내 계좌끼리). 사이드바는 '지출'로 들어온다.
 */
const TABS = [
  { href: "/dashboard/household/income", label: "수입", icon: ArrowDownToLine },
  { href: "/dashboard/household/expenses", label: "지출", icon: ArrowUpFromLine },
  { href: "/dashboard/household/transfers", label: "통장이동", icon: ArrowLeftRight },
] as const;

export function HhTxnTabs() {
  const pathname = usePathname();

  return (
    // 탭 자체가 좁은 화면에서 줄바꿈되지 않도록 가로 스크롤 허용(설정 화면 탭과 같은 규율).
    // ★overflow-x 단독이면 overflow-y 가 auto 로 승격돼 세로 스크롤바가 생긴다 → overflow-y-hidden 병기.
    <div className="-mx-4 overflow-x-auto overflow-y-hidden px-4 md:mx-0 md:px-0">
      <div className="inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground">
        {TABS.map(({ href, label, icon: Icon }) => {
          // 하위 경로(`/new`, `/[id]`, `/[id]/edit`)에서도 그 탭을 활성으로 본다.
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-3 py-1 text-sm font-medium transition-all",
                // 활성은 '파란 칠 + 흰 글씨' — 수집함 탭(HH_TAB_SOLID)과 같은 규율. (설계 142)
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-foreground/60 hover:bg-background/70 hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
