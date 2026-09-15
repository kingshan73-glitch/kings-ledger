"use client";

import { Eye, EyeOff } from "lucide-react";

import { useMasking } from "@/components/masking-provider";
import { cn } from "@/lib/utils";

export function MaskModeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { enabled, toggle } = useMasking();
  const Icon = enabled ? EyeOff : Eye;
  const label = enabled ? "마스킹 ON" : "마스킹 OFF";

  return (
    <button
      type="button"
      onClick={toggle}
      title={`${label} (⌘/Ctrl + Shift + M)`}
      aria-pressed={enabled}
      className={cn(
        "flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-medium transition-all",
        enabled
          ? "border-amber-300 bg-amber-100/80 text-amber-900 shadow-[0_8px_18px_-12px_rgba(180,131,83,0.6)]"
          : "border-border/70 bg-white/70 text-muted-foreground hover:border-primary/20 hover:bg-white",
        collapsed ? "justify-center px-0 w-9" : "w-full justify-start"
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed ? <span>{label}</span> : null}
    </button>
  );
}
