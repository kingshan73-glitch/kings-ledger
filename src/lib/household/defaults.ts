// 가계부 기본 마스터 시드값. 설정 화면의 "기본값 생성" 버튼에서 사용한다.
// 원본 엑셀(docs/household/01_data-analysis.md)의 카테고리·인물에서 도출.
//
// ★샘플 가족(템플릿용 가상 인물 — 실존 인물·계좌가 아니다):
//   본인 김하늘 · 배우자 이바다 · 공용 '가족'. 계좌·카드 이름은 `은행(소유자)` 꼴을 따른다
//   (계좌명이 소유자를 품는 것이 이 앱의 명명 규칙 — account-color.ts·card-group.ts 가 그 괄호를 읽는다).

export const DEFAULT_PERSONS = ["김하늘", "이바다", "가족"];

// 기본 계좌 3개. person 은 DEFAULT_PERSONS 의 이름(시드 시 person_id 로 치환).
export const DEFAULT_ACCOUNTS: { name: string; bank: string; person: string; kind: "checking" | "stock" | "family" | "other" }[] = [
  { name: "국민은행(김하늘)", bank: "국민은행", person: "김하늘", kind: "checking" },
  { name: "카카오뱅크(김하늘)", bank: "카카오뱅크", person: "김하늘", kind: "checking" },
  { name: "신한은행(이바다)", bank: "신한은행", person: "이바다", kind: "checking" },
];

// 기본 카드 3장. card_no 는 끝4자리만 실제 값이면 된다(문자 수집은 끝4로 카드를 찾는다 — 설계 26).
// linkedAccount 는 DEFAULT_ACCOUNTS 의 이름(시드 시 linked_account_id 로 치환).
export const DEFAULT_CARDS: {
  name: string;
  person: string;
  kind: "credit" | "check";
  cardNo: string;
  linkedAccount: string;
  billingDay: number;
}[] = [
  { name: "삼성카드(김하늘)", person: "김하늘", kind: "credit", cardNo: "****-****-****-1234", linkedAccount: "국민은행(김하늘)", billingDay: 25 },
  { name: "현대카드(이바다)", person: "이바다", kind: "credit", cardNo: "****-****-****-5678", linkedAccount: "신한은행(이바다)", billingDay: 25 },
  { name: "국민카드(김하늘)", person: "김하늘", kind: "credit", cardNo: "****-****-****-9012", linkedAccount: "국민은행(김하늘)", billingDay: 14 },
];

// 지출 카테고리 (01_data-analysis.md 18종 중 '할부'(결제방식이라 hh_installment로 별도 관리) 제외한 17종 + 일상 분리용 5종 추가)
// 추가: 다과/카페비(커피·디저트), 미용/뷰티, 교육비, 구독료, 여행
export const DEFAULT_EXPENSE_CATEGORIES = [
  "외식비",
  "다과/카페비",
  "식료품비",
  "생필품",
  "미용/뷰티",
  "양육비",
  "육아용품",
  "교육비",
  "적금",
  "보험",
  "기부금",
  "교통비",
  "차량유지비",
  "통신비",
  "구독료",
  "관리비",
  "의료비",
  "쇼핑",
  "경조사비",
  "레저/기타",
  "여행",
  "용돈",
];

// 수입 카테고리 (원본 "항목"에서 도출)
// "대출" 은 앱이 이름으로 찾는 특수 카테고리다(category-names.ts CATEGORY_NAME.loanIncome).
// 없으면 통계 화면이 대출 실행금을 수입에서 못 걸러내 "수입에 섞여 있습니다" 경고를 띄운다
// — 실행금 거래가 하나도 없어도 뜨는 거짓 경보다(2026-09-15 클린 설치 검증).
export const DEFAULT_INCOME_CATEGORIES = [
  "급여",
  "이자",
  "증권판매",
  "환급/캐시백",
  "기타수입",
  "대출",
];

