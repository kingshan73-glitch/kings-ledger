"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { MaskModeToggle } from "@/components/mask-mode-toggle";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface MenuItem {
  label: string;
  href: string;
  /** href 말고도 이 경로들에서 활성으로 볼 것(한 메뉴가 여러 화면을 묶을 때. 설계 141) */
  matchPrefixes?: string[];
  icon: React.ReactNode;
}

interface MenuSection {
  title: string | null;
  items: MenuItem[];
}

// 메뉴 순서(팀장 지정 2026-07-18): 수집함>현금흐름>통장내역>대출관리>통장이동>수입>지출>통계, 끝에 설정.
// '현황'은 통계의 '요약' 탭으로 통합돼 메뉴에서 뺐다(설계 87).
// ★섹션이 하나뿐이라 제목('가계부')을 없앴다(설계 140) — 아코디언 헤더가 64px 를 쓰면서
//   접을 곳도 고를 것도 없어 정보를 주지 않았다. title:null 이면 아코디언 없이 항상 노출된다.
const menuSections: MenuSection[] = [
  {
    title: null,
    items: [
      {
        label: "수집함",
        href: "/dashboard/household/inbox",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
        ),
      },
      {
        label: "현금흐름",
        href: "/dashboard/household/cash",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="20" height="12" x="2" y="6" rx="2" />
            <circle cx="12" cy="12" r="2" />
            <path d="M6 12h.01M18 12h.01" />
          </svg>
        ),
      },
      {
        label: "통장내역",
        href: "/dashboard/household/passbook",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
            <path d="M8 7h8" />
            <path d="M8 11h5" />
          </svg>
        ),
      },
      {
        label: "대출관리",
        href: "/dashboard/household/loans",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" x2="21" y1="22" y2="22" />
            <line x1="6" x2="6" y1="18" y2="11" />
            <line x1="10" x2="10" y1="18" y2="11" />
            <line x1="14" x2="14" y1="18" y2="11" />
            <line x1="18" x2="18" y1="18" y2="11" />
            <polygon points="12 2 20 7 4 7" />
          </svg>
        ),
      },
      {
        // 수입·지출·통장이동 세 메뉴를 하나로 묶었다(설계 141) — 사이드바 3칸(126px)을 1칸으로.
        // 세 화면의 주소는 그대로이고, 화면 안 탭(HhTxnTabs)으로 오간다. 들어오는 곳은 '지출'.
        label: "거래관리",
        href: "/dashboard/household/expenses",
        matchPrefixes: ["/dashboard/household/income", "/dashboard/household/transfers"],
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m16 3 4 4-4 4" />
            <path d="M20 7H4" />
            <path d="m8 21-4-4 4-4" />
            <path d="M4 17h16" />
          </svg>
        ),
      },
      {
        label: "통계",
        href: "/dashboard/household/stats",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 4 4 6-6" />
          </svg>
        ),
      },
      {
        label: "설정",
        href: "/dashboard/household/settings",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ),
      },
      {
        // 설정 하위 탭에 묻혀 있던 '개선사항'을 대메뉴로 올렸다(팀장 지시 2026-08-09, 설계 157).
        // 개선사항 + 재무관리 두 탭이라 설정 안에 두기엔 성격이 다르다.
        label: "시스템개선",
        href: "/dashboard/household/system",
        icon: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        ),
      },
      // '클로드코드 설치'(/dashboard/household/claude-setup)는 설정 화면 우상단 링크로 옮겼다 —
      // 매일 쓰는 메뉴가 아닌데 사이드바 한 칸(45px)을 차지해 낮은 화면에서 스크롤을 만들었다. (설계 140)
    ],
  },
];

const adminMenuItems: MenuItem[] = [];

const allMenuItems = [...menuSections.flatMap((section) => section.items), ...adminMenuItems];

interface CurrentUser {
  name: string;
  department: string | null;
  position: string | null;
  employee_type: string | null;
}

interface CurrentUserState {
  user: CurrentUser | null;
  hasSession: boolean;
  isResolved: boolean;
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  if (collapsed) {
    return null;
  }

  return (
    <Link href="/dashboard/household/inbox" className={cn("group flex items-center gap-3", collapsed && "justify-center")}>
      <div className="min-w-0">
        <span className="block truncate text-base font-bold tracking-tight text-foreground">kings의 가계부</span>
      </div>
    </Link>
  );
}

