export function validateInstallmentCounts(totalCount: number, startInstallment: number): string | null {
  if (!Number.isInteger(totalCount) || totalCount < 1) {
    return "총 회차는 1 이상이어야 합니다.";
  }
  if (!Number.isInteger(startInstallment) || startInstallment < 1) {
    return "시작 회차는 1 이상이어야 합니다.";
  }
  if (startInstallment > totalCount) {
    return `시작 회차(${startInstallment})는 총 회차(${totalCount}) 이하여야 합니다.`;
  }
  return null;
}