// 가맹점 → 카테고리 기본 매핑 시드.
// 설정 "기본값 생성" 시 hh_merchant_map 에 들어가고, 수집함에서 가맹점 입력 시 자동분류에 쓰인다.
// key 는 가맹점명에 포함되면 매칭되는 부분 문자열(소문자 비교). category 는 위 지출 카테고리명과 일치해야 한다.
// 한 가맹점에 여러 key 가 걸리면 더 긴(구체적인) key 가 우선한다. (예: "쿠팡이츠" > "쿠팡")
export const DEFAULT_MERCHANT_MAP: { key: string; category: string }[] = [
  // 다과/카페비
  { key: "스타벅스", category: "다과/카페비" },
  { key: "투썸", category: "다과/카페비" },
  { key: "이디야", category: "다과/카페비" },
  { key: "메가커피", category: "다과/카페비" },
  { key: "메가엠지씨", category: "다과/카페비" },
  { key: "컴포즈", category: "다과/카페비" },
  { key: "빽다방", category: "다과/카페비" },
  { key: "할리스", category: "다과/카페비" },
  { key: "폴바셋", category: "다과/카페비" },
  { key: "커피빈", category: "다과/카페비" },
  { key: "파리바게뜨", category: "다과/카페비" },
  { key: "뚜레쥬르", category: "다과/카페비" },
  { key: "베이커리", category: "다과/카페비" },
  { key: "카페", category: "다과/카페비" },
  // 외식비
  { key: "배달의민족", category: "외식비" },
  { key: "배민", category: "외식비" },
  { key: "요기요", category: "외식비" },
  { key: "쿠팡이츠", category: "외식비" },
  { key: "맥도날드", category: "외식비" },
  { key: "버거킹", category: "외식비" },
  { key: "롯데리아", category: "외식비" },
  { key: "맘스터치", category: "외식비" },
  { key: "김밥천국", category: "외식비" },
  { key: "한솥", category: "외식비" },
  { key: "치킨", category: "외식비" },
  { key: "피자", category: "외식비" },
  // 식료품비
  { key: "이마트", category: "식료품비" },
  { key: "홈플러스", category: "식료품비" },
  { key: "롯데마트", category: "식료품비" },
  { key: "코스트코", category: "식료품비" },
  { key: "하나로마트", category: "식료품비" },
  { key: "마켓컬리", category: "식료품비" },
  { key: "컬리", category: "식료품비" },
  { key: "정육", category: "식료품비" },
  { key: "퀸마트", category: "식료품비" },
  { key: "노브랜드", category: "식료품비" },
  { key: "킴스클럽", category: "식료품비" },
  { key: "메가마트", category: "식료품비" },
  { key: "롯데슈퍼", category: "식료품비" },
  { key: "트레이더스", category: "식료품비" },
  // 생필품
  { key: "다이소", category: "생필품" },
  { key: "네이버페이", category: "생필품" },
  // 미용/뷰티
  { key: "올리브영", category: "미용/뷰티" },
  { key: "미용실", category: "미용/뷰티" },
  { key: "헤어", category: "미용/뷰티" },
  { key: "네일", category: "미용/뷰티" },
  // 교통비
  { key: "코레일", category: "교통비" },
  { key: "srt", category: "교통비" },
  { key: "카카오택시", category: "교통비" },
  { key: "카카오 t", category: "교통비" },
  { key: "택시", category: "교통비" },
  { key: "고속버스", category: "교통비" },
  { key: "티머니", category: "교통비" },
  // 차량유지비
  { key: "주유소", category: "차량유지비" },
  { key: "gs칼텍스", category: "차량유지비" },
  { key: "s-oil", category: "차량유지비" },
  { key: "에쓰오일", category: "차량유지비" },
  { key: "현대오일뱅크", category: "차량유지비" },
  { key: "sk에너지", category: "차량유지비" },
  { key: "하이패스", category: "차량유지비" },
  // 통신비
  { key: "skt", category: "통신비" },
  { key: "kt", category: "통신비" },
  // "kt" 가 KTX 열차표까지 통신비로 잡는다 — 더 긴 키가 이긴다 (2026-09-09 실측 10건)
  { key: "ktx", category: "교통비" },
  { key: "lg유플러스", category: "통신비" },
  { key: "유플러스", category: "통신비" },
  { key: "알뜰폰", category: "통신비" },
  // 구독료
  { key: "넷플릭스", category: "구독료" },
  { key: "netflix", category: "구독료" },
  { key: "유튜브 프리미엄", category: "구독료" },
  { key: "유튜브", category: "구독료" },
  { key: "youtube", category: "구독료" },
  { key: "멜론", category: "구독료" },
  { key: "스포티파이", category: "구독료" },
  { key: "디즈니", category: "구독료" },
  { key: "왓챠", category: "구독료" },
  { key: "쿠팡플레이", category: "구독료" },
  { key: "윌라", category: "구독료" },
  { key: "아이클라우드", category: "구독료" },
  { key: "icloud", category: "구독료" },
  { key: "챗gpt", category: "구독료" },
  { key: "chatgpt", category: "구독료" },
  // 의료비
  { key: "약국", category: "의료비" },
  { key: "의원", category: "의료비" },
  { key: "병원", category: "의료비" },
  { key: "치과", category: "의료비" },
  { key: "한의원", category: "의료비" },
  // 교육비
  { key: "학원", category: "교육비" },
  { key: "교습소", category: "교육비" },
  { key: "어린이집", category: "교육비" },
  { key: "유치원", category: "교육비" },
  // 쇼핑
  { key: "쿠팡", category: "쇼핑" },
  { key: "11번가", category: "쇼핑" },
  { key: "g마켓", category: "쇼핑" },
  { key: "지마켓", category: "쇼핑" },
  { key: "옥션", category: "쇼핑" },
  { key: "무신사", category: "쇼핑" },
  { key: "지그재그", category: "쇼핑" },
  { key: "에이블리", category: "쇼핑" },
  // 추가 가맹점(SMS 수집 실데이터 기반)
  { key: "씨유", category: "생필품" },
  { key: "cu편의점", category: "생필품" },
  { key: "황금비타민", category: "의료비" },
  { key: "샤브", category: "외식비" },
  { key: "카카오모빌리티", category: "교통비" },
  { key: "영풍문고", category: "쇼핑" },
  { key: "교보문고", category: "쇼핑" },
  { key: "이비인후과", category: "의료비" },
  { key: "아마노코리아", category: "차량유지비" },
  { key: "김앤김대게", category: "외식비" },
  { key: "스시노칸도", category: "외식비" },
  // 토스 카드결제 알림 실데이터(설계 51)
  { key: "브루브로스커피", category: "다과/카페비" },
  { key: "브루브로스", category: "다과/카페비" },
  { key: "지에스25", category: "생필품" },
  { key: "gs25", category: "생필품" },
  { key: "어서와", category: "외식비" },
  // 수집함 실데이터(2026-07-01)
  { key: "핫한핫도그", category: "외식비" },
  { key: "이삭토스트", category: "외식비" },
  { key: "태권도", category: "양육비" },
  // 카카오톡 카드 알림 실데이터(설계 57)
  { key: "당가원", category: "외식비" },
];