function NavItem({
  item,
  collapsed = false,
  onNavigate,
  pathname,
}: {
  item: MenuItem;
  collapsed?: boolean;
  onNavigate?: () => void;
  pathname: string;
}) {
  const isActive =
    item.href === "/dashboard" || item.href === "/dashboard/household"
      ? pathname === item.href
      : (pathname.startsWith(item.href) && item.href !== "#") ||
        // 한 메뉴가 여러 화면을 묶는 경우(거래관리 = 지출·수입·통장이동). 설계 141
        (item.matchPrefixes?.some((p) => pathname.startsWith(p)) ?? false);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        // py-2.5 → py-2: 항목 간격 45px → 42px. 글자·아이콘 크기는 그대로 두고 상하 여백만 줄였다.
        // 9개 메뉴 기준 27px 절약 — 낮은 화면(배율 125·150%)의 세로 스크롤 제거. (설계 140)
        "group flex items-center gap-3 rounded-2xl border px-3 py-2 text-sm transition-all",
        isActive
          ? "border-primary/15 bg-primary/95 text-primary-foreground shadow-[0_16px_32px_-22px_rgba(13,105,106,0.7)]"
          : "border-transparent text-muted-foreground hover:border-primary/10 hover:bg-white/70 hover:text-foreground",
        collapsed && "justify-center px-0"
      )}
    >
      <span className={cn("shrink-0", !isActive && "text-primary/90 group-hover:text-primary")}>{item.icon}</span>
      {!collapsed ? <span className="whitespace-nowrap">{item.label}</span> : null}
    </Link>
  );
}

const ADMIN_SECTION_TITLE = "관리자 메뉴";

// 그룹 제목 오른쪽의 펼침/접힘 표시 화살표 (ERP_sample 구조 차용).
function SectionChevron({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SidebarNav({
  collapsed = false,
  isAdmin = false,
  onNavigate,
}: {
  collapsed?: boolean;
  isAdmin?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const isItemActive = (href: string) =>
    href === "/dashboard" || href === "/dashboard/household" ? pathname === href : pathname.startsWith(href) && href !== "#";

  // 현재 페이지가 속한 그룹은 기본으로 펼쳐 둔다.
  const activeSectionTitle =
    menuSections.find(
      (section) => section.title && section.items.some((item) => isItemActive(item.href))
    )?.title ?? null;
  const adminActive = adminMenuItems.some((item) => isItemActive(item.href));

  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    // 이름 있는 그룹은 기본으로 펼쳐 둔다(접을 수 있게 하되, 마이페이지에서 메뉴가 사라지지 않게).
    for (const s of menuSections) if (s.title) initial.add(s.title);
    if (adminActive) initial.add(ADMIN_SECTION_TITLE);
    return initial;
  });

  // 경로가 바뀌면 현재 그룹은 자동으로 펼친다(다른 그룹의 상태는 유지).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (activeSectionTitle) next.add(activeSectionTitle);
      if (adminActive) next.add(ADMIN_SECTION_TITLE);
      return next;
    });
  }, [activeSectionTitle, adminActive]);

  const toggleSection = (title: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  const renderItems = (items: MenuItem[]) => (
    <div className="space-y-1">
      {items.map((item) => (
        <NavItem
          key={item.label}
          item={item}
          collapsed={collapsed}
          onNavigate={onNavigate}
          pathname={pathname}
        />
      ))}
    </div>
  );

  return (
    <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-3">
      {menuSections.map((section) => {
        // 제목 없는 최상단(워크스페이스)은 아코디언 없이 항상 노출.
        if (!section.title) {
          return <div key="_top">{renderItems(section.items)}</div>;
        }

        // 아이콘 접힘 모드: 아코디언 대신 구분선 + 전체 아이콘.
        if (collapsed) {
          return (
            <div key={section.title} className="mt-2">
              <div className="mx-auto my-2 h-px w-8 bg-border/80" />
              {renderItems(section.items)}
            </div>
          );
        }

        // CRM식 아코디언: 제목을 눌러 펼침/접힘(기본 펼침). 화살표로 상태 표시.
        const title = section.title;
        return (
          <div key={title} className="mt-3">
            <button
              type="button"
              onClick={() => toggleSection(title)}
              aria-expanded={openSections.has(title)}
              className="flex w-full items-center justify-between rounded-2xl px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{title}</span>
              <SectionChevron open={openSections.has(title)} />
            </button>
            {openSections.has(title) ? renderItems(section.items) : null}
          </div>
        );
      })}

      <div className="mt-auto pt-4 space-y-1">
        {isAdmin && adminMenuItems.length > 0 ? (
          collapsed ? (
            <div className="pt-2">
              <div className="mx-auto my-2 h-px w-8 bg-border/80" />
              {renderItems(adminMenuItems)}
            </div>
          ) : (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => toggleSection(ADMIN_SECTION_TITLE)}
                aria-expanded={openSections.has(ADMIN_SECTION_TITLE)}
                className="flex w-full items-center justify-between rounded-2xl px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>{ADMIN_SECTION_TITLE}</span>
                <SectionChevron open={openSections.has(ADMIN_SECTION_TITLE)} />
              </button>
              {openSections.has(ADMIN_SECTION_TITLE) ? renderItems(adminMenuItems) : null}
            </div>
          )
        ) : null}
      </div>
    </nav>
  );
}

