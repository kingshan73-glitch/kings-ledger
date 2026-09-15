// 대출 등록·수정의 단일 경로 (설계 96).
// 팝업(loan-dialog)과 페이지(/new, /[id]/edit)가 같은 검증·변환을 쓰도록
// 규칙을 여기 한 곳에만 둔다. 화면이 늘어도 금액 규칙은 갈라지지 않는다.
import type { createClient } from "@/lib/supabase/client";
import { getOwnerUid } from "@/lib/household/owner";
import type { HhLoan, HhLoanRepaymentType } from "@/lib/household/types";

export type NumOrEmpty = number | "";

export type LoanFormState = {
  name: string;
  origin_date: string;
  principal: number;
  current_balance: number;
  maturity_date: string;
  interest_rate: NumOrEmpty;
  monthly_payment: NumOrEmpty;
  payment_day: NumOrEmpty;
  account_id: string;
  /** 설계 168. "" = 미지정(원리금균등으로 가정) — 확인 못 한 것을 확인한 것처럼 굳히지 않는다. */
  repayment_type: HhLoanRepaymentType | "";
  status: "active" | "closed";
};

// 팝업을 열 때마다 폼 상태를 target 으로부터 완전히 다시 만든다(설계 96 (가)).
// 이전 대출의 값이 남아 엉뚱한 금액이 저장되는 것을 막는 불변식이다.
export function loanFormFrom(target: HhLoan | null): LoanFormState {
  return {
    name: target?.name ?? "",
    origin_date: target?.origin_date ?? "",
    principal: target?.principal ?? 0,
    current_balance: target?.current_balance ?? 0,
    maturity_date: target?.maturity_date ?? "",
    interest_rate: target?.interest_rate ?? "",
    monthly_payment: target?.monthly_payment ?? "",
    payment_day: target?.payment_day ?? "",
    account_id: target?.account_id ?? "",
    repayment_type: target?.repayment_type ?? "",
    status: target?.status ?? "active",
  };
}

// 통과하면 null, 막히면 사용자에게 보여줄 메시지를 돌려준다.
export function validateLoanForm(form: LoanFormState): string | null {
  if (!form.name.trim()) return "대출명을 입력해주세요.";
  if (form.principal <= 0) return "대출금액(원금)은 1원 이상이어야 합니다.";
  if (form.payment_day !== "" && (Number(form.payment_day) < 1 || Number(form.payment_day) > 28)) {
    return "상환일은 1~28 사이여야 합니다.";
  }
  if (!Number.isFinite(form.principal)) return "대출금액(원금)이 올바르지 않습니다.";
  if (!Number.isFinite(form.current_balance) || form.current_balance < 0) {
    return "현재잔액은 0원 이상이어야 합니다.";
  }
  if (form.interest_rate !== "" && (!Number.isFinite(form.interest_rate) || form.interest_rate < 0)) {
    return "이자율은 0 이상이어야 합니다.";
  }
  if (form.interest_rate !== "" && form.interest_rate > 999.99) {
    return "이자율이 너무 큽니다(999.99% 이하). 연 %로 입력하세요."; // DB numeric(5,2) 상한
  }
  if (form.monthly_payment !== "" && (!Number.isFinite(form.monthly_payment) || form.monthly_payment < 0)) {
    return "월 상환액은 0원 이상이어야 합니다.";
  }
  return null;
}

export function loanFormWarnings(form: LoanFormState): string[] {
  if (form.current_balance > form.principal) {
    return [
      `현재잔액(${form.current_balance.toLocaleString("ko-KR")}원)이 원금(${form.principal.toLocaleString("ko-KR")}원)보다 큽니다. 연체·이자 포함이면 그대로 저장하세요.`,
    ];
  }
  return [];
}

export type LoanPayload = {
  name: string;
  origin_date: string | null;
  principal: number;
  current_balance: number;
  maturity_date: string | null;
  interest_rate: number | null;
  monthly_payment: number | null;
  payment_day: number | null;
  account_id: string | null;
  repayment_type: HhLoanRepaymentType | null;
  status: "active" | "closed";
};

// 빈 문자열은 0 이 아니라 null 로 보낸다 — 0 으로 저장되면 '이자율 0%'·'상환일 0일'
// 처럼 입력하지 않은 값이 확정된 값처럼 굳는다.
export function buildLoanPayload(form: LoanFormState): LoanPayload {
  return {
    name: form.name.trim(),
    origin_date: form.origin_date || null,
    principal: form.principal,
    current_balance: form.current_balance || 0,
    maturity_date: form.maturity_date || null,
    interest_rate: form.interest_rate === "" ? null : Number(form.interest_rate),
    monthly_payment: form.monthly_payment === "" ? null : Number(form.monthly_payment),
    payment_day: form.payment_day === "" ? null : Number(form.payment_day),
    account_id: form.account_id || null,
    repayment_type: form.repayment_type || null,
    status: form.status,
  };
}

export type SaveLoanResult = { ok: true; id: string } | { ok: false; message: string };

// target 이 있으면 수정, 없으면 등록. 저장된 대출 id 를 돌려준다.
export async function saveLoan(
  supabase: ReturnType<typeof createClient>,
  form: LoanFormState,
  target: HhLoan | null
): Promise<SaveLoanResult> {
  const invalid = validateLoanForm(form);
  if (invalid) return { ok: false, message: invalid };

  const payload = buildLoanPayload(form);

  if (target) {
    const { error } = await supabase.from("hh_loan").update(payload).eq("id", target.id);
    if (error) return { ok: false, message: `수정 실패: ${error.message}` };
    return { ok: true, id: target.id };
  }

  // hh_* 는 owner_auth_uid 소유자 스코프(RLS)라 insert 시 반드시 채워야 한다.
  const owner = await getOwnerUid(supabase);
  if (!owner) return { ok: false, message: "로그인 정보를 확인할 수 없습니다." };
  const { data, error } = await supabase
    .from("hh_loan")
    .insert({ ...payload, owner_auth_uid: owner })
    .select("id")
    .single();
  if (error) return { ok: false, message: `등록 실패: ${error.message}` };
  return { ok: true, id: data.id };
}