// 이체 상대처 규칙: 상대처(merchant/counterparty)에 key 가 포함되면 '이체'로 분류하고,
// from/to 를 등록 계좌 이름 부분일치로 자동 지정한다. (설계 docs/household/52)
// 인물 이름 매칭(self-transfer, 설계 27·48)이 못 잡는 '충전 대상'(경기지역화폐 등)을 위한 규칙.
// 계좌는 UUID 가 아니라 이름 부분일치로 런타임 매칭(계좌명이 바뀌면 규칙만 갱신).
//
// ★from·to 의 의미가 다르다 (설계 docs/household/129):
//   - `from` 은 **폴백**이다. 문자가 계좌를 지목했으면(끝4·앞자리 매칭) 그쪽이 이긴다.
//     여기 적힌 계좌는 "문자에 계좌가 안 나올 때(토스 앱 알림 등) 쓸 기본값"일 뿐이다.
//   - `to` 는 **지갑 이름 조각**이다. 완전한 계좌명이 아니어도 된다 — 소유자별로 지갑이 갈리므로
//     (부천페이(김하늘)/부천페이(이바다)) 이름 하나로는 못 고르고, from 계좌의 주인으로 좁힌다.
//   해석은 전부 sms-ingest.enrichParsed 가 한다.
export const DEFAULT_TRANSFER_RULES: { keys: string[]; from: string; to: string }[] = [
  // 경기지역화폐(코나카드=부천페이) 충전. 상대처 예: "코나아이(주)(경기지역화폐)"(토스 알림) /
  // "경기지역화폐 오픈뱅킹"(은행 출금 SMS). 후자는 문자에 출금계좌가 있으므로 아래 from 은 안 쓰인다.
  { keys: ["경기지역화폐", "코나아이"], from: "카카오뱅크(김하늘)", to: "부천페이" },
];