function useCurrentUser() {
  const [state, setState] = useState<CurrentUserState>({
    user: null,
    hasSession: false,
    isResolved: false,
  });

  useEffect(() => {
    const supabase = createClient();
    let isActive = true;

    const syncCurrentUser = async (authUser?: User | null) => {
      try {
        const resolvedAuthUser =
          authUser !== undefined
            ? authUser
            : (await supabase.auth.getUser()).data.user;

        if (!isActive) {
          return;
        }

        if (!resolvedAuthUser) {
          setState({
            user: null,
            hasSession: false,
            isResolved: true,
          });
          return;
        }

        const fallbackUser: CurrentUser = {
          name: resolvedAuthUser.email?.split("@")[0] ?? "사용자",
          department: null,
          position: null,
          employee_type: null,
        };

        const { data: employee } = await supabase
          .from("employees")
          .select("name, department, position, employee_type")
          .eq("auth_uid", resolvedAuthUser.id)
          .maybeSingle();

        if (!isActive) {
          return;
        }

        setState({
          user: employee ?? fallbackUser,
          hasSession: true,
          isResolved: true,
        });
      } catch {
        if (!isActive) {
          return;
        }

        setState({
          user: null,
          hasSession: false,
          isResolved: true,
        });
      }
    };

    void syncCurrentUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void syncCurrentUser(session?.user ?? null);
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, []);

  return state;
}

function UserProfile({
  collapsed = false,
  user,
  onNavigate,
}: {
  collapsed?: boolean;
  user: CurrentUser | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const isActive = pathname.startsWith("/dashboard/my");
  const subtitle = [user?.department, user?.position].filter(Boolean).join(" · ") || user?.employee_type || "직원";

  if (!user) return null;

  return (
    <Link
      href="/dashboard/my"
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm transition-all",
        isActive
          ? "border-primary/15 bg-primary/95 text-primary-foreground shadow-[0_16px_32px_-22px_rgba(13,105,106,0.72)]"
          : "border-white/50 bg-white/65 text-muted-foreground hover:border-primary/10 hover:bg-white/80 hover:text-foreground",
        collapsed && "justify-center px-0"
      )}
      title={collapsed ? user.name : undefined}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          isActive ? "bg-primary-foreground/18 text-primary-foreground" : "bg-primary/10 text-primary"
        )}
      >
        {user.name.charAt(0)}
      </div>
      {!collapsed ? (
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", isActive ? "text-primary-foreground" : "text-foreground")}>
            {user.name}
          </p>
          <p className={cn("truncate text-xs", isActive ? "text-primary-foreground/80" : "text-muted-foreground")}>
            {subtitle}
          </p>
        </div>
      ) : null}
    </Link>
  );
}

