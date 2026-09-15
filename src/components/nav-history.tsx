"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

const HISTORY_KEY = "my-secretary:nav-history";
const HINT_KEY = "my-secretary:nav-parent-hint";
const MAX_HISTORY = 20;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readHistory(): string[] {
  if (typeof window === "undefined") return [];
  return safeParse<string[]>(window.sessionStorage.getItem(HISTORY_KEY)) ?? [];
}

export function writeHistory(history: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore quota errors
  }
}

export function readParentHint(pathname: string): string | null {
  if (typeof window === "undefined") return null;
  const parsed = safeParse<{ pathname: string; parentHref: string }>(
    window.sessionStorage.getItem(HINT_KEY)
  );
  return parsed && parsed.pathname === pathname ? parsed.parentHref : null;
}

export function NavHistoryRecorder() {
  const pathname = usePathname();
  React.useEffect(() => {
    if (!pathname) return;
    const history = readHistory();
    if (history[history.length - 1] === pathname) return;
    writeHistory([...history, pathname].slice(-MAX_HISTORY));
  }, [pathname]);
  return null;
}

export function NavBackHint({ parentHref }: { parentHref?: string | null }) {
  const pathname = usePathname();
  React.useEffect(() => {
    if (typeof window === "undefined" || !pathname) return;
    if (!parentHref) {
      const parsed = safeParse<{ pathname: string }>(
        window.sessionStorage.getItem(HINT_KEY)
      );
      if (parsed && parsed.pathname === pathname) {
        window.sessionStorage.removeItem(HINT_KEY);
      }
      return;
    }
    try {
      window.sessionStorage.setItem(
        HINT_KEY,
        JSON.stringify({ pathname, parentHref })
      );
    } catch {
      // ignore quota errors
    }
  }, [pathname, parentHref]);
  return null;
}
