import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export async function requireRouteUser() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      return {
        supabase,
        user: null,
        authUnavailable: isTransientAuthError(error),
      };
    }

    if (!user) {
      return { supabase, user: null, authUnavailable: false };
    }

    return { supabase, user, authUnavailable: false };
  } catch {
    return { supabase, user: null, authUnavailable: true };
  }
}

export function createRouteAuthErrorResponse(authUnavailable = false) {
  if (authUnavailable) {
    return NextResponse.json(
      { error: "Auth service unavailable" },
      { status: 503 }
    );
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isTransientAuthError(error: { message?: string; status?: number }) {
  const msg = error.message?.toLowerCase() ?? "";

  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("timeout")
  ) {
    return true;
  }

  return Boolean(error.status && error.status >= 500);
}
