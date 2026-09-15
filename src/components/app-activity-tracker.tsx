"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { sendLog } from "@/lib/log-client";

type InteractionSnapshot = {
  action: string;
  message: string;
  details: Record<string, unknown>;
  occurred_at: string;
};

function truncate(value: string | null | undefined, max = 160) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function buildRoute(pathname: string, searchParams: { toString(): string }) {
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function getElementLabel(element: HTMLElement) {
  return (
    truncate(element.getAttribute("aria-label")) ??
    truncate(element.getAttribute("title")) ??
    truncate(element.textContent) ??
    truncate(element.getAttribute("name")) ??
    truncate(element.getAttribute("id")) ??
    "label-less"
  );
}

function getElementDetails(element: HTMLElement, currentPath: string) {
  const href =
    element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href");

  return {
    current_path: currentPath,
    tag_name: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    type:
      element instanceof HTMLButtonElement || element instanceof HTMLInputElement
        ? element.type
        : null,
    label: getElementLabel(element),
    id: element.id || null,
    name: element.getAttribute("name"),
    title: truncate(element.getAttribute("title")),
    aria_label: truncate(element.getAttribute("aria-label")),
    href,
    target: element.getAttribute("target"),
    data_slot: element.getAttribute("data-slot"),
    data_variant: element.getAttribute("data-variant"),
    data_size: element.getAttribute("data-size"),
  };
}

function serializeReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack ?? null,
      cause: reason.cause ?? null,
    };
  }

  if (typeof reason === "string") {
    return { message: reason };
  }

  if (reason && typeof reason === "object") {
    try {
      return JSON.parse(JSON.stringify(reason)) as Record<string, unknown>;
    } catch {
      return { value: String(reason) };
    }
  }

  return { value: String(reason) };
}

export function AppActivityTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const previousPathRef = useRef<string | null>(null);
  const lastInteractionRef = useRef<InteractionSnapshot | null>(null);

  useEffect(() => {
    const currentPath = buildRoute(pathname, searchParams);
    const previousPath = previousPathRef.current;
    if (previousPath === currentPath) {
      return;
    }

    sendLog("NAVIGATE_PAGE", `페이지 이동: ${currentPath}`, {
      resource: "page",
      resource_id: pathname,
      details: {
        pathname,
        query: searchParams.toString() || null,
        previous_path: previousPath,
        referrer: document.referrer || null,
      },
    });

    previousPathRef.current = currentPath;
  }, [pathname, searchParams]);

  useEffect(() => {
    const currentPath = buildRoute(pathname, searchParams);

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const interactive = target.closest<HTMLElement>(
        'button, a, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'
      );

      if (!interactive || interactive.dataset.logIgnore === "true") {
        return;
      }

      const details = getElementDetails(interactive, currentPath);
      const isNavigation = interactive instanceof HTMLAnchorElement && Boolean(interactive.href);
      const action = isNavigation ? "CLICK_NAVIGATION" : "CLICK_BUTTON";
      const message = isNavigation
        ? `페이지 이동 클릭: ${details.label}`
        : `버튼 클릭: ${details.label}`;

      const snapshot = {
        action,
        message,
        details,
        occurred_at: new Date().toISOString(),
      };

      lastInteractionRef.current = snapshot;
      sendLog(action, message, {
        resource: isNavigation ? "navigation" : "button",
        resource_id: details.id ?? undefined,
        details: snapshot,
      });
    };

    const handleError = (event: ErrorEvent) => {
      const error = event.error instanceof Error ? event.error : null;

      sendLog("CLIENT_RUNTIME_ERROR", event.message || "클라이언트 런타임 오류", {
        level: "ERROR",
        resource: "client",
        details: {
          pathname: currentPath,
          source: event.filename || null,
          line: event.lineno || null,
          column: event.colno || null,
          message: event.message || error?.message || "Unknown client error",
          name: error?.name ?? null,
          stack: error?.stack ?? null,
          last_interaction: lastInteractionRef.current,
          user_agent: navigator.userAgent,
        },
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      sendLog("CLIENT_UNHANDLED_REJECTION", "처리되지 않은 Promise 오류", {
        level: "ERROR",
        resource: "client",
        details: {
          pathname: currentPath,
          reason: serializeReason(event.reason),
          last_interaction: lastInteractionRef.current,
          user_agent: navigator.userAgent,
        },
      });
    };

    document.addEventListener("click", handleClick, true);
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [pathname, searchParams]);

  return null;
}
