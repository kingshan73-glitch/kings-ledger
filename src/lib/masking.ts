export type MaskCategory =
  | "amount"
  | "income_amount"
  | "expense_amount"
  | "merchant"
  | "owner_name"
  | "phone"
  | "email"
  | "name"
  | "customer_name"
  | "business_number"
  | "address"
  | "title"
  | "generic";

const NAME_POOL = [
  "김민서", "이지훈", "박서연", "최도윤", "정하은",
  "강시우", "윤서아", "임주원", "한지유", "송예준",
  "조은채", "신민준", "백수아", "오태민", "권나윤",
  "황건우", "안소율", "서지호", "류지안", "노예린",
  "배준서", "남채원", "문서윤", "홍지웅", "유다은",
  "전현우", "고지원", "양시현", "손하린", "곽지환",
  "표서진", "장유나", "진하준", "차예린", "구민재",
  "우서영", "마지호", "설윤서", "함도현", "변지율",
  "추하영", "도시안", "위재현", "명지원", "라은우",
  "모지훈", "사윤하", "어준영", "인서후", "천하늘",
];

const COMPANY_POOL = [
  "한빛테크", "미래소프트", "아이콘랩", "별빛전자", "누리정보",
  "다빛코퍼레이션", "가람컴퍼니", "새벽시스템즈", "한길솔루션", "푸른미디어",
  "솔잎디자인", "마루스튜디오", "보람산업", "햇살무역", "동행이노베이션",
  "라온파트너스", "다온데이터", "늘봄텍", "새빛홀딩스", "한울씨앤씨",
  "밝음컨설팅", "미르엔지니어링", "슬기로운랩", "차오름", "다온그룹",
  "한솔커뮤니케이션", "별꽃에이전시", "한가람물류", "다인테크놀로지", "새한무역",
  "길동상사", "강산유통", "빛고을산업", "한겨레식품", "봄날제조",
  "푸른솔", "한들엔터", "윤슬바이오", "가온트래블", "다솜에듀",
  "우리경영연구소", "새로미디어", "한별패션", "다나스튜디오", "마음건축",
  "누리꿈", "한솔모빌리티", "가람금속", "솔빛에너지", "한결케어",
];

// 가맹점(상호) 가상 풀 — 데모에서 실제 소비처를 가린다. (설계 docs/household/39)
const MERCHANT_POOL = [
  "행복마트", "으뜸약국", "미소분식", "한솥도시락", "초록상회",
  "동네빵집", "해밀카페", "든든주유소", "바로의원", "스마일세탁",
  "푸른마트", "온누리정육", "달콤제과", "청춘식당", "바른안경",
  "한빛문구", "코끼리편의점", "싱싱청과", "포근침구", "쾌속퀵",
  "활력헬스", "구름미용실", "반올림피자", "정성국밥", "노을카페",
  "튼튼정형외과", "새봄꽃집", "맑은세차장", "지혜서점", "달빛호프",
  "가온마트", "오복떡집", "신선마켓", "한결약국", "별빛노래방",
  "참좋은치과", "포근카페", "은하수문구", "솔내음반찬", "기쁨완구",
  "다온분식", "햇살베이커리", "미래주유", "온기국수", "푸드마켓",
  "초이스마트", "라온카페", "단골식당", "건강마트", "느티나무카페",
];

const ADDRESS_POOL = [
  "서울특별시 강남구 테헤란로 152",
  "서울특별시 서초구 강남대로 411",
  "경기도 성남시 분당구 판교역로 235",
  "서울특별시 마포구 와우산로 94",
  "서울특별시 종로구 종로 1",
  "부산광역시 해운대구 센텀중앙로 90",
  "인천광역시 연수구 송도과학로 32",
  "대전광역시 유성구 대학로 99",
  "대구광역시 수성구 동대구로 100",
  "광주광역시 서구 상무중앙로 80",
  "경기도 수원시 영통구 광교중앙로 250",
  "경기도 고양시 일산동구 호수로 596",
  "서울특별시 영등포구 여의대로 24",
  "서울특별시 송파구 올림픽로 300",
  "서울특별시 강동구 천호대로 1077",
  "경기도 안양시 동안구 시민대로 235",
  "경기도 용인시 수지구 풍덕천로 100",
  "충청남도 천안시 동남구 만남로 43",
  "강원도 춘천시 중앙로 1",
  "경상남도 창원시 의창구 중앙대로 151",
  "전라북도 전주시 완산구 효자로 225",
  "전라남도 여수시 시청로 1",
  "제주특별자치도 제주시 첨단로 213",
  "울산광역시 남구 중앙로 201",
  "세종특별자치시 도움5로 20",
  "경기도 화성시 동탄대로 537",
  "경기도 평택시 평남로 1029",
  "경상북도 포항시 남구 지곡로 80",
  "충청북도 청주시 흥덕구 직지대로 410",
  "경기도 김포시 김포한강9로 76",
];