// 들어온 이체인데 **문자가 출금계좌를 안 알려줄 때** 채워 넣을 상습 경로. (설계 154)
//
// 은행 입금 SMS 는 보낸 사람 이름만 준다 — `KB 08/06 09:18 110000-**-***000 입금 200,000원 김하늘`(예시).
// 본인이 본인에게 보낸 이체라 상대처가 '김하늘'뿐이고 어느 통장에서 나갔는지는 문자에 없다.
// 실측(2026-08-06): 같은 형태가 **전부** 카카오뱅크(김하늘)→국민은행(김하늘) 였고 매번 손으로 채웠다(샘플 가족 기준 예시).
//
// ★`toName` 을 함께 요구한다 — 상대처 '김하늘'만 보고 걸면
//   `563,770원 입금 김하늘 → 내 토스뱅크 통장`(출금=하나은행)까지 잘못 채운다.
// ★이건 **폴백**이다. 문자에 출금계좌 근거가 있으면 그쪽이 항상 이긴다(설계 129 의 결).
export const DEFAULT_INCOMING_FROM_RULES: {
  counterpartyIncludes: string;
  toName: string;
  fromName: string;
}[] = [
  { counterpartyIncludes: "김하늘", toName: "국민은행(김하늘)", fromName: "카카오뱅크(김하늘)" },
];

export function matchIncomingFromRule(
  counterparty: string | null | undefined
): { toName: string; fromName: string } | null {
  const c = (counterparty ?? "").trim();
  if (!c) return null;
  for (const r of DEFAULT_INCOMING_FROM_RULES) {
    if (c.includes(r.counterpartyIncludes)) return { toName: r.toName, fromName: r.fromName };
  }
  return null;
}

// 상대처 문자열에 규칙 key 가 하나라도 포함되면 그 규칙을 반환(없으면 null). (설계 docs/household/52)
export function matchTransferRule(
  counterparty: string | null | undefined
): { from: string; to: string } | null {
  if (!counterparty) return null;
  const c = counterparty.trim();
  if (!c) return null;
  for (const rule of DEFAULT_TRANSFER_RULES) {
    if (rule.keys.some((k) => c.includes(k))) return { from: rule.from, to: rule.to };
  }
  return null;
}

// 충전 인센티브 규칙: 이 계좌로 '충전(이체 입금)'하면 충전액의 rate 만큼 인센티브가 얹힌다.
// (설계 docs/household/84) 지역화폐 선불카드 특성 — 충전 10만원 → 잔액 11만원.
// 이체는 금액 컬럼이 하나라 한 건으로 못 넣으므로 '이체 + 인센티브 수입' 2건으로 기록한다.
// 계좌는 UUID 가 아니라 이름 부분일치로 런타임 매칭(설계 52 와 같은 결).
export const CHARGE_INCENTIVE_RULES: { nameIncludes: string; rate: number; label: string }[] = [
  // 부천페이(부천시 지역화폐): 충전액의 10% 추가 지급. 보스 확정(2026-07-17): 한도 없이 항상 10%.
  { nameIncludes: "부천페이", rate: 0.1, label: "부천페이 충전 인센티브" },
];

/** 입금계좌 이름이 인센티브 규칙에 걸리면 그 규칙을 반환(없으면 null). (설계 84) */
export function matchChargeIncentive(
  accountName: string | null | undefined
): { rate: number; label: string } | null {
  const n = (accountName ?? "").trim();
  if (!n) return null;
  for (const r of CHARGE_INCENTIVE_RULES) {
    if (n.includes(r.nameIncludes)) return { rate: r.rate, label: r.label };
  }
  return null;
}

/** 충전액에 대한 인센티브 금액(원 단위 반올림). 0 이하면 0. (설계 84) */
export function chargeIncentiveAmount(chargeAmount: number, rate: number): number {
  if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) return 0;
  return Math.round(chargeAmount * rate);
}