function SidebarFooter({
  collapsed = false,
  user,
  hasSession,
  isResolved,
  onNavigate,
}: {
  collapsed?: boolean;
  user: CurrentUser | null;
  hasSession: boolean;
  isResolved: boolean;
  onNavigate?: () => void;
}) {
  const fallbackTitle = !isResolved
    ? "계정 확인 중"
    : hasSession
      ? "사용자 정보 확인 필요"
      : "세션이 끊어졌습니다";
  const fallbackSubtitle = !isResolved
    ? "세션 상태를 확인하고 있습니다."
    : hasSession
      ? "프로필 정보를 불러오지 못했습니다."
      : "로그아웃 후 다시 로그인해 주세요.";

  return (
    <div>
      {user ? (
        <UserProfile collapsed={collapsed} user={user} onNavigate={onNavigate} />
      ) : (
        <div
          className={cn(
            "flex items-center gap-3 rounded-2xl border border-dashed border-sidebar-border/80 bg-white/45 px-3 py-3 text-sm text-muted-foreground",
            collapsed && "justify-center px-0"
          )}
          title={collapsed ? fallbackTitle : undefined}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
            ?
          </div>
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{fallbackTitle}</p>
              <p className="truncate text-xs text-muted-foreground">{fallbackSubtitle}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// 사이드바 접힘 상태 저장 키(브라우저에 유지). 사내 CRM 의 crm_sidebar_collapsed 와 같은 역할.
const SIDEBAR_COLLAPSE_KEY = "mysec_sidebar_collapsed";

// 헤더 로고 옆 접기/펼치기 토글(◀/▶). 사내 CRM 패턴 차용.
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
      title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-transparent text-muted-foreground transition-colors hover:border-primary/10 hover:bg-white/70 hover:text-foreground"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("transition-transform duration-200", collapsed && "rotate-180")}
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>
  );
}

export function Sidebar() {
  // 사이드바 접기/펼치기 복원(팀장 요청 2026-07-24, 사내 CRM 처럼). 접힘 상태는 브라우저에 저장.
  const [collapsed, setCollapsed] = useState(false);
  const { user: currentUser, hasSession, isResolved } = useCurrentUser();
  const isAdmin = currentUser?.employee_type === "관리자";

  // 마운트 후 저장된 접힘 상태를 복원(SSR 하이드레이션 안전을 위해 effect 에서 읽는다).
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1") setCollapsed(true);
    } catch {
      // localStorage 접근 불가(프라이빗 모드 등)면 기본 펼침 유지.
    }
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // 저장 실패는 무시(다음 방문 때만 기본값으로 복귀).
      }
      return next;
    });

  return (
    <aside
      className={cn(
        "hidden h-screen shrink-0 flex-col transition-all duration-300 md:sticky md:top-0 md:flex",
        collapsed ? "w-20" : "w-[12.6rem]"
      )}
    >
      <div className="m-3 flex h-[calc(100vh-1.5rem)] flex-col rounded-[2rem] border border-white/70 bg-sidebar/85 shadow-[0_28px_70px_-38px_rgba(13,77,77,0.4)] backdrop-blur-md">
        <div
          className={cn(
            "flex items-center border-b border-sidebar-border/70 px-4 py-4",
            collapsed ? "justify-center px-0" : "justify-between gap-3"
          )}
        >
          <Brand collapsed={collapsed} />
          <SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />
        </div>

        <SidebarNav collapsed={collapsed} isAdmin={isAdmin} />

        <div className="border-t border-sidebar-border/70 p-3 space-y-2">
          <MaskModeToggle collapsed={collapsed} />
          <SidebarFooter
            collapsed={collapsed}
            user={currentUser}
            hasSession={hasSession}
            isResolved={isResolved}
          />
        </div>
      </div>
    </aside>
  );
}

export function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { user: currentUser, hasSession, isResolved } = useCurrentUser();
  const isAdmin = currentUser?.employee_type === "관리자";
  const currentLabel =
    allMenuItems.find((item) =>
      item.href === "/dashboard" || item.href === "/dashboard/household" ? pathname === item.href : pathname.startsWith(item.href)
    )?.label ?? "가계부";

  return (
    <header className="sticky top-0 z-30 px-4 pt-4 md:hidden">
      <div className="surface-panel flex h-16 items-center justify-between px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{currentLabel}</p>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-2xl" aria-label="메뉴 열기">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" x2="20" y1="12" y2="12" />
                <line x1="4" x2="20" y1="6" y2="6" />
                <line x1="4" x2="20" y1="18" y2="18" />
              </svg>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[300px] border-r-0 bg-transparent p-3 shadow-none">
            <SheetTitle className="sr-only">kings의 가계부 메뉴</SheetTitle>
            <div className="flex h-full flex-col rounded-[2rem] border border-white/70 bg-sidebar/95 shadow-[0_28px_70px_-38px_rgba(13,77,77,0.42)] backdrop-blur-md">
              <div className="border-b border-sidebar-border/70 px-4 py-4">
                <Brand />
              </div>
              <SidebarNav isAdmin={isAdmin} onNavigate={() => setOpen(false)} />
              <div className="border-t border-sidebar-border/70 p-3 space-y-2">
                <MaskModeToggle />
                <SidebarFooter
                  user={currentUser}
                  hasSession={hasSession}
                  isResolved={isResolved}
                  onNavigate={() => setOpen(false)}
                />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
