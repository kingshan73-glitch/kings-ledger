export const CATEGORY_NAME = {
  loanRepay: "대출상환",
  loanIncome: "대출",
  cardBill: "카드대금",
  interest: "이자",
  pocket: "용돈",
} as const;

export function cardBillCategoryId(
  categories: readonly { id: string; name: string; is_active?: boolean }[],
  options: { activeOnly?: boolean } = {},
): string | null {
  return categories.find((c) => c.name === CATEGORY_NAME.cardBill && (!options.activeOnly || c.is_active))?.id ?? null;
}

export function isCardLoan(loan: { name: string }): boolean {
  return loan.name.includes("카드론");
}
