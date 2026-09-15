import { isDeepStrictEqual } from "node:util";

const sms = await import("../src/lib/household/sms");
const { parseSms, smsDedupKey, isNonTransactionalSms, skipDisposition, skipDedupKey, cashbackComboPayAmount, ignoreTraceGuessedType, isCardBillDoneNotice } = sms;

let pass = 0;
let fail = 0;

const kbCardLoanText = "⁨1588-1688⁩<제목: 장기카드대출입금안내> [Web발신] 이*다고객님, KB국민카드 장기카드대출을 이용해주셔서 감사합니다. ■ 신청내역  대출금액 : 1,500만원  대출기간 : 18개월  적용이자율 : 18.10%   상환방식 : 원금균등상환   대출금 지급 및 결제계좌 : 신용카드 결제계좌   대출취급일 : 2026-08-02 대출만기일 : 2028-02-10 납입예상총원리금 : 17,211,195원  ※ 금리산정내역 및 약관은 홈페이지 참조. 보이스피싱 주의";
const samsungCardLoanText = "[삼성카드] 장기카드대출(카드론) 승인 완료 안내 - 이용일 : 2026.08.11   - 이용금액 : 13,700,000원 - 이자율 : 연 12.20%   · 산정내역 : 기준 이자율(15.10%)+우대 할인(0.00%)+특판 할인(-4.90%)+가산 조정(2.00%)";
const mobilePaymentReceipt196 = "⁨114⁩<제목: 휴대폰 결제 성공 안내> [Web발신] [KG파이낸셜/SKT] 휴대폰 결제가 완료되었습니다. - 요청 일시: 2026년 8월 4일 18:01:46 - 요청 사이트: 컬리[1644-1107] - 요청 금액: 112,546 - 결제 대행사: KG파이낸셜[1800-1855] ■ [이번 달] 이용 내역 안내 - 이용 가능 금액: [1,000,000]원 - 누적 이용 금액: [112,546]원 - 잔여 이용 가능 금액: [887,454]원";
const cardBillDoneRealText = "삼성카드[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 \nhttp://q.samsungcard.com/TYOoMoD";

function ok(condition: boolean, message: string) {
  if (condition) {
    pass += 1;
    console.log(`  OK ${message}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${message}`);
  }
}

