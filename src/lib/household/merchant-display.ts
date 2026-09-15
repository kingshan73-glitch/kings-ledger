/**
 * 수집함 표에만 쓰는 **상호 표시 축약** (팀장 지시 2026-08-09: "상호 축약").
 *
 * 왜 여기만 축약하나 — 수입 화면은 같은 문자열(`카카오T주차_카카오페이 (토스뱅크 체크카드)`, 실측 214px)을
 * 열을 `x4wide(272)` 로 올려 풀었다(income/page.tsx). 수집함은 그 길을 못 간다: **9열 합계가 이미 1272px 로
 * 상한 1200 을 넘겨** 어느 열도 넓힐 수 없다. 그래서 이 표만 표시 문자열을 줄인다.
 * → 수집함 표 폭을 줄일 여지가 생기면 이 축약보다 **열 넓히기가 우선**이다(설계 123 원칙).
 *
 * 지켜야 할 것:
 * - 저장값(`guessed_merchant`·`user_memo`)과 **`merchant_map` 키에는 절대 적용하지 않는다.**
 *   merchant_map 은 부분일치라 키가 짧아지면 엉뚱한 가맹점에 오매칭된다(`주식회사 옥길` → `옥길` 실사고).
 * - 전체 원문은 `title` 로 돌려준다.
 * - **열 폭을 이 축약에 맞춰 좁히지 마라** — 축약이 없애는 것은 꼬리표가 붙은 이상치뿐이고,
 *   `배스킨라빈스부천옥길트레이더스`(156px) 같은 평범한 상호는 그대로다(2026-08-09 실측).
 */

// ★결제수단으로 **확실한** 어휘만 넣는다. 맨 `카드`·`계좌`·`통장` 을 넣으면 정상 상호를 잘라 먹는다 —
//   `생일선물 (포토카드)` · `보드게임카페 (레드카드)` · `저축상품 (모임통장)` (교차리뷰 2026-08-09 재현).
//   전각 괄호도 받는다 — 이 데이터에 `（주）소노호텔앤` 처럼 전각이 실제로 들어온다(sms.ts).
const PAYMENT_TAG_TAIL = /\s*[（(][^（()）]*(?:체크카드|신용카드|선불카드|가상카드|법인카드)[）)]\s*$/;
const PAYMENT_PLATFORM_SUFFIX = /^(.+?)_(?:카카오페이|네이버페이|토스페이|PAYCO|페이코)$/i;

export type MerchantDisplay = {
  text: string;
  title?: string;
};

export function merchantDisplay(value: string | null | undefined): MerchantDisplay {
  if (!value) return { text: "-" };

  const withoutPaymentTag = value.replace(PAYMENT_TAG_TAIL, "");
  const platformMatch = withoutPaymentTag.match(PAYMENT_PLATFORM_SUFFIX);
  const text = (platformMatch?.[1] ?? withoutPaymentTag).trim();

  // ★축약 결과가 비면 축약을 포기한다 — 빈 칸은 화면에서도 필터에서도 '미지정'과 뜻이 달라진다.
  if (!text) return { text: value, title: value };

  return { text, title: value };
}

/**
 * 사용내역(`user_memo`)은 상호가 아니라 **사용자가 고쳐 쓰는 자유입력**이다.
 * 수집할 때 상호로 자동으로 채워진 값 그대로일 때만 축약한다 —
 * 사용자가 직접 적은 `생일선물 (포토카드)` 를 상호 규칙으로 지우면 안 된다(교차리뷰 2026-08-09).
 */
export function memoDisplay(memo: string | null | undefined, merchant: string | null | undefined): MerchantDisplay {
  if (!memo) return { text: "-" };
  if (merchant && memo === merchant) return merchantDisplay(memo);
  return { text: memo, title: memo };
}

/**
 * 카테고리 표시 축약 (팀장 지시 2026-08-09 ⓑ).
 *
 * 수집함 카테고리 열의 가용폭은 **89.4px**(`standard 112` − 패딩 22.6)인데
 * `대출상환-국민주택분양자금대출` 은 한 줄에 **151px**, `대출상환-디딤돌대출` 은 **99px** 이 필요했다.
 * 표 합계가 1272px 로 상한 1200 을 이미 넘겨 열을 넓힐 수 없어 표시 문자열을 줄인다.
 *
 * 두 가지를 뗀다 — ① 반복되는 구분 접두어 `대출상환-` ② 그러고 남은 이름의 꼬리 `대출`.
 * 접두어만 떼면 `국민주택분양자금대출` 이 약 101px 로 여전히 넘친다(문자당 약 10px 실측).
 * 대출임을 말해 주는 것은 **유형 배지 '납부'** 다(설계 70: 대출납부 = payment).
 * 전체 이름은 `title` 로 남는다.
 *
 * ★`대출상환` 이라는 문자열에 기대는 것은 이 저장소의 기존 관례와 같다
 *   (대출 집계도 카테고리 이름이 정확히 `대출상환` 일 때만 잡는다). 다른 구분은 손대지 않는다.
 */
const LOAN_CATEGORY_PREFIX = /^대출상환-/;

export function categoryDisplay(name: string | null | undefined): MerchantDisplay {
  if (!name || name === "-") return { text: name || "-" };
  if (!LOAN_CATEGORY_PREFIX.test(name)) return { text: name, title: name };

  // ★trim 을 꼬리 제거보다 **먼저** 한다 — 끝에 공백이 있으면 `/대출$/` 가 안 맞아 축약이 조용히 안 걸린다.
  const leaf = name.replace(LOAN_CATEGORY_PREFIX, "").trim().replace(/대출$/, "").trim();
  // 축약하면 비어 버리면(예: 이름이 `대출상환-대출`) 축약을 포기한다.
  return leaf ? { text: leaf, title: name } : { text: name, title: name };
}
