"use client";

import { useMasking } from "@/components/masking-provider";

export function MaskModeIndicator() {
  const { enabled } = useMasking();
  if (!enabled) return null;
  return (
    <>
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] bg-amber-400"
        aria-hidden
      />
      <div className="pointer-events-none fixed right-4 top-3 z-[60] flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100/95 px-2.5 py-1 text-[11px] font-semibold text-amber-900 shadow-sm">
        <span className="size-1.5 rounded-full bg-amber-500" />
        마스킹 모드
      </div>
    </>
  );
}
