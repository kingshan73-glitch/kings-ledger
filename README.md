# 킹스가계부 (kings-ledger)

> ## 이 저장소에 대하여 — 해냄에듀 사내 교육용 샘플
>
> - **용도** : 해냄에듀 직원 대상 Claude Code 사내 교육에서 쓰는 **개인 시스템 샘플**입니다.
>   (짝이 되는 **업무 시스템 샘플**은 「윤비서」입니다. 두 샘플은 설치 방법이 같습니다.)
> - **데이터** : 들어 있는 데이터는 **전부 가상**입니다. 인물·계좌·카드·대출·거래는 가공의
>   「김하늘 · 이바다 가족」 이야기이며, 실제 사람·계좌·거래와 아무 관계가 없습니다.
> - **제작자** : kinghama (한종수)
> - **바탕이 된 템플릿** : 윤용승 님의 「윤비서 템플릿」 — https://github.com/youn-yong-seung/yunbiseo-template
>   로그인·계정 관리·설치 도우미 같은 뼈대는 그 템플릿에서 왔고, 가계부 기능은 그 위에 새로 만든 것입니다.
> - **비공개 유지** : 원본 템플릿에 LICENSE 파일이 없어 재배포 조건이 정해져 있지 않습니다.
>   그래서 이 저장소는 **비공개(private)** 로 두고, 사내 교육 밖으로 공유하지 않습니다.

수입·지출·통장이동·할부·대출을 한 곳에서 기록하고, **다음 달 통장에서 얼마가 빠져나갈지**를
미리 보여 주는 **개인/가족 가계부** 앱입니다. 교육에서는 이 샘플을 클론해 내 컴퓨터에서 실행해 보고,
각자 원하는 방향으로 고쳐 보는 연습에 씁니다.

> **시작하기 (처음이라면):** 빈 폴더를 하나 만들어 **Claude Code 로 열고** 아래처럼 말하면
> 클론부터 로그인까지 처음부터 끝까지 같이 설치해 줍니다. (또는 `/setup` 입력) · 직접 하려면 → **[SETUP.md](./SETUP.md)**
>
> > **"https://github.com/kingshan73-glitch/kings-ledger.git 설치해줘"**
>
> 이미 코드를 받아 둔 폴더라면 그 폴더를 열고 **"초기 설정 도와줘"** 라고 하면 됩니다.

## 기술 스택

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Supabase** (Postgres + Auth + RLS)
- **Tailwind CSS v4** + shadcn/ui + Pretendard

## 포함된 기능 (메뉴)

왼쪽 사이드바 순서대로:

| 메뉴 | 하는 일 |
|------|---------|
| **수집함** | 폰에서 자동으로 들어온 결제 문자를 검토하고 확정하는 곳 (문자수집을 안 켜면 비어 있는 게 정상) |
| **현금흐름** | 이번 달·다음 달 **출금 예정** 목록과 잔액 예측. 지급일에 돈이 부족하면 미리 경고 |
| **통장내역** | 계좌별 입출금 내역을 통장처럼 보기 |
| **대출관리** | 대출 등록, 상환 일정·잔액 자동 계산 (상환중 / 상환완료) |
| **거래관리** | **수입 · 지출 · 통장이동** 세 탭. 지출은 일시불과 할부를 함께 관리. 여러 건은 엑셀 붙여넣기로 일괄 등록 |
| **통계** | 월별 흐름·분류별 지출 추이 |
| **설정** | 계좌정보 · 지출항목 분류 · 인물 · 정기지출 · 예산 · 문자수집(토큰 발급) |
| **시스템개선** | 개선 요청·재무 점검 메모를 남기는 게시판 |
| **마이페이지** | 사이드바 맨 아래 '내 이름' 클릭 → 비밀번호 변경 |

## 쓰는 법 (빠른 시작)

모든 과정이 **CLI-first** 입니다 — GitHub·Supabase·Vercel 을 전부 명령줄로 다루고, Claude Code 가 대신 실행해 줍니다.

```bash
git clone https://github.com/kingshan73-glitch/kings-ledger.git .   # 빈 폴더 안에서 (끝의 점 주의)
npm install
gh auth login                   # (권장) GitHub 로그인 → 내 비공개 저장소 만들기
git remote rename origin template && gh repo create <내-저장소이름> --private --source=. --push
supabase login                  # 브라우저 인증 (대시보드 키 복사 불필요)
supabase projects create "kings-ledger" --org-id <org> --db-password <pw> --region ap-northeast-2
cp .env.example .env.local
supabase projects api-keys --project-ref <ref>   # anon/service_role 키를 .env.local 에 기입
supabase link --project-ref <ref> && supabase db push   # 테이블 생성
npm run setup:admin             # 기본 관리자 계정 생성 → admin / jadong!
npm run seed:demo               # (권장) 가상 가족의 더미 데이터 넣기 — 화면이 채워진 채로 시작
npm run dev                     # http://localhost:3000  (admin / jadong! 로 로그인)
```

> 로그인 후 **사이드바 하단 '내 이름' → 마이페이지**에서 비밀번호를 꼭 바꾸세요.
> `supabase login` · `gh auth login` · `vercel login` 은 브라우저가 열려야 하므로 **새 터미널에서 직접** 실행합니다.

인터넷 배포까지 원하면 Claude Code 에게 **"배포해줘"** — `vercel login` 한 번이면
프로젝트 생성·환경변수 등록·배포를 알아서 진행합니다.

자세한 내용은 **[SETUP.md](./SETUP.md)** 참고.

## 더미 데이터 (가상 가족)

`npm run seed:demo` 를 실행하면 **인물 3명 · 계좌 3개 · 카드 3장 · 대출 3건 · 최근 3개월 거래**가 들어갑니다.
전부 가공의 「김하늘 · 이바다 가족」 데이터라 마음껏 고치고 지워도 됩니다.
지우고 처음부터 내 데이터로 쓰려면 `node scripts/seed-demo.mjs --reset` 을 실행하세요.

## 선택(심화 · 업그레이드) — 폰 문자 자동수집

연동 없이도 **모든 화면이 동작**합니다(직접 입력 + 엑셀 붙여넣기). 안드로이드 폰의 **MacroDroid** 앱이
결제 문자를 이 앱의 `/api/household/inbox/sms` 로 보내도록 설정하면 수집함에 자동으로 쌓입니다.
토큰은 **[설정] ▸ 문자수집** 탭에서 발급합니다. 절차는 [SETUP.md 7장](./SETUP.md) 과
`docs/household/SMS_FORWARDING.md`, `docs/household/MACRODROID_GALAXY.md` 참고.

## 참고

학습용 샘플입니다. 자세한 규약은 [CLAUDE.md](./CLAUDE.md), UI 규칙은
[docs/UI_UX_GUIDELINES.md](./docs/UI_UX_GUIDELINES.md), 가계부 기능의 설계 이력은 `docs/household/` 에 있습니다.