const TITLE_POOL = [
  "신규 프로젝트 검토", "월간 보고서 작성", "클라이언트 미팅 준비", "분기 예산 검토",
  "마케팅 전략 회의", "제품 출시 일정 조율", "인사 평가 진행", "계약서 검토",
  "부서 워크숍 기획", "기술 세미나 참석", "협력사 방문", "신입사원 교육",
  "고객 만족도 조사", "시장 동향 분석", "매출 분석 리포트", "디자인 시안 검토",
  "개발 일정 조율", "인테리어 견적 확인", "행사 진행 준비", "채용 면접",
  "매뉴얼 업데이트", "사내 공지사항 정리", "신제품 기획 회의", "영업 실적 보고",
  "재고 관리 회의", "인프라 점검", "보안 정책 수립", "데이터 백업 확인",
  "사용자 피드백 정리", "광고 캠페인 기획", "콘텐츠 검수", "SNS 운영 회의",
  "협업 도구 점검", "출장 일정 조율", "거래처 미팅", "결산 회의",
  "세금 신고 준비", "자산 점검", "회의실 예약 정리", "임원 회의 자료 준비",
  "신규 채용 공고", "인사이동 검토", "복리후생 점검", "사옥 이전 검토",
  "외주 발주 검토", "시스템 점검", "교육 자료 작성", "비품 발주",
  "견적서 작성", "일정표 정리",
];

function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFromPool<T>(pool: T[], input: string): T {
  return pool[hash(input) % pool.length];
}

// 데모용 가상금액: 자릿수(규모)는 유지하되 각 자리는 무작위로 바꿔 실제 금액을 가린다.
// 맨 앞자리만 항목 종류로 편향해 "수입 > 지출(약 3배)"이 합계 카드에서도 성립하게 한다. (설계 docs/household/39)
// 같은 자릿수면 수입 앞자리 평균≈7 / 지출 앞자리 평균≈2 ⇒ 약 3배. 조정은 아래 두 상수만 바꾸면 된다.
const INCOME_LEAD_DIGITS = [4, 5, 6, 7];
const EXPENSE_LEAD_DIGITS = [1, 2, 3];

function replaceDigits(
  input: string,
  seed: string,
  options: { preserveLeading?: number; leadDigits?: number[] } = {}
): string {
  const { preserveLeading = 0, leadDigits } = options;
  const rng = mulberry32(hash(seed));
  let idx = 0;
  return input.replace(/\d/g, (d) => {
    const current = idx++;
    if (current < preserveLeading) return d;
    // 첫 유효숫자만 종류별 풀에서 선택(수입=고액 앞자리 / 지출=소액 앞자리)
    if (current === 0 && leadDigits && leadDigits.length > 0) {
      return String(leadDigits[Math.floor(rng() * leadDigits.length)]);
    }
    return String(Math.floor(rng() * 10));
  });
}

// 데모용 가상금액: 실제 금액과 규모가 너무 비슷해 시연이 애매하다는 요청(2026-07-16)으로,
// 원래 자릿수 + 3(=0을 3개 더, 약 1000배)의 무작위 금액을 만든다. 자릿수 순서는 보존해
// 큰 금액은 여전히 크게 보이되, 전체가 부풀려져 실제 값과 헷갈리지 않는다.
// 부호·통화접미사("원"·"만원" 등)와 천단위 콤마는 새 금액에 맞춰 다시 포맷한다.
const EXTRA_ZEROS = 3;

