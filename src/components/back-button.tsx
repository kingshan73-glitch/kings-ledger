"use client";

import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { readHistory, readParentHint, writeHistory } from "@/components/nav-history";

export function BackButton() {
  const pathname = usePathname();
  const router = useRouter();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length < 4) return null;

  const urlFallback = "/" + segments.slice(0, -1).join("/");

  const handleClick = () => {
    const history = readHistory();
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i] !== pathname) {
        writeHistory(history.slice(0, i));
        router.push(history[i]);
        return;
      }
    }
    const hint = readParentHint(pathname);
    router.push(hint ?? urlFallback);
  };

  return (
    <div className="hidden md:flex w-8 shrink-0 flex-col items-center pt-6">
      <button
        type="button"
        onClick={handleClick}
        aria-label="이전 페이지로"
        title="이전 페이지로"
        className="sticky top-6 flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:-translate-x-0.5 hover:bg-slate-50 hover:text-slate-900"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
    </div>
  );
}
