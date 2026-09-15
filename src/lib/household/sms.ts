// 결제문자 룰 기반 파서(서버용). 설계 docs/household/22.
// 한국 카드사/은행 일반 문자 패턴으로 거래종류·금액·가맹점·일시·잔액·카드끝4자리를 best-effort 추출.
// 추출 실패해도 호출부는 원문(raw_text)을 반드시 보존한다(유실 0).
// 설계 181: 카드론 조건은 상품명+금액 앵커가 모두 있는 안내문에서만 좁게 추출한다.
// '만원/억원' 해석도 이 분기 안에만 가둬 전역 금액 규칙의 기존 문자 판정을 바꾸지 않는다.
import { createHash } from "crypto";

export type SmsKind =
  | "approve" // 카드 승인(일시불/할부/결제)
  | "cancel" // 승인취소/취소
  | "deposit" // 입금
  | "withdraw" // 출금/지급/인출
  | "transfer" // 이체/송금
  | "autopay" // 자동이체/자동납부/정기결제
  | "unknown";

export interface SmsLoanTerms {
  rate: number | null;
  termMonths: number | null;
  repaymentType: "annuity" | "equal_principal" | "interest_only" | null;
  totalRepayment: number | null;
  maturityDate: string | null; // 'YYYY-MM-DD'. `대출만기일 : 2028-02-10` 처럼 명시된 것만(기간으로 계산하지 않는다)
}

export interface SmsParsed {
  kind: SmsKind;
  amount: number | null;
  merchant: string | null;
  occurredAt: string | null; // 'YYYY-MM-DD'
  occurredTime: string | null; // 'HH:MM'(24시간). 수집함 표시 전용. (설계 docs/household/44)
  balance: number | null;
  cardLast4: string | null;
  accountTail: string | null; // 마스킹된 계좌번호 끝 4자리(예: '*120000' → '0000'). 계좌 자동매칭용.
  accountPrefix: string | null; // 마스킹된 계좌번호 앞 숫자(예: '110-11-0***-111' → '110110', 5자리↑). 끝자리까지 마스킹된 카드용. (설계 docs/household/34)
  accountSuffix: string | null; // KB 새 마스크(`NNNNNN-**-***NNN`)의 보이는 끝 3자리. 같은 지점 계좌 구분용. (설계 193)
  institution: string | null; // 기관명(은행/카드사/페이) 표시용. 예: '우리은행', '하나카드'. (설계 docs/household/32)
  cardName: string | null; // 카드앱(토스 등) 알림의 카드명(예: '우리체크'). 카드번호 없는 결제수단 매칭용. (설계 docs/household/51)
  installmentMonths: number | null; // 카드 할부 개월수(2 이상만 할부로 봄; 일시불/1개월=null). (설계 docs/household/54)
  loanTerms: SmsLoanTerms | null; // 카드론 안내문에 명시된 조건. 그 외 문자는 null. (설계 181)
}

/** 거래종류 → 수집함 guessed_type(거래 타입). */
export function kindToTxnType(kind: SmsKind): "income" | "expense" | "transfer" {
  if (kind === "deposit") return "income";
  if (kind === "transfer") return "transfer";
  return "expense"; // approve/withdraw/autopay/cancel/unknown
}

const KIND_LABEL: Record<SmsKind, string> = {
  approve: "카드승인",
  cancel: "승인취소",
  deposit: "입금",
  withdraw: "출금",
  transfer: "이체",
  autopay: "자동이체",
  unknown: "미분류",
};
export function smsKindLabel(kind: SmsKind): string {
  return KIND_LABEL[kind];
}

// "12,345원" 류 표기를 정수로. balance 제외용 헬퍼는 호출부에서 처리.
function wonAmounts(t: string): number[] {
  const out: number[] = [];
  const re = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,})\s*원/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** Asia/Seoul 기준 오늘 'YYYY-MM-DD' */
/**
 * 서울 기준 오늘(YYYY-MM-DD).
 *
 * `now` 는 **테스트용 주입구**다 — 기본값이 현재 시각이라 호출부는 그대로다. 이게 없으면
 * 이 함수를 검증할 길이 없고, 지갑 사슬 테스트가 픽스처·구현 양쪽에서 같은 함수를 쓰는 탓에
 * 타임존이 깨져도 **둘 다 똑같이 밀려서** 통과한다(교차리뷰 2026-08-19).
 */
export function seoulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

// 문자 내 날짜 추출: 'YYYY.MM.DD' / 'MM/DD' / 'MM월 DD일'. 미래면 작년 보정(과거 문자 가정).
function parseSmsDate(t: string): string | null {
  const today = seoulToday();
  const [ty, tm, td] = today.split("-").map(Number);
  const clamp = (y: number, mo: number, d: number): string | null => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = t.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return clamp(Number(m[1]), Number(m[2]), Number(m[3]));
  // 'YYYY년 M월 D일' — 연도가 명시돼 있으면 그대로 믿는다. 없던 시절엔 아래 'M월 D일' 가지로 떨어져 **미래면 작년** 보정이
  // 걸렸고, 9/1 에 온 "2026년 9월 2일" 취소 영수증이 2025-09-02 로 휴지통에 앉았다(배포 전 교차리뷰 재검증 M3, 2026-09-01).
  m = t.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return clamp(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    // 올해로 보되, 미래(이번달·올해 기준 지나지 않은 날)면 작년으로.
    let y = ty;
    if (mo > tm || (mo === tm && d > td)) y = ty - 1;
    return clamp(y, mo, d);
  }
  return null;
}

// 날짜 토큰의 시작 위치(없으면 -1). 시각이 날짜 바로 뒤에 오는 경우 우선 채택용. (설계 docs/household/44)
function dateTokenIndex(t: string): number {
  let m = t.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m?.index != null) return m.index;
  m = t.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (m?.index != null) return m.index;
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m?.index != null) return m.index;
  return -1;
}

// 문자 내 거래 시각 추출 → 'HH:MM'(없으면 null). 콜론(:)이 있는 토큰만 잡아 24시간 범위로 제한(잔액·카드번호 오인 방지).
// 여러 개면 날짜 토큰 바로 뒤 시각을 우선 채택, 날짜가 없으면 첫 시각. (설계 docs/household/44)
const TIME_TOKEN_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
export function parseSmsTime(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const times: { idx: number; hh: number; mm: number }[] = [];
  const re = new RegExp(TIME_TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    times.push({ idx: m.index, hh: Number(m[1]), mm: Number(m[2]) });
  }
  if (!times.length) return null;
  const dateIdx = dateTokenIndex(t);
  const chosen = (dateIdx >= 0 ? times.find((x) => x.idx >= dateIdx) : undefined) ?? times[0];
  return `${String(chosen.hh).padStart(2, "0")}:${String(chosen.mm).padStart(2, "0")}`;
}

// 종류 판별: 키워드 우선순위(겹침 주의 — 자동이체⊃이체, 승인취소⊃승인).
function detectKind(t: string): SmsKind {
  if (/취소/.test(t)) return "cancel";
  if (/자동이체|자동납부|정기결제|자동출금/.test(t)) return "autopay";
  if (/이체|송금/.test(t)) return "transfer";
  // '입금'은 상호 속 글자를 오인하지 않게 세입금(지자체세입금)·수입금·매입금을 제외. (실사례: 위택스 세금이 income 오수집)
  if (/(?<![세수매])입금/.test(t)) return "deposit";
  if (/출금|인출|지급/.test(t)) return "withdraw";
  if (/승인|일시불|할부|결제|체크|매출/.test(t)) return "approve";
  return "unknown";
}

const WON_AMOUNT_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,})\s*원/;

// 전각 영숫자·기호 → 반각(２６０６→2606, ＬＧＵ＋→LGU+), 전각 공백 정리. (설계 76)
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