// 수입 상대처 규칙: 상대처(merchant)에 key 가 포함되면 '수입'으로 분류하고,
// 카테고리·입금계좌를 이름 부분일치로 자동 지정한다. (설계 docs/household/53)
// 토스포트 이자 입금처럼 자주 반복되는 수입을 자동 분류하기 위한 규칙(이체 규칙 52와 같은 결).
// 계좌·카테고리는 UUID 가 아니라 이름 부분일치로 런타임 매칭한다.
export const DEFAULT_INCOME_RULES: { keys: string[]; category: string; account: string }[] = [
  // 토스포트(모으기) 이자 입금: 수입 → 카테고리 '이자' → 입금계좌 카카오뱅크(김하늘).
  { keys: ["토스포트", "토스 포트"], category: "이자", account: "카카오뱅크(김하늘)" },
];

// 상대처 문자열에 수입 규칙 key 가 포함되면 그 규칙을 반환(없으면 null). (설계 docs/household/53)
// 표기 흔들림("토스포트"/"토스 포트") 대응 위해 양쪽 공백을 제거하고 비교한다.
export function matchIncomeRule(
  counterparty: string | null | undefined
): { category: string; account: string } | null {
  if (!counterparty) return null;
  const c = counterparty.replace(/\s+/g, "");
  if (!c) return null;
  for (const rule of DEFAULT_INCOME_RULES) {
    if (rule.keys.some((k) => c.includes(k.replace(/\s+/g, "")))) {
      return { category: rule.category, account: rule.account };
    }
  }
  return null;
}

/**
 * 후불교통 전용 카드대금(= 지출/교통비로 취급할 카드 청구). (설계 150)
 *
 * 우리체크카드는 소비를 결제 즉시 별도 출금 문자로 알려 주므로, 매월 1회 따로 빠지는
 * '우리카드결제대금'은 **후불교통 이용분**뿐이다(팀장 확인 2026-08-06 + 실측: 금액이
 * 5,550~28,400원으로 교통 이용량만큼만 움직이고, 같은 달 체크 소비와 겹치지 않는다).
 * 다른 카드는 개별 승인이 따로 수집되므로 종전대로 payment 로 남긴다.
 */
export const POSTPAID_TRANSIT_BILL_RE = /우리카드(?:결제대금?|대금결제|대금|결제대)/;

// 카드대금·대출(캐피탈/저축은행) 납부 판별 = 거래유형 'payment'. (설계 docs/household/70)
// ⚠️ '개별 카드승인(expense)'과 구분해야 이중계산이 안 난다: 승인은 kind='approve'(카드사 알림),
//    여기서 잡는 건 은행에서 카드사·대출기관으로 나가는 '월 대금/원리금' 출금(kind=withdraw/autopay).
//    개별 승인은 지출(소비)로, 월 대금은 잔액만 깎는 납부로 나뉜다(도메인모델 02, calc.ts monthFlowTotals).
/** 카드 월 대금 판별용 카드사명(공백 제거 원문 대상). ★한 사실은 한 파일에만 —
 *  isCardOrLoanPayment ①·설계 105 카드대금 매칭·설계 186 보험 되돌리기 가드가 이 하나를 공유한다. */
export const CARD_BILL_ISSUER_RE = /(삼성카드|현대카드|국민카드|KB카드|롯데카드|하나카드|신한카드|우리카드|비씨카드|BC카드)/;

