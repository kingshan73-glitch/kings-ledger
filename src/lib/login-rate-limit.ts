// 설계 180 — 로그인 프록시의 순수 함수(next 의존 없음). 임계값은 여기 한 곳에만 둔다.
export const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAIL_LIMIT = 20;
// 입력 상한 — 인증 없는 공개 엔드포인트라 1MB 짜리 loginId 가 감사로그에 그대로 박히는 것을 막는다(교차리뷰 Medium).
export const LOGIN_ID_MAX_LENGTH = 64;
export const PASSWORD_MAX_LENGTH = 200;

type NormalizedLoginInput =
  | { ok: true; loginId: string; password: string }
  | { ok: false; error: string };

const INVALID_FORMAT = "요청 형식이 올바르지 않습니다.";
const EMPTY_INPUT = "로그인 ID와 비밀번호를 입력해 주세요.";

export function normalizeLoginInput(body: unknown): NormalizedLoginInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: INVALID_FORMAT };
  }

  const { loginId, password } = body as Record<string, unknown>;
  if (typeof loginId !== "string" || typeof password !== "string") {
    return { ok: false, error: INVALID_FORMAT };
  }

  const id = loginId.trim();
  // 비밀번호는 trim 하지 않는다 — 예전 클라이언트 직접 인증도 원문 그대로 보냈다(공백 비번을 새로 거부하지 않는다).
  if (!id || !password) {
    return { ok: false, error: EMPTY_INPUT };
  }

  // 길이 상한 · `@` 금지(로그인 ID 는 이메일이 아니다 — 설계 179 §1 프로필 규칙과 통일.
  //   `@` 를 통과시키면 loginIdToAuthEmail 이 그대로 이메일로 써서 프로젝트 안 임의 이메일을 겨냥하는 창구가 된다).
  if (id.length > LOGIN_ID_MAX_LENGTH || password.length > PASSWORD_MAX_LENGTH || id.includes("@")) {
    return { ok: false, error: INVALID_FORMAT };
  }

  return { ok: true, loginId: id, password };
}

export function shouldBlockLogin(
  recentFailures: number,
  limit = LOGIN_FAIL_LIMIT
): boolean {
  return recentFailures >= limit;
}

export function rateLimitWindowStart(
  now: Date,
  windowMs = LOGIN_FAIL_WINDOW_MS
): string {
  return new Date(now.getTime() - windowMs).toISOString();
}

// IPv4/IPv6 로 보이는 값만 키로 쓴다 — 헤더는 문자열일 뿐이라 아무 값이나 올 수 있고, 그대로 쓰면 ip_address 에 쓰레기가 박힌다.
// (형식 검증은 위조 방지가 아니다 — 위조 방지는 Vercel 이 헤더를 덮어쓴다는 배포 전제에 기댄다. 설계 180 §1)
const IP_LIKE = /^[0-9a-fA-F.:]{3,45}$/;

export function extractClientIp(xForwardedFor: string | null): string | null {
  const first = xForwardedFor?.split(",")[0]?.trim();
  return first && IP_LIKE.test(first) ? first : null;
}

/**
 * 레이트리밋 키로 쓸 클라이언트 IP. 신뢰 순서:
 *   1) `x-vercel-forwarded-for` — Vercel 이 채우고 클라이언트가 덮어쓸 수 없다
 *   2) `x-real-ip`
 *   3) `x-forwarded-for` 첫 항목 — 직접 배포에선 Vercel 이 덮어쓰지만, 앞에 다른 프록시가 있으면 위조 가능
 * 전부 없으면 null — 호출부는 **건너뛰지 말고** null 버킷으로 함께 센다(교차리뷰: 스킵은 보호의 조용한 비활성화).
 */
export function resolveClientIp(getHeader: (name: string) => string | null): string | null {
  return (
    extractClientIp(getHeader("x-vercel-forwarded-for")) ??
    extractClientIp(getHeader("x-real-ip")) ??
    extractClientIp(getHeader("x-forwarded-for"))
  );
}