function maskScaledAmount(input: string, leadDigits?: number[]): string {
  const digitCount = (input.match(/\d/g) ?? []).length;
  if (digitCount === 0) return input;
  // ★0 은 그대로 둔다 (2026-08-26, 설계 189). 0 은 숨길 정보가 없는데 예전엔 첫 자리를 1~9 풀에서
  //   뽑아 `0` → `2,484` 같은 **없는 돈**을 만들었다. 그래프에서 특히 나빴다 — 아직 오지 않은 달,
  //   거래가 없는 해가 전부 막대로 그려지고 "대출이 있나"(계열 유무) 판정까지 뒤집혔다.
  if (!/[1-9]/.test(input)) return input;
  const rng = mulberry32(hash(input));
  const total = digitCount + EXTRA_ZEROS;
  let out = "";
  for (let i = 0; i < total; i++) {
    if (i === 0) {
      const pool = leadDigits && leadDigits.length > 0 ? leadDigits : [1, 2, 3, 4, 5, 6, 7, 8, 9];
      out += String(pool[Math.floor(rng() * pool.length)]);
    } else {
      out += String(Math.floor(rng() * 10));
    }
  }
  const formatted = Number(out).toLocaleString("ko-KR");
  const sign = input.trimStart().startsWith("-") ? "-" : "";
  const suffix = input.replace(/^[\s+-]*[\d,.\s]*/, ""); // 숫자·콤마·부호를 걷어낸 통화접미사("원"/"만원")
  return `${sign}${formatted}${suffix}`;
}

function maskAmount(input: string): string {
  return maskScaledAmount(input);
}

function maskIncomeAmount(input: string): string {
  return maskScaledAmount(input, INCOME_LEAD_DIGITS);
}

function maskExpenseAmount(input: string): string {
  return maskScaledAmount(input, EXPENSE_LEAD_DIGITS);
}

function maskPhone(input: string): string {
  return replaceDigits(input, input, { preserveLeading: 3 });
}

function maskBusinessNumber(input: string): string {
  return replaceDigits(input, input);
}

function maskEmail(): string {
  return "sample@example.com";
}

function maskName(input: string): string {
  return pickFromPool(NAME_POOL, input);
}

function maskMerchant(input: string): string {
  return pickFromPool(MERCHANT_POOL, input);
}

// 계좌·카드명에 박힌 소유자 이름만 가린다: "국민은행(이바다)" → "국민은행(가명)".
// 괄호가 없으면 그대로 둬 은행·카드명("현금" 포함)을 보존한다. (설계 docs/household/39)
function maskOwnerName(input: string): string {
  return input.replace(/\(([^)]+)\)/g, (_m, inner) => `(${maskName(inner)})`);
}

function maskCustomerName(input: string): string {
  return pickFromPool(COMPANY_POOL, input);
}

function maskAddress(input: string): string {
  return pickFromPool(ADDRESS_POOL, input);
}

function maskTitle(input: string): string {
  return pickFromPool(TITLE_POOL, input);
}

function maskGeneric(input: string): string {
  return pickFromPool(TITLE_POOL, input);
}

export function mask(
  category: MaskCategory,
  input: string | number | null | undefined,
  enabled: boolean
): string {
  if (input == null) return "";
  const str = typeof input === "number" ? String(input) : input;
  if (!enabled) return str;
  if (str.length === 0) return str;

  switch (category) {
    case "amount":
      return maskAmount(str);
    case "income_amount":
      return maskIncomeAmount(str);
    case "expense_amount":
      return maskExpenseAmount(str);
    case "merchant":
      return maskMerchant(str);
    case "owner_name":
      return maskOwnerName(str);
    case "phone":
      return maskPhone(str);
    case "email":
      return maskEmail();
    case "name":
      return maskName(str);
    case "customer_name":
      return maskCustomerName(str);
    case "business_number":
      return maskBusinessNumber(str);
    case "address":
      return maskAddress(str);
    case "title":
      return maskTitle(str);
    case "generic":
    default:
      return maskGeneric(str);
  }
}
