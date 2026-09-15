"use client";

import * as React from "react";
import { toast } from "sonner";

import { mask, type MaskCategory } from "@/lib/masking";

const STORAGE_KEY = "my-secretary:mask-mode";

type MaskingContextValue = {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (value: boolean) => void;
  mask: (category: MaskCategory, value: string | number | null | undefined) => string;
};

const MaskingContext = React.createContext<MaskingContextValue | null>(null);

function readStoredEnabled(): boolean {
  // 토글식 마스킹(금액 등 데모 치환)은 기본 OFF — 본인이 평소 금액을 그대로 보게 한다.
  // 계좌번호·카드번호·계좌명·대출명 같은 식별정보는 이 토글과 무관하게 owner.ts 함수로 항상 부분 가림한다.
  if (typeof window === "undefined") return false;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

function writeStoredEnabled(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

export function MaskingProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = React.useState(false);

  React.useEffect(() => {
    setEnabledState(readStoredEnabled());
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.dataset.maskMode = enabled ? "on" : "off";
    return () => {
      delete document.body.dataset.maskMode;
    };
  }, [enabled]);

  const setEnabled = React.useCallback((value: boolean) => {
    setEnabledState(value);
    writeStoredEnabled(value);
  }, []);

  const toggle = React.useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      writeStoredEnabled(next);
      toast.success(next ? "마스킹 모드 켜짐" : "마스킹 모드 꺼짐", {
        description: next
          ? "민감정보가 가려진 상태로 표시됩니다."
          : "민감정보가 다시 보입니다.",
      });
      return next;
    });
  }, []);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (isMod && event.shiftKey && (event.key === "M" || event.key === "m")) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  const value = React.useMemo<MaskingContextValue>(
    () => ({
      enabled,
      toggle,
      setEnabled,
      mask: (category, raw) => mask(category, raw, enabled),
    }),
    [enabled, toggle, setEnabled]
  );

  return <MaskingContext.Provider value={value}>{children}</MaskingContext.Provider>;
}

export function useMasking(): MaskingContextValue {
  const ctx = React.useContext(MaskingContext);
  if (ctx) return ctx;
  return {
    enabled: false,
    toggle: () => {},
    setEnabled: () => {},
    mask: (_category, raw) => (raw == null ? "" : String(raw)),
  };
}