export function isCardOrLoanPayment(
  text: string | null | undefined,
  kind: string | null | undefined
): boolean {
  if (!text) return false;
  if (kind !== "withdraw" && kind !== "autopay") return false; // 카드 개별승인(approve)·수입·이체 제외
  const t = text.replace(/\s+/g, "");
  // ★후불교통 전용 카드대금은 '납부'가 아니라 '지출(교통비)'이다. (설계 150, 팀장 지시 2026-08-06)
  // payment 는 잔액만 깎고 **지출집계에서 빠지는데**(calc.ts categorySpending 은 expense 만 센다),
  // 그 전제는 "개별 승인이 따로 수집돼 그쪽이 지출로 잡힌다"는 것이다(설계 70).
  // 우리체크카드의 교통 이용분은 **개별 승인 문자가 오지 않아** 이 월 청구가 유일한 기록이라,
  // payment 로 두면 교통비가 통계에서 통째로 사라진다. 그래서 이 건만 expense 로 흘려보낸다.
  // (일반 소비는 체크카드라 결제 즉시 별도 출금 문자로 들어온다 — 이 청구와 겹치지 않는다.)
  if (POSTPAID_TRANSIT_BILL_RE.test(t)) return false;
  // ① 카드 월 대금 결제(은행 출금측): 카드사명 + 출금/대금. '체크카드출금 [가맹점]'(직불 소비)은 카드사명이 없어 안 걸린다.
  if (CARD_BILL_ISSUER_RE.test(t) && /(출금|대금)/.test(t)) return true;
  // ② 대출·캐피탈·저축은행 원리금 자동납부(CMS)
  // ★`캐피(?=\d)` 를 함께 본다 (설계 162, 2026-08-11). 은행 출금 문자는 상대처를 축약해서 보내
  //   `캐피탈` 이라는 낱말이 **원문에 없을 수 있다** — 실사례:
  //     `출금 212,337원… 110-11-0***-111 롯데캐피2608 FBS출금 212,337 잔액5,175,291`
  //   여기엔 `롯데캐피2608` 뿐이라 `캐피탈` 매칭이 실패했고, payment 로 분류되지 못해
  //   ⓐ대출관리가 `type=payment` 만 조회하는 탓에 '당월출금'에서 통째로 빠지고
  //   ⓑ loan_id 자동연결(월납 정확일치)까지 연쇄로 실패했다. 7개월간 엑셀(import)로 들어올 땐
  //   payment 였는데, 엑셀 재적재를 그만두면서(2026-08-07 팀장 지시) 이 경로가 유일해져 드러났다.
  // ★좁게 발동한다(설계 106): `캐피` **뒤에 숫자가 오는 경우만**. 뒤 조건(출금·CMS·자동·납부·상환)도
  //   그대로 함께 요구한다. 실측 — 수집된 SMS 원문 212건 전량으로 껐다 켜서 대조한 결과
  //   **판정이 달라지는 건 이 1건뿐**이고 후불교통 예외(우리카드)도 영향 없다.
  if (/(캐피탈|캐피(?=\d)|저축은행)/.test(t) && /(출금|CMS|자동|납부|상환)/.test(t)) return true;
  if (/CMS출/.test(t)) return true;
  if (/(원금·?이자|원리금)/.test(t)) return true;
  return false;
}

// 가맹점명으로 매핑 사전(hh_merchant_map 행)에서 카테고리 id 를 추정한다.
// merchant 가 merchant_key 를 포함하면 매칭, 여러 개면 가장 긴 key(구체적) 우선.
export type MerchantRule = {
  merchant_key: string;
  category_id: string | null;
  payment_method_id?: string | null;
  account_id?: string | null;
};

export const MERCHANT_LEARN_MIN_LEN = 4;

// 짧은 키는 부분일치로 긴 상호를 전부 잡아 유형·카테고리를 뒤집는다(2026-09-09 `카카오` 실사고).
// 시드의 짧은 키는 의도된 일반어이므로 매칭은 그대로 둔다.
export function shouldLearnMerchantKey(merchant: string | null | undefined): boolean {
  return Boolean(merchant && merchant.trim().length >= MERCHANT_LEARN_MIN_LEN);
}

/** 확정 때 학습한 가맹점 규칙 중 가장 구체적인(키가 긴) 규칙을 찾는다. */
export function matchMerchantRule<T extends MerchantRule>(
  merchant: string | null | undefined,
  rows: T[]
): T | null {
  if (!merchant) return null;
  const m = merchant.trim().toLowerCase();
  if (!m) return null;
  let best: { key: string; row: T } | null = null;
  for (const r of rows) {
    if (!r.merchant_key) continue;
    const key = r.merchant_key.trim().toLowerCase();
    if (!key || !m.includes(key)) continue;
    if (!best || key.length > best.key.length) best = { key, row: r };
  }
  return best?.row ?? null;
}

export function matchMerchantCategory(
  merchant: string | null | undefined,
  rows: MerchantRule[]
): string | null {
  return matchMerchantRule(merchant, rows)?.category_id ?? null;
}
