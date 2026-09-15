export function loginIdToAuthEmail(loginId: string, domain?: string): string {
  const id = loginId.trim();
  return id.includes("@")
    ? id
    : `${id}@${domain || process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`;
}
