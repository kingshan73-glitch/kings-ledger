import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 금액을 만 단위로 포맷 (예: 220000000 → "22,000만원") */
export function formatAmountInMan(amount: number): string {
  if (amount === 0) return "0원";
  const man = Math.round(amount / 10_000);
  return `${man.toLocaleString("ko-KR")}만원`;
}

/** PostgREST ilike 패턴에서 특수문자 이스케이프 */
export function escapePostgrestLike(str: string): string {
  return str.replace(/[%_\\]/g, "\\$&");
}
