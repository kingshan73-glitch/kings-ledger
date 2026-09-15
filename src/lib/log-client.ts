export function sendLog(
  action: string,
  message: string,
  opts?: {
    level?: "INFO" | "ERROR";
    resource?: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }
) {
  fetch("/api/logs", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, message, ...opts }),
  }).catch(() => {});
}