function stripMerchantNoise(s: string): string {
  return toHalfWidth(s)
    .replace(/\[[^\]]*발신[^\]]*\]/g, " ")
    .replace(/잔액\s*[:]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,})\s*원?/g, " ") // 잔액(원 선택적)
    .replace(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/g, " ")
    .replace(/\d{1,2}월\s*\d{1,2}일/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, " ")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, " ")
    .replace(/\*+[0-9]+|[0-9]+\*+|[0-9][0-9\-]*\*+[0-9\-]*/g, " ") // 마스킹 계좌/카드번호(*120000, 1234**, 110-11-0***-111)
    .replace(/[가-힣]\*+[가-힣]/g, " ") // 마스킹 이름(이*다, 김*늘)
    .replace(new RegExp(WON_AMOUNT_RE.source, "g"), " ") // 원-금액(9,000원) — '원'까지 함께 제거
    .replace(/[0-9]{1,3}(?:,[0-9]{3})+/g, " ") // 원 없는 콤마 금액(5,600·잔액 잔재)
    .replace(/[가-힣]+(?:은행|카드)/g, " ") // 기관명(하나은행/신한카드 등)
    .replace(
      // 복합 토큰(인터넷출금이/전자금융입금)을 앞에 둬 통째로 지운다 — '출금'만 지우면 '인터넷…이' 부스러기가 상호에 남는다.
      /(인터넷출금이?|전자금융입금|승인취소|승인|취소|일시불|할부|결제|입금|출금|인출|지급|이체|송금|자동이체|자동납부|정기결제|자동출금|누적|잔액|사용|체크|매출|금액)/g,
      " "
    )
    .replace(/카드\s+카드/g, "카드") // '카드출금 카드출금' → 노이즈 제거 후 '카드 카드' 잔재 축약
    .replace(/[([{]+\s*$/g, "") // 끝에 매달린 여는 괄호 제거('카드(' → '카드')
    .replace(/\s+/g, " ")
    .trim();
}

// 문장 종결어미 부스러기 판정: 노이즈 제거 후 '됐어요.'·'되었습니다' 처럼 서술어 조각만 남은 것은 상호가 아니다.
// (설계 106 — '입금됐어요.' 에서 노이즈 '입금'만 지워져 '됐어요.'가 상호가 되던 흠)
// 빈칸이 오상호보다 낫다: 여기서 걸러 null 이 되면 화면엔 상호 없음으로 보이고 학습도 안 된다.
// ★교차리뷰 반영(2026-07-28): 종결어미로 끝나는 단일 토큰을 전부 버리면 '카페예요' 같은 실제 상호까지
//   지운다 → 어간을 명시한 **서술어 조각 목록**으로 좁힌다(노이즈 제거 후 실제로 관측되는 형태들).
function isSentenceFragment(s: string): boolean {
  if (/\s/.test(s)) return false; // 두 단어 이상이면 상호일 수 있다 — 건드리지 않는다
  return /^(?:됐|되었|되|했|하였|받았|드렸|왔|갔|생겼|있|없|같)(?:어요|습니다|네요)[.!]?$|^(?:입니다|합니다|해요)[.!]?$/.test(s);
}

// 문장(서술문)꼴 판정: 종결어미로 끝나면 상호가 아니라 안내 문장이다. 상호 후보를 버릴지 정할 때 쓴다.
function looksLikeSentence(s: string): boolean {
  return /(?:어요|에요|예요|습니다|합니다|입니다|하세요|해요|네요)[.!]?$/.test(s.trim());
}

// 상호 앞뒤에 남는 '필요없는 텍스트' 정리. (설계 docs/household/114 — 106 후속)
// ① **앞머리** 문장 종결어미 부스러기: '입금되었습니다. -바다기획-' 은 노이즈 '입금'만 지워져
//    '되었습니다. -바다기획-' 가 통째로 상호가 된다. isSentenceFragment 는 공백이 있으면 손대지
//    않으므로(두 단어 이상은 상호일 수 있다) 이 형태를 못 걸렀다 → 앞머리만 잘라 뒤의 실상호를 살린다.
// ② 월·날짜 접두: '07월 옥길데시앙 406동2302호' 처럼 달이 붙으면 다음 달엔 '08월 …'이 되어
//    merchant_map 학습키가 매달 갈린다(사실상 1회용 키 — 106 이 지적한 피해가 관리비에서 재현).
//    공백을 요구하므로 '5월의종로' 같은 실상호는 건드리지 않는다.
// ③ 앞뒤 구두점 잔재: '-바다기획-' → '바다기획'.
// 잘라낸 결과가 비면 원본을 그대로 돌려준다 — 멀쩡한 상호를 지우는 쪽이 더 나쁘다.
const MERCHANT_LEADING_PREDICATE =
  /^(?:됐|되었|되|했|하였|받았|드렸|왔|갔|생겼|있|없|같)(?:어요|습니다|네요)[.!]?(?=\s|$)/;
const MERCHANT_LEADING_POLITE = /^(?:입니다|합니다|해요|드립니다|드려요)[.!]?(?=\s|$)/;
const MERCHANT_DATE_PREFIX = /^(?:\d{1,2}\s*월|\d{1,2}\/\d{1,2}|\d{4}[-.]\d{1,2})\s+/;

function tidyMerchant(s: string): string {
  let out = s.trim();
  out = out.replace(MERCHANT_LEADING_PREDICATE, "").trim();
  out = out.replace(MERCHANT_LEADING_POLITE, "").trim();
  out = out.replace(MERCHANT_DATE_PREFIX, "").trim();
  // 끝의 마침표는 건드리지 않는다 — 단일 토큰 종결어미는 isSentenceFragment 가 이미 거른다.
  out = out.replace(/^[\s\-–—·・,.]+/, "").replace(/[\s\-–—·・,]+$/, "").trim();
  return out || s.trim();
}

// 상호에서 **이해에 필요 없는 것**을 걷어낸다. (설계 154, 팀장 지시 2026-08-06)
//
// ① 법인표기 — `(주)`·`（주）`·`㈜`·`주식회사`·`유한회사`. 어느 자리에 있든 뺀다.
//    '(주)교보문고'와 '교보문고'가 **다른 학습키가 되는 것**이 실질 피해다.
// ② 끝에서 **닫히지 않은 괄호 조각** — 은행이 상호를 N자에서 자르며 `（주）`가 중간에 끊긴다.
//    실사례: `노스폴코리아（주` / `KH에너지(주)직영 가평주유소(춘`.
//    ★남는 이름이 4자 미만이면 자르지 않는다 — `김교사(3030영어` 를 `김교사` 으로 줄이면
//      merchant_map 이 부분일치라 '김교사'이 든 모든 상호에 걸려 규칙이 오염된다(설계 106 의 교훈).
//    ★닫는 괄호로 끝나면 손대지 않는다 — `(주)비바리퍼블리카(토스페이)` 의 뒤 괄호는 정상 표기다.
const MERCHANT_CORP = /\s*(?:[（(]\s*(?:주|유)\s*[)）]|㈜|주식회사|유한회사)\s*/g;
const MERCHANT_TRUNCATED_PAREN = /[（(][^)）]{0,6}$/;

export function normalizeMerchantName(s: string | null | undefined): string | null {
  const src = (s ?? "").trim();
  if (!src) return null;
  // 빈 문자열로 지운다(공백 아님) — 이름 **가운데** 있는 법인표기를 공백으로 바꾸면
  // `아마노코리아(주)_TP타워` 가 `아마노코리아 _TP타워` 가 되어 새 학습키가 하나 더 생긴다.
  let out = src.replace(MERCHANT_CORP, "").replace(/\s+/g, " ").trim();
  // ★너무 짧아지면 **정리하지 않는다** — merchant_map 이 부분일치라 2자짜리 키('옥길')는
  //   그 글자가 든 모든 상호('옥길데시앙'…)에 걸려 규칙을 통째로 오염시킨다(설계 106 의 교훈).
  //   실사례: '주식회사 옥길' → '옥길'. 이런 건 원문을 그대로 둔다.
  if (out.length < 3) out = src;
  const cut = out.replace(MERCHANT_TRUNCATED_PAREN, "").trim();
  if (cut.length >= 4) out = cut;
  out = out.replace(/^[\s\-–—·・,.]+/, "").replace(/[\s\-–—·・,]+$/, "").trim();
  return out || src; // 다 지워지면 원본을 살린다 — 빈 상호보다 낫다
}

// 카드앱(토스 등) 결제 알림 형식: "{카드명} | {가맹점}({할부표기})". 파이프 뒤가 가맹점. (설계 docs/household/51)
// 은행 SMS·[Web발신] 문자엔 '|'가 없어 안전. 정상 상호 손실 방지를 위해 stripMerchantNoise를 태우지 않는다.
function extractPipeMerchant(t: string): string | null {
  const idx = t.indexOf("|");
  if (idx < 0) return null;
  const m = t
    .slice(idx + 1)
    .replace(/잔액\s*[0-9][0-9,]*\s*원?/g, " ") // 다음 줄에 붙는 '잔액 1,724,835원' 꼬리 제거(실상호에 없는 표기라 안전)
    .replace(/[（(]\s*(?:일시불|할부|\d+\s*개월)?\s*[)）]?\s*$/g, " ") // 끝의 (일시불)/(NN개월)/(할부) 할부표기 제거
    .replace(/(?:[（(]\s*[)）]|[（(])+\s*$/g, " ") // 짝 안 맞는 잔여 여는괄호·빈 괄호쌍(전각 포함)만 제거 — '(카카오페이)' 같은 정상 괄호는 보존
    // 페이스페이 할인 꼬리 제거. (설계 154, 팀장 지시 2026-08-06)
    // 알림 형식이 바뀌었다 — 예전엔 `결제 페이스페이 (토스뱅크) | 아구랑코다리` 였는데
    // 지금은 `결제 토스뱅크 | 비발디파크 오션월드 페이스페이 1,000원 할인` 처럼 **상호 뒤에** 붙는다.
    // 할인액은 상호가 아니고 금액마다 달라 **매번 다른 학습키**를 만든다(사실상 1회용 키).
    .replace(/\s*페이스페이\s*[0-9][0-9,]*\s*원?\s*할인\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeMerchantName(m);
}

// 카드앱 알림의 파이프 앞 카드명 추출(예: '5,500원 결제 우리체크 | …' → '우리체크'). (설계 docs/household/51)
function extractCardName(t: string): string | null {
  const idx = t.indexOf("|");
  if (idx < 0) return null;
  const name = t
    .slice(0, idx)
    .replace(new RegExp(WON_AMOUNT_RE.source, "g"), " ") // 금액(원 포함)
    .replace(/[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,}/g, " ") // 남은 숫자
    .replace(/(결제|승인|취소|일시불|할부|누적|잔액|원)/g, " ")
    .replace(/\s+/g, "")
    .trim();
  return name || null;
}

// 카드 할부 개월수 추출: 'NN개월'의 NN. 2 이상만 할부로 본다(일시불·00개월·01개월 → null). (설계 docs/household/54)
// 예: '170,000원 02개월' → 2, '(3개월)' → 3, '일시불' → null.
export function extractInstallmentMonths(text: string): number | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const m = t.match(/(\d{1,2})\s*개월/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 2 ? n : null;
}

// 가맹점/적요 추출: 시각 뒤 텍스트를 우선하고, 시각이 없는 은행/자동이체 문자는 금액 뒤 텍스트를 사용.
// t 는 공백이 접힌 본문(parseSms 가 만든다), raw 는 줄바꿈이 살아 있는 원문이다.
// 줄 구조는 알림에서 의미가 있다(둘째 줄 = 마케팅 문구·안내문) → 줄 단위 규칙에만 raw 를 쓴다. (설계 106)
function extractMerchant(t: string, raw: string): string | null {
  const rawLines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  // 카드앱(토스 등) 파이프 형식을 최우선 처리(일반 로직이 카드명·할부표기를 잘못 잡는 걸 방지). (설계 docs/household/51)
  const pipe = extractPipeMerchant(t);
  if (pipe) return pipe;

  // 증권 배당금 입금 알림: "{발행사} 배당금 입금🎉 / {증권사} 계좌로 N원이 입금됐어요." (설계 190)
  // 일반 경로는 이 서술형에서 상호를 **아예 못 뽑고**(null) 기관명 '토스'만 남겨,
  // merchant_map 의 짧은 키 `"토스"`(환급/캐시백·토스뱅크)가 배당 입금을 삼켰다(2026-08-25 실사고).
  // ★좁게 발동한다(설계 106) — '배당금 입금'과 '증권 계좌로'가 **둘 다** 있을 때만.
  //   은행이 보내는 "○○ 배당금 입금 100,000원" 같은 문자는 뒤 조건이 없어 일반 경로로 간다.
  // 상호에 '배당금'을 붙여 둔다 — 팀장이 8/25 에 확정하며 학습한 키가 `아이스크림미디어 배당금` 이고,
  // 발행사만 남기면 그 규칙에 안 걸려 다음 배당이 또 미분류로 들어온다.
  if (/증권\s*계좌로/.test(t)) {
    // ★발행사는 **낱말 경계에서만 시작**시킨다(`(?:^|\s)`) — 이게 이 분기의 핵심 방어다.
    //   예전엔 문자군(`[가-힣A-Za-z0-9()·\s]`)으로 30자를 되짚었는데, 그 군에 없는 글자
    //   (`&`·`-`·`.`·`/`)가 이름 안에 있으면 매치가 그 **뒤**에서 시작해 앞이 잘렸다:
    //     `TIGER 미국S&P500 배당금` → 상호 `P500 배당금`   ← 교차검토 2026-08-26 실측
    //   토스증권 배당(분배금)의 대표 상품군이 바로 이런 ETF 이름이라 가정이 아니다. 게다가
    //   merchant_map 은 **부분일치**라 `P500` 같은 조각이 학습되면 TIGER·KODEX·ACE 의 서로 다른
    //   S&P500 상품이 전부 한 규칙으로 접힌다 — 이 수정이 막으려던 바로 그 오염이다.
    //   낱말 경계에서만 시작하면 조각이 원천적으로 안 생긴다(30자 상한에 걸리면 매치 자체가 없다).
    // 발행사는 **배당금 바로 앞 1~2 낱말**만 본다. 더 늘리면 앞 안내문이 딸려오고, 1낱말로 줄이면
    //   `TIGER 미국S&P500` 같은 두 낱말 상품명이 앞 브랜드를 잃는다.
    // ★긴 키가 섞여 들어오는 것은 **덜 위험하다** — merchant_map 은 키가 상호에 포함될 때만 맞으므로
    //   긴 오상호는 다음에 안 맞고 끝난다(빈칸과 같다). 반대로 짧은 조각은 남의 상호까지 삼킨다.
    const dividend = t.match(/(?:^|\s)(\S{1,30}(?:\s\S{1,30})?)\s*배당금\s*입금/);
    // ① 앞 낱말이 안내 문장의 꼬리면 잘라 낸다(설계 106 의 payApp 분기와 같은 수법).
    //    `입니다/이에요/예요/네요` 도 포함한다 — `입금 알림입니다 아이스크림미디어` 실측(교차검토).
    // ② tidyMerchant 로 앞머리 부스러기·날짜 접두 정리(설계 114) — 안 하면 매달 학습키가 갈린다.
    // ③ 문장꼴·길이 상한·**최소 2글자**를 못 넘기면 채택하지 않고 일반 경로로 흘린다.
    //    오상호를 만드느니 빈칸이 낫다(설계 106).
    const clause = (dividend?.[1] ?? "").replace(
      /^.*(?:어요|에요|예요|이에요|네요|습니다|합니다|입니다)[.!]?\s+/,
      ""
    );
    // ④ 글자가 하나도 없는 앞 낱말(이모지·기호만)은 버린다 — `🎉 가 배당금 입금` 이 실제로 들어왔을 때
    //    상호가 `🎉 가 배당금` 이 되던 구멍(교차검토 2026-08-26). 벗겨 낸 뒤 최소 2글자를 못 채우면 빈칸.
    const issuer = tidyMerchant(clause).replace(/^(?:[^가-힣A-Za-z0-9\s]+(?:\s+|$))+/, "").trim();
    const name = issuer.length >= 2 ? `${issuer} 배당금` : "";
    if (name && name.length <= MERCHANT_MAX_LEN && !looksLikeSentence(issuer) && !isSentenceFragment(issuer)) {
      return normalizeMerchantName(name);
    }
  }

  // 은행 출금 문자의 '카드대금' 상호를 정규형으로 못 박는다. (설계 150)
  // 일반 경로로 보내면 노이즈 제거가 기관명(`[가-힣]+카드`)과 '결제'를 차례로 지워
  // **한 글자 부스러기**만 남는다 — 실사례: `출금 14,400원 우리카드결제대 잔액 63,749원` → 상호 `대`.
  // ★한 글자 키가 merchant_map 에 학습되면 매칭이 부분일치(defaults.ts matchMerchantRule)라
  //   '대'를 포함한 모든 상호(대출·현대·대한…)에 걸려 규칙이 통째로 오염된다.
  // 은행 문자는 상호를 N자에서 자르므로 '결제대'처럼 잘린 꼴도 함께 받는다.
  const cardBill = t.match(
    /(삼성카드|현대카드|국민카드|KB카드|롯데카드|하나카드|신한카드|우리카드|비씨카드|BC카드)\s*(?:결제\s*대금?|대금\s*결제|대금)/
  );
  if (cardBill) return `${cardBill[1]}결제대금`;

  // 지역화폐 문자: "결제 완료 8,000원가맹점 부천페이 추가형 인센티브 ...".
  // 일반 금액 뒤 파싱은 인센티브·잔액 안내까지 상호로 붙이므로 고정 꼬리 앞까지만 취한다.
  const localPay = t.match(/결제\s*완료\s*[0-9][0-9,]*\s*원\s*(.+?)\s*부천페이\s*추가형\s*인센티브/);
  if (localPay?.[1]?.trim()) return localPay[1].trim();

  // 토스 결제완료 알림: "{금액}원 결제 완료 {결제수단} ・ {가맹점}"(+ 다음 줄에 마케팅 문구). (설계 106)
  // '・' 앞은 결제수단(토스페이머니·우리은행 등)이라 상호가 아니다 → '・' 뒤가 상호.
  //
  // ★교차리뷰 반영(2026-07-28) — 이 규칙은 다음 4가지를 모두 만족할 때만 발동한다(오상호 학습 방지):
  //  ① **줄에서만** 찾는다. 접힌 본문(t)으로 폴백하면 '결제 완료'와 '·'가 서로 다른 줄에 있어도 매칭돼
  //     불릿('· 문의 1588-…') 뒤를 상호로 확정하는 사고가 난다.
  //  ② 줄이 **금액으로 시작**하는 토스 형식이어야 한다(`{금액}원 결제 완료 …`).
  //  ③ '・' 앞이 **결제수단꼴**(페이/머니/카드/뱅크/은행 등)이어야 한다. 순서가 반대인 문자
  //     ("… 스타벅스 강남점 ・ 신한카드")에서 결제수단을 상호로 학습하는 걸 막는다.
  //  ④ 캡처는 다음 '・' 전까지만(승인번호 등 뒤 세그먼트 배제), 문장꼴이면 채택하지 않는다.
  // 하나라도 어긋나면 기존 일반 경로로 넘어간다(새 오염 상호를 만들지 않는 쪽이 안전).
  const dotLine = rawLines.find((line) => /^[0-9][0-9,]*\s*원\s*결제\s*완료\s*[^・·]*[・·]/.test(line));
  const payDot = dotLine?.match(/^[0-9][0-9,]*\s*원\s*결제\s*완료\s*([^・·]*)[・·]\s*([^・·]+)/);
  if (payDot) {
    const method = payDot[1].trim();
    const m = payDot[2]
      .replace(/잔액\s*[0-9][0-9,]*\s*원?/g, " ")
      // 끝의 할부표기 제거 — 파이프 규칙(설계 51)과 동일하게. 안 지우면 같은 가맹점이
      // '(일시불)'·'(3개월)'별로 다른 학습 키가 된다. (교차리뷰 반영 2026-07-28)
      .replace(/[（(]\s*(?:일시불|할부|\d+\s*개월)\s*[)）]?\s*$/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const methodLike = /(?:페이|머니|카드|뱅크|은행|체크|계좌)/.test(method) && method.split(" ").length <= 2;
    if (m && methodLike && !isSentenceFragment(m) && !looksLikeSentence(m)) return normalizeMerchantName(m); // 설계 154
  }

  // 간편결제 알림 형식("{가맹점}에서 N원을 결제했어요/송금했어요") — 가맹점이 금액 앞 '에서' 절에 온다.
  // 카카오페이·카카오모빌리티·네이버페이 등. 금액 뒤가 조사+동사 부스러기('을 결제했어요')라 일반 로직이 잘못 잡는 걸 우선 처리.
  const payApp = t.match(/(.+?)에서\s*[0-9][0-9,]*\s*원?\s*[을를]?\s*(?:결제|송금|이체|출금)/);
  if (payApp) {
    // 앞선 완결 문장("결제가 완료되었어요 ")이 캡처에 딸려오면 마지막 문장 종결어미까지 잘라낸다.
    // (실사례: "결제가 완료되었어요 위택스에서 …" → 상호 '가 완료되었어요 위택스' 오추출)
    const clause = payApp[1].replace(/^.*(?:어요|에요|습니다|합니다)[.!]?\s+/, "");
    const m = stripMerchantNoise(clause);
    if (m) return normalizeMerchantName(m); // 법인표기 정리(설계 154) — '주식회사 카카오' → '카카오'
  }

  // 토스 출금 알림: "요금납부 N원 출금 내 {기관} 통장 → {상대처}" — 화살표 뒤가 상대처다. (설계 105)
  // 일반 경로는 stripMerchantNoise 의 기관명 제거 규칙이 상대처(하나카드·웰컴저축은행 등)를 통째로
  // 지워 "내 토스뱅크 통장 →"만 남긴다 → 상대처가 기관명일 수 있으니 노이즈 제거 없이 최소 정리만.
  // "X → 내 … 통장"(포인트 전환입금 등, 화살표 앞이 상대처)은 '내 … 통장'이 화살표 뒤라 안 걸린다.
  const arrow = t.match(/내\s*[가-힣A-Za-z0-9]*\s*통장\s*→\s*(.+)$/);
  if (arrow?.[1]) {
    const m = tidyMerchant(
      arrow[1]
        .replace(/잔액\s*[0-9][0-9,]*\s*원?/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (m) return normalizeMerchantName(m); // 설계 154 — 화살표 뒤 상대처도 법인표기를 뺀다
  }

  // 은행 출금 문자의 상대처가 **은행류**면 일반 경로가 통째로 지운다. (설계 160)
  // 실사례 2026-08-10: `(구)하나은행 출금 388,748원 하나저축은행 잔액 61,252원 …` → 상호 `(구)`.
  //   stripMerchantNoise 의 기관명 제거가 상대처(`하나저축은행`)를 지우고 문두 부스러기만 남긴다.
  //   상호가 부스러기면 대출·정기지출 매칭이 전부 실패해 카테고리·대출연결이 빈 채로 들어온다.
  //   설계 105 가 토스 화살표 형식("… 통장 → 웰컴저축은행")에서 같은 문제를 이미 이렇게 풀었다.
  // ★좁게 발동한다(설계 106 원칙): `출금 {금액}원` 과 `잔액` 사이를 캡처하고, 그 값이
  //   **은행류로 끝날 때만** 채택한다. 사람 이름·가맹점은 종전 경로 그대로다(캐피탈·카드는 이미 정상).
  // ★교차리뷰 반영: 캡처가 '출금액 뒤 ~ 첫 잔액'이라 안내문·거래 메타가 섞여도 끝만 기관류면 통과한다.
  //   → **한 토막(공백 없음)·20자 이내·숫자 없음**만 받는다. 상대처 기관명은 그 꼴이다.
  const bankPayee = t.match(/출금\s*[0-9][0-9,]*\s*원\s*(.+?)\s*잔액/);
  if (bankPayee?.[1]) {
    const m = bankPayee[1].replace(/\s+/g, " ").trim();
    const compact = !/\s/.test(m) && m.length <= 20 && !/\d/.test(m);
    if (compact && /(?:저축은행|은행|새마을금고|신협|수협|우체국)$/.test(m) && !looksLikeSentence(m) && !isSentenceFragment(m)) {
      return normalizeMerchantName(m); // 설계 154 법인표기 정리
    }
  }

  // 카드 자동결제 통보: "[카드사]NNNN 자동결제 MM/DD접수 {가맹점} {금액}원" — '접수' 뒤가 가맹점. (설계 113)
  // 일반 경로는 금액 앞 전체가 후보가 돼 "[ ]1234 자동 접수 SK통신료(100000)" 부스러기가 상호로 남는다.
  // 앵커 셋('자동결제'+'접수'+금액)을 모두 요구해 좁게 발동하고, 어긋나면 기존 경로로. (설계 106 원칙)
  // ★교차리뷰 반영(2026-07-30): '접수번호'의 '접수'를 앵커로 오인해 '번호 9876 …'이 상호가 되던 것 → (?!번호).
  const autopay = t.match(/자동\s?결제\s*(?:\d{1,2}\/\d{1,2}\s*)?접수(?!번호)\s*(.+?)\s*[0-9][0-9,]*\s*원/);
  if (autopay?.[1]?.trim()) {
    const m = autopay[1].replace(/\s+/g, " ").trim();
    if (!looksLikeSentence(m) && !isSentenceFragment(m)) return normalizeMerchantName(m); // 설계 154
  }

  // 휴대폰 소액결제 안내(효성FMS·다날·KG모빌리언스 등 결제대행): 상호는 '요청 사이트' 뒤에 온다.
  // 실사례 2026-08-03: "[효성FMS/SKT] 휴대폰 결제가 완료되었습니다. - 요청 일시: … - 요청 사이트:
  // (주)블루앤[1522-4655] - 요청 금액: 1,100 - 결제 대행사: 효성FMS[…] ■ [이번 달] 이용 내역 안내 …"
  // → 일반 경로는 금액 뒤 전체가 후보라 안내문이 통째로 상호가 됐다(수집함 표에서 15줄로 꺾였다).
  // ★'요청 사이트' 앵커 하나만 믿고, **다음 구분자(' - ' 또는 '■') 전까지만** 캡처한다.
  //   '결제 대행사'(효성FMS 등)는 상호가 아니므로 절대 쓰지 않는다. (설계 132)
  // ★상호 서두에 '휴대폰소액결제'를 붙인다(설계 135) — 통신요금 합산 청구라 계좌·카드에서 바로
  //   안 나가는 돈이다. 표기가 없으면 일반 지출로 확정해 다음 달 통신료와 이중 계상하기 쉽다.
  //   팀장이 수집함에서 표기를 보고 확인 후 직접 무시(삭제) 처리하는 운영.
  const mobilePay = t.match(/요청\s*사이트\s*[:：]\s*(.+?)\s*(?:[-–—]\s|■|$)/);
  if (mobilePay?.[1]) {
    const m = mobilePay[1]
      .replace(/\[[\d\s-]+\]/g, " ") // 상호 뒤 대표번호 "[1522-4655]"
      .replace(/\s+/g, " ")
      .trim();
    if (m && !looksLikeSentence(m)) return `휴대폰소액결제 ${normalizeMerchantName(m) ?? m}`; // 설계 154
  }

  // 은행 계좌 출금/입금 SMS: "...{마스킹계좌(대시 포함)} {적요} {금액} 잔액{잔액}" — 적요가 상대처/목적.
  // (KB국민은행 실사례: "...110-11-0***-111 KB카드출금 카드출금( 459,200 잔액..." → 'KB카드')
  // 카드번호(**1234)와 달리 '대시 포함 마스킹 계좌'가 있고 끝에 '잔액'이 붙는 형식만 대상 → 카드승인 문자 오인 없음. (설계 76)
  const bank = t.match(/\d+-\d+[\d-]*\*+[\d-]*\s+(.+?)\s+[0-9][0-9,]*\s*잔액/);
  if (bank?.[1]) {
    const desc = bank[1].trim();
    const inst = extractInstitution(desc); // 신한저축은행·KB카드 등 기관/카드사 우선
    if (inst) return inst;
    const cleaned = stripMerchantNoise(desc); // 기관 아니면(지로·사람이름 등) 노이즈만 정리
    if (cleaned) return normalizeMerchantName(cleaned); // 법인표기 정리(설계 154) — '(주)소노스' → '소노스'
  }

  const timeMatch = t.match(/\d{1,2}:\d{2}(:\d{2})?/);
  const amountMatch = t.match(WON_AMOUNT_RE);
  const candidates: string[] = [];

  if (timeMatch?.index != null) {
    candidates.push(t.slice(timeMatch.index + timeMatch[0].length));
  }
  if (amountMatch?.index != null) {
    // 줄 단위 후보(설계 106): 금액이 있는 줄의 '금액 뒤', 비어 있으면 '다음 줄'. 접힌 본문(t)으로 자르면
    // 둘째 줄 마케팅 문구·안내문까지 상호에 붙는다("… ・ KT 결제한 돈 일부를 돌려받을 수 있어요.").
    // ★교차리뷰 반영: 줄 후보가 안내 문장이면(“…확인하세요”) 상호가 아니다 → 아래 루프에서 걸러
    //   다음 후보(접힌 본문)로 넘어간다. 안내 줄이 상호 줄 앞에 끼어도 상호를 잃지 않는다.
    const li = rawLines.findIndex((line) => line.includes(amountMatch[0]));
    if (li >= 0) {
      const after = rawLines[li].slice(rawLines[li].indexOf(amountMatch[0]) + amountMatch[0].length).trim();
      if (after) candidates.push(after);
      else if (rawLines[li + 1]) candidates.push(rawLines[li + 1]);
    }
    candidates.push(t.slice(amountMatch.index + amountMatch[0].length));
    // 가맹점이 금액 앞에 오는 카드 형식("하나은행 씨유 승인금액 5000원")을 위한 마지막 후보.
    // 단 서술형 알림("… 10,000원 입금됐어요.")의 금액 앞은 안내 도입부("입금 알림 KB국민은행 계좌에")라
    // 상호가 아니다 → 이 후보를 버린다(빈칸이 오상호보다 낫다). (설계 106)
    // ★교차리뷰 반영: '문장이 종결어미로 끝나면 무조건 버리기'는 과했다 — "오늘의커피 5,000원 결제됐어요."
    //   처럼 금액 앞이 진짜 상호인 경우까지 죽는다. **금액 앞이 조사로 끝날 때만**(…계좌에/…에게) 버린다.
    const pre = stripMerchantNoise(t.slice(0, amountMatch.index));
    const introClause = looksLikeSentence(t) && /(?:에|에게|으로|로|에서|의)$/.test(pre);
    if (!introClause) candidates.push(t.slice(0, amountMatch.index));
  }

  for (const c of candidates) {
    // tidyMerchant 를 노이즈 제거 **뒤**에 태운다 — '입금'이 먼저 빠져야 '되었습니다.'가 앞머리로 드러난다.
    const cleaned = tidyMerchant(stripMerchantNoise(c));
    // 문장꼴 탈락은 **여러 단어일 때만** 적용한다 — 한 단어짜리 상호('카페예요')까지 죽이면 안 된다.
    // 한 단어는 isSentenceFragment(서술어 조각 목록)로만 거른다. (교차리뷰 반영 2026-07-28)
    const sentence = /\s/.test(cleaned) && looksLikeSentence(cleaned);
    // ★길이 상한(설계 132): 사람이 짓는 상호는 이만큼 길지 않다. 넘으면 안내문을 통째로 집은 것이다 —
    //   다음 후보로 넘어가고, 끝까지 없으면 빈칸으로 둔다(오상호를 만드느니 빈칸 — 설계 106 원칙).
    //   화면에서도 이게 마지막 방어선이다: 긴 문자열 하나가 표 한 칸을 15줄로 꺾어 표 전체를 무너뜨린다.
    if (cleaned.length > MERCHANT_MAX_LEN) continue;
    // 법인표기·잘린 괄호 조각 정리는 **판정을 다 통과한 뒤** 마지막에 한다(설계 154) —
    // 먼저 걷어내면 길이·문장꼴 판정이 원문과 다른 문자열을 보게 된다.
    if (cleaned && !isSentenceFragment(cleaned) && !sentence) return normalizeMerchantName(cleaned);
  }

  return null;
}

/** 상호로 인정할 최대 길이(글자). 실측 상 가장 긴 정상 상호가 20자 안쪽이라 넉넉히 잡았다. (설계 132) */
const MERCHANT_MAX_LEN = 40;

/** 마스킹된 계좌번호 끝 4자리 추출: `*NNNNNN`(6자리) → 뒤 4자리. 카드 끝4자리(`**NNNN`, 4자리)와 구분해 5자리 이상만 계좌로 본다. */
// ⚠️예시에 실제 계좌·카드 번호를 적지 마라 — 교차리뷰 에이전트가 PII 로 보고 리뷰를 중단한다(2026-08-09).
function extractAccountTail(t: string): string | null {
  // ★설계 160: 마스킹과 끝자리 사이에 **하이픈**이 오는 은행이 있다 — 하나은행 `100-******-12345`.
  //   예전엔 `*` 바로 뒤 숫자만 받아 끝4를 못 뽑았고, 앞자리 폴백도 `133`(3자리)이라 5자리 미만으로
  //   버려져 **계좌가 아예 안 붙었다**(2026-08-10 하나저축은행 대출 납부 건). 국민은행 형식은
  //   앞자리가 6자리라 폴백이 받아 줘서 이 결함이 그동안 드러나지 않았다.
  //   ⚠️5자리 이상 요구는 그대로 둔다 — 카드 끝4(`**1234`)를 계좌로 오인하지 않기 위한 가드다.
  const m = t.match(/\*+[\s-]*(\d{5,})/);
  if (!m) return null;
  return m[1].slice(-4);
}

/** 마스킹 계좌의 앞 숫자 추출: '110-11-0***-111' → '110110'(5자리↑만). 끝자리까지 마스킹돼 끝4를 못 뽑는 경우의 매칭용. */
function extractAccountPrefix(t: string): string | null {
  const m = t.match(/(\d[\d-]*)\*+[\d-]*/); // 마스킹(*) 앞에 오는 숫자/대시 묶음
  if (!m) return null;
  const digits = m[1].replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

// 접미사가 없거나(토스) 분리되기 쉬운(체크카드 오인) 기관은 명시 목록으로 먼저 잡는다. (설계 docs/household/32)
const KNOWN_INSTITUTIONS = [
  "KB국민카드", "KB국민은행", "국민카드", "국민은행", "신한카드", "신한은행", "우리카드", "우리은행",
  "하나카드", "하나은행", "NH농협카드", "NH농협", "농협카드", "농협은행", "삼성카드", "현대카드", "롯데카드",
  "비씨카드", "BC카드", "씨티카드", "씨티은행", "카카오뱅크", "카카오페이", "케이뱅크", "토스뱅크", "토스",
  // ★증권사는 **반드시 명시 목록에 둔다** (설계 190). 접미사 패턴(`…증권`)은 잡을 수 있지만,
  //   이 목록에 이미 있는 짧은 이름(`토스`·`카카오페이`)이 **같은 자리에서 먼저 걸려** 일반 패턴까지
  //   가지도 못한다. 그래서 배당 입금 알림의 기관이 `토스증권`이 아니라 `토스`로 잡혔고,
  //   그 값이 토스뱅크 계좌 추론으로 이어졌다(2026-08-25 실사고). 같은 자리면 **긴 이름이 이긴다.**
  "토스증권", "카카오페이증권",
  "IBK기업은행", "기업은행", "수협", "새마을금고", "우체국", "부천페이", "네이버페이", "페이코", "SC제일은행",
  "부산은행", "대구은행", "경남은행", "광주은행", "전북은행", "제주은행", "산업은행",
];
// 접미사 기반 일반 패턴(목록에 없는 기관 포착). 결제문자는 기관명이 앞에 오므로 첫 매칭을 쓴다.
const INSTITUTION_RE = /[가-힣A-Za-z]{2,}(?:저축은행|은행|뱅크|카드|페이|증권|캐피탈)/g;
// 기관이 아닌 일반 카드유형 — 접미사 패턴이 기관으로 오인하지 않게 제외.
const INSTITUTION_BLACKLIST = new Set(["카드", "체크카드", "신용카드", "법인카드", "가상카드", "선불카드", "기프트카드"]);

/** 기관명(은행/카드사/페이) 추출. 명시 목록 중 가장 앞(동률이면 가장 긴 것)을 우선, 없으면 접미사 패턴 첫 매칭(일반 카드유형 제외). */
export function extractInstitution(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  let best: { name: string; idx: number } | null = null;
  for (const name of KNOWN_INSTITUTIONS) {
    const idx = t.indexOf(name);
    if (idx < 0) continue;
    if (!best || idx < best.idx || (idx === best.idx && name.length > best.name.length)) {
      best = { name, idx };
    }
  }
  if (best) return best.name;
  const re = new RegExp(INSTITUTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (!INSTITUTION_BLACKLIST.has(m[0])) return m[0];
  }
  return null;
}

/**
 * 캐시백 결합 알림("N원 캐시백 🎉 M원 결제 | 가맹점")의 **결제 금액 M**. 해당 형식이 아니면 null. (설계 165)
 * `원 캐시백` **인접** 매칭만 인정한다 — 우리은행 "입금 1,250원 체크할인캐시백"(금액 1개 = 곧 거래액)은
 * '체크할인'이 사이에 끼어 발동하지 않고, 부천페이 인센티브 알림은 '캐시백' 단어가 없어 무관.
 * 수집(ingest)의 이중수집 가드도 이 함수로 결합 알림 여부를 판정한다.
 */
export function cashbackComboPayAmount(text: string): number | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const cb = t.match(/([0-9][\d,]*)\s*원\s*캐시백/);
  const pay = t.match(/([0-9][\d,]*)\s*원\s*결제/);
  if (!cb || !pay) return null;
  // ★관측 형식(캐시백이 앞, 결제가 뒤)만 인정한다(교차리뷰: "10,000원 결제 시 500원 캐시백" 같은
  //   혜택 안내가 반대 순서로 걸려 금액을 덮는 오발동 차단 — 설계 106 '좁게 발동' 원칙).
  if ((cb.index ?? 0) > (pay.index ?? 0)) return null;
  return parseInt(pay[1].replace(/,/g, ""), 10);
}

/** 카드론 실행/승인 안내문에 명시된 실행금과 조건. 두 앵커가 모두 있는 형식에만 발동한다. */
export function parseCardLoanNotice(t: string): { amount: number | null; terms: SmsLoanTerms } | null {
  // ① 상품명 + ② 금액 앵커(둘 다 본문 어디든) + ③ **머리말 판정**(앞 120자 = 제목·첫 문장).
  //   ★완료/부정 판정을 본문 전체에 걸지 마라(2026-08-17 실측) — 실행 안내문의 **법정 상용구**에 '대출철회권'·'고금리 대출 상환 안내
  //     사기 주의'·'연체이자율' 이 들어 있어 전체 부정 조건은 진짜 실행 안내를 떨어뜨렸고, KB 실원문에는 '입금되었습니다' 같은
  //     완료 어휘가 본문에 아예 없다(제목 `장기카드대출입금안내` 와 `대출취급일` 뿐). 축약 픽스처는 통과했는데 실물이 떨어졌다.
  //   ★`이용\s*가능` 을 부정 조건에 넣지 마라 — 카드 관용구 '이용가능금액' 에 걸린다(승인 규칙 ㉠과 같은 함정).
  if (!/장기카드대출|카드론/.test(t) || !/대출금액|이용금액/.test(t)) return null;
  const head = t.slice(0, 120);
  // 머리말의 부정 신호: 취소·철회·거절·실패·명세·상환·결제예정·사전승인·한도·부정형('승인되지 않')
  //   ★부정 신호는 **필드 라벨과 겹치지 않는 형태**로 — `상환` 은 KB 의 '상환방식 :' 라벨, `한도` 는 '이용한도' 에 걸린다(2026-08-17 종단에서 실측).
  //   ★`상환(?!\s*방식)` 처럼 넓히지 마라 — KB 머리말의 '원금균등상환 대출취급일' 이 걸린다. 상환 통지 어휘만 열거.
  if (/취소|철회|거절|실패|미승인|명세서|상환\s*(?:안내|예정|일|완료|액)|중도\s*상환|전액\s*상환|결제\s*예정|사전\s*승인|승인\s*가능|한도\s*안내|신청\s*안내|되지\s*않/.test(head)) return null;
  // 머리말의 완료 신호: '입금안내'(KB 제목) · '입금되' · '승인 완료' · '승인되' · '실행'
  if (!/입금\s*안내|입금되|승인\s*완료|승인되|실행/.test(head)) return null;

  const valuePattern = "([0-9][\\d,]*\\s*억(?:\\s*[0-9][\\d,]*\\s*만)?\\s*원|[0-9][\\d,]*\\s*만\\s*원|[0-9][\\d,]*\\s*원)";
  const parseWonValue = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const compact = raw.replace(/,/g, "").replace(/\s+/g, "");
    const eok = compact.match(/^(\d+)억(?:(\d+)만)?원?$/); // '1억원'(만 단위 없음)도 읽는다(배포 전 리뷰 High)
    if (eok) return Number(eok[1]) * 100_000_000 + Number(eok[2] ?? 0) * 10_000;
    const man = compact.match(/^(\d+)만원$/);
    if (man) return Number(man[1]) * 10_000;
    const won = compact.match(/^(\d+)원$/);
    return won ? Number(won[1]) : null;
  };
  const anchoredAmount = (anchor: "대출금액" | "이용금액" | "납입예상총원리금") => {
    const match = t.match(new RegExp(`${anchor}\\s*[:：]?\\s*${valuePattern}`));
    return parseWonValue(match?.[1]);
  };

  // `연체이자율 : 24.00%` 이 앞에 오는 형식에서 연체금리를 집지 않게 좌측 경계(부정 룩비하인드).
  const rateMatch = t.match(/(?<!연체\s?)(?:적용)?이자율\s*[:：]?\s*(?:연\s*)?([0-9]+(?:\.[0-9]+)?)\s*%/);
  const termMatch = t.match(/대출기간\s*[:：]?\s*([0-9]{1,3})\s*개월/);
  const repaymentMatch = t.match(/상환방식\s*[:：]?\s*([^\s·,]+)/);
  // 만기일: `대출만기일 : 2028-02-10` / `만기일 : 2028.02.10`. 기간(개월)으로 계산하지 않고 명시된 것만 — 카드사 회차 규칙이 제각각이라 계산값은 대조 근거가 못 된다.
  const maturityMatch = t.match(/(?:대출)?만기일\s*[:：]?\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  const maturityDate = maturityMatch ? `${maturityMatch[1]}-${maturityMatch[2].padStart(2, "0")}-${maturityMatch[3].padStart(2, "0")}` : null;
  const repaymentText = repaymentMatch?.[1] ?? "";
  const repaymentType = repaymentText.includes("원리금균등")
    ? "annuity"
    : repaymentText.includes("원금균등")
      ? "equal_principal"
      : repaymentText.includes("만기일시")
        ? "interest_only"
        : null;

  return {
    amount: anchoredAmount("대출금액") ?? anchoredAmount("이용금액"),
    terms: {
      rate: rateMatch ? Number(rateMatch[1]) : null,
      termMonths: termMatch ? Number(termMatch[1]) : null,
      repaymentType,
      totalRepayment: anchoredAmount("납입예상총원리금"),
      maturityDate,
    },
  };
}

/** 결제문자 룰 파싱. */
export function parseSms(text: string, sender?: string | null): SmsParsed {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { kind: "unknown", amount: null, merchant: null, occurredAt: null, occurredTime: null, balance: null, cardLast4: null, accountTail: null, accountPrefix: null, accountSuffix: null, institution: null, cardName: null, installmentMonths: null, loanTerms: null };

  const cardLoanNotice = parseCardLoanNotice(t);
  // 카드론 실행·승인 안내는 계좌로 들어오는 실행금이다 — '승인' 어휘 때문에 approve(카드 지출)로 새면 안 된다(설계 181).
  const kind: SmsKind = cardLoanNotice ? "deposit" : detectKind(t);

  // 잔액(원 선택적: '잔액 18,058원'·'잔액4,104,319' 모두)
  const balMatch = t.match(/잔액\s*[:]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,})\s*원?/);
  const balance = balMatch ? parseInt(balMatch[1].replace(/,/g, ""), 10) : null;

  // 금액: 잔액 제외한 본문에서 원-금액 우선, 없으면 첫 콤마 그룹 숫자(원 없는 '출금 5,600' 형식).
  const balText = balMatch ? balMatch[0] : "";
  const tNoBal = balText ? t.replace(balText, " ") : t;
  const amts = wonAmounts(tNoBal);
  let amount = amts.length ? amts[0] : null;
  if (amount == null) {
    const comma = tNoBal.match(/[0-9]{1,3}(?:,[0-9]{3})+/);
    if (comma) amount = parseInt(comma[0].replace(/,/g, ""), 10);
  }
  // ★설계 165: 캐시백 결합 알림("N원 캐시백 🎉 M원 결제 | 가맹점")은 첫 금액이 캐시백이라
  //   거래액(결제 M)을 놓친다 — 실사례 2026-08-12 쿠팡 19,220원이 57원으로 수집됨.
  const comboPay = cashbackComboPayAmount(tNoBal);
  if (comboPay != null) amount = comboPay;
  if (cardLoanNotice) amount = cardLoanNotice.amount;

  // 카드 끝4자리: '1234**' 또는 '**1234'. 마스킹이 없으면 카카오톡 카드 알림의
  // '{발급사약칭}NNNN승인'(예: 삼성1234승인) 폴백 — 기존 형식엔 '승인' 직전에 숫자가 오지 않아 안전. (설계 docs/household/57)
  let cardLast4: string | null = null;
  const c1 = t.match(/(\d{4})\*{2,}/);
  const c2 = t.match(/\*{2,}(\d{4})/);
  const c3 = t.match(/[가-힣]\s?(\d{4})\s*승인/);
  // 카드 자동결제 통보 '[카드사]NNNN 자동결제'(예: [삼성카드]1234 자동결제 07/28접수 SK통신료…) —
  // 마스킹(c1·c2)도 '승인'(c3)도 없어 끝4를 못 뽑던 형식. '카드]' 직후 4자리 + '자동결제' 앵커를
  // 모두 요구해 좁게 발동한다. ★교차리뷰 반영(2026-07-30): 앵커가 `\]`뿐이면 '[Web발신] 5000 자동결제'·
  // '[고객번호]1234 자동결제' 같은 비카드 대괄호에서도 발동한다 → 대괄호 내용이 '…카드'로 끝날 때만. (설계 docs/household/113)
  const c4 = t.match(/카드\]\s?(\d{4})\s*자동\s?결제/);
  // KB Pay 앱 사용알림이 문자로 오는 형식 'KB Pay[KB Pay 사용 알림] 신용 9012 08/18 14:57 54,780원 상호 승인' —
  // 마스킹(c1·c2)도 '승인' 직전 숫자(c3)도 없다. 'KB Pay' 머리말 + '신용|체크 NNNN' 을 모두 요구해 좁게 발동. (설계 183)
  // ★c3 보다 앞에 둔다(반증 리뷰): 이 형식은 '{상호} 승인' 꼴이라 상호가 4자리로 끝나면('서울33바1234 승인')
  //   c3 가 그 숫자를 끝4 로 집는다 — 명시적 '신용 NNNN' 이 있으면 그쪽이 권위다. 마스킹(c1·c2)은 여전히 우선.
  //   교차리뷰 반영: ①머리말은 'KB Pay' 만이 아니라 '…(사용|결제|승인) 알림' 제목까지 요구한다 — KB Pay 발신
  //   마케팅('신용 30000원 이상 결제시')이 c5 사정권에 들어 우연히 등록카드와 맞으면 틀린 카드가 조용히 채워진다.
  //   ②끝4 뒤 숫자·금액 경계 — '신용 54780원' 의 앞 4자리와 '신용 1234원' 금액 오추출 차단.
  //   ③닫는 대괄호까지 있는 정확한 제목형('[KB Pay 사용 알림]')만 허용한다.
  const kbPayHead = /^\s*(?:\[?web발신\]?\s*)?(?:KB\s?Pay\s*)?\[\s*KB\s?Pay\s+(?:사용|결제|승인)\s*알림\s*\]/i.test(t);
  const c5 = kbPayHead ? t.match(/(?:신용|체크)\s?(\d{4})(?!\d|\s*원)/) : null;
  if (c2) cardLast4 = c2[1];
  else if (c1) cardLast4 = c1[1];
  else if (c5) cardLast4 = c5[1];
  else if (c3) cardLast4 = c3[1];
  else if (c4) cardLast4 = c4[1];

  const occurredAt = parseSmsDate(t);
  const occurredTime = parseSmsTime(t);
  let merchant = extractMerchant(t, text ?? "");
  if (kind === "cancel" && merchant) merchant = `[취소] ${merchant}`;
  if (!merchant && sender) merchant = sender.trim() || null;

  const accountTail = extractAccountTail(t);
  const accountPrefix = extractAccountPrefix(t);
  const kbAccountMask = t.match(/\b(\d{6})-\*\*-\*{3}(\d{3})\b/);
  const accountSuffix = kbAccountMask?.[2] ?? null;
  // KB Pay 사용알림엔 카드사 이름이 없다('KB Pay' 뿐) — 끝4가 **c5 로** 잡힌 건 KB국민카드 발급분이다. (설계 183)
  //   (교차리뷰: c5 정규식이 맞았다는 것과 끝4의 출처가 c5 라는 것은 다르다 — 마스킹 c1·c2 가 이겼으면 폴백하지 않는다)
  const c5Used = c5 != null && cardLast4 === c5[1] && !c2 && !c1;
  // 새 6-2-6 마스크는 KB 전용인데 푸시에 은행명이 없으므로, 정확한 마스크가 있을 때만 기관을 보완한다. (설계 193)
  const institution = extractInstitution(t) ?? (c5Used ? "KB국민카드" : null) ?? (kbAccountMask ? "KB국민은행" : null);
  if (cardLoanNotice) merchant = institution ?? merchant; // 카드사명이 사전에 없으면 기존 상호(발신자 폴백)를 남긴다
  // 파이프 없는 카드 SMS의 상품명(예: "현대카드M 승인")도 보존한다.
  //   ★현대카드는 같은 카드를 "현대카드M 승인"·"현대 M 승인"(카드 글자 생략) 두 형태로 보낸다(2026-08-26 카페24 실사례).
  //   '카드'가 빠진 꼴은 **실증된 현대카드에 한해** 발급사 뒤에 영문 상품코드가 올 때만 잡고 "현대카드M" 으로 정규화한다.
  //   ⚠️전 발급사로 열면 "[KB Pay 승인 알림]"·"삼성 PAY 승인" 이 가짜 카드명(KB카드Pay)이 되어 설계 163 발급사 폴백을
  //   조용히 꺼 버린다(2026-08-26 교차리뷰 H1·H2) — 그래서 '승인' 뒤에 번호·알림·요청·안내가 오는 꼴도 제외한다.
  const productCardRaw = t.match(/((?:(?:현대|삼성|신한|하나|롯데|국민|우리|농협|KB)[가-힣A-Za-z0-9_-]*카드[A-Za-z0-9_-]*|현대\s+[A-Za-z][A-Za-z0-9_-]*))\s*승인(?!\s*(?:번호|알림|요청|안내))/)?.[1] ?? null;
  const productCardCandidate = productCardRaw?.replace(/^현대\s+([A-Za-z])/, "현대카드$1") ?? null;
  const productCardName = productCardCandidate && !productCardCandidate.endsWith("카드") ? productCardCandidate : null;
  const cardName = extractCardName(t) ?? productCardName;
  const installmentMonths = cardLoanNotice ? null : extractInstallmentMonths(t);

  return { kind, amount, merchant, occurredAt, occurredTime, balance, cardLast4, accountTail, accountPrefix, accountSuffix, institution, cardName, installmentMonths, loanTerms: cardLoanNotice?.terms ?? null };
}

/**
 * 카드사 '결제금액 … 출금완료' **사후** 안내인가 — skipDisposition 규칙 3-5d 가 true 면 ignore-trace 로 보낸다. (설계 205)
 * 실원문 2026-09-11: "삼성카드[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 \nhttp://q.samsungcard.com/…".
 * 같은 출금의 은행 문자("출금 1,503,040원이*다님 09/10 19:45 … 삼성카드 FBS출금 … 잔액431,260")가 따로 온다 — 둘 다 `sms` 라
 * 크로스소스 dedup 밖이고 상호도 달라(안내는 '완료'로 뽑힌다) payment/카드대금 pending 이 두 건 앉았다.
 * 기존 카드사 안내 규칙(3·3-3·3-3a·3-4)은 전부 **미래 예고**용이라 이 사후 꼴을 못 잡았다.
 *
 * ★ignore-noise 가 아니라 ignore-trace 다(3-5c 와 같은 이유) — 은행 문자가 폰 전달 유실로 안 온 달엔 이 안내가 유일한 증거다.
 * ★거래신호 가드(`txnSignal`)를 걸지 마라 — 안내 자체가 '출금완료' 를 품어 규칙이 항상 죽는다.
 * ★실거래 보호의 본체는 **본문 꼴**(`N월 결제금액 N원 MM/DD출금완료` 인접)이다 — 머리말만으로는 못 지킨다.
 *   카드 승인(`[Web발신] [KB국민카드] 승인 35,000원 …`)·카드론(`[삼성카드] 장기카드대출 …`)도 맨 앞에 `[…카드]` 머리말이 있다(교차리뷰 M3).
 *   본문 꼴을 넓힐 때(결제대금·출금되었습니다 등)는 승인·카드론 keep 회귀가 같이 지키는지 먼저 보라.
 * 머리말은 보조 가드다: 원문 맨 앞에 `[…카드]`(이름 1~8자, 공백 허용). 그 앞에 허용하는 건 `[Web발신]` 과 그 앞뒤의
 * 대괄호 없는 20자 이내 토막(발신자명·번호)뿐이고, 그 토막에 거래어(출금·입금·승인·이체·송금·결제)가 있으면 은행 문자로 보고 발동하지 않는다.
 * 머리말과 본문 사이에도 다른 거래가 끼면 안 된다 — 그 사이 토막에 `N원` 금액이나 승인·취소·출금·입금·이체·송금이 있으면
 * 합쳐진 승인 문자나 부분 출금일 수 있으므로 발동하지 않는다.
 * 발동 금지(종전 판정 그대로 — 규칙 13 이 잡으면 ignore-noise, 아니면 keep):
 *   - 실패·미납·부분처리어(실패·부족·미출금·미납·미결제·잔여·거절·거부·연체·불가·되지 않·못 했·안 됐/안 되·취소·일부·부분).
 *     교차리뷰 L1: 규칙 13 목록과 맞추고 미납류를 더했다.
 *   - `출금완료` 뒤에 또 `N원` 이 나오는 꼴 — '미결제 503,040원'·'잔여 결제금액 N원' 처럼 **남은 돈**을 적는 부분 출금일 수 있다(교차리뷰 R1-M2).
 *     청구액 전액이 빠졌다고 확신할 수 없으면 사람이 본다. '중 N원 출금완료' 는 본문 인접 꼴이 아니라 애초에 안 걸린다.
 */
export function isCardBillDoneNotice(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  const lead = "(?:(?!출금|입금|승인|이체|송금|결제)[^\\[]){0,20}";
  const header = new RegExp(`^${lead}(?:\\[Web발신\\]\\s*${lead})?\\[[가-힣A-Za-z ]{1,8}카드\\]`);
  const body = /\d{1,2}\s*월\s*결제\s*금액\s*[0-9][\d,]*\s*원\s*(?:이|은)?\s*\d{1,2}\/\d{1,2}\s*출금\s*완료/.exec(t);
  const headerMatch = header.exec(t);
  if (!headerMatch || !body) return false;
  const between = t.slice(headerMatch.index + headerMatch[0].length, body.index);
  if (/[0-9][\d,]*\s*원|승인|취소|출금|입금|이체|송금/.test(between)) return false;
  if (/실패|부족|미출금|미납|미결제|잔여|거절|거부|연체|불가|되지\s*(?:않|못)|못\s*했|안\s*(?:됐|되)|취소|일부|부분/.test(t)) return false;
  return !/[0-9][\d,]*\s*원/.test(t.slice(body.index + body[0].length));
}

/** ignore-trace 휴지통 행의 기본 유형. 카드대금 사후 안내만 납부, 나머지는 종전대로 지출이다. (설계 205-B) */
export function ignoreTraceGuessedType(text: string): "payment" | "expense" {
  return isCardBillDoneNotice(text) ? "payment" : "expense";
}

/**
 * 거래가 아님이 분명한 문자(광고/정보성 알림)인지 판정. true면 수집함에 넣지 않는다. (설계 docs/household/24, 40)
 * 1) 법정 광고 표기 `(광고)`  2) 거래 종류 미상(unknown)  3) 결제'예정' 안내
 * 4) 혜택/쿠폰/이벤트 안내 문구(균형 강도: "할인" 단독은 제외해 실거래 보호).
 */
/**
 * 스킵 처리 방식. (설계 docs/household/56)
 * - "keep": 정상 거래 → 수집함 pending 으로 적재.
 * - "ignore-noise": 명백한 광고/정보성(규칙 1·3~10) → DB에 흔적없이 skip.
 * - "trace-unknown": 거래인지 판단 못한 미인식(규칙 2, kind=unknown) → 휴지통(ignored)에 흔적으로 남김.
 *   실거래 오판 시 복원하거나 파서 개선 근거로 삼기 위함(흔적없이 버리면 진단 불가).
 * - "ignore-trace": 거래이긴 하지만 장부에 올리면 안 되는 문자(휴대폰 소액결제 영수증 — 통신요금에 합산 청구, 설계 196) → 휴지통(ignored)에 흔적만 남김.
 */
export type SkipDisposition = "keep" | "ignore-noise" | "trace-unknown" | "ignore-trace";

export function skipDisposition(text: string, parsed: SmsParsed): SkipDisposition {
  const t = (text ?? "").replace(/\s+/g, " ");
  // 명백한 광고/정보성(규칙 1·3~10) — 되살릴 일이 없어 흔적없이 버린다.
  if (/\(광고\)/.test(t)) return "ignore-noise"; // 1. 광고
  if (/결제\s*예정|예정\s*금액|결제예정금액/.test(t)) return "ignore-noise"; // 3. 청구예정 안내
  // 3-1. 출금·납부 예고 알림(설계 docs/household/63) — "내일은 240,000원 나가는 날 …자동이체가 있어요"처럼
  //     금액+거래어(자동이체 등)가 있어 pending 지출로 오수집되나 실제 결제가 아니다(미래 예고).
  //     완료 거래는 "…원 출금/결제/승인 → 상대처"로 오지 이런 예고 표현(나가는 날/있어요/D-1)을 쓰지 않는다.
  if (/나가는\s*날|내는\s*날|갚는\s*날|출금돼요|출금될?\s*예정|(자동)?이체가\s*있어요|D-\s*\d|상환일\s*D/.test(t)) return "ignore-noise";
  // 3-2. 요금청구서/이용대금 명세 등 '청구 명세 안내' — 다가올 청구 예고이지 실제 출금이 아니다.
  //     예: SK텔레콤 '요금안내서'(autopay로 오파싱돼 금액이 잡혀 pending으로 새던 실사례), 카드사 '이용대금명세서'.
  //     실제 승인/출금 SMS엔 '청구서/안내서/명세서' 표현이 없다. (설계 docs/household/50)
  if (/요금\s*안내서|요금\s*청구서|청구서|이용\s*대금\s*명세|이용대금명세서|요금\s*내역서/.test(t)) return "ignore-noise";
  // 3-3. 카드사 '월 명세서 도착' 안내 — 결제일이 아직 미래인 예고라 실제 출금이 아니다.
  //      실사례: "[삼성카드] 7월 명세서가 도착했어요 … ■결제일 7월 26일(7월27일 출금) ■결제금액 1,363,233원"이
  //      payment로 오파싱돼 pending 으로 샜다(과거문자 가정 탓에 날짜도 작년으로 보정됨). 승인·출금 문자엔 '명세서'가 없다.
  if (/명세서\s*가?\s*도착|명세서\s*안내|명세서\s*를?\s*확인/.test(t)) return "ignore-noise";
  // 3-3a. 카드사 '결제금액 변경' 안내 — 명세서 발송 뒤 청구액이 바뀌었다는 예고라 실제 출금이 아니다. (설계 187)
  //      실사례 2026-08-24: "[삼성카드] 8월 결제금액이 변경되었어요 … 명세서 발송 이후 변경된 결제금액을 … ■ 결제일 8월 26일
  //      ■ 결제금액 1,566,450원 … 실제 출금액이 달라질 수 있습니다" 가 payment/카드대금 pending(추정일은 작년)으로 샜다.
  //      3(예정)·3-3(명세서 도착)·3-4(MM/DD결제금액) 어느 변형도 아니었다. 거래어는 낱말 유무가 아니라 금액에 붙은 형태만 가드한다.
  //      K: '해외결제 65,000원'은 승인 낱말이 없어 실거래가 소실됐다. L: 변경 사유의 '승인취소'는 안내를 통과시켜 cancel로 둔갑시켰다.
  //      ★(?!금액)이 없으면 '결제금액 1,200,000원'의 '금액'이 마스킹 이름 자리에 매칭돼 안내문이 다시 통과한다.
  const billChangeNotice = /(?:결제|청구)\s*(?:하실\s*)?금액\s*(?:이|은|을|에)?\s*(?:변경|확정)|변경된\s*(?:결제|청구)\s*금액|이용\s*대금\s*(?:이|은|을|에)?\s*변경|명세서\s*(?:가|를|은|는)?\s*발송/.test(t);
  const txnAmountAdjacent = /(?:승인|취소|출금|입금|결제|이체)\s*(?:완료)?\s*(?!금액)(?:[가-힣*]{2,4}\s*)?[\d,]{4,}\s*원|[\d,]{4,}\s*원\s*(?:이|을|를)?\s*(?:승인|취소|출금|입금|결제|이체)/.test(t);
  if (billChangeNotice && !txnAmountAdjacent) return "ignore-noise";
  // 3-3b. 납부요청·수납 안내(학원비·회비 등). (설계 docs/household/114)
  //      실사례: "<제목: 납부요청> … 한별학생의 8월 수업료는 350,000원입니다./납부기간은 8월1일~5일 입니다.
  //      기한내에 납부 부탁드립니다 … 납부계좌) 우리은행 …" 이 **이체 350,000원**으로 pending 에 앉았다.
  //      낼 돈을 알리는 청구지 완료된 거래가 아니며, 확정하면 있지도 않은 이체가 장부에 생긴다.
  //      기존 규칙 5(`<제목:…안내…>`)는 ㉠'안내'라는 낱말을 요구하고 ㉡문자 맨 앞 고정이라
  //      발신번호가 앞에 붙은 `…<제목: 납부요청>` 을 둘 다 놓쳤다 → 제목어 확장 + 위치 고정 해제.
  if (/<\s*제목\s*:[^>]*(?:납부\s*요청|수납|청구)[^>]*>/.test(t)) return "ignore-noise";
  //      MMS 제목이 없는 문자를 위한 본문 규칙 — '납부기간' 고지와 '납부 부탁/기한 내' 요청이 함께 오면 청구다.
  //      완료 거래 문자는 낼 기간을 안내하지 않으므로 실거래를 치지 않는다.
  if (/납부\s*기간/.test(t) && /납부\s*(?:를)?\s*부탁|납부하여\s*주|기한\s*내/.test(t)) return "ignore-noise";
  // 3-3c. 무통장입금 안내(주문 접수 후 '이 계좌로 보내세요') — 앞으로 **낼** 돈 안내지 완료된 거래가 아니다.
  //      ★실사례 2026-08-13(팀장 지적): "<제목: 사평기정떡 … 무통장입금 안내> … ★무통장 입금 안내★
  //        농협 355-…-33 예금주: (주)사평기정떡 결제금액: 36,800원" 이 **income/deposit 36,800원**으로 앉았다.
  //        '무통장 입금'의 '입금'이 kindOf(124행)에 걸려 **낸 돈이 받은 돈으로 뒤집혔다.**
  //        실제 출금은 1분 뒤 우리은행 문자로 따로 왔다 — 그래서 팀장 눈에 '중복 2건'으로 보였다.
  //      판별: `무통장` **AND** `예금주`. 둘 다 있어야 '내가 보낼 계좌 안내'다.
  //      ★`입금 안내` 로 거르면 안 된다 — 전수 검사(수집함 468건)에서 **국민카드 카드론 실행금
  //        15,000,000원 입금**(확정된 진짜 거래)이 함께 걸렸다. 좁게 발동한다(설계 106).
  //      전수 검사 결과: `무통장` 1건·`예금주` 1건, **확정된 진짜 거래 0건** — 잃을 것이 없다.
  if (/무통장/.test(t) && /예금주/.test(t)) return "ignore-noise";
  // 3-4. 카드사 '결제예정 금액' 안내 — "MM/DD결제금액 N원(MM/DD기준)"처럼 미래 결제일의 청구예정액을
  //      기준일과 함께 알려주는 문자. 결제일이 미래라 실제 승인·출금이 아니다. (설계 docs/household/50)
  //      실사례: "[현대카드] 이*다님 08/03결제금액 1,625,572원(07/21기준) …결제내역확인" 이
  //      expense/approve 로 오파싱돼 pending 으로 샜다(미래날짜라 작년으로 보정까지 됨).
  //      기존 규칙 3(결제예정금액)은 '예정'이란 말이 있어야 잡아 이 변형('결제금액')을 놓쳤다.
  //      판별: 날짜가 '결제금액'에 바로 붙거나(MM/DD결제금액) '결제금액'+'MM/DD기준'이 함께 있으면 안내다.
  //      실제 승인/출금 SMS엔 '(…기준)' 기준일 표기나 날짜에 붙은 '결제금액'이 없어 오탐 위험이 낮다.
  if (/\d{1,2}\/\d{1,2}\s*결제\s*금액/.test(t) || (/결제\s*금액/.test(t) && /\d{1,2}\/\d{1,2}\s*기준/.test(t))) return "ignore-noise";
  // 3-5. 휴대폰 소액결제 '한도/누적 이용 금액 안내' — 이번 달 한도를 알려주는 통신사 안내지 결제가 아니다. (설계 149)
  //      실사례 2026-08-04: "[SKT] 휴대폰 결제 누적 이용 금액 안내 … 한도 금액: 1,000,000원 - 누적 이용 금액:
  //      112,546원 - 남은 한도 금액: 887,454원" 이 **expense 1,000,000원**(=한도액)으로 pending 에 앉았다.
  //      게다가 이 문자는 같은 시각 컬리 112,546원 결제(설계 132·135)에 딸려 온 **중복 통지**다.
  //      ★규칙 5(`^<제목:…안내…>`)의 앵커를 풀어 잡으면 안 된다 — 진짜 영수증 문자의 제목도
  //        "<제목: 휴대폰 결제 성공 안내>" 라 실거래가 통째로 죽는다(회귀 테스트로 고정).
  //      판별: ㉠**휴대폰/소액 결제 문자**이고 ㉡한도/누적 문구가 있고 ㉢**영수증 문구가 없고**
  //        ㉣**은행·카드 거래신호(승인·출금·입금)도 없을 때만**.
  //        영수증에도 '이용 가능 금액' 안내가 붙어 오므로 ㉢이 이 규칙의 본체다.
  //      ★㉠을 빼면 안 된다 — `이용\s*가능\s*금액` 은 공백 0개도 매칭해 **카드 승인 문자의
  //        '이용가능금액'** 까지 집는다. 그러면 멀쩡한 승인이 조용히 죽는다.
  //      ★영수증 판별에서 `요청 사이트`는 뺐다(교차리뷰 2026-08-04, Codex) — "한도 상향 **요청 사이트**"
  //        같은 안내문이 영수증 행세를 하며 규칙을 빠져나간다. 돈이 적힌 `요청 금액`·완료 문구만 믿는다.
  //      ★완료 문구는 조사 변형을 함께 본다 — `결제가 완료`만 인정하면 "휴대폰 결제 완료" 형식
  //        영수증이 통째로 죽는다(교차리뷰 2026-08-04, Codex). 아래 3개 방어선이 회귀 테스트로 고정돼 있다.
  const mobileLimitNotice =
    /휴대폰\s*결제|소액\s*결제/.test(t) &&
    /한도\s*금액|남은\s*한도|누적\s*이용\s*금액|이용\s*가능\s*금액/.test(t);
  const mobilePayReceipt = /요청\s*금액|결제\s*(?:가|를)?\s*완료|결제완료|승인\s*완료/.test(t);
  // 은행·카드 문자의 강한 거래신호. 있으면 '안내문' 규칙(3-5·3-6)을 발동하지 않는다 —
  // 버려서 잃는 쪽(진짜 거래 소실)이 남겨서 잃는 쪽(팀장이 수집함에서 지움)보다 훨씬 비싸다.
  //   ★규칙 3-5b 만 `승인번호` 를 뺀 변형(receiptTxnSignal)을 쓴다 — 소액결제 영수증엔 승인번호가 흔하고 그건 거래신호가 아니다.
  //     나머지 규칙은 넓은 쪽(버려서 잃는 게 더 비싸다)을 유지한다. 일부러 다르게 둔 것.
  const txnSignal = /승인|출금|입금/.test(t);
  if (mobileLimitNotice && !mobilePayReceipt && !txnSignal) return "ignore-noise";
  // 3-5b. 설계 196(2026-09-01 팀장 결정) — 설계 135의 "접두어를 붙여 keep, 팀장이 직접 삭제"를 대체한다.
  //       휴대폰 소액결제 대금은 SKT 통신요금으로 나중에 빠진다(SK통신료 삼성카드 승인: 예 8/27 168,230원 vs 예정 111,490원,
  //       차액이 소액결제분). 영수증을 확정하면 이중 계상이므로 원문은 보존한 채 휴지통으로 보낸다(오판 시 휴지통에서 복원).
  //       txnSignal(승인|출금|입금) 가드는 휴대폰 결제 문구가 든 은행·카드 거래를 살리고, mobilePayReceipt를 함께 요구해
  //       한도·상향 안내는 이전처럼 규칙 3-5 / 규칙 5로 흐르게 한다. extractMerchant의 접두어는 휴지통에서도 유용하므로 유지한다.
  //       ★취소 문자도 같은 길로 보낸다(배포 전 교차리뷰 M2, 2026-09-01) — 원 결제가 휴지통인데 취소만 pending 에 앉으면
  //         존재한 적 없는 지출의 환불이 장부에 생긴다. 취소도 통신요금에서 상계된다.
  //       ★`mobilePayReceipt` 를 조건에 넣지 마라 — 완료 문구가 곧 영수증 표식이라 항상 참인 죽은 가드였다(교차리뷰 L1).
  //       ★거래신호는 `승인번호`(영수증 자체의 승인번호 표기)를 빼고 본다 — 덱스 교차리뷰 M1: 이걸 '승인'으로 읽으면 영수증이 keep 으로 새어 pending 에 앉는다.
  const mobilePayDone = /휴대폰\s*(?:소액\s*)?결제\s*(?:가|를)?\s*(?:완료|취소)/.test(t);
  const receiptTxnSignal = /승인(?!\s*번호)|출금|입금/.test(t);
  if (mobilePayDone && !receiptTxnSignal) return "ignore-trace";
  // 3-5c. 네이버 멤버십 '이용료 결제' 안내 — 매달 5일 같은 4,900원 결제를 KB국민카드 승인 문자와 **따로** 네이버가 다시 알린다
  //       (같은 문자가 발신번호 접두 유무로 2통, 3ms 차). 셋 다 `sms` 라 크로스소스 dedup 밖이고 상호가 달라 동일소스 dedup 도 못 거른다. (설계 204)
  //       실원문 2026-09-05: "[Web발신]\n[네이버 멤버십] 멤버십 이용료 4,900원 결제" / "⁨1599-1399⁩[Web발신]\n[네이버 멤버십] 멤버십 이용료 4,900원 결제".
  //       08/05(설계 150)·09/05 두 달 연속 손으로 카드 승인 확정 + 안내 2건 ignored 처리한 것을 규칙으로 옮긴다.
  //       ★ignore-noise 가 아니라 ignore-trace 다 — 이 문자는 광고가 아니라 **실제 결제의 두 번째 통지**다. 카드 승인 문자가 어떤 이유로든
  //         안 들어온 달엔 휴지통에서 복원해 쓸 수 있어야 한다(버려서 잃는 쪽이 비싸다). 판별은 네이버 머리말+'멤버십 이용료 N원 결제' 실원문 꼴 —
  //         KB국민카드 승인 문자에는 이 머리말이 없어 실거래를 치지 않는다(회귀 테스트로 고정).
  //       ★덱스 교차리뷰(2026-09-05) 반영 두 가지: ⓐ은행·카드 거래신호 `txnSignal`(승인|출금|입금)이 있으면 발동하지 않는다 — 안내 원문엔 셋 다 없고,
  //         카드 문자가 안내 문구를 인용해 붙는 꼴이 오면 승인이 살아야 한다(넓은 쪽을 쓴다 — 3-5b 의 `receiptTxnSignal` 은 영수증 전용).
  //         ⓑ`N원 결제` 까지 요구한다 — '멤버십 이용료 변경 안내' 같은 금액 없는 안내가 거래 흔적(ignore-trace)으로 휴지통에 앉지 않게.
  //         그런 문자는 금액 없음 규칙으로 흘러 미인식(trace-unknown)이 된다.
  //       ★배포 전 교차리뷰 High(덱스, 2026-09-05): 머리말을 **문자 맨 앞**에 고정한다 — 앞에 올 수 있는 건 발신번호(대괄호 없는 짧은 토막)와
  //         `[Web발신]` 뿐이다. `[KB국민카드] [네이버 멤버십] …` 처럼 카드사 머리말 뒤에 인용된 꼴은 '승인' 낱말이 없어도 살아야 한다(keep 회귀 고정).
  //         접두가 20자를 넘거나 `[` 를 품으면 규칙이 **안 걸리는 쪽**으로 실패한다(pending 3건 — 종전 상태). 포워더 접두 형식이 바뀌면 여기부터 본다.
  //       ★배포 전 교차리뷰 High(클로드, 2026-09-05): **'결제 실패' 안내를 가로채면 안 된다** — 이 규칙이 규칙 13(실패·거절 → ignore-noise)보다
  //         앞에 있어, `… 4,900원 결제 실패. 결제수단을 확인해주세요` 가 금액 4,900·approve 를 실은 거래 흔적으로 휴지통에 앉았다.
  //         실패한 달은 카드 승인 문자도 없는 달이라 **가장 복원되기 쉬운 행**이 되고, 없는 지출이 장부에 생긴다. 실패어가 있으면 종전대로 규칙 13 에 맡긴다.
  const naverMembershipNotice =
    /^[^\[]{0,20}(?:\[Web발신\]\s*)?\[네이버\s*멤버십\]\s*멤버십\s*이용료\s*[0-9][\d,]*\s*원\s*결제/.test(t) && !/실패|거절|거부/.test(t);
  if (naverMembershipNotice && !txnSignal) return "ignore-trace";
  // 3-5d. 카드사 '결제금액 … 출금완료' 사후 안내 → 휴지통 흔적. 판별과 근거는 `isCardBillDoneNotice` 주석(설계 205).
  if (isCardBillDoneNotice(text)) return "ignore-trace";
  // 3-6. 모바일 교환권·입장권 '발송 안내' — 티켓을 보내주는 문자지 결제 문자가 아니다. (설계 149)
  //      실사례 2026-08-04: 오션월드 종일권 교환권 안내가 **expense 1,500원 / 2025-08-30 / cancel** 로 앉았다.
  //      1,500원은 본문 유의사항의 "현장 대여료(1장): 타월(샤워) 1,500원", 날짜는 이용기한("2026년 8월 30일")
  //      오파싱, cancel 은 '환불 규정' 문구 탓 — 세 값이 전부 안내문 부스러기다.
  //      실제 결제는 판매처 결제 문자로 따로 온다(이 건은 토스페이 '놀유니버스 166,098원' 알림으로 이미 수집됐다).
  //      판별: 교환권 표식과 이용안내 표식이 **함께** 있고, **거래신호(승인·출금·입금)가 없을 때만**.
  //      ★거래신호 배제가 없으면 "신한카드 승인 50,000원 … 모바일 상품권 … 사용 기한" 같은
  //        **진짜 승인 문자**가 죽는다(교차리뷰 2026-08-04, Codex). 교환권 안내문엔 이 낱말이 없다.
  const voucherMarker = /모바일\s*(?:입장권|교환권|티켓|상품권|이용권)|바코드\s*제시|▣\s*상품명|▣\s*매수|▣\s*구매자/.test(t);
  const voucherGuide = /이용\s*기간|이용\s*방법|유의\s*사항|환불\s*규정|사용\s*기한/.test(t);
  if (voucherMarker && voucherGuide && !txnSignal) return "ignore-noise";
  // 4. 혜택/쿠폰/이벤트 안내 — 거래 키워드(승인/출금 등)가 잡혀도 안내 문구가 있으면 광고 우선. (설계 docs/household/40)
  //    토스 혜택 홍보의 "받을 수 있(었)어요"가 N개월+금액 때문에 할부로 오수집된 실사고(2026-08-30, 설계 195).
  //    단, 실제 결제 뒤 같은 홍보 문장이 붙는 형식은 거래신호가 있으면 살린다.
  //    ★배포 전 교차리뷰(덱스·클로드 동시 지적, 2026-08-31): 한국어 알림은 금액이 앞에 온다("2,989원 출금", "3,000원 일시불").
  //      키워드→금액 어순만 보던 가드로는 홍보 꼬리말이 붙은 **실거래가 흔적 없이 버려진다**(ignore-noise 는 휴지통도 안 남긴다).
  //      규칙 3-5·3-6 과 같은 넓은 txnSignal(승인|출금|입금)을 함께 본다 — 실사고 원문엔 셋 다 없어 그대로 막힌다.
  const benefitPromo =
    (/혜택/.test(t) && /받을\s*수\s*있(?:었)?어요/.test(t)) ||
    /지난\s*\d+\s*개월\s*동안[\s\S]*?[0-9][\d,]*\s*원\s*받을\s*수\s*있(?:었)?어요/.test(t);
  //      ★이 좁은 신호는 규칙 9-b 도 함께 쓴다 — 넓은 txnSignal 이 '입금일' 같은 낱말에 걸려 죽는 자리용이다.
  //        한 규칙의 사정으로 이 정규식을 바꿀 땐 두 규칙을 다 보고 바꿔라.
  //      ★2026-09-02 교차리뷰 High — 처음 이 정규식은 **동사→금액** 어순만 인정했다(`입금 4,078원` ○ / `1,830원이 입금됐어요` ✗).
  //        그건 설계 195 가 낸 사고의 가정 그대로다. 한국어 알림은 금액이 앞에 온다.
  //        규칙 4 는 `!txnSignal` 이 2차 방어선이라 살았지만, 규칙 9-b 는 이 신호 하나뿐이라 **진짜 입금이 그대로 버려졌다**
  //        (실측: "…단주대금 1,830원이 입금됐어요. 보유한 주식 수가 … 변경됐어요" → 소실). 그래서 **금액 선행 어순**을 더한다.
  //        설계 195 회귀 원문("1,500원 받을 수 있었어요")은 '받을'이 거래동사가 아니라 여전히 안 걸린다.
  //      ★2026-09-02 배포 전 교차리뷰 Medium — 조사를 `이|가` 로만, 동사를 5개로 좁게 뒀더니
  //        `3,200원을 입금하였습니다`(증권·은행 정식 문투)·`45,000원 송금`·`12,000원 납부` 가 다 빠졌다.
  //        같은 파일 아래 규칙 13 이 이미 `JOSA`(이|가|은|는|을|를|에|도)를 갖고 있었다 — **한 파일 안에서
  //        같은 조사 목록이 두 벌로 갈려 있던 것**이 원인이라, 조사는 여기로 끌어올려 두 규칙이 공유한다.
  const JOSA = "(?:이|가|은|는|을|를|에|도)?";
  //      돈이 실제로 오간 동사. 규칙 13 의 `FAIL_VERB` 와 **일부러 다르다** — 저쪽은 '실패/거절' 문구 전용이라
  //      `거래` 를 포함하고 `입금` 을 뺀 목록이고, 회귀 테스트가 그 경계에 걸려 있다. 합치지 마라.
  const MONEY_VERB = "(?:결제|승인|출금|입금|이체|송금|납부|인출|충전)";
  const amountTxnSignal = new RegExp(
    `${MONEY_VERB}\\s*[0-9][\\d,]*\\s*원|[0-9][\\d,]*\\s*원\\s*${JOSA}\\s*${MONEY_VERB}|원\\s*결제`,
  ).test(t);
  if (benefitPromo && !amountTxnSignal && !txnSignal) return "ignore-noise";
  if (/혜택을?\s*확인|받(은|으실)\s*혜택|혜택\s*내용|쿠폰/.test(t)) return "ignore-noise";
  if (/이벤트/.test(t) && /당첨|응모|참여/.test(t)) return "ignore-noise";
  // 5. MMS 제목 헤더가 '…안내…'인 정보성 장문(견적·약관·공지). 카드/은행 결제 SMS엔 제목 헤더가 없다. (설계 docs/household/41)
  //    ★단 휴대폰 소액결제 **영수증은 예외**다 — 제목이 "<제목: 휴대폰 결제 성공 안내>" 라서 이 규칙에 걸린다.
  //      지금까지는 발신번호(`⁨114⁩`)가 앞에 붙어 `^` 앵커를 우연히 피했을 뿐이고, 번호 없이 오면
  //      진짜 결제가 죽는다(교차리뷰 2026-08-04, Codex). 3-5 의 영수증 판별을 그대로 재사용한다. (설계 149)
  //    ★카드론 실행 안내(설계 181)도 예외 — 제목이 "<제목: 장기카드대출입금안내>" 라서 발신번호 없이 오면 여기서 죽는다
  //      (배포 전 교차리뷰 High, 2026-08-17). 카드론 분기(parsed.loanTerms)가 잡혔으면 규칙 5·7 을 건너뛴다.
  const cardLoanNotice = parsed.loanTerms != null;
  if (/^\s*<제목:[^>]*안내[^>]*>/.test(t) && !mobilePayReceipt && !cardLoanNotice) return "ignore-noise";
  // 6. 견적서·유심 교체 등 거래가 아닌 통신/판매 안내.
  if (/견적서|유심\s*교체/.test(t)) return "ignore-noise";
  // 7. 대괄호 머리말에 '안내'가 든 카드사/은행 정보성 문자(예: [KB국민카드, 기타 안내]). (설계 docs/household/45)
  //    실제 카드승인 SMS의 대괄호는 [Web발신]·[KB국민카드]처럼 발신/기관명만 담고 '안내'를 넣지 않는다.
  if (/\[[^\]]*안내[^\]]*\]/.test(t) && !cardLoanNotice) return "ignore-noise";
  // 8. 금액이 전혀 안 잡힌 승인/취소 카드 문자 — 실제 결제엔 항상 금액이 있어 안내 문구일 가능성이 높다. (설계 docs/household/45)
  if ((parsed.kind === "approve" || parsed.kind === "cancel") && parsed.amount == null) return "ignore-noise";
  // 9. 주식/증권 시세 알림 — 토스증권 등의 보유주식 가격 변동 푸시(거래 아님). (설계 docs/household/50)
  //    실제 결제·입출금 문자엔 이런 표현이 없다.
  if (/📈|📉/.test(t)) return "ignore-noise";
  if (/주가|주식\s*가격/.test(t) && /올랐|내렸|떨어졌|상승|하락/.test(t)) return "ignore-noise";
  // 9-b. 증권 보유수량 변경 안내(액면분할·주식병합·무상증자 등) — 돈이 오간 게 아니라 주식 수가 바뀌었다는 통지. (설계 198)
  //      실사고(2026-09-02 pending): "미스터블루 액면분할 보유한 주식 수가 4,078주 → 815.60주로 변경되었어요.
  //      0.60주는 입금일에 맞춰 현금으로 드려요." → 수량 `4,078주`를 금액으로, `입금일`의 '입금'을 거래로 읽어
  //      **입금 4,078원**으로 수집됐다. 규칙 9(시세 알림)는 등락 표현만 봐서 이 계열을 못 잡는다.
  //      ★가드로 넓은 txnSignal(승인|출금|입금)을 쓰면 안 된다 — 바로 이 원문의 '입금일'에 걸려 규칙이 죽는다.
  //        금액+원이 거래 동사에 붙은 형태(amountTxnSignal)만 거래로 인정한다.
  //      단주 현금("0.60주는 … 현금으로 드려요")은 나중에 **금액이 적힌 별도 입금 알림**으로 온다.
  //      ★교차리뷰 Medium — 처음엔 조사를 선택(`수(가|는|를)?`)으로 둬 사실상 `주식수` 접두만 요구했고, 짝인 `변경|변동|조정`이
  //        너무 흔해 `주식 수수료가 변경됩니다`·`매도체결 … 보유수량 변경`·`OO펀드 보유 수량이 변경` 이 전부 걸렸다(실측).
  //        ㉠**액면분할·병합·증자 계열 표식**을 필수로 두고 ㉡조사도 필수로 해서 의도한 계열만 남긴다.
  const shareCorporateAction = /액면\s*분할|주식\s*분할|주식\s*병합|무상\s*증자|유상\s*증자|주식\s*배당/.test(t);
  const shareCountNotice =
    shareCorporateAction &&
    /주식\s*수(?:가|는|를)|보유\s*수량|보유한?\s*주식/.test(t) &&
    /변경|변동|바뀌었|조정/.test(t);
  //      ★`ignore-noise`(흔적 0)가 아니라 `ignore-trace`(휴지통 보존)다 — 교차리뷰 Medium.
  //        신설 규칙이 기존의 복구 가능한 경로를 복구 불가능으로 **강등**시키면 안 되기 때문이다.
  //        ⚠️이 규칙이 없을 때의 행선지는 원문마다 다르다(2026-09-02 배포 전 리뷰가 잡은 부정확한 주석 정정):
  //          · 금액이 안 잡히는 것(`100주 → 20주`)은 규칙 12·2 로 `trace-unknown`(복원 가능)이었다.
  //          · **사고 원문은 `keep` 이었다** — 수량 4,078 을 금액으로 읽어 `kind=deposit`·`amount=4078` 이라
  //            규칙 12·2 에 안 걸렸고, 그게 정확히 이번 pending 사고다.
  //        즉 "어차피 휴지통이었다"가 근거가 아니다. 오차단 0 이 한동안 확인되면 그때 내려도 늦지 않다는 것이 근거다.
  //      ★가드는 `amountTxnSignal` 이 아니라 **"원 단위 금액이 원문에 하나라도 있는가"** 다(2026-09-02 배포 전 2차 리뷰).
  //        동사·조사 목록을 넓히는 방식은 끝이 없다 — `출금액: 1,000,000원`(동사와 금액 사이에 글자가 낌)·
  //        `45,000원이 계좌로 들어왔어요`·`승인 이*다 26,400원`(카드 승인 형식) 이 전부 목록을 빠져나갔다.
  //        기업행위 **안내문에는 원 단위 금액이 없다**(실사고 원문·병합·증자 3형 모두 `원` 한 글자도 없다).
  //        그러니 "돈 액수가 적혀 있으면 버리지 않는다"가 이 자리의 옳은 잣대다 — 목록을 쫓지 말고 돈을 봐라.
  const hasWonAmount = /[0-9][\d,]*\s*원/.test(t);
  if (shareCountNotice && !hasWonAmount) return "ignore-trace";
  // 10. 할인/적립 안내 광고 — "N원 할인 …받을 수 있어요" 형태(규칙 4의 쿠폰/혜택이 못 잡는 보완). (설계 docs/household/50)
  if (/할인|적립/.test(t) && /받(을|으실)\s*수\s*있/.test(t)) return "ignore-noise";
  // 11. 포인트/리워드 — 적립/안내 알림은 노이즈. (설계 docs/household/50, 2026-07-15 개정)
  //     단, "N원 입금 토스 포인트 → 내 토스뱅크 통장"처럼 포인트가 통장으로 **전환 입금**된 알림은
  //     실제 은행잔액이 늘어나는 진짜 거래라 keep(income). 처음(7/5)엔 이것도 차단했으나
  //     통장내역·문자잔액 대조가 어긋나고 보스가 매번 수동입력하게 되어 전환입금만 살린다.
  //     전환입금 판별 = 금액 있음 + '입금' + "포인트 → 내 …" (적립·소멸·안내 문구엔 이 3요소가 함께 없음).
  const pointConversionDeposit = parsed.amount != null && /입금/.test(t) && /포인트\s*→\s*내/.test(t);
  // ★'포인트 {N}원 적립'처럼 낱말 사이에 금액이 끼는 변형도 잡는다(설계 136) —
  //   실사례 2026-08-04: "포인트 209원 적립 결제 혜택으로 209원 받았어요" 가 '포인트 적립'(인접)에
  //   안 걸려 income pending 으로 들어왔다. 전환입금 예외는 위 pointConversionDeposit 이 그대로 지킨다.
  if (!pointConversionDeposit && /토스\s*포인트|포인트\s*적립|리워드\s*적립|캐시백\s*적립|포인트\s*[\d,]+\s*원\s*적립/.test(t)) return "ignore-noise";
  // 11-1. 페이스페이 '적립' — 결제액의 일부가 **포인트로** 돌아오는 것이라 통장 잔액이 늘지 않는다.
  //     실제 입금은 팀장이 토스에서 **환전**할 때 따로 생기고, 그 문자는 위 전환입금 예외로 살아 있다.
  //     (팀장 확인 2026-08-04) 실사례: "4,547원 적립 페이스페이 결제하고 최대 7% 받았어요" 가
  //     **income 4,547원**으로 pending 에 앉아 있었다 — 확정했으면 없는 수입이 장부에 생긴다.
  //     ★'적립'과 '페이스페이'를 **함께** 요구한다: 페이스페이 **결제** 문자
  //     ("64,925원 결제 페이스페이 (토스뱅크) | 아구랑코다리")는 진짜 출금이라 반드시 살려야 한다. (설계 133)
  if (!pointConversionDeposit && /적립/.test(t) && /페이스페이/.test(t)) return "ignore-noise";
  // 13. 결제·출금 '실패/거절' 알림 — 돈이 나가지 않은 사건이라 가계부 거래가 아니다. (설계 docs/household/95)
  //     실사례: "195,687원 해외결제 실패 우리체크 | PLAUD LLC SAN FRA(일시불)" 가 금액+'결제'로 잡혀 pending 으로 샜다.
  //     ⚠️ 아래 규칙 12(금액 없으면 trace-unknown)보다 **앞**에 둔다 — "이체한도 초과로 이체 불가"처럼
  //        금액이 없는 실패 알림도 휴지통이 아니라 흔적없이 버리기 위함(순서를 바꾸면 조용히 동작이 달라진다).
  //     오탐 방지: 거래어와 실패어가 **붙어 있을 때만**(사이에 조사 1개까지) 매칭한다. 실제 문자는
  //        거래어와 상호 사이에 금액이 끼므로 '불가마사우나'·'환불불가 상품' 같은 상호명은 걸리지 않는다.
  const FAIL_VERB = "(?:결제|승인|출금|이체|송금|납부|거래|인출|충전)";
  // JOSA 는 규칙 4·9-b 가 쓰는 것과 같은 목록이라 위(amountTxnSignal 옆)에서 한 번만 선언한다.
  if (new RegExp(`${FAIL_VERB}\\s*${JOSA}\\s*(?:실패|거절|거부|불가)`).test(t)) return "ignore-noise";
  //     "결제가 되지 않았습니다 / 자동이체가 처리되지 못했습니다" 처럼 부정어로 쓰는 카드사 문구.
  if (new RegExp(`${FAIL_VERB}\\s*${JOSA}\\s*(?:처리)?되지\\s*(?:않|못)`).test(t)) return "ignore-noise";
  if (/실패했어요|실패하였|미승인/.test(t)) return "ignore-noise";
  //     ⚠️ '취소·환불' 자체는 실제 승인이 되돌려지는 진짜 거래라 keep 한다(위 거래어 목록에 없음).
  //        단 '취소가 실패'하면 원결제가 살아있는 것이라, 환불로 오기록되지 않도록 이것만 차단한다.
  //        ⚠️ 여기엔 '불가'를 넣지 않는다 — "환불불가 상품"·"취소불가"는 상품 약관 용어라
  //           멀쩡한 승인 문자를 차단하는 오탐이 실제로 났다(회귀 테스트 "환불불가 상품 승인 보존").
  if (/(?:취소|환불)\s*(?:이|가|은|는|에|도)?\s*(?:실패|거절|거부)/.test(t)) return "ignore-noise";
  // 12. 금액이 안 잡힌 이체/입출금 문구 — 실거래 문자엔 금액이 항상 있다. 토스 선물 알림
  //     ("아기돼지 선물 1개 도착 송금하고 받았어요")이 '송금'으로 transfer 오수집되던 실사례.
  //     확정 불가능한 행이므로 pending 대신 휴지통 흔적으로(오판 시 복원 가능). (설계 docs/household/50)
  if (parsed.amount == null) return "trace-unknown";
  // 2. 거래 키워드 없음(미인식) — 실거래 오판 가능성이 있어 흔적으로 남긴다. (설계 docs/household/56)
  //    ⚠️ 광고/정보성 규칙(위)보다 뒤에 둬서, 광고이면서 unknown인 문자는 흔적없이 버린다.
  if (parsed.kind === "unknown") return "trace-unknown";
  return "keep";
}

/** @deprecated skipDisposition 사용. 하위호환: 스킵 여부만(trace-unknown 포함). */
export function isNonTransactionalSms(text: string, parsed: SmsParsed): boolean {
  return skipDisposition(text, parsed) !== "keep";
}

/**
 * 미인식(trace-unknown) 문자를 휴지통에 남길 때의 dedup_hash. (설계 docs/household/56 결정 3)
 * 금액이 없어(smsDedupKey=null) 반복 도착 시 무한 적재되는 것을 막기 위해
 * 원문 앞 80자 + 날짜로 하루 1건으로 억제한다.
 */
export function skipDedupKey(text: string, date: string): string {
  const head = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `skip|${head}|${date}`;
}

/**
 * 상대방 텍스트에 인물 이름이 포함되는지(자기 계좌 간 이체 판정용). (설계 docs/household/27)
 * 공백 제거 후 부분일치, 이름은 2자 이상만 인정(오탐 방지).
 */
export function counterpartyHasName(counterparty: string | null, name: string | null): boolean {
  if (!counterparty || !name) return false;
  const n = name.replace(/\s/g, "");
  if (n.length < 2) return false;
  return counterparty.replace(/\s/g, "").includes(n);
}

/**
 * 가맹점명이 "숫자+영문 코드성"인지 판정. 한글이 하나도 없고 숫자를 포함하면 true.
 * ATM 출금·무통장 송금처럼 가맹점이 코드로 찍히는 정체불명 출금을 가리킨다(예: 0042497TAQ046, 120000).
 * → merchant_map 매칭이 안 될 때 한해 카테고리를 '용돈'으로 추정하는 데 쓴다. (설계 docs/household/42)
 * 한글이 섞인 정상 가맹점(GS25옥길골드점), 숫자 없는 영문 가맹점(STARBUCKS)은 제외.
 */
export function isNumericCodeMerchant(merchant: string | null | undefined): boolean {
  if (!merchant) return false;
  const m = merchant.trim();
  if (!m) return false;
  if (/[가-힣]/.test(m)) return false; // 한글 있으면 정상 가맹점
  return /[0-9]/.test(m); // 숫자 포함해야 코드성(영문 전용 가맹점 제외)
}

// 카드앱 알림의 카드명(예: '우리체크')을 등록 결제수단에 매칭. (설계 docs/household/51)
const CARD_ISSUERS = [
  "KB국민", "국민", "우리", "신한", "하나", "삼성", "현대", "롯데", "NH농협", "농협",
  "카카오", "토스", "씨티", "BC", "비씨", "케이", "IBK기업", "기업", "수협", "새마을", "우체국",
];
const CARD_TYPES = ["체크", "신용", "법인", "선불", "기프트"];

// 카드사 별칭표·정규화 키는 card-issuer.ts 로 옮겼다(설계 182 — 클라이언트 모듈도 같은 정본을 쓴다). 여기선 재수출만.
export { CARD_ISSUER_ALIASES, cardIssuerKey } from "@/lib/household/card-issuer";

/**
 * 카드명(예: '우리체크')을 등록 결제수단 목록에 매칭해 id를 반환. 카드번호(끝4)가 없는 토스 등 카드앱 알림용.
 * 발급사 토큰 + 종류 토큰을 **모두 포함**하는 결제수단이 **유일할 때만** 채택(모호하면 null=미기재, 오매칭 방지). (설계 docs/household/51)
 */
export function matchCardNameToMethod(
  cardName: string | null | undefined,
  methods: Array<{ id: string; name: string | null }>
): string | null {
  if (!cardName) return null;
  const label = cardName.replace(/\s/g, "");
  // 카드 상품명이 충분히 구체적이면 등록명 포함 일치가 유일한 경우 먼저 채택한다.
  const exactish = methods.filter((m) => (m.name ?? "").replace(/\s/g, "").includes(label));
  if (label.length >= 5 && exactish.length === 1) return exactish[0].id;
  const issuer = CARD_ISSUERS.find((k) => label.includes(k));
  const type = CARD_TYPES.find((k) => label.includes(k));
  if (!issuer || !type) return null; // 발급사·종류 둘 다 있어야 후보가 좁혀진다
  const hits = methods.filter((m) => {
    const n = (m.name ?? "").replace(/\s/g, "");
    return n.includes(issuer) && n.includes(type);
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** 인제스트 토큰 → sha256 hex. (클라이언트 Web Crypto SHA-256 hex와 동일 포맷) */
export function hashIngestToken(raw: string): string {
  return createHash("sha256").update(raw.trim(), "utf8").digest("hex");
}

/**
 * dedup_hash: 가능한 식별값을 합쳐 같은 문자의 재전송을 차단한다.
 * ★시각·통보잔액을 반드시 포함한다(설계 164) — 없던 시절, 같은 날 같은 가맹점·금액의 **두 번째
 *   정당한 결제** 문자가 키 충돌로 무흔적 소실됐다(2026-08-11 실사례, 잔액 사슬 -5,000 역산).
 *   재전송은 본문이 같아 시각·잔액도 같으므로 여전히 차단된다. 같은 분 재결제는 은행 출금 문자의
 *   잔액이 갈라 주고, 그 뒤는 설계 163 동일시각 규칙이 휴지통으로 보존한다.
 * ⚠️완전하지 않다(교차리뷰 2026-08-12): 시각·잔액이 **둘 다 같거나 둘 다 없는** 별도 거래
 *   (잔액 없는 카드 승인 문자의 같은 분 재결제 등)는 여전히 같은 키로 차단된다 → 설계 164 §3.
 */
export function smsDedupKey(p: { kind: SmsKind; date: string; amount: number | null; merchant: string | null; cardLast4: string | null; time: string | null; balance: number | null }): string | null {
  if (p.amount == null) return null; // 금액 없으면 dedup 안 함(서로 다른 값 취급)
  return [p.kind, p.date, p.amount, (p.merchant ?? "").trim(), p.cardLast4 ?? "", p.time ?? "", p.balance ?? ""].join("|");
}

/** @deprecated parseSms 사용. 하위호환: 금액만. */
export function guessFromSms(text: string): { amount: number | null } {
  return { amount: parseSms(text).amount };
}

// ── 선불 지갑 잔액 사슬 (설계 161) ────────────────────────────────────────────────
/**
 * 선불 지갑 결제 문자의 **'총 보유 잔액'**. 은행 문자의 일반 `잔액 N원`(계좌 잔액)과 구분해
 * '총 보유 잔액'이 명시된 것만 받는다 — 충전 문자는 `… 오픈뱅킹출금 300,000 잔액4,875,291` 꼴로
 * 은행 잔액만 실려 오는데, 그걸 지갑 잔액으로 받으면 사슬 입력이 오염된다(2026-08-10 교차리뷰).
 * 예: `… 부천페이(캐릭터) 총 보유 잔액 201,980원` → 201980 / `… 부천페이 총 보유 잔액 189,354원` → 189354
 */
export function extractWalletBalance(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const m = t.match(/총\s*보유\s*잔액\s*:?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export type WalletChainPrev = { walletAccountId: string; prevBalance: number };

/**
 * 잔액 사슬 판정: **직전 문자 잔액 − 이번 결제금액 == 이번 문자 잔액** 이면 같은 지갑이다.
 * 지갑별 직전 건을 넣으면 사슬이 성립하는 지갑 id 목록을 돌려준다(중복 제거).
 * 호출부는 **정확히 하나**일 때만 채택한다 — 둘 이상이면(우연 일치) 빈칸(설계 105: 모호하면 빈칸).
 * 금액·잔액이 없거나 금액이 0 이하면 판정하지 않는다(0원 결제는 어떤 지갑과도 '일치'해 버린다).
 */
export function walletChainLinks(
  cur: { amount: number | null; balance: number | null },
  prevs: readonly WalletChainPrev[],
): string[] {
  if (cur.amount == null || cur.balance == null || !(cur.amount > 0)) return [];
  const hits = new Set<string>();
  for (const p of prevs) if (p.prevBalance - cur.amount === cur.balance) hits.add(p.walletAccountId);
  return [...hits];
}

/**
 * 선불 지갑 결제 문자의 **표기**(카드 상품명) — '총 보유 잔액' 바로 앞의 `기관(괄호안)`. (설계 197)
 * 예: `… 부천페이(캐릭터) 총 보유 잔액 15,330원` → `부천페이|캐릭터` / `… 부천페이 총 보유 잔액 90,354원` → `부천페이|`(무표기).
 * 실측 2026-09-01: 수집함 전량에서 `(캐릭터)` 는 한 지갑 38/38, 무표기는 다른 지갑 5/5 — 카드 상품명이 지갑을 가른다.
 * 기관이 '총 보유 잔액' 바로 앞에 없거나 '총 보유 잔액' 자체가 없으면 null(사슬 입력과 같은 기준 — 은행 `잔액` 은 안 받는다).
 */
export function extractWalletLabel(text: string | null | undefined, institution: string | null | undefined): string | null {
  if (!institution) return null;
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!/총\s*보유\s*잔액/.test(t)) return null;
  const esc = institution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = t.match(new RegExp(esc + "\\s*(?:[（(]\\s*([^()（）]+?)\\s*[)）])?\\s*총\\s*보유\\s*잔액"));
  if (!m) return null;
  return `${institution}|${(m[1] ?? "").trim()}`;
}

export type WalletLabelHistoryRow = { label: string; walletAccountId: string };

/**
 * 표기 학습 이력 조회 상한(설계 197). 조회가 이 수에 닿으면 **잘린 것**이므로 폴백을 포기한다 —
 * 잘린 이력은 반대 지갑 확정을 빠뜨려 '모호→빈칸'을 '만장일치→오배정'으로 뒤집을 수 있다(배포 전 교차리뷰 M1).
 * 실측 2026-09-01: 지갑 잔액 문자 ≈ 월 45건 → 365일 ≈ 550건. 테스트는 이 값을 원천에서 읽는다(Rule 7).
 * ★PostgREST 응답 상한(max-rows, 기본 1,000)보다 크게 두지 마라 — 2,000 으로 두면 응답이 1,000 에서 잘리는데 가드는
 *   `>= 2000` 만 봐서 **영원히 안 걸린다**(덱스 교차리뷰 M2). 상한과 같게 둔다.
 */
export const WALLET_LABEL_HISTORY_LIMIT = 1000;

/**
 * 표기 학습 판정(설계 197): 사람이 확정한 이력에서 같은 표기가 **minCount 건 이상**이고 지갑이 **만장일치**일 때만 그 지갑.
 * 둘 이상 지갑에 걸리면(상대 배우자가 같은 상품 카드를 만든 경우) 다수결 없이 null — 틀리게 채우느니 빈칸(설계 105).
 * 사슬(설계 161)이 유일 지갑을 못 정했을 때의 **폴백**이지 사슬을 대체하지 않는다.
 */
export function walletLabelPick(label: string | null, history: readonly WalletLabelHistoryRow[], minCount = 3): string | null {
  if (label == null) return null;
  const wallets = new Map<string, number>();
  let total = 0;
  for (const h of history) {
    if (h.label !== label) continue;
    total++;
    wallets.set(h.walletAccountId, (wallets.get(h.walletAccountId) ?? 0) + 1);
  }
  if (total < minCount || wallets.size !== 1) return null;
  return [...wallets.keys()][0];
}

/** `YYYY-MM-DD` 에 일수를 더한 날짜 문자열(달력 기준, 시간대 무관). 사슬 조회 창(거래일 기준) 계산용. */
export function shiftIsoDate(iso: string, days: number): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}