const cases = [
  {
    // 설계 193: KB스타뱅킹 알림푸시는 은행명 없이 KB 전용 6-2-6 마스크만 보낸다.
    name: "KB스타뱅킹 새 계좌 마스크 입금",
    text: "입금 1,000원 김*늘님 08/28 10:54 110000-**-***000 김하늘 전자금융입금 1,000 잔액1,000",
    expected: { kind: "deposit", amount: 1000, merchant: "김하늘", date: "2026-08-28", balance: 1000, cardLast4: null, accountTail: null, accountPrefix: "110000", accountSuffix: "000", institution: "KB국민은행" },
  },
  {
    // 설계 132: 휴대폰 소액결제(효성FMS 등) — 상호는 '요청 사이트' 뒤. 안내문 전체가 상호가 되면 안 된다.
    // 실사례 2026-08-03 원문(수집함 표에서 15줄로 꺾였다).
    name: "mobile micropayment (요청 사이트)",
    text: "⁨114⁩ <제목: 휴대폰 결제 성공 안내> [Web발신] [효성FMS/SKT] 휴대폰 결제가 완료되었습니다. - 요청 일시: 2026년 8월 3일 17:25:34 - 요청 사이트: (주)블루앤[1522-4655] - 요청 금액: 1,100 - 결제 대행사: 효성FMS[1544-5163] ■ [이번 달] 이용 내역 안내 - 이용 가능 금액: [500,000]원",
    // 설계 135: 서두 '휴대폰소액결제' 표기 — 통신요금 합산 청구라 일반 지출로 확정하면 이중 계상.
    expected: { kind: "approve", amount: 1100, merchant: "휴대폰소액결제 블루앤", date: "2026-08-03", balance: null, cardLast4: null, institution: null },
  },
  {
    // 대행사(효성FMS)를 상호로 쓰지 않는다 — '요청 사이트' 가 없으면 차라리 빈칸/다른 후보.
    name: "mobile micropayment keeps site not agency",
    text: "[Web발신] [다날/KT] 휴대폰 결제 완료 - 요청 사이트: 쿠팡[1577-7011] - 요청 금액: 9,900 - 결제 대행사: 다날[1566-3355]",
    expected: { kind: "approve", amount: 9900, merchant: "휴대폰소액결제 쿠팡", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // 설계 183: KB Pay 앱 사용알림이 문자로 오는 형식 — 마스킹도 '승인' 직전 숫자도 없어 끝4를 못 뽑았다.
    // 실원문 2026-08-18 14:57(끝4 뒤 날짜·시각·금액·상호·'승인' 순). 정식 'KB국민카드…9012승인' 문자와 0.1초 차로 같이 온다.
    name: "KB Pay usage alert (신용 NNNN)",
    text: "KB Pay[KB Pay 사용 알림] 신용 9012 08/18 14:57 54,780원 에이블리코퍼레이션 승인",
    expected: { kind: "approve", amount: 54780, merchant: "에이블리코퍼레이션", date: "2026-08-18", balance: null, cardLast4: "9012", institution: "KB국민카드" },
  },
  {
    // 같은 형식의 체크카드 변형(합성 — 아직 실물 미관측). '체크' 도 같은 규칙으로 잡혀야 한다.
    name: "KB Pay usage alert (체크 NNNN)",
    text: "KB Pay[KB Pay 사용 알림] 체크 2065 08/18 15:01 3,200원 GS25옥길점 승인",
    expected: { kind: "approve", amount: 3200, merchant: "GS25옥길점", date: "2026-08-18", balance: null, cardLast4: "2065", institution: "KB국민카드" },
  },
  {
    // 반증 리뷰(2026-08-18): 상호가 4자리로 끝나면 c3('{한글}NNNN 승인')가 그 숫자를 끝4 로 집었다 → 명시적 '신용 NNNN'(c5) 이 이긴다(합성).
    name: "KB Pay usage alert — merchant ending with 4 digits keeps explicit last4",
    text: "KB Pay[KB Pay 사용 알림] 신용 9012 08/18 23:10 8,900원 서울33바1234 승인",
    expected: { kind: "approve", amount: 8900, merchant: "서울33바1234", date: "2026-08-18", balance: null, cardLast4: "9012", institution: "KB국민카드" },
  },
  {
    // 교차리뷰(2026-08-18): 본문만 넘어오는 변형(발신자명 없이 제목 대괄호부터) — 선행 대괄호 허용(합성).
    name: "KB Pay usage alert — bracket-first variant",
    text: "[Web발신] [KB Pay 사용 알림] 신용 9012 08/18 14:57 54,780원 에이블리코퍼레이션 승인",
    expected: { kind: "approve", amount: 54780, merchant: "에이블리코퍼레이션", date: "2026-08-18", balance: null, cardLast4: "9012", institution: "KB국민카드" },
  },
  {
    // 실문자 전처리 변형: Web발신 접두의 대괄호가 빠져도 정확한 KB Pay 제목 대괄호가 게이트다.
    name: "KB Pay usage alert — unbracketed Web발신 prefix",
    text: "Web발신 [KB Pay 사용 알림] 신용 9012 08/18 14:57 54,780원 에이블리코퍼레이션 승인",
    expected: { kind: "approve", amount: 54780, merchant: "에이블리코퍼레이션", date: "2026-08-18", balance: null, cardLast4: "9012", institution: "KB국민카드" },
  },
  {
    name: "card approval",
    text: "[Web발신] 삼성카드 승인 12,345원 일시불 2026.06.21 14:30 스타벅스 1234**",
    expected: { kind: "approve", amount: 12345, merchant: "스타벅스", date: "2026-06-21", balance: null, cardLast4: "1234", institution: "삼성카드" },
  },
  {
    name: "approval cancel without time",
    text: "[Web발신] 삼성카드 승인취소 5,001원 2026.06.21 스타벅스",
    expected: { kind: "cancel", amount: 5001, merchant: "[취소] 스타벅스", date: "2026-06-21", balance: null, cardLast4: null, institution: "삼성카드" },
  },
  {
    name: "deposit excludes balance",
    text: "[Web발신] 국민은행 입금 1,000,002원 잔액 2,500,000원 급여",
    expected: { kind: "deposit", amount: 1000002, merchant: "급여", date: null, balance: 2500000, cardLast4: null, institution: "국민은행" },
  },
  {
    name: "withdraw excludes balance",
    text: "[Web발신] 우리은행 출금 30,003원 잔액 100,000원 ATM",
    expected: { kind: "withdraw", amount: 30003, merchant: "ATM", date: null, balance: 100000, cardLast4: null, institution: "우리은행" },
  },
  {
    name: "transfer",
    text: "[Web발신] 하나은행 이체 200,004원 홍길동",
    expected: { kind: "transfer", amount: 200004, merchant: "홍길동", date: null, balance: null, cardLast4: null, institution: "하나은행" },
  },
  {
    name: "autopay",
    text: "[Web발신] 신한카드 자동이체 55,005원 통신요금",
    expected: { kind: "autopay", amount: 55005, merchant: "통신요금", date: null, balance: null, cardLast4: null, institution: "신한카드" },
  },
  {
    name: "hana card approval (merchant before amount)",
    text: "하나은행\n씨유\n승인금액 5000원",
    expected: { kind: "approve", amount: 5000, merchant: "씨유", date: null, balance: null, cardLast4: null, institution: "하나은행" },
  },
  {
    // 설계 113 — 카드 자동결제 통보(실원문 2026-07-28, 김하늘 폰 통신료): '[카드사]NNNN 자동결제'의 끝4와
    // 'MM/DD접수 {가맹점} {금액}원'의 가맹점. 끝4가 뽑혀야 enrich 가 결제수단(달달할인 카드)을 자동기재한다.
    name: "card autopay 접수 형식 — 끝4·가맹점 (설계 113)",
    text: "삼성카드 [삼성카드]1234 자동결제 07/28접수 SK통신료(100000) 132,560원",
    expected: { kind: "approve", amount: 132560, merchant: "SK통신료(100000)", date: "2026-07-28", balance: null, cardLast4: "1234", institution: "삼성카드" },
  },
  {
    // 설계 113 — 같은 형식 이바다 폰(실원문 2026-07-14, 카드 1583=트레이더스).
    name: "card autopay 접수 형식 — 이바다 1583 (설계 113)",
    text: "[삼성카드]1583 자동결제 07/14접수 SK통신료(100001) 138,660원",
    expected: { kind: "approve", amount: 138660, merchant: "SK통신료(100001)", date: "2026-07-14", balance: null, cardLast4: "1583", institution: "삼성카드" },
  },
  {
    name: "unknown keeps raw parse minimal",
    text: "알림입니다",
    expected: { kind: "unknown", amount: null, merchant: null, date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // 상호 속 '세입금'의 '입금'을 오인해 deposit(income)으로 잡던 실사례 — 결제(approve)여야 한다. (2026-07-05)
    name: "세입금은 입금 오인 금지(위택스 토스알림)",
    text: "129,870원 결제 토스뱅크 체크카드 | 지자체세입금(카카오페이)\n잔액 1,724,835원",
    expected: { kind: "approve", amount: 129870, merchant: "지자체세입금(카카오페이)", date: null, balance: 1724835, cardLast4: null, institution: "토스뱅크" },
  },
  {
    // 간편결제 문장에서 앞선 완결문("결제가 완료되었어요 ")이 상호에 딸려오던 실사례. (2026-07-05)
    name: "위택스 간편결제 상호 추출",
    text: "결제가 완료되었어요 위택스에서 129,870원을 결제했어요.",
    expected: { kind: "approve", amount: 129870, merchant: "위택스", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // '인터넷출금이'에서 '출금'만 지워져 상호가 '토뱅김하늘 인터넷 이'로 남던 실사례. (2026-07-05)
    name: "인터넷출금이 복합토큰 제거",
    text: "이*다님 06/30 21:12 110-11-0***-111  토뱅김하늘 인터넷출금이 1,000,000 잔액5,068,279",
    expected: { kind: "withdraw", amount: 1000000, merchant: "토뱅김하늘", date: "2026-06-30", balance: 5068279, cardLast4: null, institution: null },
  },
  {
    // '전자금융입금'의 '전자금융' 부스러기가 상호에 남지 않아야 한다. (2026-07-05)
    name: "전자금융입금 복합토큰 제거",
    text: "이*다님 06/30 11:52 110-11-0***-111  바다기획 전자금융입금 2,000,000 잔액6,090,679",
    expected: { kind: "deposit", amount: 2000000, merchant: "바다기획", date: "2026-06-30", balance: 6090679, cardLast4: null, accountSuffix: null, institution: null },
  },
  {
    // 우리은행 체크카드 출금: 금액에 '원' 없음 + 마스킹 계좌(***) 섞임. (설계 docs/household/33)
    name: "check-card withdraw without 원 + masked account",
    text: "이*다님 06/25 10:56 110-11-0***-111  산들소아청소 체크카드출금 5,600 잔액4,104,319",
    expected: { kind: "withdraw", amount: 5600, merchant: "산들소아청소", date: "2026-06-25", balance: 4104319, cardLast4: null, institution: null },
  },
  {
    // KB국민은행 계좌 출금 — 적요가 'KB카드출금 카드출금(' 부스러기로 오추출되던 것을 기관명으로. (설계 76)
    name: "KB국민 계좌출금 → 카드사 기관명(KB카드)",
    text: "출금 459,200원이*다님 07/10 18:11 110-11-0***-111  KB카드출금 카드출금(    459,200 잔액2,350,302",
    expected: { kind: "withdraw", amount: 459200, merchant: "KB카드", date: "2026-07-10", balance: 2350302, cardLast4: null, institution: "KB카드" },
  },
  {
    // KB국민은행 계좌 출금 — 저축은행 CMS 자동이체. 적요에서 저축은행 기관명 추출. (설계 76)
    name: "KB국민 계좌출금 → 저축은행 CMS(신한저축은행)",
    text: "출금 247,450원이*다님 07/10 19:24 110-11-0***-111  신한저축은행 공동CMS출  247,450 잔액2,102,852",
    expected: { kind: "withdraw", amount: 247450, merchant: "신한저축은행", date: "2026-07-10", balance: 2102852, cardLast4: null, institution: "신한저축은행" },
  },
  {
    // 지로 출금 + 전각숫자(２６０６) → 반각 정규화, 기관 없으면 적요 정리. (설계 76)
    name: "KB국민 계좌출금 → 지로(전각숫자 반각화)",
    text: "출금 103,410원이*다님 07/10 20:14 110-11-0***-111  ２６０６국민 지로출금 103,410 잔액811,248",
    expected: { kind: "withdraw", amount: 103410, merchant: "2606국민 지로", date: "2026-07-10", balance: 811248, cardLast4: null, institution: null },
  },
  {
    name: "check-card withdraw 유지(회귀 방지 — 대시계좌라도 실상호 보존)",
    text: "이*다님 06/25 10:56 110-11-0***-111  산들소아청소 체크카드출금 5,600 잔액4,104,319",
    expected: { kind: "withdraw", amount: 5600, merchant: "산들소아청소", date: "2026-06-25", balance: 4104319, cardLast4: null, institution: null },
  },
  {
    name: "won withdraw with masked account (우리 *120000)",
    text: "[Web발신] 우리 06/25 08:04\n*120000\n출금 9,000원\n씨유(CU)옥길헤\n잔액 18,058원",
    expected: { kind: "withdraw", amount: 9000, merchant: "씨유(CU)옥길헤", date: "2026-06-25", balance: 18058, cardLast4: null, institution: null },
  },
  {
    name: "현대카드 일시불(누적 금액 오인 방지)",
    text: "[Web발신]\n현대카드M 승인\n이*다\n49,500원 일시불\n06/24 17:39\n㈜우아한형제들\n누적1,750,476원",
    // 상호는 '㈜우아한형제들' 이 아니라 '우아한형제들' — 법인표기는 뺀다(설계 154, 팀장 지시 2026-08-06).
    // '(주)교보문고'와 '교보문고'가 다른 학습키가 되던 것을 막는 변경이라 기대값을 같이 옮겼다.
    expected: { kind: "approve", amount: 49500, merchant: "우아한형제들", date: "2026-06-24", balance: null, cardLast4: null, institution: "현대카드" },
  },
  {
    // 간편결제 알림: "{가맹점}에서 N원을 결제했어요" — 가맹점이 금액 앞 '에서' 절. (설계 docs/household/41)
    name: "카카오모빌리티 간편결제(가맹점 금액 앞)",
    text: "카카오모빌리티에서 20,400원을 결제했어요.",
    expected: { kind: "approve", amount: 20400, merchant: "카카오모빌리티", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // 토스 카드결제 알림: "{금액}원 결제 {카드명} | {가맹점}(할부)" — 파이프 뒤가 가맹점, 전각괄호+할부표기 제거. (설계 51)
    name: "토스 카드결제(전각괄호+일시불 잔여 정리)",
    text: "5,500원 결제 우리체크 | 브루브로스커피（(일시불)",
    expected: { kind: "approve", amount: 5500, merchant: "브루브로스커피", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    name: "토스 카드결제(지점명 유지 + 일시불 제거)",
    text: "4,500원 결제 우리체크 | 지에스25 홍대레드로드점(일시불)",
    expected: { kind: "approve", amount: 4500, merchant: "지에스25 홍대레드로드점", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    name: "토스 카드결제(짧은 상호)",
    text: "11,000원 결제 우리체크 | 어서와(일시불)",
    expected: { kind: "approve", amount: 11000, merchant: "어서와", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // 카카오톡 카드 알림: '{발급사약칭}NNNN승인' — 마스킹 없는 끝4 폴백 추출. (설계 docs/household/57)
    name: "카카오톡 삼성카드(약칭+끝4+승인)",
    text: "삼성카드 삼성1234승인 김*늘 57,000원 일시불 07/03 18:27 당가원 누적3,001,757원",
    expected: { kind: "approve", amount: 57000, merchant: "당가원", date: "2026-07-03", balance: null, cardLast4: "1234", institution: "삼성카드" },
  },
  {
    // 끝4 폴백 오인 방지: '승인' 앞에 숫자가 없는 기존 형식은 계속 null.
    name: "승인 앞 숫자 없음 → cardLast4 null 유지",
    text: "[Web발신] 현대카드M 승인 이*다 8,000원 일시불 07/03 12:00 분식집 누적100,000원",
    expected: { kind: "approve", amount: 8000, merchant: "분식집", date: "2026-07-03", balance: null, cardLast4: null, institution: "현대카드" },
  },
  {
    name: "부천페이 상호 뒤 인센티브·잔액 꼬리 제거",
    text: "결제 완료 8,000원카페게이트 부천옥길점 부천페이 추가형 인센티브 727원 부천페이(캐릭터) 총 보유 잔액 93,430원",
    expected: { kind: "approve", amount: 8000, merchant: "카페게이트 부천옥길점", date: null, balance: 93430, cardLast4: null, institution: "부천페이" },
  },
  {
    // 토스 요금납부 알림: "내 {기관} 통장 → {상대처}" — 화살표 뒤가 상대처. 상대처가 기관명(카드사)이어도
    // stripMerchantNoise 에 지워지지 않아야 한다. (설계 105, 2026-07-27 실사례)
    name: "토스 요금납부(카드사 상대처 보존)",
    text: "요금납부 103,786원 출금 내 토스뱅크 통장 → 하나카드",
    expected: { kind: "withdraw", amount: 103786, merchant: "하나카드", date: null, balance: null, cardLast4: null, institution: "토스뱅크" },
  },
  {
    name: "토스 요금납부(캐피탈 상대처)",
    text: "요금납부 697,161원 출금 내 토스뱅크 통장 → 현대캐피탈(주)",
    expected: { kind: "withdraw", amount: 697161, merchant: "현대캐피탈", date: null, balance: null, cardLast4: null, institution: "토스뱅크" },
  },
  {
    name: "토스 요금납부(일반 상대처)",
    text: "요금납부 10,000원 출금 내 토스뱅크 통장 → 당비7월",
    expected: { kind: "withdraw", amount: 10000, merchant: "당비7월", date: null, balance: null, cardLast4: null, institution: "토스뱅크" },
  },
  {
    // 토스 결제완료 알림: '・' 앞은 결제수단, 뒤가 가맹점. 다음 줄 마케팅 문구는 상호에 붙으면 안 된다.
    // (설계 106, 2026-07-21 실사례 — 상호가 "완료 토스페이머니 ・ KT 한 돈 일부를…"로 들어왔다)
    name: "토스 결제완료(마케팅 꼬리말 절단)",
    text: "95,040원 결제 완료 토스페이머니 ・ KT\n결제한 돈 일부를 돌려받을 수 있어요.",
    // institution='토스'는 기존 기관추출 동작(설계 32) 그대로 — 이번 설계는 상호만 다룬다.
    expected: { kind: "approve", amount: 95040, merchant: "KT", date: null, balance: null, cardLast4: null, institution: "토스" },
  },
  {
    // '・' 앞이 은행명인 형태(2026-07-12 실사례). 기관명 제거 규칙에 상호가 지워지면 안 된다.
    name: "토스 결제완료(수단이 은행명)",
    text: "8,900원 결제 완료 우리은행 ・ 구글페이먼트코리아 유한회사\n결제한 돈 일부를 돌려받을 수 있어요.",
    expected: { kind: "approve", amount: 8900, merchant: "구글페이먼트코리아", date: null, balance: null, cardLast4: null, institution: "우리은행" },
  },
  {
    // 노이즈 '입금'만 지워져 종결어미 부스러기가 상호가 되던 흠 → 상호 없음(null)이 정답. (설계 106)
    name: "입금 알림(종결어미 부스러기는 상호 아님)",
    text: "입금 알림 KB국민은행 계좌에 10,000원 입금됐어요.",
    expected: { kind: "deposit", amount: 10000, merchant: null, date: null, balance: null, cardLast4: null, institution: "KB국민은행" },
  },
  {
    // 앞머리 종결어미 부스러기 뒤에 **실상호**가 붙어 오는 형태. 106 은 단일 토큰('됐어요.')만 걸러
    // 공백이 낀 '되었습니다. -바다기획-' 은 통째로 상호가 됐다 → 앞머리만 잘라 상호를 살린다. (설계 114)
    name: "입금 알림(앞머리 부스러기 뒤 실상호 보존)",
    text: "[Web발신] 이*다님 계좌에 2,000,000원 입금되었습니다. -바다기획-",
    expected: { kind: "deposit", amount: 2000000, merchant: "바다기획", date: null, balance: null, cardLast4: null, institution: null },
  },
  {
    // 월 접두가 붙으면 다음 달에 학습키가 갈려 merchant_map 매칭이 매번 실패한다(1회용 키). (설계 114)
    name: "토스 요금납부(월 접두 제거로 학습키 안정화)",
    text: "요금납부 406,520원 출금 내 토스뱅크 통장 → 07월 옥길데시앙 406동2302호",
    expected: { kind: "withdraw", amount: 406520, merchant: "옥길데시앙 406동2302호", date: null, balance: null, cardLast4: null, institution: "토스뱅크" },
  },
  {
    // 오정정 방지 — '5월의종로'처럼 공백 없는 실상호는 월 접두 규칙이 건드리면 안 된다. (설계 114)
    name: "월로 시작하는 실상호는 보존",
    text: "[Web발신] 우리 07/07 10:17 *120000 출금 12,000원 5월의종로 잔액 107,415원",
    expected: { kind: "withdraw", amount: 12000, merchant: "5월의종로", date: "2026-07-07", balance: 107415, cardLast4: null, institution: null },
  },
  {
    // 폴백 확인: 상호가 금액 '다음 줄'에 오는 우리 RCS 형식은 첫 줄 규칙으로 더 정확해져야 한다. (설계 106)
    name: "우리 RCS 출금(다음 줄 상호 보존)",
    text: "우리 07/07 10:17\n*120000\n출금 4,500원\nGS25홍대잔다리\n잔액 107,415원",
    // '07/07'은 기존 날짜 규칙이 그대로 잡는다(우리 문자 머리의 날짜 표기).
    expected: { kind: "withdraw", amount: 4500, merchant: "GS25홍대잔다리", date: "2026-07-07", balance: 107415, cardLast4: null, institution: null },
  },
  {
    name: "KB 카드론 안내문 조건 추출",
    text: kbCardLoanText,
    expected: {
      kind: "deposit",
      amount: 15000000,
      merchant: "KB국민카드",
      date: "2026-08-02", // 대출취급일
      balance: null,
      cardLast4: null,
      institution: "KB국민카드",
      loanTerms: { rate: 18.1, termMonths: 18, repaymentType: "equal_principal", totalRepayment: 17211195, maturityDate: "2028-02-10" },
    },
  },
  {
    // ★'승인 완료' 어휘가 있어도 카드론 실행금은 입금이다 — approve(카드 지출)로 새면 안 된다.
    name: "삼성 카드론 안내문 조건 추출 (kind 는 deposit 고정)",
    text: samsungCardLoanText,
    expected: {
      kind: "deposit",
      amount: 13700000,
      merchant: "삼성카드",
      date: "2026-08-11",
      balance: null,
      cardLast4: null,
      institution: "삼성카드",
      loanTerms: { rate: 12.2, termMonths: null, repaymentType: null, totalRepayment: null, maturityDate: null },
    },
  },
] as const;

for (const c of cases) {
  const parsed = parseSms(c.text, null);
  ok(parsed.kind === c.expected.kind, `${c.name}: kind=${parsed.kind}`);
  ok(parsed.amount === c.expected.amount, `${c.name}: amount=${parsed.amount}`);
  ok(parsed.merchant === c.expected.merchant, `${c.name}: merchant=${parsed.merchant}`);
  ok(parsed.occurredAt === c.expected.date, `${c.name}: date=${parsed.occurredAt}`);
  ok(parsed.balance === c.expected.balance, `${c.name}: balance=${parsed.balance}`);
  ok(parsed.cardLast4 === c.expected.cardLast4, `${c.name}: cardLast4=${parsed.cardLast4}`);
  if ("accountTail" in c.expected) ok(parsed.accountTail === c.expected.accountTail, `${c.name}: accountTail=${parsed.accountTail}`);
  if ("accountPrefix" in c.expected) ok(parsed.accountPrefix === c.expected.accountPrefix, `${c.name}: accountPrefix=${parsed.accountPrefix}`);
  if ("accountSuffix" in c.expected) ok(parsed.accountSuffix === c.expected.accountSuffix, `${c.name}: accountSuffix=${parsed.accountSuffix}`);
  ok(parsed.institution === c.expected.institution, `${c.name}: institution=${parsed.institution}`);
  if ("loanTerms" in c.expected) {
    ok(isDeepStrictEqual(parsed.loanTerms, c.expected.loanTerms), `${c.name}: loanTerms=${JSON.stringify(parsed.loanTerms)}`);
  }
}

// 설계 106 교차리뷰(2026-07-28, Codex × Claude)가 찾아낸 경계 케이스 회귀.
// 규칙은 "정상 상호를 잃지 않는다 / 오상호를 만들지 않는다"이므로, 지저분해도 상호를 품은 기존 동작은 허용하고
// 새 규칙이 잘못 발동하는 것만 막는다.
const merchantCases: { name: string; text: string; check: (m: string | null) => boolean; want: string }[] = [
  {
    // '결제 완료'와 '·'가 다른 줄에 있으면 토스 규칙이 발동하면 안 된다(불릿 뒤를 상호로 확정하던 사고).
    name: "'·' 불릿 오발동 방지",
    text: "우리 07/07 10:17\n*120000\n결제 완료 4,500원\nGS25홍대잔다리\n· 우리WON뱅킹",
    check: (m) => m !== "우리WON뱅킹" && !!m?.includes("GS25홍대잔다리"),
    want: "상호(GS25홍대잔다리)를 잃지 않을 것",
  },
  {
    // '・' 앞이 결제수단이 아닌 순서(가맹점 ・ 카드사)면 발동하면 안 된다 — 카드사를 상호로 학습하는 사고.
    name: "'・' 순서 반대(수단이 뒤)",
    text: "5,000원 결제 완료 스타벅스 강남점 ・ 신한카드",
    check: (m) => m !== "신한카드",
    want: "결제수단을 상호로 쓰지 않을 것",
  },
  {
    name: "'・'가 두 번(승인번호 꼬리 배제)",
    text: "95,040원 결제 완료 토스페이머니 ・ KT ・ 승인번호 123456",
    check: (m) => m === "KT",
    want: "KT",
  },
  {
    // 줄바꿈 없이 합쳐져 오면 마케팅 문장이 붙는다 → 오상호를 만드느니 빈칸(학습 안 됨)이 낫다.
    name: "합본(줄바꿈 없음)은 빈칸",
    text: "95,040원 결제 완료 토스페이머니 ・ KT 결제한 돈 일부를 돌려받을 수 있어요.",
    check: (m) => m === null,
    want: "null",
  },
  {
    // 서술형이라고 금액 앞 후보를 통째로 버리면 진짜 상호가 죽는다 → 조사로 끝날 때만 버린다.
    name: "금액 앞 상호 + 서술 종결어미",
    text: "오늘의커피 5,000원 결제됐어요.",
    check: (m) => m === "오늘의커피",
    want: "오늘의커피",
  },
  {
    // 종결어미로 끝나는 '한 단어' 상호는 실제로 존재한다 → 부스러기 목록에 없으면 살린다.
    name: "한 단어 상호 보존(카페예요)",
    text: "[Web발신] 신한카드 승인 12,000원 카페예요",
    check: (m) => m === "카페예요",
    want: "카페예요",
  },
  {
    // 금액 줄과 상호 줄 사이에 안내 문장이 끼면, 줄 후보를 버리고 기존 경로로 폴백해야 상호가 산다.
    name: "안내 줄이 끼어든 다중행",
    text: "우리 07/07\n*120000\n출금 4,500원\n우리WON뱅킹에서 확인하세요\nGS25홍대잔다리\n잔액 107,415원",
    check: (m) => !!m?.includes("GS25홍대잔다리"),
    want: "상호를 잃지 않을 것",
  },
  {
    name: "'・' 뒤 할부표기 제거(학습 키 분리 방지)",
    text: "12,000원 결제 완료 우리체크 ・ 지에스25 홍대점(일시불)",
    check: (m) => m === "지에스25 홍대점",
    want: "지에스25 홍대점",
  },
  {
    // ★설계 150 — 카드대금 상호가 한 글자로 갈려 나가던 결함.
    // 노이즈 제거가 기관명('우리카드')과 '결제'를 차례로 지워 '대'만 남았다(실사례 2026-08-05 원문).
    // 한 글자 키는 merchant_map 부분일치 때문에 '대'를 포함한 모든 상호에 걸린다.
    name: "카드대금 상호 정규화(은행이 자른 '결제대')",
    text: "[Web발신] 우리 08/05 03:06 *120000 출금 14,400원 우리카드결제대 잔액 63,749원",
    check: (m) => m === "우리카드결제대금",
    want: "우리카드결제대금",
  },
  {
    name: "카드대금 상호 정규화(안 잘린 '결제대금')",
    text: "[Web발신] 우리 07/06 03:06 *120000 출금 17,155원 우리카드결제대금 잔액 63,749원",
    check: (m) => m === "우리카드결제대금",
    want: "우리카드결제대금",
  },
  {
    name: "카드대금 상호 정규화(어순 반대 '대금결제')",
    text: "[Web발신] 우리 06/05 03:06 *120000 출금 14,910원 우리카드대금결제 잔액 63,749원",
    check: (m) => m === "우리카드결제대금",
    want: "우리카드결제대금",
  },
  {
    // 회귀 가드: '대금'이 없는 평범한 카드승인은 종전대로 가맹점을 잡아야 한다.
    name: "카드대금 규칙이 일반 카드승인을 삼키지 않는다",
    text: "삼성카드 삼성1234승인 김*늘 42,260원 일시불 08/01 20:43 쿠팡 누적2,402,255원",
    check: (m) => m === "쿠팡",
    want: "쿠팡",
  },
  {
    // 회귀 가드: '대출'의 '대'를 '대금'으로 오인하면 안 된다.
    name: "카드대금 규칙이 '카드대출'을 삼키지 않는다",
    text: "[Web발신] 우리 08/05 03:06 *120000 출금 500,000원 삼성카드대출 잔액 63,749원",
    check: (m) => m !== "삼성카드결제대금",
    want: "카드대금으로 오판하지 않을 것",
  },
];
for (const c of merchantCases) {
  const got = parseSms(c.text, null).merchant;
  ok(c.check(got), `merchant[${c.name}]: ${JSON.stringify(got)} (기대: ${c.want})`);
}

// 설계 181 회귀: 카드론 조건 안내가 아닌 기존 카드대출 출금·대출상환 문자는 종전 파싱을 유지한다.
{
  const cardLoanWithdrawal = parseSms("[Web발신] 우리 08/05 03:06 *120000 출금 500,000원 삼성카드대출 잔액 63,749원", null);
  ok(cardLoanWithdrawal.loanTerms === null, "카드대출 출금: loanTerms=null");
  ok(cardLoanWithdrawal.amount === 500000 && cardLoanWithdrawal.merchant === "대출", `카드대출 출금 종전값: ${cardLoanWithdrawal.amount}/${cardLoanWithdrawal.merchant}`);

  const loanPayment = parseSms("[Web발신] 우리 08/05 출금 195,000원 대출원리금납입 잔액 100원", null);
  ok(loanPayment.loanTerms === null, "대출원리금납입: loanTerms=null");
  // 실행/승인 어휘가 없는 카드론 상환·한도 안내는 분기하지 않는다(세 번째 앵커).
  const cardLoanRepayNotice = parseSms("[Web발신] 현대카드 카드론 이용금액 338,742원 09/01 결제 예정 안내");
  ok(cardLoanRepayNotice.loanTerms === null, "카드론 결제예정 안내(실행 어휘 없음): loanTerms=null");
  // 억 단위 · 이용가능금액 꼬리(부정 조건에 걸리면 안 된다) · 연체이자율이 앞서는 형식
  const eokNotice = parseSms("[Web발신] [현대카드] 장기카드대출(카드론) 승인 완료 안내 - 이용금액 : 1억 2,000만원 - 연체이자율 : 24.00% - 이자율 : 연 9.90% - 대출만기일 : 2029.08.17 남은 이용가능금액 3,000,000원");
  ok(eokNotice.amount === 120_000_000, `억 단위 환산: amount=${eokNotice.amount}`);
  ok(eokNotice.loanTerms?.rate === 9.9, `연체이자율 건너뛰고 적용 이자율: rate=${eokNotice.loanTerms?.rate}`);
  ok(eokNotice.loanTerms?.maturityDate === "2029-08-17", `만기일 점 표기 정규화: ${eokNotice.loanTerms?.maturityDate}`);
  ok(eokNotice.merchant === "현대카드", `상호=카드사명: ${eokNotice.merchant}`);
  ok(eokNotice.installmentMonths === null, "카드론 분기: installmentMonths=null");
  // 앵커는 있는데 값이 안 읽히면 amount=null(빈칸 > 오값) — 납입예상총원리금 17,211,195 를 집으면 안 된다
  const badValue = parseSms("[Web발신] KB국민카드 장기카드대출 입금되었습니다. 대출금액 : 일천오백만원 납입예상총원리금 : 17,211,195원");
  ok(badValue.loanTerms !== null && badValue.amount === null, `값 파싱 실패 → amount=null (실제 ${badValue.amount})`);
  // 취소·철회 안내는 실행 어휘가 있어도 분기하지 않는다(cancel 이 deposit 으로 뒤집히면 안 된다)
  const cancelNotice = parseSms("[Web발신] [삼성카드] 장기카드대출(카드론) 승인 취소 안내 - 이용금액 : 13,700,000원 승인되었던 건이 취소되었습니다.");
  ok(cancelNotice.loanTerms === null && cancelNotice.kind !== "deposit", `취소 안내: loanTerms=null, kind=${cancelNotice.kind}`);
  // 완료 신호(입금되)가 있어도 상환 안내·명세서·부정형(승인되지 않)은 부정 조건이 막는다 — 각 조건이 실제로 일하는지 따로 본다
  const repayNotice = parseSms("[Web발신] 장기카드대출 상환 안내 대출금액 : 15,000,000원 이번 달 원리금이 정상 입금되었습니다");
  ok(repayNotice.loanTerms === null, "상환 안내(완료 어휘 있음): 부정 조건으로 loanTerms=null");
  const stmtNotice = parseSms("[Web발신] 장기카드대출 명세서 안내 대출금액 : 15,000,000원 대출취급일 : 2026-08-02 실행되었던 건의 이용내역");
  ok(stmtNotice.loanTerms === null, "명세서 안내(완료 어휘 있음): 부정 조건으로 loanTerms=null");
  const deniedNotice = parseSms("[Web발신] [삼성카드] 장기카드대출(카드론) 이용금액 1,000,000원은 승인되지 않았습니다.");
  ok(deniedNotice.loanTerms === null, "부정형 '승인되지 않았습니다': loanTerms=null");
  // 실행 안내 본문의 법정 상용구('대출철회권'·'상환 안내 사기 주의')는 분기를 끄면 안 된다(2026-08-17 실원문 실측)
  const boilerplate = parseSms("⁨1588-1688⁩<제목: 장기카드대출입금안내> [Web발신] KB국민카드 장기카드대출을 이용해주셔서 감사합니다. ■ 신청내역 대출금액 : 1,500만원 적용이자율 : 18.10% 대출취급일 : 2026-08-02 * 대출철회권 : 대출 실행일 14일이내 신청 가능합니다. * 고금리 대출 상환 안내 사기 전화 주의");
  ok(boilerplate.loanTerms !== null && boilerplate.amount === 15_000_000, `본문 상용구(철회권·상환 안내 사기주의)에도 분기 유지: amount=${boilerplate.amount}`);
  // 인사말이 짧아 머리말 120자 안에 '상환방식 :' 라벨이 들어오는 형식 — 부정 조건 `상환` 이 라벨을 잡으면 분기가 꺼진다(2026-08-17 종단 실측)
  const shortHead = parseSms("⁨1588-1688⁩<제목: 장기카드대출입금안내> [Web발신] KB국민카드 장기카드대출을 이용해주셔서 감사합니다. ■ 신청내역 대출금액 : 1,234만원 대출기간 : 12개월 적용이자율 : 15.50% 상환방식 : 원리금균등상환 대출취급일 : 2026-08-17 대출만기일 : 2027-08-17 납입예상총원리금 : 13,401,000원");
  ok(shortHead.amount === 12_340_000 && shortHead.loanTerms?.repaymentType === "annuity", `머리말에 '상환방식' 라벨이 들어와도 분기 유지: amount=${shortHead.amount}`);
  // '1억원'(만 단위 없음) · 중도상환 실행 통지(나간 돈이 수입으로 앉으면 안 된다)
  const eokOnly = parseSms("[Web발신] [현대카드] 장기카드대출(카드론) 승인 완료 안내 - 이용금액 : 1억원 - 이자율 : 연 9.90%");
  ok(eokOnly.amount === 100_000_000, `'1억원' 환산: amount=${eokOnly.amount}`);
  const midRepay = parseSms("[삼성카드] 장기카드대출(카드론) 중도상환이 실행되었습니다. 이용금액 : 13,700,000원 상환액 : 5,000,000원");
  ok(midRepay.loanTerms === null, "중도상환 실행 통지: loanTerms=null(부정 조건)");
  const onlyDateNotice = parseSms("[Web발신] 장기카드대출 이용내역 대출금액 : 15,000,000원 대출취급일 : 2026-08-02");
  ok(onlyDateNotice.loanTerms === null, "대출취급일만 있고 완료 어휘 없음: loanTerms=null");
  ok(loanPayment.amount === 195000 && loanPayment.merchant === "대출원리금납입", `대출원리금납입 종전값: ${loanPayment.amount}/${loanPayment.merchant}`);
}

// 설계 113 — 자동결제 규칙은 앵커가 다 갖춰졌을 때만 발동한다(오상호·오카드 방지, 설계 106 원칙).
// ★교차리뷰 반영(2026-07-30, Codex×Claude): 미발동 케이스의 기대 상호를 기존 경로의 **정확값**으로
// 고정한다 — includes 부정 검사는 입력에 그 문자열이 없으면 항진명제라 검증력이 없었다.
{
  // 닫는 대괄호 없는 4자리는 끝4로 안 본다(전화번호·회원번호 오인 방지).
  const noBracket = parseSms("삼성카드 1234 자동결제 통신료 10,000원", null);
  ok(noBracket.cardLast4 === null, `autopay 끝4 좁은 앵커: 대괄호 없으면 미발동 (got ${noBracket.cardLast4})`);
  // 대괄호가 카드사가 아니면('…카드]'로 안 끝나면) 미발동 — [고객번호]NNNN·[Web발신] 오인 방지. (Codex·Claude 각자 발견)
  const notCard = parseSms("[고객번호]1234 자동결제 07/28접수 보험료 10,000원", null);
  ok(notCard.cardLast4 === null, `autopay 끝4: 대괄호가 카드사 아니면 미발동 (got ${notCard.cardLast4})`);
  const webHeader = parseSms("[Web발신] 5000 자동결제 출금 5,000원 잔액 10,000원", null);
  ok(webHeader.cardLast4 === null, `autopay 끝4: [Web발신] 머리말 오인 안 함 (got ${webHeader.cardLast4})`);
  // '접수'가 없으면 가맹점 규칙 미발동 → 기존 경로 결과(부스러기여도 그대로)를 쓴다.
  const noReceipt = parseSms("[삼성카드]1234 자동결제 SK통신료 132,560원", null);
  ok(noReceipt.cardLast4 === "1234" && noReceipt.merchant === "[ ]1234 자동 SK통신료",
    `autopay 가맹점 규칙: '접수' 없으면 미발동·기존 경로 유지 (merchant=${noReceipt.merchant})`);
  // '접수번호'의 '접수'는 앵커가 아니다 — '번호 9876 …'을 상호로 만들지 않고 기존 경로로. (Codex 발견)
  const receiptNo = parseSms("[삼성카드]1234 자동결제 07/28 접수번호 9876 SK통신료 132,560원", null);
  ok(receiptNo.merchant === "[ ]1234 자동 접수번호 9876 SK통신료",
    `autopay 가맹점 규칙: '접수번호' 미발동·기존 경로 유지 (merchant=${receiptNo.merchant})`);
}

// 증권 배당금 입금 알림 (설계 190) — 2026-08-25 실사고: 상호를 못 뽑아 기관명 '토스'만 남았고,
// merchant_map 의 짧은 키 "토스"(환급/캐시백·토스뱅크)가 배당 입금을 삼켰다.
{
  const dividend = parseSms("아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요.");
  ok(dividend.merchant === "아이스크림미디어 배당금", `배당금 상호 = 발행사+배당금 (merchant=${dividend.merchant})`);
  ok(dividend.institution === "토스증권", `배당금 기관 = 토스증권 (inst=${dividend.institution})`);
  ok(dividend.amount === 93466, `배당금 금액 (amount=${dividend.amount})`);
  ok(dividend.kind === "deposit", `배당금 종류 = deposit (kind=${dividend.kind})`);
  // 개행이 섞여 들어와도 같아야 한다. (실제 수집 경로는 notification-ingest 가 title+본문을
  //  공백으로 합쳐 보내므로 개행이 오지 않는다 — 이건 파서가 접기(fold)에 의존하는지 확인하는 가드다.)
  const twoLine = parseSms("아이스크림미디어 배당금 입금🎉\n토스증권 계좌로 93,466원이 입금됐어요.");
  ok(twoLine.merchant === "아이스크림미디어 배당금", `배당금 상호(개행 포함) (merchant=${twoLine.merchant})`);
  // 발행사가 달라도 같은 규칙으로 일반화된다.
  const other = parseSms("삼성전자 배당금 입금🎉 토스증권 계좌로 12,340원이 입금됐어요.");
  ok(other.merchant === "삼성전자 배당금", `다른 발행사도 일반화 (merchant=${other.merchant})`);
  const alnum = parseSms("SK하이닉스 배당금 입금 토스증권 계좌로 5,000원이 입금됐어요.");
  ok(alnum.merchant === "SK하이닉스 배당금", `영문+한글 발행사 (merchant=${alnum.merchant})`);

  // ★★ETF 이름에 `&`·`-` 가 들어가는 경우 (교차검토 2026-08-26 실측 결함).
  //   예전 문자군 방식은 이 글자들이 캡처군 밖이라 매치가 그 **뒤**에서 시작해 앞이 잘렸다
  //   (`TIGER 미국S&P500` → `P500`). merchant_map 이 부분일치라 그런 조각이 학습되면
  //   TIGER·KODEX·ACE 의 서로 다른 S&P500 상품이 전부 한 규칙으로 접힌다.
  //   지금은 낱말 경계(`(?:^|\s)`)에서만 시작하므로 조각이 원천적으로 안 생긴다.
  const etf = parseSms("TIGER 미국S&P500 배당금 입금🎉 토스증권 계좌로 5,120원이 입금됐어요.");
  ok(etf.merchant === "TIGER 미국S&P500 배당금", `ETF 이름의 '&' 앞이 잘리지 않는다 (merchant=${etf.merchant})`);
  const etfDash = parseSms("HANARO K-반도체 배당금 입금🎉 토스증권 계좌로 800원이 입금됐어요.");
  ok(etfDash.merchant === "HANARO K-반도체 배당금", `ETF 이름의 '-' 앞이 잘리지 않는다 (merchant=${etfDash.merchant})`);

  // ★캡처가 공백을 포함해 **앞 문장이 통째로 딸려오는** 것을 막는지 (설계 190).
  //   정규식은 가장 왼쪽에서 시작하려 해서 lazy 만으로는 못 막는다 — 종결어미 컷이 있어야 한다.
  const leadClause = parseSms("결제가 완료되었어요 아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요.");
  ok(leadClause.merchant === "아이스크림미디어 배당금", `앞 문장(종결어미)은 잘라낸다 (merchant=${leadClause.merchant})`);
  const leadPeriod = parseSms("알림이 도착했습니다. 삼성전자 배당금 입금🎉 토스증권 계좌로 12,340원이 입금됐어요.");
  ok(leadPeriod.merchant === "삼성전자 배당금", `앞 문장(마침표) 뒤 발행사를 살린다 (merchant=${leadPeriod.merchant})`);
  const datePrefix = parseSms("07월 아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요.");
  ok(datePrefix.merchant === "아이스크림미디어 배당금", `날짜 접두 제거 — 매달 다른 학습키 방지 (merchant=${datePrefix.merchant})`);

  // ★상호가 부스러기가 되느니 **빈칸**이 낫다(설계 106) — 한두 글자 키는 부분일치라 규칙을 오염시킨다.
  const noIssuer = parseSms("배당금 입금🎉 토스증권 계좌로 1,000원이 입금됐어요.");
  ok(noIssuer.merchant === null, `발행사가 없으면 빈칸 (merchant=${noIssuer.merchant})`);
  const tooLong = parseSms(
    "아주아주아주아주아주아주아주아주아주긴발행사이름이길게이어지는회사 배당금 입금🎉 토스증권 계좌로 100원이 입금됐어요."
  );
  ok(tooLong.merchant === null, `발행사가 캡처 상한을 넘으면 앞이 잘린 상호를 쓰지 않고 빈칸 (merchant=${tooLong.merchant})`);
  // 상한이 마침 공백 자리에 떨어질 때도 앞 낱말을 잃은 채 통과하면 안 된다(교차검토 지적).
  const boundary = parseSms(
    "아주긴회사이름주식회사 나나나나나나나나나나나나나나나나나나나나나나나나나나나나나 배당금 입금 토스증권 계좌로 100원이 입금됐어요."
  );
  ok(boundary.merchant === null, `30자 경계가 공백에 떨어져도 앞 낱말을 잃은 상호를 쓰지 않는다 (merchant=${boundary.merchant})`);
  // 앞머리가 종결어미가 아닌 '…입니다' 꼴이어도 잘라 낸다.
  const politeLead = parseSms("입금 알림입니다 아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요.");
  ok(politeLead.merchant === "아이스크림미디어 배당금", `'입니다' 머리말도 잘라낸다 (merchant=${politeLead.merchant})`);
  // 글자 없는 앞 낱말(이모지·기호)은 벗겨 내고, 벗긴 뒤 2글자를 못 채우면 빈칸.
  const emojiLead = parseSms("🎉 삼성전자 배당금 입금 토스증권 계좌로 100원이 입금됐어요.");
  ok(emojiLead.merchant === "삼성전자 배당금", `앞 이모지는 벗겨 낸다 (merchant=${emojiLead.merchant})`);
  const emojiOneChar = parseSms("🎉 가 배당금 입금 토스증권 계좌로 100원이 입금됐어요.");
  ok(emojiOneChar.merchant === null, `이모지를 벗긴 뒤 한 글자면 빈칸 (merchant=${emojiOneChar.merchant})`);
  // ★좁게 발동 — '증권 계좌로'가 없으면 이 규칙을 타지 않는다(은행 배당 문자를 건드리지 않는다).
  //   기존 경로가 뽑던 상호('배당금')가 그대로 나와야 한다 — '{발행사} 배당금' 꼴로 바뀌면 새 규칙이 샌 것이다.
  const bank = parseSms("[Web발신] 국민은행 08/25 입금 100,000원 배당금입금 잔액 1,000원");
  ok(bank.merchant === "배당금", `증권 아닌 배당 문자는 기존 경로 유지 (merchant=${bank.merchant})`);
  ok(bank.institution === "국민은행", `증권 아닌 배당 문자의 기관 (inst=${bank.institution})`);
  // 증권 시세 알림은 노이즈로 남아야 한다(설계 50). ★이모지 없는 꼴로 검사한다 —
  //   `📈` 가 있으면 규칙 9가 이모지만 보고 통과시켜 **이 분기를 되돌려도 통과**한다(교차검토 지적).
  const quoteText = "토스증권 보유 주식 주가가 올랐어요";
  const quote = parseSms(quoteText);
  ok(skipDisposition(quoteText, quote) === "ignore-noise", "토스증권 시세 알림은 노이즈(이모지 없이도)");
  // 시세 알림에는 '배당금 입금'도 '증권 계좌로'도 없으니 배당 분기가 발동하면 안 된다.
  ok(quote.merchant !== "토스증권 배당금", `시세 알림에 배당 분기 미발동 (merchant=${quote.merchant})`);
}

// 기관명 추출 회귀 (설계 docs/household/32)
const { extractInstitution } = sms;
const instCases: { name: string; text: string; inst: string | null }[] = [
  { name: "우리(약식) 출금 → 우리은행 아님(약식은 미포착)", text: "[Web발신] 우리 06/23 16:34\n*120000\n출금 4,500원\nGS25홍대잔다리", inst: null },
  { name: "토스뱅크", text: "토스뱅크 입금 50,000원 김하늘", inst: "토스뱅크" },
  { name: "부천페이", text: "[Web발신] 부천페이 승인 3,000원 분식집", inst: "부천페이" },
  { name: "KB국민카드 우선(긴 이름)", text: "[Web발신] [KB국민카드] 승인 1,000원 편의점", inst: "KB국민카드" },
  { name: "기관 없는 문자", text: "씨유 5,000원 결제", inst: null },
  { name: "접미사 일반패턴(웰컴저축은행)", text: "웰컴저축은행 입금 100원", inst: "웰컴저축은행" },
  // 설계 190 — 같은 자리에서 짧은 이름('토스')이 먼저 걸려 일반 접미사 패턴까지 못 가던 흠.
  { name: "토스증권(짧은 '토스'에 안 먹힘)", text: "토스증권 계좌로 93,466원이 입금됐어요.", inst: "토스증권" },
  { name: "카카오페이증권(짧은 '카카오페이'에 안 먹힘)", text: "카카오페이증권 계좌로 1,000원이 입금됐어요.", inst: "카카오페이증권" },
  { name: "토스뱅크는 그대로(회귀 가드)", text: "요금납부 1,566,450원 출금 내 토스뱅크 통장 → 삼성카드", inst: "토스뱅크" },
];
for (const c of instCases) {
  const got = extractInstitution(c.text);
  ok(got === c.inst, `inst[${c.name}]: ${got}`);
}

// 설계 183 c5(KB Pay 끝4) 오발동 방지 — 교차리뷰 반영(2026-08-18). 전부 합성.
const kbPayNeg: { name: string; text: string; last4: string | null; inst: string | null }[] = [
  { name: "KB Pay 마케팅 머리말(대괄호 제목 없음) → 끝4 없음", text: "KB Pay 신용카드 사용 알림 서비스 신용 1234 고객님, 5,000원 이상 결제 시 캐시백", last4: null, inst: null },
  { name: "KB Pay 제목 뒤 '서비스' + 한도 안내 → 끝4 없음", text: "KB Pay[KB Pay 사용 알림 서비스] 체크 1234 이용한도 50,000원", last4: null, inst: null },
  { name: "KB Pay 정확한 제목이어도 '신용 1234원'은 끝4가 아니라 금액", text: "KB Pay[KB Pay 사용 알림] 신용 1234원 이상 결제 시 혜택", last4: null, inst: null },
  { name: "KB Pay 마케팅 '신용 30000원' → 끝4 없음", text: "KB Pay 이벤트! 신용 30000원 이상 결제시 5,000원 캐시백", last4: null, inst: null },
  { name: "KB Pay 사용알림이라도 5자리 숫자는 끝4 아님", text: "KB Pay[KB Pay 사용 알림] 신용 54780원 08/18 14:57 에이블리 승인", last4: null, inst: null },
  { name: "KB Pay 송금 안내(사용알림 제목 없음) → 끝4 없음", text: "KB Pay 송금 완료 홍길동님에게 50,000원을 보냈어요. 체크 5062 계좌에서 출금", last4: null, inst: null },
  { name: "KB Pay 머리말 아님(카카오페이) → c5 미발동", text: "[카카오페이] 신용 1234 08/18 결제 3,000원 편의점 승인", last4: null, inst: "카카오페이" },
  { name: "마스킹이 있으면 마스킹 우선(c2) · 기관 폴백 안 함", text: "KB Pay[KB Pay 사용 알림] 신용 9012 **9999 08/18 14:57 1,000원 편의점 승인", last4: "9999", inst: null },
];
for (const c of kbPayNeg) {
  const p = parseSms(c.text, null);
  ok(p.cardLast4 === c.last4, `kbpay-neg[${c.name}]: last4=${p.cardLast4}`);
  ok(p.institution === c.inst, `kbpay-neg[${c.name}]: inst=${p.institution}`);
}

// 할부 개월수 추출 회귀 (설계 docs/household/54)
const instMonthCases: { name: string; text: string; months: number | null }[] = [
  { name: "현대카드M 2개월 할부", text: "[Web발신]\n현대카드M 승인\n이*다\n170,000원 02개월\n06/30 08:58\n국가대표K태권도장", months: 2 },
  { name: "3개월 할부 표기", text: "삼성카드 승인 300,000원 03개월 가전마트", months: 3 },
  { name: "12개월 무이자 할부", text: "국민카드 승인 1,200,000원 12개월 무이자 노트북", months: 12 },
  { name: "토스 카드앱 (3개월)", text: "90,000원 결제 우리체크 | 어느가게(3개월)", months: 3 },
  { name: "일시불 → null", text: "우리체크 승인 4,500원 일시불 편의점", months: null },
  { name: "01개월 → null(할부 아님)", text: "삼성카드 승인 5,000원 01개월 카페", months: null },
  { name: "개월 표기 없음 → null", text: "[Web발신] 우리 06/30\n*120000\n출금 6,000원\nCOC", months: null },
];
for (const c of instMonthCases) {
  const got = parseSms(c.text, null).installmentMonths;
  ok(got === c.months, `installment[${c.name}]: months=${got}`);
}

const parsed = parseSms("[Web발신] 삼성카드 승인 9,900원 2026.06.21 12:00 메가커피 ****5678");
const keyOf = (p: ReturnType<typeof parseSms>) => smsDedupKey({
  kind: p.kind,
  date: p.occurredAt ?? "2026-06-21",
  amount: p.amount,
  merchant: p.merchant,
  cardLast4: p.cardLast4,
  time: p.occurredTime,
  balance: p.balance,
});
const key = keyOf(parsed);
ok(key === "approve|2026-06-21|9900|메가커피|5678|12:00|", `dedup key=${key}`);

// 설계 164 — 키에 시각·통보잔액 포함. 재전송만 막고 같은 날 재결제는 살린다.
// ★픽스처 계좌·이름은 합성값이다(실계좌 조각 금지 — 2026-08-10 규칙).
{
  const bankSms = "출금 5,000원홍*동님 08/11 18:58 123-45-0***-999 (주)합성상점 체크카드출금 5,000 잔액2,218,588";
  const a = keyOf(parseSms(bankSms, null));
  const aResent = keyOf(parseSms(bankSms, null)); // 같은 문자 재전송 → 같은 키(차단 유지)
  ok(a !== null && a === aResent, `dedup164[재전송 동일키]: ${a}`);
  // 같은 날 같은 가맹점·금액, 다른 시각(재결제) → 다른 키(수집됨) — 2026-08-11 무흔적 소실의 본체
  const b = keyOf(parseSms("출금 5,000원홍*동님 08/11 19:10 123-45-0***-999 (주)합성상점 체크카드출금 5,000 잔액2,213,588", null));
  ok(b !== null && a !== b, `dedup164[다른 시각 다른 키]: ${b}`);
  // 같은 분 재결제 — 은행 출금 문자는 통보잔액이 갈라 준다 → 다른 키(이후 설계 163 이 휴지통 보존)
  const c = keyOf(parseSms("출금 5,000원홍*동님 08/11 18:58 123-45-0***-999 (주)합성상점 체크카드출금 5,000 잔액2,213,588", null));
  ok(c !== null && a !== c, `dedup164[같은 분 잔액차 다른 키]: ${c}`);
  // 시각·잔액이 없는 문자 → 빈 세그먼트(키 자체는 만들어진다, 기존과 동일한 잔여)
  const d = keyOf(parseSms("[Web발신] 삼성카드 승인 9,900원 메가커피 ****5678", null));
  ok(d !== null && d.endsWith("||"), `dedup164[시각·잔액 없음 빈 세그먼트]: ${d}`);
  // 세그먼트 격리(교차리뷰) — 위 케이스들은 시각·잔액이 같이 변한다. 한쪽만 변해도 갈리는지 따로 확인.
  const base = { kind: "withdraw" as const, date: "2026-08-11", amount: 5000, merchant: "합성상점", cardLast4: null, time: "18:58", balance: 2218588 };
  const kBase = smsDedupKey(base);
  ok(kBase !== null && kBase !== smsDedupKey({ ...base, time: "19:10" }), "dedup164[시각만 변경 → 다른 키]");
  ok(kBase !== null && kBase !== smsDedupKey({ ...base, balance: 2213588 }), "dedup164[잔액만 변경 → 다른 키]");
}

// 설계 165 — 캐시백 결합 알림: 거래액은 캐시백이 아니라 '결제' 금액이다. (실사례 2026-08-12, 금액은 합성)
{
  const combo = "57원 캐시백 🎉 19,220원 결제 | 쿠팡전용_KCP\n잔액 5,302,828원(토스뱅크 체크카드)";
  const p = parseSms(combo, null);
  ok(p.amount === 19220, `combo165[결제액 채택]: amount=${p.amount} (기대 19220)`);
  ok(p.kind === "approve", `combo165[kind=approve]: ${p.kind}`);
  ok(cashbackComboPayAmount(combo) === 19220, "combo165[판정 함수 = 19220]");
  // 비발동 3종 — ⓐ우리은행 캐시백 '입금'(금액 1개가 곧 거래액) ⓑ부천페이 인센티브('캐시백' 단어 없음)
  // ⓒ결제+마케팅 문구(캐시백 단어 없음). 금액이 바뀌면 안 된다.
  const woori = "[Web발신] 우리 08/10 11:18 *120000 입금 3,000원 체크할인캐시백 잔액 34,829원";
  ok(cashbackComboPayAmount(woori) === null && parseSms(woori, null).amount === 3000,
    `combo165[우리은행 캐시백 입금 비발동]: amount=${parseSms(woori, null).amount}`);
  const localpay = "결제 완료 16,740원브레댄코 부천옥길점 부천페이 추가형 인센티브 1,522원 부천페이(캐릭터) 총 보유 잔액 264,750원";
  ok(parseSms(localpay, null).amount === 16740, `combo165[부천페이 인센티브 비발동]: amount=${parseSms(localpay, null).amount}`);
  const google = "8,900원 결제 완료 우리은행 ・ 구글페이먼트코리아\n결제한 돈 일부를 돌려받을 수 있어요.";
  ok(cashbackComboPayAmount(google) === null && parseSms(google, null).amount === 8900,
    `combo165[마케팅 문구 비발동]: amount=${parseSms(google, null).amount}`);
  // 교차리뷰 반영 — 순서가 반대인 혜택 안내("M원 결제 시 N원 캐시백")는 결합 알림이 아니다.
  const promo = "10,000원 결제 시 500원 캐시백 드려요";
  ok(cashbackComboPayAmount(promo) === null, "combo165[결제 시 캐시백(순서 반대) 비발동]");
  // 취소 결합("캐시백 취소 + 결제 취소")은 금액은 결제액이 맞고 kind 는 cancel — ingest 가드는 cancel 을 건너뛴다.
  const cancelCombo = "42원 캐시백 취소 21,343원 결제 취소 | 합성상점A_PG";
  const pc = parseSms(cancelCombo, null);
  ok(pc.kind === "cancel" && pc.amount === 21343, `combo165[취소 결합: kind=${pc.kind}, amount=${pc.amount}]`);
}

// 노이즈 필터 회귀 (설계 docs/household/24): 2026-06-23 삭제했던 25건 대표 + 담배 실거래 1건.
const noiseCases: { name: string; text: string; noise: boolean }[] = [
  { name: "담배 실거래(보존)", text: "[Web발신] 우리 06/23 16:34\n*120000\n출금 4,500원\nGS25홍대잔다리\n잔액 2,128원", noise: false },
  { name: "주식 하락 알림", text: "주식 가격이 5% 떨어졌어요(37,715원)", noise: true },
  // 알림 수집 노이즈 (설계 docs/household/50) — 토스증권 시세 알림·할인 광고 실사례
  { name: "주식 상승 알림(📈, 차단)", text: "PLUS 태양광&ESS 📈 주식 가격이 5% 올랐어요(39,300원)", noise: true },
  { name: "주식 상승 알림2(📈, 차단)", text: "셀바스헬스케어 📈 주식 가격이 5% 올랐어요(2,910원)", noise: true },
  { name: "할인 광고(받을 수 있어요, 차단)", text: "6,000원 할인 bhc광명사거리역점에서 받을 수 있어요.", noise: true },
  // 규칙 11(2026-07-15 개정). 포인트 '전환입금'(금액+입금+포인트→내 통장)은 실입금이라 보존,
  // 적립/소멸 안내만 차단. (설계 docs/household/50 개정이력 — 실사례 7/15 2,772원 미수집)
  { name: "토스 포인트 전환입금(보존)", text: "5,112원 입금 토스 포인트 → 내 토스뱅크 통장", noise: false },
  { name: "토스 포인트 소액 전환입금(보존)", text: "90원 입금 토스 포인트 → 내 토스뱅크 통장", noise: false },
  { name: "포인트 적립 안내(차단)", text: "출석체크 성공! 10원 포인트 적립 완료", noise: true },
  { name: "토스 포인트 소멸 안내(차단)", text: "토스 포인트 1,200P가 이번 달 말 소멸돼요", noise: true },
  { name: "정상 통장 입금은 보존", text: "[Web발신] 토스뱅크 06/30 11:52 입금 2,000,000원 바다기획 잔액 3,000,000원", noise: false },
  { name: "최저가 알림", text: "최근 1년 중 최저가를 기록했어요(499원).", noise: true },
  { name: "결제예정 안내", text: "김*늘 님 06월 29일 결제예정금액은 108,331원 입니다.", noise: true },
  { name: "광고(임플란트)", text: "[Web발신] (광고) [SKT] 플란치과병원 부평점 임플란트 이벤트 안내", noise: true },
  { name: "광고(하나은행 커피)", text: "[Web발신]\n(광고) 하나은행\n시원한 커피가 공짜", noise: true },
  { name: "카드사용알림 변경완료", text: "[Web발신] [KB국민카드]김*늘님 카드사용알림(toss_무료) 변경완료", noise: true },
  { name: "출근 보너스 알림", text: "김하늘님 출근 시간이에요. (출근길 보너스 알림)", noise: true },
  { name: "복권 알림", text: "6월 23일, 100% 당첨 복권이에요.", noise: true },
  // 혜택/쿠폰/이벤트 안내(설계 40) — "결제" 단어로 approve로 잡혀도 안내 문구로 차단
  { name: "쿠팡 혜택안내", text: "3,945원 할인! 받은 혜택을 확인해 보세요. ■ 혜택내용 - 이용처 : 쿠팡(와우 멤버십) - 이용카드 : 삼성 iD 달달할인 카드 - 결제", noise: true },
  { name: "쿠폰 안내", text: "<제목: 후기 작성 감사 쿠폰> 강의 후기를 작성해 주세요", noise: true },
  { name: "이벤트 당첨 안내", text: "축하합니다! 이벤트에 당첨되셨어요. 응모 내역을 확인하세요", noise: true },
  { name: "정상 카드승인(보존)", text: "[Web발신] 삼성카드 승인 12,345원 일시불 2026.06.21 14:30 스타벅스 1234**", noise: false },
  // "할인" 단독은 실거래 보호 — 할인 적용된 승인문자는 보존
  { name: "할인점 승인(보존)", text: "[Web발신] 우리 06/27 17:31 *120000 출금 5,600원 노브랜드할인점 잔액 20,158원", noise: false },
  // 안내성 장문(견적·유심 안내) — MMS 제목 헤더/키워드로 차단 (설계 docs/household/41)
  { name: "SKT 견적서 안내(차단)", text: "<제목: 견적서 전송 및 공유 안내> [Web발신] 안녕하세요, 고객님, T다이렉트샵입니다. 고객님의 상품 구매 내역을 안내 드립니다.", noise: true },
  { name: "SKT 유심교체 안내(차단)", text: "<제목: 유심 교체 후 구글 결제 수단 안내드립니다.> [Web발신] [SKT] 유심 교체 후 구글 결제 수단 재등록 안내", noise: true },
  { name: "간편결제는 보존", text: "카카오모빌리티에서 20,400원을 결제했어요.", noise: false },
  // 카드사 안내성 문자 — 대괄호 '안내' 머리말 + 금액없는 승인 (설계 docs/household/45)
  { name: "KB Pay 가입 안내(차단)", text: "[Web발신] [KB국민카드, 기타 안내] 김*늘 님, 「KB Pay 서비스」가 정상 제공되지 않아 안내드립니다. KB Pay 앱을 가입하시면 가맹점에서 KB Pay로 카드 결제가 가능합니다.", noise: true },
  { name: "대괄호 안내 머리말은 금액·결제어 있어도 차단(룰7)", text: "[KB국민카드, 카드신청 고객 안내] 50,000원 결제 서비스 이용 방법", noise: true },
  { name: "금액없는 승인 문구(차단)", text: "카드로 결제가 가능합니다 승인 안내", noise: true },
  { name: "정상 카드승인은 금액있어 보존", text: "[Web발신] [KB국민카드] 승인 35,000원 일시불 06/30 GS25", noise: false },
  // 카드사 월 명세서 도착 안내 — 결제일이 미래인 예고 (설계 docs/household/91)
  { name: "삼성카드 명세서 도착(차단)", text: "[삼성카드] 7월 명세서가 도착했어요. 김*늘 회원님, 결제금액 안내 드립니다. ■ 결제일 7월 26일 (7월27일 출금) ■ 결제금액 1,363,233원", noise: true },
  { name: "삼성카드 결제금액 변경 안내(차단)", text: "[삼성카드] 8월 결제금액이 변경되었어요. 김*늘 회원님, 명세서 발송 이후 변경된 결제금액을 확인해 보세요. ■ 결제일 8월 26일 ■ 결제금액 1,566,450원 □ 꼭 확인하세요 ㆍ 결제금액 변경 안내 이후 선결제, 환불 등에 따라 실제 출금액이 달라질 수 있습니다. ㆍ 앱알림을 누르면 명세서 화면으로 이동합니다.", noise: true },
  { name: "실제 카드대금 출금은 보존", text: "[Web발신] 토스뱅크 07/27 09:01 출금 1,363,233원 삼성카드 잔액 120,000원", noise: false },
  { name: "해외승인 면책문구는 보존", text: "[Web발신] 삼성카드 해외승인 65,000원 08/24 14:30 AMAZON 1234** 환율에 따라 결제금액이 변경될 수 있습니다", noise: false },
  { name: "승인 없는 해외결제 면책문구는 보존", text: "[Web발신] 토스뱅크 체크카드 해외결제 65,000원 08/24 14:30 AMAZON.COM 환율에 따라 결제금액이 변경될 수 있어요", noise: false },
  { name: "해외 출금 면책문구는 보존", text: "[Web발신] 신한체크(1234) 해외 출금 65,000원 08/24 AMAZON 결제금액이 변경될 수 있습니다", noise: false },
  { name: "부분취소 결제금액 변경은 보존", text: "[Web발신] 삼성카드 부분취소 10,000원 08/24 14:30 스타벅스 1234** 결제금액이 변경되었습니다", noise: false },
  { name: "승인취소 변경된 결제금액은 보존", text: "삼성카드 승인취소 12,000원 07/20 핫한핫도그 변경된 결제금액 8,000원", noise: false },
  { name: "승인취소 사유 결제금액 변경 안내(차단)", text: "[신한카드] 9월 결제금액이 변경되었습니다. 승인취소·선결제 반영 결제일 9월 25일 결제금액 1,200,000원", noise: true },
  { name: "최근 승인취소 내역 반영 안내(차단)", text: "[현대카드] 8월 결제금액이 변경되었습니다. 최근 승인/취소 내역이 반영되었습니다. 결제일 8월 25일 결제금액 900,000원", noise: true },
  { name: "이용대금 변경 안내(차단)", text: "[현대카드] 8월 이용대금이 변경되었습니다. 결제일 8월 25일 변경 후 이용대금 900,000원", noise: true },
  { name: "결제하실 금액 변경 안내(차단)", text: "[삼성카드] 8월 결제하실 금액이 변경되었어요. 결제일 8월 26일 결제금액 1,566,450원", noise: true },
  { name: "명세서가 발송 안내(차단)", text: "[삼성카드] 8월 명세서가 발송되었습니다. 김*늘 회원님, ■ 결제일 8월 26일 ■ 결제금액 1,566,450원", noise: true },
  { name: "결제금액 확정 안내(차단)", text: "[삼성카드] 8월 결제금액이 확정되었어요. ■ 결제일 8월 26일 ■ 결제금액 1,566,450원", noise: true },
  { name: "청구금액 변경 안내(차단)", text: "[신한카드] 8월 청구금액이 변경되었어요. 결제일 8월 25일 청구금액 1,200,000원", noise: true },
  // 카드사 결제예정 금액 안내 — "MM/DD결제금액 N원(MM/DD기준)" 미래 청구예정액 (설계 docs/household/50)
  { name: "현대카드 결제예정금액 안내(차단)", text: "[Web발신] [현대카드] 이*다님 08/03결제금액 1,625,572원(07/21기준) h7.is/결제내역확인", noise: true },
  { name: "결제금액+기준일 안내(차단)", text: "[삼성카드] 김*늘님 결제금액 500,000원 (07/25기준) 확인", noise: true },
  { name: "누적금액 있는 실승인은 보존", text: "삼성카드삼성1583승인 이*다 16,000원 일시불 07/22 16:49 (주)호텔롯데롯데 누적1,471,449원", noise: false },
  // 결제 실패/거절 — 돈이 나가지 않은 사건 (설계 docs/household/95)
  { name: "해외결제 실패(차단)", text: "195,687원  해외결제 실패 우리체크 | PLAUD LLC              SAN FRA(일시불)", noise: true },
  { name: "승인 거절(차단)", text: "[Web발신] [KB국민카드] 승인거절 35,000원 07/20 한도초과 GS25", noise: true },
  { name: "이체 실패(차단)", text: "100,000원 이체가 실패했어요. 잔액을 확인해 주세요.", noise: true },
  { name: "취소는 실거래라 보존", text: "삼성카드 승인취소 12,000원 07/20 핫한핫도그", noise: false },
  { name: "부분취소도 실거래라 보존", text: "삼성카드 부분취소 3,000원 07/20 GS25", noise: false },
  { name: "환불은 실거래라 보존", text: "[Web발신] 우리 07/20 15:41 *120000 입금 31,200원 쿠팡환불 잔액 44,000원", noise: false },
  // 부정어 형태(조사 포함) — 조사 때문에 새던 실사례 방지
  { name: "결제가 되지 않았습니다(차단)", text: "[KB국민카드] 한도초과로 결제가 되지 않았습니다 35,000원 07/20 GS25", noise: true },
  { name: "승인이 되지 않았습니다(차단)", text: "[삼성카드] 승인이 되지 않았습니다 12,000원 07/20 스타벅스", noise: true },
  { name: "출금이 되지 않았습니다(차단)", text: "잔액부족으로 출금이 되지 않았습니다 30,000원", noise: true },
  { name: "자동이체 처리되지 못했습니다(차단)", text: "잔액부족으로 자동이체가 처리되지 못했습니다 30,000원", noise: true },
  { name: "미승인(차단)", text: "[KB국민카드] 미승인 35,000원 07/20 한도초과 GS25", noise: true },
  { name: "결제는 실패하였습니다(차단)", text: "결제는 실패하였습니다 35,000원 GS25", noise: true },
  // 취소가 '실패'한 것은 원결제가 살아있음 → 환불로 오기록되면 잔액이 틀어진다
  { name: "승인취소 실패(차단)", text: "[Web발신] 승인취소 실패 12,000원 GS25", noise: true },
  // 상호명에 실패어가 들어가도 실거래는 보존(거래어와 인접하지 않음)
  { name: "불가마사우나 승인 보존", text: "삼성카드 승인 12,000원 07/20 불가마사우나", noise: false },
  { name: "환불불가 상품 승인 보존", text: "삼성카드 승인 50,000원 07/20 항공권 환불불가 상품", noise: false },
  { name: "하이패스충전 출금 보존", text: "[Web발신] 우리 07/20 출금 30,000원 하이패스충전 잔액 44,000원", noise: false },
];
for (const n of noiseCases) {
  const got = isNonTransactionalSms(n.text, parseSms(n.text, null));
  ok(got === n.noise, `noise[${n.name}]: ${got}`);
}

// 스킵 처리 방식 skipDisposition — 명백한 광고=흔적없이 버림 / 미인식=휴지통 흔적 / 정상=적재. (설계 docs/household/56)
const dispCases: { name: string; text: string; disp: "keep" | "ignore-noise" | "trace-unknown" | "ignore-trace"; cardBillDone?: boolean }[] = [
  // 명백한 광고/정보성 → ignore-noise (흔적없이 버림)
  { name: "(광고) → ignore-noise", text: "[Web발신]\n(광고) 하나은행\n시원한 커피가 공짜", disp: "ignore-noise" },
  { name: "쿠팡 혜택안내 → ignore-noise", text: "3,945원 할인! 받은 혜택을 확인해 보세요. ■ 혜택내용 - 결제", disp: "ignore-noise" },
  // 규칙 4(설계 195): N개월+금액을 할부로 읽더라도 skipDisposition 게이트에서 혜택 홍보를 먼저 버린다.
  { name: "토스 결제 혜택 실사고(할부 오수집 차단) → ignore-noise", text: "결제 혜택 지난 3개월 동안 1,500원 받을 수 있었어요.", disp: "ignore-noise" },
  { name: "토스 결제 혜택 현재형 → ignore-noise", text: "결제 혜택 이번 달 2,300원 받을 수 있어요.", disp: "ignore-noise" },
  // ★오차단 0 확인 — 실제 Toss 결제 뒤 같은 '돌려받을 수 있어요' 홍보 꼬리말이 붙어도 살아야 한다.
  { name: "토스 결제+혜택 홍보 꼬리말 → keep", text: "95,040원 결제 완료 토스페이머니 ・ KT\n결제한 돈 일부를 돌려받을 수 있어요.", disp: "keep" },
  // ★교차리뷰 2026-08-31(덱스·클로드 동시 지적): 위 KT 케이스는 '혜택' 이 없어 benefitPromo 자체가 false — 가드를 지나지 않는다.
  //   아래가 진짜 가드 검증이다. 금액이 앞에 오는 어순(한국어 알림 기본형)에서 홍보 꼬리말이 붙은 실거래가 살아야 한다.
  { name: "혜택 꼬리말+금액→출금 어순(토스뱅크 이자) → keep", text: "2,989원 출금 내 토스뱅크 통장 → 현대약대이자\n결제 혜택 5,000원 받을 수 있어요", disp: "keep" },
  { name: "혜택 꼬리말+카드 승인(이름이 사이에) → keep", text: "[Web발신]\n삼성카드 승인 김*늘\n3,000원 일시불\n08/31 12:00 스타벅스\n이 카드 혜택 3,000원 더 받을 수 있어요", disp: "keep" },
  { name: "혜택 꼬리말+포인트 전환입금(설계 136) → keep", text: "1,200원 입금 토스 포인트 → 내 토스뱅크 통장\n결제 혜택 더 받을 수 있어요", disp: "keep" },
  { name: "혜택 꼬리말+금액→결제 어순(페이스페이) → keep", text: "64,925원 결제 페이스페이 (토스뱅크) | 아구랑코다리\n결제 혜택 500원 받을 수 있어요", disp: "keep" },
  { name: "혜택 홍보에 거래어 없음(현재형·문장 뒤 안내) → ignore-noise", text: "결제 혜택 이번 달 최대 5,000원 받을 수 있어요. 지금 확인해 보세요", disp: "ignore-noise" },
  { name: "주식 시세(📈) → ignore-noise", text: "PLUS 태양광&ESS 📈 주식 가격이 5% 올랐어요(39,300원)", disp: "ignore-noise" },
  { name: "할인 광고 → ignore-noise", text: "6,000원 할인 bhc에서 받을 수 있어요", disp: "ignore-noise" },
  // 규칙 11(2026-07-15 개정): 전환입금은 keep, 적립/소멸 안내만 ignore-noise.
  { name: "토스 포인트 전환입금 → keep", text: "5,112원 입금 토스 포인트 → 내 토스뱅크 통장", disp: "keep" },
  { name: "토스 포인트 소멸 안내 → ignore-noise", text: "토스 포인트 1,200P가 이번 달 말 소멸돼요", disp: "ignore-noise" },
  // 설계 136: '포인트 {N}원 적립' — 낱말 사이에 금액이 끼는 변형 (실사례 2026-08-04, income pending 오수집)
  { name: "포인트 N원 적립(금액 낀 변형) → ignore-noise", text: "포인트 209원 적립 결제 혜택으로 209원 받았어요", disp: "ignore-noise" },
  // 규칙 12. 금액 없는 이체/입출금 — 토스 선물 알림이 transfer로 오수집되던 실사례 (2026-07-05)
  { name: "토스 선물 알림(금액없는 송금) → trace-unknown", text: "아기돼지 선물 1개 도착 송금하고 받았어요.", disp: "trace-unknown" },
  { name: "견적서 안내 → ignore-noise", text: "<제목: 견적서 전송 및 공유 안내> [Web발신] T다이렉트샵입니다.", disp: "ignore-noise" },
  // 거래 키워드 없는 미인식(광고도 아님) → trace-unknown (휴지통에 흔적)
  { name: "복권 알림 → trace-unknown", text: "6월 23일, 100% 당첨 복권이에요.", disp: "trace-unknown" },
  { name: "출근 보너스 → trace-unknown", text: "김하늘님 출근 시간이에요. (출근길 보너스 알림)", disp: "trace-unknown" },
  { name: "정체불명 알림 → trace-unknown", text: "택배가 방금 도착했습니다. 문 앞을 확인하세요.", disp: "trace-unknown" },
  // 정상 거래 → keep (수집함 pending 적재)
  { name: "정상 카드승인 → keep", text: "[Web발신] 삼성카드 승인 12,345원 일시불 2026.06.21 14:30 스타벅스 1234**", disp: "keep" },
  { name: "정상 출금 → keep", text: "[Web발신] 우리 06/27 17:31 *120000 출금 5,600원 노브랜드할인점 잔액 20,158원", disp: "keep" },
  { name: "삼성카드 결제금액 변경 안내 → ignore-noise", text: "[삼성카드] 8월 결제금액이 변경되었어요. 김*늘 회원님, 명세서 발송 이후 변경된 결제금액을 확인해 보세요. ■ 결제일 8월 26일 ■ 결제금액 1,566,450원 □ 꼭 확인하세요 ㆍ 결제금액 변경 안내 이후 선결제, 환불 등에 따라 실제 출금액이 달라질 수 있습니다. ㆍ 앱알림을 누르면 명세서 화면으로 이동합니다.", disp: "ignore-noise" },
  { name: "해외승인 면책문구 → keep", text: "[Web발신] 삼성카드 해외승인 65,000원 08/24 14:30 AMAZON 1234** 환율에 따라 결제금액이 변경될 수 있습니다", disp: "keep" },
  { name: "승인 없는 해외결제 면책문구 → keep", text: "[Web발신] 토스뱅크 체크카드 해외결제 65,000원 08/24 14:30 AMAZON.COM 환율에 따라 결제금액이 변경될 수 있어요", disp: "keep" },
  { name: "승인취소 사유 결제금액 변경 안내 → ignore-noise", text: "[신한카드] 9월 결제금액이 변경되었습니다. 승인취소·선결제 반영 결제일 9월 25일 결제금액 1,200,000원", disp: "ignore-noise" },
  { name: "명세서가 발송 → ignore-noise", text: "[삼성카드] 8월 명세서가 발송되었습니다. 김*늘 회원님, ■ 결제일 8월 26일 ■ 결제금액 1,566,450원", disp: "ignore-noise" },
  // 규칙 13. 결제 실패/거절 → ignore-noise (흔적없이 버림, 설계 docs/household/95)
  { name: "해외결제 실패 → ignore-noise", text: "195,687원  해외결제 실패 우리체크 | PLAUD LLC              SAN FRA(일시불)", disp: "ignore-noise" },
  { name: "승인 거절 → ignore-noise", text: "[Web발신] [KB국민카드] 승인거절 35,000원 07/20 한도초과 GS25", disp: "ignore-noise" },
  { name: "승인취소는 실거래 → keep", text: "삼성카드 승인취소 12,000원 07/20 핫한핫도그", disp: "keep" },
  // 규칙 3-3b. 납부요청·수납 안내 → ignore-noise (설계 docs/household/114)
  // 2026-07-30 실사례 — 학원비 청구가 '이체 350,000원' pending 으로 앉아 있었다.
  {
    name: "학원비 납부요청(제목어) → ignore-noise",
    text: "⁨02-2138-****⁩<제목: 납부요청> [Web발신] 안녕하세요 목동수학입니다. 한별학생의 8월 수업료는 350,000원입니다./납부기간은 8월1일~5일 입니다. 기한내에 납부 부탁드립니다^^ / 납부계좌) 우리은행 김다영 1005-804-***494",
    disp: "ignore-noise",
  },
  {
    name: "납부기간+납부부탁 본문(제목 없음) → ignore-noise",
    text: "[Web발신] 8월 회비는 50,000원입니다. 납부기간은 8월 1일~10일이며 기한내에 납부 부탁드립니다.",
    disp: "ignore-noise",
  },
  // 규칙 11-1. 페이스페이 적립(포인트 환급) → ignore-noise (설계 133, 팀장 확인 2026-08-04)
  // 포인트로만 쌓이고 통장 잔액은 안 는다. 실제 입금은 토스에서 '환전'할 때 따로 온다.
  {
    name: "페이스페이 적립 → ignore-noise",
    text: "4,547원 적립 페이스페이 결제하고 최대 7% 받았어요",
    disp: "ignore-noise",
  },
  // ★오차단 0 확인 — 페이스페이 **결제**는 진짜 출금이라 반드시 살아야 한다.
  {
    name: "페이스페이 결제 → keep",
    text: "64,925원 결제 페이스페이 (토스뱅크) | 아구랑코다리",
    disp: "keep",
  },
  // ★환전(포인트 → 통장) 입금도 살아야 한다 — 이게 실제로 잔액이 느는 순간이다.
  {
    name: "포인트 전환입금 → keep",
    text: "4,547원 입금 토스 포인트 → 내 토스뱅크 통장",
    disp: "keep",
  },
  // 오차단 0 확인 — '납부'가 들어간 **완료된** 출금은 그대로 살아야 한다.
  {
    name: "요금납부 완료 출금 → keep",
    text: "요금납부 406,520원 출금 내 토스뱅크 통장 → 07월 옥길데시앙 406동2302호",
    disp: "keep",
  },
  // 규칙 3-5. 휴대폰 소액결제 '한도/누적 이용 금액 안내' → ignore-noise (설계 149, 실원문 2026-08-04)
  // 한도액 1,000,000원이 결제금액으로 오파싱돼 pending 에 앉았던 건.
  {
    name: "SKT 휴대폰결제 한도안내 → ignore-noise",
    text: "⁨114⁩<제목: [SKT] 휴대폰 결제 누적 이용 금액 안내> [Web발신] 010****0000 고객님, 안녕하세요. 8월 휴대폰 결제를 10만 원 이상 사용하셨습니다. ■ 이번 달 이용 금액 - 한도 금액: 1,000,000원 - 누적 이용 금액: 112,546원 - 남은 한도 금액: 887,454원 ※ 이용 금액을 미리 납부하신 경우, 그 금액만큼 남은 한도 금액이 늘어납니다.",
    disp: "ignore-noise",
  },
  // 설계 196: 결제 영수증은 이제 휴지통으로 보내되 흔적은 반드시 남긴다(ignore-noise 금지).
  //   한도 안내인 규칙 3-5로 떨어지지 않고 ignore-trace가 되어야 한다.
  {
    name: "휴대폰소액결제 영수증(컬리) → ignore-trace (설계 196)",
    text: mobilePaymentReceipt196,
    disp: "ignore-trace",
  },
  // 규칙 3-6. 모바일 교환권 발송 안내 → ignore-noise (설계 149, 실원문 2026-08-04)
  // 본문 유의사항의 "타월(샤워) 1,500원"이 결제금액으로, 이용기한이 거래일로 오파싱됐던 건.
  {
    name: "오션월드 모바일 교환권 안내 → ignore-noise",
    text: "⁨1661-1063⁩ <제목: (골드시즌)비발디파크 오션월드 종일권+구명조끼> [Web발신] ▣상품명 : (골드시즌)비발디파크 오션월드 종일권+구명조끼 ▣매수: 1 ▣구매자: 김하늘 ▣이용기간: 구매 후 익일 ~ 2026년 8월 30일 ▶모바일입장권[클릭] [이용 방법] ①모바일 티켓(바코드) 수령 ②이용 당일, 오션월드 야외게이트에서 바코드 제시 후 입장 [유의사항] -모바일 티켓(바코드) 미지참 시 입장이 불가합니다. ※ 현장 대여료(1장) : 타월(샤워) 1,500원 [환불 규정] -미사용시 100% 환불가능",
    disp: "ignore-noise",
  },
  // ★오차단 0 확인 — 카드 승인 문자의 '이용가능금액'(공백 0개)에 3-5 가 걸리면 안 된다.
  //   `이용\s*가능\s*금액` 만으로 판정하면 멀쩡한 승인이 조용히 죽는다 → 휴대폰/소액 결제 문맥을 함께 요구.
  {
    name: "카드승인 + 이용가능금액 → keep (3-5 오차단 방지)",
    text: "[Web발신] 국민카드 승인 12,000원 일시불 2026.08.04 GS25옥길점 이용가능금액 1,500,000원",
    disp: "keep",
  },
  // 설계 196: 조사 없는 "결제 완료" 형식도 휴지통 흔적을 남겨야 한다(ignore-noise·규칙 3-5 낙하 금지).
  {
    name: "휴대폰결제 '결제 완료' 형식 영수증 → ignore-trace (설계 196)",
    text: "[Web발신] 휴대폰 결제 완료 35,000원 컬리 이용 가능 금액 965,000원",
    disp: "ignore-trace",
  },
  // ★교차리뷰(Codex) 반례 — 교환권 낱말이 든 **진짜 카드승인**은 살아야 한다(거래신호 배제).
  {
    name: "모바일 상품권 든 카드승인 → keep (3-6 오차단 방지)",
    text: "[Web발신] 신한카드 승인 50,000원 일시불 08/04 12:34 모바일 상품권 사용 기한 2027.08.04",
    disp: "keep",
  },
  // 설계 196: 발신번호가 없어도 규칙 5로 떨어뜨리지 말고 휴지통 흔적을 남긴다(ignore-noise 금지).
  {
    name: "발신번호 없는 휴대폰결제 영수증 → ignore-trace (설계 196) (규칙 5 예외)",
    text: "<제목: 휴대폰 결제 성공 안내> [Web발신] 휴대폰 결제가 완료되었습니다. 요청 사이트: 컬리 요청 금액: 35,000원 이용 가능 금액: 965,000원",
    disp: "ignore-trace",
  },
  {
    name: "휴대폰결제 취소 문자 → ignore-trace (교차리뷰 M2 — 원 결제가 휴지통인데 취소만 pending 이면 유령 환불)",
    text: "⁨114⁩ <제목: 휴대폰 결제 취소 안내> [Web발신] [효성FMS/SKT] 휴대폰 결제가 취소되었습니다. - 요청 일시: 2026년 9월 2일 10:00:00 - 요청 사이트: (주)블루앤[1522-4655] - 요청 금액: 1,100 - 결제 대행사: 효성FMS[1544-5163]",
    disp: "ignore-trace",
  },
  {
    name: "영수증 안 '승인번호' 는 거래신호가 아니다 → ignore-trace (덱스 교차리뷰 M1)",
    text: "⁨114⁩ <제목: 휴대폰 결제 성공 안내> [Web발신] [KG모빌리언스/SKT] 휴대폰 결제가 완료되었습니다. - 요청 사이트: 컬리 - 요청 금액: 1,100원 - 승인번호: 123456 - 결제 대행사: KG모빌리언스",
    disp: "ignore-trace",
  },
  {
    name: "휴대폰결제 문구 든 은행 출금 → keep (196 오차단 방지)",
    text: "[Web발신] 우리은행 09/01 12:00 출금 35,000원 휴대폰결제 완료 잔액 1,234,567원",
    disp: "keep",
  },
  {
    name: "2026-09-01 효성FMS/SKT 휴대폰소액결제 영수증 → ignore-trace (설계 196)",
    text: "⁨114⁩ <제목: 휴대폰 결제 성공 안내> [Web발신] [효성FMS/SKT] 휴대폰 결제가 완료되었습니다. - 요청 일시: 2026년 9월 1일 17:48:43 - 요청 사이트: (주)블루앤[1522-4655] - 요청 금액: 1,100 - 결제 대행사: 효성FMS[1544-5163] ■ [이번 달] 이용 내역 안내 - 이용 가능 금액: [500,000]원",
    disp: "ignore-trace",
  },
  // ── 설계 198 — 증권 보유수량 변경 안내(액면분할·병합·무상증자)는 거래가 아니다 ──────────────
  //   실사고(2026-09-02 pending): 수량 `4,078주`를 금액으로, `입금일`의 '입금'을 거래로 읽어 입금 4,078원으로 수집됐다.
  //   ★이 원문에 '입금'이 들어 있다는 것이 핵심이다 — 넓은 txnSignal 을 가드로 쓰면 규칙이 죽는 걸 이 케이스가 고정한다.
  {
    name: "토스증권 액면분할 보유수량 변경 안내 → ignore-trace (설계 198 실사고)",
    text: "미스터블루 액면분할 보유한 주식 수가 4,078주 → 815.60주로 변경되었어요. 0.60주는 입금일에 맞춰 현금으로 드려요.",
    disp: "ignore-trace",
  },
  {
    name: "주식병합 보유수량 변경 안내 → ignore-trace (설계 198)",
    text: "삼성전자 주식병합 보유한 주식 수가 100주 → 20주로 변경되었어요.",
    disp: "ignore-trace",
  },
  {
    name: "무상증자 보유수량 변경 안내 → ignore-trace (설계 198)",
    text: "카카오 무상증자로 보유한 주식 수가 10주 → 15주로 변경되었어요. 입금일에 맞춰 반영돼요.",
    disp: "ignore-trace",
  },
  // ★★가드(`!amountTxnSignal`)를 **실제로 무는** 케이스 — 아래 2건은 `shareCountNotice` 가 참인데도 keep 이어야 한다.
  //   교차리뷰(2026-09-02)가 잡은 실제 오차단이다: 처음 가드는 동사→금액 어순만 봐서 `1,830원이 입금됐어요` 를 놓쳤고,
  //   진짜 입금이 흔적 없이 사라졌다(설계 195 와 같은 형태). 이 2건을 지우면 가드를 삭제해도 스위트가 통과해 버린다.
  {
    name: "★단주대금 입금 + 수량변경이 한 문자로 올 때 → keep (설계 198 가드가 실제로 무는 케이스)",
    text: "미스터블루 액면분할 단주대금 1,830원이 입금됐어요. 보유한 주식 수가 4,078주 → 815주로 변경됐어요.",
    disp: "keep",
  },
  {
    name: "★배당 입금 + 수량변경이 한 문자로 올 때 → keep (설계 198 가드가 실제로 무는 케이스)",
    text: "아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요. 보유 수량이 변경됐어요. 무상증자 반영분이에요.",
    disp: "keep",
  },
  // ★★배포 전 교차리뷰 Medium(2026-09-02) — 가드의 조사·동사 목록이 좁아 증권·은행 정식 문투가 휴지통으로 갔다.
  //   `원을`(조사 `을`)·`송금`·`납부` 가 빠져 있었다. 조사 목록은 규칙 13 의 JOSA 를 끌어올려 공유한다.
  {
    name: "★단주대금 '3,200원을 입금하였습니다' + 수량변경 → keep (가드 조사 '을')",
    text: "[미래에셋] 무상증자 단주대금 3,200원을 입금하였습니다. 보유 수량이 변경되었습니다.",
    disp: "keep",
  },
  {
    name: "★배당금 '45,000원 송금' + 수량변경 → keep (가드 동사 '송금')",
    text: "[KB증권] 주식배당 현금 45,000원 송금 보유한 주식 수가 변경됨",
    disp: "keep",
  },
  // ★2차 리뷰 뒤 가드를 '원 단위 금액이 하나라도 있는가'로 바꿔 아래 두 형태까지 닫았다.
  //   동사·조사 목록을 넓히는 방식으로는 끝내 못 잡던 것들이다(동사와 금액 사이에 글자가 끼거나, 카드 승인 어순).
  {
    name: "★'출금액: 1,000,000원'처럼 동사와 금액 사이에 글자가 껴도 → keep",
    text: "[신한투자증권] 유상증자 청약대금 출금액: 1,000,000원 보유 주식 수가 변경됩니다.",
    disp: "keep",
  },
  {
    name: "★카드 승인 어순('승인 이*다 26,400원')에 기업행위 문구가 붙어도 → keep",
    text: "삼성카드 승인 이*다 26,400원 일시불 주식배당 보유 주식 수가 변경",
    disp: "keep",
  },
  // ★규칙 4(설계 195 혜택 홍보)와 amountTxnSignal 을 공유하므로, 규칙 4 쪽 델타도 함께 못박는다.
  //   이 정규식을 9-b 사정으로 되돌리면 규칙 4 가 조용히 다시 조여진다(교차리뷰 Low).
  {
    name: "실결제 + 혜택 홍보 꼬리 → keep (규칙 4, amountTxnSignal 금액 선행 어순)",
    text: "혜택으로 3,000원이 결제됐어요. 더 받을 수 있어요",
    disp: "keep",
  },
  // ★규칙이 너무 넓지 않은지 — 액면분할·증자 표식이 없는 증권 알림은 이 규칙에 걸리면 안 된다(교차리뷰 Medium 실측 3형).
  {
    name: "주식 수수료 변경 안내 → 규칙 9-b 에 안 걸림 (설계 198 과확장 방지)",
    text: "[신한투자증권] 주식 수수료가 변경됩니다. 자세한 내용은 앱에서 확인해 주세요.",
    // 9-b 가 잡았다면 ignore-trace 였을 것이다. trace-unknown 이라는 것이 곧 "9-b 에 안 걸렸다"의 증거다.
    disp: "trace-unknown",
  },
  {
    name: "매도체결 + 보유수량 변경 → 규칙 9-b 에 안 걸림 (설계 198 과확장 방지)",
    text: "[신한투자증권] 매도체결 삼성전자 10주 70,000원 보유수량 변경",
    disp: "trace-unknown",
  },
  // ★오차단 0 확인 — 증권 배당 입금(설계 190 §1 실관측 원문)은 그대로 살아야 한다.
  {
    name: "토스증권 배당 입금(실관측 원문) → keep (설계 190 §1, 설계 198 오차단 방지)",
    text: "아이스크림미디어 배당금 입금🎉 토스증권 계좌로 93,466원이 입금됐어요.",
    disp: "keep",
  },
  // ★교차리뷰(Codex) 반례 — '요청 사이트'만 있는 **한도 상향 안내**는 영수증 행세를 못 해야 한다.
  //   그래서 영수증 판별에서 '요청 사이트'를 빼고 돈이 적힌 '요청 금액'·완료 문구만 믿는다.
  {
    name: "한도 상향 안내(요청 사이트만) → ignore-noise",
    text: "⁨114⁩<제목: 휴대폰 결제 한도 상향 안내> [Web발신] 한도 금액 1,000,000원, 한도 상향 요청 사이트: T world",
    disp: "ignore-noise",
  },
  // ★오차단 0 확인 — 그 티켓의 **실제 결제**(토스페이 알림)는 살아야 한다. 이게 장부에 남을 거래다.
  {
    name: "놀유니버스 토스페이 결제 → keep",
    text: "166,098원 결제 완료 토스페이머니 ・ 놀유니버스 결제한 돈 일부를 돌려받을 수 있어요.",
    disp: "keep",
  },
  // ★오차단 0 확인 — '이용기간'이 든 상품권형 **승인 문자**는 살아야 한다(교환권 표식이 없으므로 통과).
  {
    name: "이용기간 문구 든 카드승인 → keep",
    text: "[Web발신] 삼성카드 승인 74,000원 일시불 2026.08.04 놀유니버스 1234** 이용기간 3개월",
    disp: "keep",
  },
  // 무통장입금 안내(설계 171) — 앞으로 **낼** 돈 안내지 완료 거래가 아니다. 실사례 2026-08-13.
  //   '무통장 입금'의 '입금'이 kindOf 에 걸려 income/deposit 으로 **방향이 뒤집혔었다.**
  {
    name: "무통장입금 안내(주문접수) → ignore-noise",
    text: "<제목: 사평기정떡 무통장입금 안내> [Web발신] 주문이 접수 되었습니다. 주문 번호: #92864 ★무통장 입금 안내★ 농협 000-0000-0000-00 예금주: (주)사평기정떡 결제금액: 36,800원 감사합니다 ^_^",
    disp: "ignore-noise",
  },
  // ★★오차단 0 확인 — '입금 안내'로 거르면 이게 죽는다. 카드론 **실행금 입금**은 진짜 거래다
  //   (수집함 전수 검사에서 확정된 15,000,000원 건). '무통장'·'예금주'가 없어 통과해야 한다.
  {
    // ★발신번호 없이 제목으로 바로 시작하는 카드론 안내 — 규칙 5(^<제목:…안내…>)에 죽으면 안 된다(배포 전 교차리뷰 High)
    name: "카드론 안내가 <제목:…입금안내> 로 바로 시작해도 keep",
    text: "<제목: 장기카드대출입금안내> [Web발신] KB국민카드 장기카드대출을 이용해주셔서 감사합니다. ■ 신청내역 대출금액 : 1,500만원 대출기간 : 18개월 적용이자율 : 18.10% 상환방식 : 원금균등상환 대출취급일 : 2026-08-02",
    disp: "keep",
  },
  {
    // 대괄호 머리말에 '안내'가 들어 있는 카드론 승인 안내(규칙 7) 도 keep
    name: "카드론 [승인 완료 안내] 대괄호 머리말이어도 keep",
    text: "[삼성카드 장기카드대출 승인 완료 안내] 장기카드대출(카드론) 13,700,000원이 2026.08.11 승인되었습니다. - 이용금액 : 13,700,000원 - 이자율 : 연 12.20%",
    disp: "keep",
  },
  {
    name: "카드론 실행금 입금안내 → keep (무통장·예금주 없음)",
    text: "⁨1588-1688⁩<제목: 장기카드대출입금안내> [Web발신] 이*다고객님, KB국민카드 장기카드대출 15,000,000원 입금되었습니다.",
    disp: "keep",
  },
  { name: "KB 카드론 조건 안내문 → keep", text: kbCardLoanText, disp: "keep" },
  { name: "삼성 카드론 조건 안내문 → keep", text: samsungCardLoanText, disp: "keep" },
  // 설계 204 — 네이버 멤버십 '이용료 결제' 안내는 KB국민카드 승인 문자의 두 번째 통지. 실원문 2026-09-05 두 형(발신번호 접두 유무).
  //   ★ignore-noise 가 아니라 ignore-trace — 카드 문자가 안 온 달엔 휴지통에서 복원해야 한다.
  {
    name: "네이버 멤버십 이용료 안내 → ignore-trace (설계 204)",
    text: "[Web발신]\n[네이버 멤버십] 멤버십 이용료 4,900원 결제",
    disp: "ignore-trace",
  },
  {
    name: "네이버 멤버십 이용료 안내(발신번호 접두) → ignore-trace (설계 204)",
    text: "⁨1599-1399⁩[Web발신]\n[네이버 멤버십] 멤버십 이용료 4,900원 결제",
    disp: "ignore-trace",
  },
  {
    // 같은 결제의 진짜 승인 문자 — 상호에 '네이버플러스 멤버십'이 있어도 머리말이 없으니 살아야 한다.
    name: "KB국민카드 네이버플러스 멤버십 승인 → keep (설계 204 실거래 보호)",
    text: "KB국민카드KB국민카드9012승인\n이*다님\n4,900원 일시불\n09/05 10:17\n네이버플러스 멤버십\n누적843,470원",
    disp: "keep",
  },
  {
    // 덱스 교차리뷰 M(2026-09-05): 카드 문자가 안내 문구를 인용해 붙는 꼴 — 거래신호(승인)가 있으면 규칙 3-5c 가 발동하면 안 된다.
    name: "승인 신호 + 네이버 멤버십 머리말 인용 → keep (설계 204 거래신호 가드)",
    text: "[KB국민카드] 승인 4,900원 [네이버 멤버십] 멤버십 이용료 4,900원 결제",
    disp: "keep",
  },
  {
    // 배포 전 교차리뷰 High(덱스, 2026-09-05): 카드사 머리말 뒤에 인용된 꼴 — '승인' 낱말이 없어도 머리말이 맨 앞이 아니면 규칙 3-5c 가 안 건다.
    name: "카드사 머리말 + 네이버 멤버십 인용(승인 낱말 없음) → keep (설계 204 머리말 위치 고정)",
    text: "[KB국민카드] [네이버 멤버십] 멤버십 이용료 1,000원 결제",
    disp: "keep",
  },
  {
    // 배포 전 교차리뷰 High(클로드, 2026-09-05): '결제 실패' 안내는 규칙 13(실패·거절)이 종전대로 흔적 없이 버려야 한다 —
    //   3-5c 가 가로채면 금액 4,900·approve 를 실은 '복원 가능한 거래'가 휴지통에 앉고, 실패한 달엔 카드 승인 문자도 없어 가장 복원되기 쉽다.
    name: "네이버 멤버십 이용료 결제 실패 안내 → ignore-noise (규칙 13 유지, 3-5c 가로채기 금지)",
    text: "[Web발신]\n[네이버 멤버십] 멤버십 이용료 4,900원 결제 실패. 결제수단을 확인해주세요",
    disp: "ignore-noise",
  },
  {
    // 덱스 교차리뷰 L: 금액 없는 '이용료 변경 안내'는 거래 흔적(ignore-trace)이 아니다 — 3-5c 를 지나 금액 없음 규칙으로 미인식(trace-unknown) 처리.
    name: "네이버 멤버십 이용료 변경 안내(금액 없음) → trace-unknown, ignore-trace 아님 (설계 204)",
    text: "[Web발신]\n[네이버 멤버십] 멤버십 이용료 변경 안내",
    disp: "trace-unknown",
  },
  // 설계 205 — 카드사 '결제금액 … 출금완료' 사후 안내는 은행 출금 문자의 두 번째 통지. 실원문 2026-09-11(삼성카드 1,503,040).
  //   ★ignore-noise 가 아니라 ignore-trace — 은행 문자가 안 온 달엔 휴지통에서 복원해야 한다.
  //   ★keep·ignore-noise 기대값은 전부 규칙 추가 **전** 코드(3e8a1dc)의 실제 결과다 — diag_design205_probe_20260911 이 옛 코드와 나란히 찍는다.
  //   ★가드 케이스는 **그 가드가 없으면 발동하는 문자**로만 고른다(교차리뷰 M1: 본문 꼴부터 안 맞는 문자는 가드를 지워도 통과해 아무것도 고정하지 못했다).
  {
    name: "삼성카드 결제금액 출금완료 안내(실원문) → ignore-trace (설계 205)",
    text: cardBillDoneRealText,
    disp: "ignore-trace",
    cardBillDone: true,
  },
  {
    name: "카드사 출금완료 안내(발신자명 접두 없음) → ignore-trace (설계 205)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "ignore-trace",
  },
  {
    name: "카드사 출금완료 안내([Web발신] 뒤 발신자명) → ignore-trace (설계 205, 교차리뷰 L4)",
    text: "[Web발신]\n삼성카드[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "ignore-trace",
  },
  {
    name: "카드사 출금완료 안내('원이 … 출금완료되었습니다') → ignore-trace (설계 205, 교차리뷰 L4)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원이 09/10출금완료되었습니다",
    disp: "ignore-trace",
  },
  {
    // ⚠️합성 픽스처 — 현대카드 실원문이 아니다. 머리말 일반화([…카드])만 확인한다. 현대카드 사후 안내가 실제로 이 꼴인지는 모른다.
    name: "카드사 머리말 일반화(합성, [Web발신]·현대카드) → ignore-trace (설계 205)",
    text: "[Web발신]\n[현대카드] 이*다님 08월 결제금액 1,625,572원 08/03출금완료",
    disp: "ignore-trace",
  },
  // — 실거래 보호: 보호의 본체는 본문 꼴이다(머리말은 승인·카드론 문자에도 있다, 교차리뷰 M3).
  {
    name: "짝 은행 출금 문자(삼성카드 FBS출금) → keep (설계 205 실거래 보호)",
    text: "출금 1,503,040원이*다님 09/10 19:45 110-11-0***-111  삼성카드 FBS출금 1,503,040 잔액431,260",
    disp: "keep",
  },
  {
    name: "삼성카드 승인 문자 → keep (설계 205 실거래 보호)",
    text: "삼성카드삼성1583승인 이*다 21,300원 일시불 09/11 10:55 늘봄약국 누적435,840원",
    disp: "keep",
  },
  {
    name: "[…카드] 머리말이 맨 앞인 승인 문자 → keep (설계 205, 머리말만으론 못 지킨다 — 교차리뷰 M3)",
    text: "[Web발신] [KB국민카드] 승인 35,000원 일시불 09/11 10:55 스타벅스",
    disp: "keep",
  },
  {
    name: "은행 문자 뒤에 카드사 머리말 인용([Web발신]) → keep (설계 205 머리말 앞 거래어 가드)",
    text: "[Web발신] 우리 09/10 출금 [삼성카드] 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
  },
  {
    // 교차리뷰 L3: 옛 앵커는 대괄호 없는 20자 토막이면 무엇이든 받아 '우리 09/10 출금 ' 을 발신자명으로 봤다 → 토막에 거래어가 있으면 발동 금지.
    name: "은행 문자 뒤에 카드사 머리말 인용(접두 없음) → keep (설계 205 머리말 앞 거래어 가드)",
    text: "우리 09/10 출금 [삼성카드] 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
  },
  // — 발동 금지: 부분 출금. 청구액 전액이 빠졌다고 확신할 수 없으면 사람이 본다(교차리뷰 R1-M2).
  {
    name: "출금완료 뒤에 또 금액('나머지 503,040원') → keep (설계 205 뒤따르는 금액 가드)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 나머지 503,040원",
    disp: "keep",
  },
  {
    name: "출금완료 + '미결제 503,040원' → keep (설계 205 부분 출금)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 미결제 503,040원",
    disp: "keep",
  },
  {
    name: "'결제금액 N원 중 M원 출금완료' → keep (설계 205 본문 인접 꼴만)",
    text: "삼성카드[삼성카드]이*다님 09월 결제금액 1,503,040원 중 1,000,000원 09/10출금완료",
    disp: "keep",
  },
  // — 후속 C: 실패어는 한 단어당 한 케이스. 모두 본문 꼴·머리말 인접을 만족하고 뒤따르는 금액은 없다.
  //   각 단어를 실패어 정규식에서 하나씩 빼면 그 케이스 하나만 ignore-trace 로 뒤집혀야 한다.
  ...[
    "실패", "부족", "미출금", "미납", "미결제", "잔여", "거절", "거부", "연체", "불가",
    "되지 않았습니다", "못 했습니다", "안됐습니다", "취소", "일부", "부분",
  ].map((word) => ({
    name: `카드대금 출금완료 + 실패어 '${word}' → keep (설계 205-C)`,
    text: `[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 ${word}`,
    disp: "keep" as const,
    cardBillDone: false,
  })),
  // — 후속 C 교차리뷰: 머리말-본문 사이 거래어를 하나씩 제거하면 해당 케이스가 발동해야 한다.
  //   취소는 실패어 가드에도 있어 인접 가드만 제거해도 안전하며, 여기서는 ignore-trace 아님을 고정한다.
  ...["승인", "취소", "출금", "입금", "이체", "송금"].map((word) => ({
    name: `머리말-본문 사이 거래어 '${word}'(사이 금액 없음) → ignore-trace 아님 (설계 205-C)`,
    text: `[삼성카드] ${word} 합성상점 09월 결제금액 1,503,040원 09/10출금완료`,
    disp: "keep" as const,
    cardBillDone: false,
  })),
  // — 후속 C: 머리말-본문 사이에 다른 거래나 다른 금액이 끼면 카드대금 사후 안내로 보지 않는다.
  {
    name: "두 카드 문자가 한 원문으로 합쳐진 승인+출금완료 → keep (설계 205-C 인접 가드)",
    text: "[A카드] 승인 10,000원 일시불 09/11 합성상점\n[B카드] 9월 결제금액 20,000원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "결제 문자 뒤 카드대금 안내 인용 → keep (설계 205-C 머리말 앞 결제 가드)",
    text: "KB 09/10 결제 [삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "카드대금 출금완료 + 실패어 '안 되었습니다' → keep (설계 205-C 안 되 가드)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 안 되었습니다",
    disp: "keep",
    cardBillDone: false,
  },
  {
    // ★'못했습니다' 는 '못 했' 갈래에도 걸려 '되지 못' 갈래를 못 고정한다(ship 교차리뷰 Claude L3) — '못하였습니다' 로.
    name: "카드대금 출금완료 + 실패어 '되지 못하였습니다' → keep (설계 205-C 되지 못 가드)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료 되지 못하였습니다",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "청구금액 일부만 출금완료 → keep (설계 205-C 인접 금액 가드)",
    text: "[삼성카드]이*다님 청구금액 1,503,040원 중 09월 결제금액 1,000,000원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "승인 문자 뒤 카드대금 안내가 붙은 원문 → keep (설계 205-C 인접 거래어 가드)",
    text: "[삼성카드] 승인 이*다 21,300원 일시불 09/11 합성상점 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "자동이체 문자 뒤 카드대금 안내 인용 → keep (설계 205-C 머리말 앞 가드)",
    text: "우리 09/10 자동이체 [삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  {
    name: "송금 문자 뒤 카드대금 안내 인용 → keep (설계 205-C 머리말 앞 가드)",
    text: "KB 09/10 송금 [삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금완료",
    disp: "keep",
    cardBillDone: false,
  },
  // — 본문 꼴부터 안 맞아 3-5d 에 닿지 않는 문자: 종전 판정 그대로임을 고정한다(가드 검증용이 아니다).
  {
    name: "카드사 출금실패 안내 → ignore-noise (본문 꼴 불일치, 종전 규칙 13 그대로)",
    text: "삼성카드[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10출금실패 잔액부족",
    disp: "ignore-noise",
  },
  {
    name: "카드사 미출금 안내 → keep (본문 꼴 불일치, 종전 판정 그대로)",
    text: "[삼성카드]이*다님 09월 결제금액 1,503,040원 09/10 미출금",
    disp: "keep",
  },
];
// 재검증 M3: 'YYYY년 M월 D일' 은 연도를 믿는다 — 오늘보다 미래여도 작년으로 밀지 않는다(취소 영수증 2026년 9월 2일 → 2025-09-02 로 앉던 것).
{
  const futureDated = parseSms("[효성FMS/SKT] 휴대폰 결제가 취소되었습니다. - 요청 일시: 2999년 12월 31일 10:00:00 - 요청 금액: 1,100", null);
  ok(futureDated.occurredAt === "2999-12-31", `연도 명시 날짜 그대로: ${futureDated.occurredAt}`);
  const noYear = parseSms("[Web발신] 국민카드 승인 12,000원 12월 31일 GS25", null);
  ok(noYear.occurredAt != null && noYear.occurredAt < sms.seoulToday(), `연도 없는 미래 날짜는 작년 보정 유지: ${noYear.occurredAt}`);
}
for (const c of dispCases) {
  const got = skipDisposition(c.text, parseSms(c.text, null));
  const cardBillDoneMatches = c.cardBillDone === undefined || isCardBillDoneNotice(c.text) === c.cardBillDone;
  ok(got === c.disp && cardBillDoneMatches, `disp[${c.name}]: ${got}, cardBillDone=${isCardBillDoneNotice(c.text)}`);
}

// 설계 205-B: ignore-trace 중 카드대금 사후 안내만 payment, 기존 196 휴대폰 소액결제는 expense 유지.
ok(ignoreTraceGuessedType(cardBillDoneRealText) === "payment", "ignoreTraceGuessedType[카드대금 출금완료=payment]");
ok(ignoreTraceGuessedType(mobilePaymentReceipt196) === "expense", "ignoreTraceGuessedType[설계 196 휴대폰 소액결제=expense]");

// skipDedupKey — 같은 원문+날짜는 같은 키(반복 억제), 날짜 다르면 다른 키.
{
  const t = "택배가 방금 도착했습니다. 문 앞을 확인하세요.";
  ok(skipDedupKey(t, "2026-07-03") === skipDedupKey(t, "2026-07-03"), "skipDedup[동일 원문·날짜=같은 키]");
  ok(skipDedupKey(t, "2026-07-03") !== skipDedupKey(t, "2026-07-04"), "skipDedup[날짜 다르면 다른 키]");
  ok(skipDedupKey(t, "2026-07-03").startsWith("skip|"), "skipDedup[skip| 접두]");
}

// 계좌 끝자리 추출 회귀 (설계 docs/household/25)
const tailCases: { name: string; text: string; tail: string | null }[] = [
  { name: "우리은행 출금(*120000)", text: "[Web발신] 우리 06/23 16:34\n*120000\n출금 4,500원\nGS25홍대잔다리\n잔액 2,128원", tail: "0000" },
  { name: "카드 일시불(계좌없음)", text: "[Web발신] 삼성카드 승인 12,345원 일시불 스타벅스 1234**", tail: null },
  { name: "카드 끝4(**1234)는 계좌로 안 봄", text: "신한카드 승인 5,000원 **1234 메가커피", tail: null },
  // 설계 160: 하나은행은 마스킹 뒤에 **하이픈**이 온다(`100-******-12345`). 예전 정규식은 `*` 바로 뒤
  // 숫자만 받아 끝4를 못 뽑았고, 앞자리 폴백도 `133`(3자리)뿐이라 버려져 **계좌가 안 붙었다**.
  // 국민은행 형식은 앞자리가 6자리라 폴백으로 붙어서 이 결함이 안 드러났다. 실사례 2026-08-10 원문.
  {
    name: "하나은행 마스킹 뒤 하이픈(합성 계좌번호)",
    text: "(구)하나은행 출금 388,748원 하나저축은행 잔액 61,252원 08/10 04:44 100-******-12345",
    tail: "2345",
  },
  // 하이픈을 허용해도 4자리 이하는 여전히 계좌로 보지 않는다(카드 끝4 오인 방지).
  // ⚠️합성 계좌번호를 쓴다 — 실번호를 넣으면 교차리뷰 에이전트가 PII 로 보고 리뷰를 중단한다(2026-08-09).
  { name: "하이픈 뒤 3자리는 계좌 아님", text: "홍*동님 100-11-0***-999 체크카드출금 5,600", tail: null },
];
for (const c of tailCases) {
  const got = parseSms(c.text, null).accountTail;
  ok(got === c.tail, `tail[${c.name}]: ${got}`);
}

// 설계 160: 은행 출금 문자의 상대처가 **금융기관 이름**이면 노이즈 제거가 통째로 지워 버린다.
//   실사례 2026-08-10: `(구)하나은행 출금 388,748원 하나저축은행 잔액 61,252원 …` → 상호 `(구)`.
//   상호가 부스러기라 대출·정기지출 매칭이 전부 실패해 카테고리·대출연결이 빈 채로 들어왔다.
//   (설계 105 가 토스 화살표 형식에 대해 같은 문제를 이미 풀었다 — 은행 출금 형식에도 같은 원칙.)
//   ★상대처가 기관꼴일 때만 발동한다 — 사람 이름 등 기존 정상 케이스를 건드리면 안 된다.
const payeeCases: { name: string; text: string; merchant: string | null }[] = [
  {
    name: "은행 출금 상대처가 저축은행",
    text: "(구)하나은행 출금 388,748원 하나저축은행 잔액 61,252원 08/10 04:44 100-******-12345",
    merchant: "하나저축은행",
  },
  {
    name: "상대처가 사람 이름이면 종전대로",
    text: "(구)하나은행 출금 100,000원 홍길동 잔액 61,252원 08/10 04:44 100-******-12345",
    merchant: "홍길동",
  },
  {
    name: "상대처가 캐피탈",
    text: "(구)하나은행 출금 212,337원 롯데캐피탈 잔액 61,252원 08/10 04:44 100-******-12345",
    merchant: "롯데캐피탈",
  },
];
for (const c of payeeCases) {
  const got = parseSms(c.text, null).merchant;
  ok(got === c.merchant, `payee[${c.name}]: ${got}`);
}

// 마스킹 계좌 앞자리 추출 회귀 (설계 docs/household/34)
const prefixCases: { name: string; text: string; prefix: string | null }[] = [
  { name: "끝자리까지 마스킹(110-11-0***-111)", text: "이*다님 06/25 10:56 110-11-0***-111  산들소아청소 체크카드출금 5,600 잔액4,104,319", prefix: "110110" },
  { name: "앞에 *만 있으면 prefix 없음(*120000)", text: "[Web발신] 우리 *120000 출금 9,000원 씨유", prefix: null },
  { name: "카드 끝4(**1234)는 prefix 아님", text: "신한카드 승인 5,000원 **1234 메가커피", prefix: null },
];
for (const c of prefixCases) {
  const got = parseSms(c.text, null).accountPrefix;
  ok(got === c.prefix, `prefix[${c.name}]: ${got}`);
}

// 시각(HH:MM) 추출 회귀 (설계 docs/household/44)
const timeCases: { name: string; text: string; time: string | null }[] = [
  { name: "카드 일시불 14:30", text: "[Web발신] 삼성카드 승인 12,345원 일시불 2026.06.21 14:30 스타벅스 1234**", time: "14:30" },
  { name: "현대카드 08:58(02개월·금액 오인없음)", text: "현대카드M 승인 이*다 170,000원 02개월 06/30 08:58 국가대표K태권도장", time: "08:58" },
  { name: "우리 출금 07:43(날짜 바로 뒤)", text: "[Web발신] 우리 06/29 07:43 *120000 출금 9,000원 씨유(CU)옥길헤", time: "07:43" },
  { name: "시각 없는 입금 → null", text: "[Web발신] 국민은행 입금 1,000,002원 잔액 2,500,000원 급여", time: null },
  { name: "한 자리 시각 9:05 → 09:05", text: "우리 06/29 9:05 출금 1,000원 테스트", time: "09:05" },
  { name: "잔액·카드번호 숫자는 시각 오인 안 함", text: "산들소아청소 체크카드출금 5,600 잔액4,104,319", time: null },
];
for (const c of timeCases) {
  const got = parseSms(c.text, null).occurredTime;
  ok(got === c.time, `time[${c.name}]: ${got}`);
}

// 자기 계좌 간 이체 이름 매칭 (설계 docs/household/27)
const { counterpartyHasName } = sms;
const nameCases: { name: string; counterparty: string | null; person: string | null; match: boolean }[] = [
  { name: "상대방=본인이름(이체)", counterparty: "김하늘", person: "김하늘", match: true },
  { name: "공백 섞여도 매칭", counterparty: "김 하늘 님", person: "김하늘", match: true },
  { name: "다른 가족 이름은 비매칭", counterparty: "이바다", person: "김하늘", match: false },
  { name: "가맹점명은 비매칭", counterparty: "스타벅스", person: "김하늘", match: false },
  { name: "상대방 없음", counterparty: null, person: "김하늘", match: false },
  { name: "인물 없음", counterparty: "김하늘", person: null, match: false },
  { name: "1자 이름은 오탐방지로 비매칭", counterparty: "김", person: "김", match: false },
];
for (const c of nameCases) {
  const got = counterpartyHasName(c.counterparty, c.person);
  ok(got === c.match, `name[${c.name}]: ${got}`);
}

// 숫자+영문 코드성 가맹점 판정 (설계 docs/household/42) → 매핑 안 될 때 용돈 추정용
const { isNumericCodeMerchant } = sms;
const codeCases: { name: string; merchant: string | null; code: boolean }[] = [
  { name: "숫자+영문 코드", merchant: "0042497TAQ046", code: true },
  { name: "순수 숫자", merchant: "120000", code: true },
  { name: "영문 전용(숫자없음)", merchant: "STARBUCKS", code: false },
  { name: "한글 섞인 가맹점", merchant: "GS25옥길골드점", code: false },
  { name: "한글+숫자", merchant: "11번가", code: false },
  { name: "한글 전용", merchant: "씨유", code: false },
  { name: "빈값", merchant: "", code: false },
  { name: "null", merchant: null, code: false },
];
for (const c of codeCases) {
  const got = isNumericCodeMerchant(c.merchant);
  ok(got === c.code, `code[${c.name}]: ${got}`);
}

// 카드앱(토스) 카드명 추출 + 결제수단 카드명 매칭 (설계 docs/household/51)
const { matchCardNameToMethod } = sms;
const cardNameCases: { name: string; text: string; cardName: string | null }[] = [
  { name: "토스 우리체크", text: "5,500원 결제 우리체크 | 브루브로스커피（(일시불)", cardName: "우리체크" },
  { name: "파이프 없음(일반 SMS)", text: "[Web발신] 삼성카드 승인 12,345원 스타벅스", cardName: null },
  { name: "파이프 없음(카드 상품명)", text: "현대카드M 승인 이*다 60,200원 일시불 교보문고", cardName: "현대카드M" },
  { name: "파이프 없음(현대 '카드' 생략형)", text: "[Web발신]\n현대 M 승인\n이*다\n29,800원 일시불\n08/26 07:53\n카페24주식회사\n누적1,301,892원", cardName: "현대카드M" },
  { name: "발급사만 있고 상품코드 없음 → null", text: "[Web발신] 현대 승인 12,345원 스타벅스", cardName: null },
  // 교차리뷰 H1·H2(2026-08-26): '카드' 생략형은 현대에만 열고, '승인 알림/승인번호' 는 상품명이 아니다.
  { name: "KB Pay 승인 알림 → 가짜 카드명 금지", text: "[Web발신] KB Pay[KB Pay 승인 알림] 신용 9012 08/18 14:57 54,780원 스타벅스 승인", cardName: null },
  { name: "삼성 PAY 승인 → 타 발급사 생략형 미적용", text: "[Web발신] 삼성 PAY 승인 12,345원 스타벅스", cardName: null },
  { name: "승인번호 안내 → null", text: "고객님 하나 A 승인번호 12345 안내", cardName: null },
];
for (const c of cardNameCases) {
  const got = parseSms(c.text, null).cardName;
  ok(got === c.cardName, `cardName[${c.name}]: ${got}`);
}

// 발급사 토큰 + 종류 토큰 둘 다 포함하는 결제수단이 유일할 때만 매칭(모호하면 null).
const methods = [
  { id: "acct-우리", name: "우리은행(김하늘)" },
  { id: "card-우리체크", name: "우리카드(김하늘) 체크카드" },
  { id: "card-삼성펫", name: "삼성카드(이바다) PET 카드" },
  { id: "card-삼성트레", name: "삼성카드(이바다) 트레이더스" },
  { id: "card-현대M", name: "현대카드(이바다) 현대카드M" },
];
const matchCases: { name: string; cardName: string | null; id: string | null }[] = [
  { name: "우리체크 → 우리 체크카드(은행계좌 아님)", cardName: "우리체크", id: "card-우리체크" },
  { name: "삼성(종류 없음) → 모호 → null", cardName: "삼성", id: null },
  { name: "빈값 → null", cardName: null, id: null },
  { name: "미등록(하나체크) → null", cardName: "하나체크", id: null },
  { name: "현대카드M 상품명 → 유일 카드", cardName: "현대카드M", id: "card-현대M" },
];
for (const c of matchCases) {
  const got = matchCardNameToMethod(c.cardName, methods);
  ok(got === c.id, `cardMatch[${c.name}]: ${got}`);
}

const { matchMerchantRule } = await import("../src/lib/household/defaults");
const learned = matchMerchantRule("씨유(CU)옥길헤일라움점", [
  { merchant_key: "씨유", category_id: "편의점", payment_method_id: "card-old", account_id: null },
  { merchant_key: "씨유(CU)옥길헤일라움점", category_id: "간식", payment_method_id: "card-new", account_id: "acct-1" },
]);
ok(
  learned?.category_id === "간식" &&
    learned.payment_method_id === "card-new" &&
    learned.account_id === "acct-1",
  "merchantRule: 가장 구체적인 확정 규칙의 카테고리·결제수단·계좌를 함께 반환"
);

// ★설계 150 — 후불교통 전용 카드대금은 payment(지출집계 제외)가 아니라 expense 로 흘려야 한다.
// payment 로 두면 calc.ts 의 categorySpending 이 expense 만 세므로 교통비가 통계에서 사라진다.
{
  const { isCardOrLoanPayment } = await import("../src/lib/household/defaults");
  const wooriBill = "[Web발신] 우리 08/05 03:06 *120000 출금 14,400원 우리카드결제대 잔액 63,749원";
  ok(isCardOrLoanPayment(wooriBill, "withdraw") === false, "우리카드 결제대금 → payment 아님(교통비 지출로 흘림)");
  ok(
    isCardOrLoanPayment("[Web발신] 우리 08/05 출금 17,155원 우리카드결제대금 잔액 100원", "withdraw") === false,
    "우리카드 결제대금(안 잘린 꼴) → payment 아님"
  );
  // 다른 카드사 대금은 개별 승인이 따로 수집되므로 종전대로 payment 를 유지해야 한다(설계 70).
  ok(
    isCardOrLoanPayment("[Web발신] 국민 08/10 출금 289,166원 삼성카드결제대금 잔액 100원", "withdraw") === true,
    "삼성카드 결제대금 → 종전대로 payment 유지(회귀 가드)"
  );
  ok(
    isCardOrLoanPayment("[Web발신] 우리 08/05 출금 195,000원 대출원리금납입 잔액 100원", "withdraw") === true,
    "대출 원리금 → 종전대로 payment 유지(회귀 가드)"
  );
  // 우리체크카드 '소비'는 카드대금이 아니다 — 즉시출금이라 지출로 남아야 한다.
  ok(
    isCardOrLoanPayment("[Web발신] 우리 08/05 15:01 *120000 출금 12,000원 레고랜드코리아 잔액 71,899원", "withdraw") === false,
    "우리체크 일반 소비 → payment 아님(회귀 가드)"
  );
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
