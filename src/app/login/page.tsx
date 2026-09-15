"use client";

import { LockKeyhole, UserRound } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    const normalizedLoginId = loginId.trim();
    if (!normalizedLoginId || !password) {
      setError("로그인 ID와 비밀번호를 입력해 주세요.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: normalizedLoginId, password }),
      });

      if (res.ok) {
        // 성공 시엔 로딩을 풀지 않는다 — 화면 전환 전에 버튼이 되살아나 중복 제출되는 회귀 방지(교차리뷰).
        router.push("/dashboard/household/inbox");
        router.refresh();
        return;
      }

      // 실패 횟수 잠금은 제거했다. 판정을 클라이언트가 통보하고 서버가 그대로 믿는 구조라,
      // 인증 없이 5회만 호출하면 유일한 관리자 계정을 외부에서 잠글 수 있었고(DoS),
      // 반대로 success 를 호출해 카운터를 리셋하면 무차별 대입 제한이 무력화됐다.
      // 개인 가계부 단일 계정에서는 잠금이 막아주는 것보다 본인이 갇히는 위험이 크다.
      // → 설계 180: 실패 기록·IP 레이트리밋은 서버(`/api/auth/login`)가 한다.
      // 401 은 고정 문구(계정 열거 방지). 그 외(400 입력 형식·429 시도 과다·500 세션 실패)는 서버 문구를 보여주고,
      // 본문이 없으면 상태별 폴백.
      if (res.status === 401) {
        setError("로그인 ID 또는 비밀번호가 올바르지 않습니다.");
      } else {
        const responseBody = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const fallback =
          res.status === 429
            ? "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."
            : res.status === 400
              ? "로그인 ID와 비밀번호를 다시 확인해 주세요."
              : "로그인 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.";
        setError(typeof responseBody?.error === "string" ? responseBody.error : fallback);
      }
      setLoading(false);
    } catch {
      setError("로그인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(13,105,106,0.12),_transparent_32%),radial-gradient(circle_at_bottom,_rgba(180,131,83,0.14),_transparent_28%)]" />

      <Card className="relative z-10 w-full max-w-md border-none py-0 shadow-[0_28px_80px_-42px_rgba(13,77,77,0.32)]">
        <CardContent className="p-8 sm:p-10">
          <div className="space-y-8">
            <div className="space-y-4 text-center">
              <div className="space-y-1.5">
                <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">kings의 가계부</h1>
                <h3 className="text-base font-medium text-muted-foreground">로그인</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  로그인 ID와 비밀번호를 입력해 가계부에 접속하세요.
                </p>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="loginId">로그인 ID</Label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="loginId"
                    name="loginId"
                    type="text"
                    placeholder="로그인 ID"
                    value={loginId}
                    onChange={(event) => setLoginId(event.target.value)}
                    autoFocus
                    autoComplete="username"
                    className="h-11 pl-10"
                    disabled={loading}
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">이메일이 아니라 로그인 ID만 입력하면 됩니다.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">비밀번호</Label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    placeholder="비밀번호를 입력해 주세요"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="h-11 pl-10"
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">로그인 상태는 이 브라우저에서 유지됩니다. 공용 PC에서는 사용 후 로그아웃하세요.</p>

              {error ? (
                <div className="rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="h-11 w-full text-sm font-semibold" disabled={loading}>
                {loading ? "로그인 중..." : "로그인"}
              </Button>
            </form>

          </div>
        </CardContent>
      </Card>
    </div>
  );
}
