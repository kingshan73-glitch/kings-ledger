import type { createClient } from "@/lib/supabase/client";

// hh_* 테이블은 owner_auth_uid = auth.uid() 소유자 스코프(RLS)다.
// insert 시 현재 로그인 사용자 id 를 owner_auth_uid 로 채워야 정책을 통과한다.
export async function getOwnerUid(
  supabase: ReturnType<typeof createClient>
): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// 개인용 가계부라 식별정보 자체 마스킹은 비활성(원본 그대로 표시)한다.
// 가릴 필요가 있으면 전역 마스킹 토글(src/lib/masking.ts)을 사용한다.
// 함수 시그니처는 호출부 호환을 위해 유지하고, 빈값만 "-"로 보정한다.
export function maskAccountNo(no: string | null): string {
  return no?.trim() ? no : "-";
}

export function maskCardNo(no: string | null): string {
  return no?.trim() ? no : "-";
}

export function maskName(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "-";
}
