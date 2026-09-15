// 가계부(household) 모듈 타입. DB: 20260613000000_household_init.sql 의 hh_* 테이블과 1:1.
// 모든 테이블은 owner_auth_uid 소유자 스코프(RLS). Insert 시 owner_auth_uid 를 주입한다.

export type HhPersonKind = string;

export interface HhPerson {
  id: string;
  owner_auth_uid: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type HhAccountKind = "checking" | "stock" | "family" | "other";

export interface HhAccount {
  id: string;
  owner_auth_uid: string;
  name: string;
  bank: string | null;
  account_no: string | null;
  person_id: string | null;
  kind: HhAccountKind;
  opening_balance: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type HhCategoryKind = "income" | "expense";

export interface HhCategory {
  id: string;
  owner_auth_uid: string;
  name: string;
  kind: HhCategoryKind;
  is_fixed: boolean;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type HhPaymentMethodKind = "cash" | "check" | "credit" | "installment";

export interface HhPaymentMethod {
  id: string;
  owner_auth_uid: string;
  name: string;
  kind: HhPaymentMethodKind;
  person_id: string | null;
  linked_account_id: string | null;
  billing_day: number | null;
  card_no: string | null;
  card_expiry: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type HhTransactionType =
  | "income"
  | "expense"
  | "installment"
  | "transfer"
  | "payment";

export interface HhTransaction {
  id: string;
  owner_auth_uid: string;
  txn_date: string;
  type: HhTransactionType;
  amount: number;
  category_id: string | null;
  counterparty: string | null;
  memo: string | null;
  note: string | null;
  payment_method_id: string | null;
  account_id: string | null;
  from_account_id: string | null;
  to_account_id: string | null;
  person_id: string | null;
  installment_id: string | null;
  loan_id: string | null;
  source: "manual" | "inbox" | "import";
  created_at: string;
  updated_at: string;
}

export interface HhInstallment {
  id: string;
  owner_auth_uid: string;
  start_date: string;
  payment_method_id: string | null;
  category_id: string | null;
  title: string | null;
  total_amount: number;
  total_count: number;
  start_installment: number;
  is_active: boolean;
  /** 설계 170 — 재적재는 'import' 만 지운다. 앱 등록분은 'manual' 로 보존된다. */
  source: HhRowSource;
  created_at: string;
  updated_at: string;
}

/**
 * 재적재가 지울 것인가. `import`=엑셀 재적재분(지우고 다시 넣음) · `manual`=앱·스크립트 등록(보존).
 * 설계 170. DB DEFAULT 가 'manual' 이라 앱에서 넣을 때 생략해도 보존되는 쪽으로 떨어진다.
 */
export type HhRowSource = "manual" | "import";

/** 상환방식. null = 미지정이며 원리금균등으로 가정한다(설계 168). */
export type HhLoanRepaymentType = "annuity" | "equal_principal" | "interest_only";

export type HhLoanTerms = {
  rate: number | null;
  term_months: number | null;
  repayment_type: HhLoanRepaymentType | null;
  total_repayment: number | null;
  /** 'YYYY-MM-DD'. 안내문에 명시된 만기일만(없으면 null). */
  maturity_date: string | null;
};

export interface HhLoan {
  id: string;
  owner_auth_uid: string;
  name: string;
  origin_date: string | null;
  principal: number;
  current_balance: number;
  maturity_date: string | null;
  interest_rate: number | null;
  monthly_payment: number | null;
  payment_day: number | null;
  account_id: string | null;
  /** 설계 168. null=미지정(원리금균등 가정) — '모르는 것'과 '확인한 것'을 구분하려 일부러 nullable. */
  repayment_type: HhLoanRepaymentType | null;
  /** 설계 170 — 재적재는 'import' 만 지운다. 앱 등록분은 'manual' 로 보존된다. */
  source: HhRowSource;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
}

export type HhScheduledPaymentKind =
  | "autopay"
  | "subscription"
  | "insurance"
  | "telecom"
  | "maintenance"
  | "saving"
  | "loan"
  | "card_bill"
  | "income";

export interface HhScheduledPayment {
  id: string;
  owner_auth_uid: string;
  title: string;
  kind: HhScheduledPaymentKind;
  amount: number | null;
  frequency: "monthly" | "weekly" | "bimonthly";
  pay_day: number | null;
  account_id: string | null;
  /**
   * 이 고정비가 결제되는 수단(설계 108). 신용카드면 현금은 그날이 아니라 **카드대금일에** 빠지므로
   * 계좌 잔액 예측·출금예정 합계에서 제외한다(카드대금 정기지출이 대표). 체크/선불은 즉시 출금.
   */
  payment_method_id: string | null;
  category_id: string | null;
  person_id: string | null;
  payee: string | null;
  direction: "out" | "in";
  is_active: boolean;
  /** 영구보류 마커(설계 98). is_active=false 중 폐지(false)와 영구보류(true) 구분. */
  permanent_hold: boolean;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  /** 엑셀 월고정비현황 D열 원문 — 재적재 upsert 키(설계 191). 앱이 만든 행은 null. */
  import_key?: string | null;
}

// 월별 예산 (설계: docs/household/19)
export interface HhBudget {
  id: string;
  owner_auth_uid: string;
  ym: string; // 'YYYY-MM'
  category_id: string;
  amount: number;
  created_at: string;
  updated_at: string;
}

// 결제관리 월별 실적
export interface HhPaymentEntry {
  id: string;
  owner_auth_uid: string;
  scheduled_payment_id: string;
  year_month: string;
  fixed_amount: number;
  variable_amount: number;
  paid: boolean;
  created_at: string;
  updated_at: string;
}

// 결제관리 월 마감
export interface HhPaymentMonthClose {
  id: string;
  owner_auth_uid: string;
  year_month: string;
  closed_at: string;
}

// 현금흐름 출금예정 항목별 월별 오버라이드 (설계: docs/household/31)
export type HhCashflowSourceKind = "fixed" | "loan" | "installment" | "card";

export interface HhCashflowOverride {
  id: string;
  owner_auth_uid: string;
  year_month: string; // 'YYYY-MM'
  source_kind: HhCashflowSourceKind;
  source_id: string;
  amount_override: number | null;
  account_id: string | null;
  released: boolean;
  day_override: number | null; // 해당 월 납부일(일자) 변경. null이면 자동 계산일.
  paid_override: number | null; // 수기 입력 지급금액. null이면 자동 매칭 결과 사용.
  /**
   * 이 달만 다른 결제수단으로 냈을 때의 수단. null이면 항목에 등록된 결제수단을 따른다. (설계 203)
   * 학원비처럼 달마다 카드↔지갑이 바뀌는 항목 때문에 생겼다 — 항목에 한 값으로 고정하면
   * 지갑으로 낸 달은 현금 유출이 합계에서 빠지고, 카드로 낸 달은 카드대금과 이중계상된다.
   */
  payment_method_id: string | null;
  created_at: string;
  updated_at: string;
}

export type HhCashflowOverrideInsert = Omit<HhCashflowOverride, "id" | "created_at" | "updated_at">;

export type HhInboxStatus = "pending" | "confirmed" | "ignored" | "duplicate" | "archived";

export interface HhTransactionInbox {
  id: string;
  owner_auth_uid: string;
  raw_text: string | null;
  source: "sms" | "file" | "manual" | "notification";
  source_adapter: string | null;
  collected_at: string;
  guessed_date: string | null;
  guessed_time: string | null;
  guessed_amount: number | null;
  guessed_merchant: string | null;
  guessed_category_id: string | null;
  guessed_account_id: string | null;
  guessed_payment_method_id: string | null;
  guessed_from_account_id: string | null;
  guessed_to_account_id: string | null;
  guessed_type: string | null;
  guessed_kind: string | null;
  /** 승인취소가 취소하는 원 거래. 확정 시 새 거래 생성 대신 이 거래를 삭제한다. (설계 151) */
  cancel_target_txn_id: string | null;
  guessed_institution: string | null;
  guessed_loan_terms: HhLoanTerms | null;
  guessed_installment_months: number | null;
  /** 확정 시 연결할 대출. null 이면 대출이 아닌 납부(카드대금 등). (설계 94) */
  guessed_loan_id: string | null;
  user_memo: string | null;
  reported_balance: number | null;
  reported_balance_account_id: string | null;
  confidence: number | null;
  status: HhInboxStatus;
  dedup_hash: string | null;
  raw_meta: Record<string, unknown> | null;
  confirmed_txn_id: string | null;
  confirmed_installment_id: string | null;
  created_at: string;
  updated_at: string;
}

// 잔액 뷰
export interface HhAccountBalance {
  account_id: string;
  owner_auth_uid: string;
  name: string;
  current_balance: number;
}

export interface HhLoanBalance {
  loan_id: string;
  owner_auth_uid: string;
  name: string;
  principal: number;
  computed_balance: number;
}

// ── Insert payload 타입 (id/타임스탬프 제외, owner_auth_uid 는 저장 시 주입) ──
export type HhPersonInsert = Omit<HhPerson, "id" | "created_at" | "updated_at">;
export type HhAccountInsert = Omit<HhAccount, "id" | "created_at" | "updated_at">;
export type HhCategoryInsert = Omit<HhCategory, "id" | "created_at" | "updated_at">;
export type HhPaymentMethodInsert = Omit<HhPaymentMethod, "id" | "created_at" | "updated_at">;
export type HhTransactionInsert = Omit<HhTransaction, "id" | "created_at" | "updated_at">;
// source 는 선택 — 생략하면 DB DEFAULT 가 'manual' 로 채운다(설계 170).
export type HhInstallmentInsert = Omit<HhInstallment, "id" | "created_at" | "updated_at" | "source"> & { source?: HhRowSource };
export type HhLoanInsert = Omit<HhLoan, "id" | "created_at" | "updated_at" | "source"> & { source?: HhRowSource };
export type HhScheduledPaymentInsert = Omit<HhScheduledPayment, "id" | "created_at" | "updated_at">;

export const SCHEDULED_KIND_LABEL: Record<HhScheduledPaymentKind, string> = {
  autopay: "자동이체",
  subscription: "구독",
  insurance: "보험",
  telecom: "통신",
  maintenance: "관리비",
  saving: "적금",
  loan: "대출상환",
  card_bill: "카드대금",
  income: "정기수입",
};

export const INBOX_STATUS_LABEL: Record<HhInboxStatus, string> = {
  pending: "검토대기",
  confirmed: "확정",
  ignored: "제외",
  duplicate: "중복",
  archived: "보관",
};

// 화면 표시에 쓰는 라벨
export const ACCOUNT_KIND_LABEL: Record<HhAccountKind, string> = {
  checking: "입출금",
  stock: "주식",
  family: "가족",
  other: "기타",
};

export const PAYMENT_METHOD_KIND_LABEL: Record<HhPaymentMethodKind, string> = {
  cash: "현금",
  check: "체크카드",
  credit: "신용카드",
  installment: "할부",
};

// ── 개선사항 게시판 (설계 156) ─────────────────────────────────────────────
// 오판 -> 재점검 -> 개선의 과정을 팀장님이 볼 수 있게 앱 안에 쌓는다.
export type HhImprovementKind = "check" | "fix";
export type HhImprovementSeverity = "high" | "mid" | "low";
export type HhImprovementStatus = "open" | "done" | "dropped";

export type HhImprovement = {
  id: string;
  owner_auth_uid: string;
  kind: HhImprovementKind;
  title: string;
  symptom: string | null;      // 증상 — 무엇이 잘못 보였나
  root_cause: string | null;   // 원인 — 진짜 이유
  action: string | null;       // 조치 — 무엇을 했나 / 무엇을 정해야 하나
  evidence: string | null;     // 근거 — 수치·스크립트명
  design_no: number | null;
  severity: HhImprovementSeverity;
  status: HhImprovementStatus;
  occurred_on: string | null;
  checked_at: string | null;
  checked_memo: string | null;
  created_at: string;
  updated_at: string;
};

export const IMPROVEMENT_SEVERITY_LABEL: Record<HhImprovementSeverity, string> = {
  high: "높음",
  mid: "보통",
  low: "낮음",
};

export const IMPROVEMENT_STATUS_LABEL: Record<HhImprovementStatus, string> = {
  open: "대기",
  done: "확인완료",
  dropped: "해당없음",
};
