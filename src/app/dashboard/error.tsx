"use client";

import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <h2 className="text-xl font-semibold">문제가 발생했습니다</h2>
      {process.env.NODE_ENV === "development" && (
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {error.message}
        </p>
      )}
      <Button onClick={reset}>다시 시도</Button>
    </div>
  );
}
