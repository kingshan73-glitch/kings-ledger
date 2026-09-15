# 킹스가계부 설치 가이드 (로컬 실행)

처음 설치하는 분도 **이 문서만 따라 하면** 내 컴퓨터에서 킹스가계부를 실행하고 로그인할 수 있습니다.
설치는 크게 6단계이고, 보통 **10~15분**이면 끝납니다.
(짝이 되는 업무 시스템 샘플 「윤비서」와 설치 순서가 **완전히 같습니다.** 한 번 해 봤다면 그대로 하시면 됩니다.)

## 전체 흐름 한눈에

```
0. 필요한 프로그램 설치 (git · Node.js · GitHub CLI · Supabase CLI · Vercel CLI)
1. 코드 받기 (git clone) + npm install + 내 GitHub 저장소 만들기 (gh)
2. Supabase 로그인 → 프로젝트 만들기
3. 키 조회 → .env.local 작성 → DB 테이블 생성 (db push)
4. 첫 관리자 계정 만들기 (setup:admin)   ← 회원가입 화면이 없으므로 이 단계로 로그인 계정을 만듭니다
   + 더미 데이터 넣기 (seed:demo)         ← 가상 가족의 데이터로 화면이 채워진 채 시작
5. 실행 (npm run dev) → http://localhost:3000 로그인
6. (선택) Vercel 로 인터넷에 배포
7. (심화 · 업그레이드) 폰 문자 자동수집 켜기
```

> 💡 **왜 CLI 를 먼저 다 깔까요?** GitHub·Supabase·Vercel 은 전부 CLI(명령줄 도구)를 제공합니다.
> 처음에 CLI 3종을 설치해 두면 저장소 생성 → DB 프로젝트 생성·연결 → 배포까지 **전 과정을
> 브라우저 대시보드 없이 명령으로** 끝낼 수 있고, Claude Code 가 이 명령들을 대신 실행해 줍니다.

---

## ✨ 가장 쉬운 방법 — Claude Code 에게 맡기기

위 단계를 직접 안 하고 싶으면, **Claude Code 가 처음부터 끝까지 대신** 해 줍니다.

- **아직 URL밖에 없다면:** 빈 폴더를 하나 만들어 Claude Code 로 열고 이렇게 말하세요. 클론부터 알아서 합니다.
  > **"https://github.com/kingshan73-glitch/kings-ledger.git 설치해줘"**
- **이미 이 폴더를 클론했다면:** 폴더를 Claude Code 로 열고
  > **"설치해줘"** (또는 `초기 설정 도와줘`, `/setup`)

그러면 Claude 가 OS(Windows/맥)를 확인해 필요한 프로그램을 깔고, 클론·설치·DB 생성·관리자 계정·더미 데이터까지
**한 단계씩 같이** 진행한 뒤, 마지막에 **로그인 ID 와 비밀번호**를 알려 줍니다.
(git·Node 설치 시 승인 팝업/마법사는 클릭 한두 번만 직접 해 주면 됩니다.)

> 막히면 언제든 **Claude Code 에게 에러 메시지를 그대로 붙여넣고** 물어보세요.
> 예: "SETUP.md 3단계 `supabase db push` 에서 에러가 났어. 같이 봐줘."

아래는 **직접(수동) 설치**하는 분을 위한 단계별 안내입니다.

---

## 0. 필요한 프로그램 (5가지)

| 필요한 것 | Windows | macOS |
|-----------|---------|-------|
| **git** (코드 받기) | `winget install --id Git.Git -e` | `git --version` 실행 → 설치창 뜨면 진행 (또는 `xcode-select --install`) |
| **Node.js 20.9+** (빌드·실행) | `winget install --id OpenJS.NodeJS.LTS -e` | `brew install node` / 없으면 [nodejs.org](https://nodejs.org) LTS |
| **GitHub CLI** (내 저장소 만들기) | `winget install --id GitHub.cli -e` | `brew install gh` |
| **Supabase CLI** (DB) | `npm install -g supabase` | `npm install -g supabase` (또는 `brew install supabase/tap/supabase`) |
| **Vercel CLI** (인터넷 배포) | `npm install -g vercel` | `npm install -g vercel` |

- 잘 깔렸는지 확인: `git --version`, `node -v`(v20.9 이상), `gh --version`, `supabase --version`, `vercel --version` 이 모두 버전을 출력하면 OK.
- `winget` 이 없으면(구형 Windows) [nodejs.org](https://nodejs.org)·[git-scm.com](https://git-scm.com) 에서 설치파일로 받으세요.
- Supabase CLI 와 Vercel CLI 는 **Node 를 먼저 깐 뒤** 설치됩니다(`npm` 이 필요).
- 계정 3개(모두 무료)가 필요합니다: **GitHub**(github.com) · **Supabase**(supabase.com) · **Vercel**(vercel.com, GitHub 계정으로 가입 가능).
  각 로그인은 필요한 단계에서 CLI 가 브라우저를 열어 처리합니다.
- **윤비서를 먼저 설치했다면 이 5가지는 이미 다 깔려 있습니다.** 버전 확인만 하고 1단계로 넘어가세요.
- 최소한으로 가려면 git·Node·Supabase CLI 3개만으로도 **로컬 실행까지는** 됩니다.
  GitHub CLI 는 내 저장소 백업(1단계), Vercel CLI 는 배포(6단계)에 쓰입니다.

> 💡 git·Node 설치는 승인 팝업(Windows UAC)이나 설치 마법사가 떠서 **클릭 한두 번은 직접** 해야 합니다.

> ⚠️ **Windows 필독 — 설치 직후 `supabase` 가 "인식되지 않습니다"로 나오면:**
> 방금 설치한 프로그램은 **이미 열려 있던 터미널·VS Code 창에는 즉시 반영되지 않습니다**(PATH 갱신 문제).
> 같은 창에서 계속 시도하지 말고, 아래 순서로 해결하세요. (Claude Code 로 하면 1번을 알아서 해 줍니다.)
> 1. **(가장 쉬움 — 재시작 불필요) 설치된 전체 경로로 실행.** 먼저 설치 위치를 확인합니다:
>    ```
>    npm prefix -g
>    ```
>    출력된 경로 뒤에 `\supabase.cmd` 를 붙여 그 **절대경로로** 명령을 실행하면 PATH 갱신 없이 바로 됩니다. 예:
>    ```
>    "C:\Users\내계정\AppData\Roaming\npm\supabase.cmd" --version
>    ```
>    ⚠️ 단 **`supabase login` 은 이렇게 하지 마세요.** login 은 브라우저가 필요한데 절대경로/Claude `!` 로 돌리면
>    브라우저 대신 "토큰을 입력하라"고 나옵니다. login 은 아래 2·3번처럼 **새 터미널에서 `supabase login`** 으로 하세요.
> 2. (권장 — 특히 login) **새 cmd(또는 터미널) 창을 따로 열어** 거기서 `supabase login` 을 실행하세요.
>    새 창은 PATH 도 갱신돼 있고 진짜 터미널이라 **브라우저가 바로 열립니다.**
> 3. (대안) **VS Code 를 완전히 종료했다가 다시 켜기** → 새 터미널에서 `supabase` 가 잡힙니다.
>    Claude Code 로 진행 중이었다면 재시작 후 `claude` 를 다시 실행하고 **"이어서 설치해줘"** 라고 하면 됩니다.

---

## 1. 코드 받기 & 내 저장소 만들기

먼저 **프로젝트로 쓸 빈 폴더**를 만들고 그 안에서 클론합니다. 끝의 **점(`.`)** 이 "지금 폴더에 바로 받아라"는 뜻입니다.

```bash
mkdir my-ledger        # 폴더 이름은 영문 소문자·숫자·하이픈으로 (나중에 저장소·배포 이름으로 다시 씁니다)
cd my-ledger
git clone https://github.com/kingshan73-glitch/kings-ledger.git .
npm install
```

> - 이후 모든 명령은 **이 폴더 안에서** 실행합니다.
> - 점을 빠뜨리면 `kings-ledger/` 라는 폴더가 한 겹 더 생겨 사람마다 경로가 달라지고, 다음 단계의 저장소 이름이
>   원본과 같아져 헷갈립니다. 이미 그렇게 됐다면 `cd kings-ledger` 로 들어가서 계속하면 됩니다.

이어서 **내 GitHub 저장소(비공개)로 연결**합니다. 앞으로 고친 내용을 커밋·백업하고, Vercel 연동에도 쓰는 내 소유 저장소입니다.

```bash
# 1) GitHub 로그인 (처음 한 번, 브라우저가 열립니다 — 일반 터미널에서 실행)
gh auth login

# 2) 원본 샘플 리모트는 'template' 라는 이름으로 남겨두고
git remote rename origin template

# 3) 내 계정에 비공개 저장소를 만들고 코드를 올립니다 (origin = 내 저장소)
gh repo create my-ledger --private --source=. --push
```

> - 이후 커밋은 `git push` 만 하면 **내 저장소**로 올라갑니다.
> - 원본 샘플이 업데이트되면 `git pull template main` 으로 받아올 수 있습니다.
> - 급하면 이 부분(내 저장소 만들기)은 건너뛰고 나중에 해도 됩니다 —
>   Claude Code 에게 **"내 GitHub 저장소 만들어줘"** 라고 하면 위 절차를 대신 해 줍니다.

---

## 2. Supabase 로그인 & 프로젝트 만들기 (CLI 로 한 번에)

대시보드에서 키를 손으로 복사할 필요 없이, **CLI 로 로그인 → 프로젝트 생성 → 키 조회**까지 끝냅니다.

> ⚠️ `supabase login` 은 **일반 터미널(또는 cmd)에서 직접** 실행하세요. 그래야 브라우저가 열립니다.
> Claude Code 안에서 `!` 로 실행하면 비대화형이라 브라우저 대신 **"토큰을 입력하라"** 고 나와서 막힙니다.

```bash
# 1) 로그인 (일반 터미널에서 실행 → 브라우저가 열려 인증합니다)
supabase login

# 2) 내 조직 ID 확인 (ID 열의 값을 복사)
supabase orgs list

# 3) 새 프로젝트 생성 — 비밀번호는 직접 정하고 꼭 메모하세요. 한국이면 리전은 ap-northeast-2(서울) 권장
#    (한 줄로 입력하세요 — Windows/맥 동일)
supabase projects create "kings-ledger" --org-id <조직-ID> --db-password <원하는-DB비밀번호> --region ap-northeast-2

# 4) 생성된 project ref 확인 (REFERENCE ID 열의 값을 복사)
supabase projects list
```

> 새 프로젝트는 준비에 **1~2분** 걸립니다. (이미 쓰던 빈 프로젝트가 있으면 3번을 건너뛰고 4번에서 ref 만 골라도 됩니다.)

> 💰 **무료 플랜 안내:** Supabase 무료 플랜은 **조직(organization) 하나당 활성 프로젝트 2개**까지입니다.
> 윤비서 설치 때 프로젝트를 하나 만들었다면 **이번 킹스가계부가 두 번째**이고, 여기까지는 무료로 됩니다.
> 세 번째를 만들려 하면 실패하니, 그때는 안 쓰는 프로젝트를 일시정지(pause)하거나 삭제한 뒤 만드세요.

---

## 3. 키 조회 & DB 만들기

```bash
# 1) 환경변수 파일 만들기   (Windows cmd 라면 'copy .env.example .env.local')
cp .env.example .env.local

# 2) anon / service_role 키 조회 (대시보드 복사 불필요)
supabase projects api-keys --project-ref <내-project-ref>
```

`.env.local` 을 열어 위에서 받은 값으로 아래를 채웁니다 (URL 은 `https://<ref>.supabase.co`):

```
NEXT_PUBLIC_SUPABASE_URL=https://<내-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon 키>
SUPABASE_SERVICE_ROLE_KEY=<service_role 키>     # 🔒 비밀값 — 외부 공유 금지
SUPABASE_DB_PASSWORD=<2단계에서 정한 DB 비밀번호>   # 🔒 재연결용 기록(앱은 사용 안 함)
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN=example.com         # 기본값 그대로 두면 됩니다
```

이어서 DB(테이블·정책)를 생성합니다:

```bash
# 내 프로젝트와 연결 (2단계에서 정한 DB 비밀번호 입력)
supabase link --project-ref <내-project-ref>

# 테이블/정책 생성 — 'Do you want to push...' 물으면 Y 입력
supabase db push
```

> ✅ 성공하면 Supabase 대시보드의 **Table Editor** 에 `employees` 와 가계부 테이블
> (`hh_transaction`, `hh_account`, `hh_loan`, `hh_installment`, `hh_transaction_inbox` 등)이 생깁니다.

---

## 4. 첫 관리자 계정 만들기 ⭐ (로그인하려면 꼭 필요)

> **킹스가계부에는 회원가입 화면이 없습니다.** 개인 가계부이므로 아래 명령으로 만드는
> **관리자 계정 1개**로 로그인해 사용합니다.

```bash
npm run setup:admin
```

실행하면 **외우기 쉬운 기본 계정**이 만들어집니다 (윤비서와 같은 값):

```
========================================
  🔑 관리자 계정 준비 완료!
  👤 로그인 ID : admin
  🔒 비밀번호  : jadong!
========================================
```

| 로그인 ID | 비밀번호 |
|-----------|----------|
| **admin** | **jadong!** |

> 다른 값으로 만들고 싶으면 `npm run setup:admin -- 원하는ID 원하는비밀번호` (비밀번호는 **6자 이상**).
> 같은 명령을 다시 실행하면 비밀번호가 재설정됩니다.

### 4-2. 더미 데이터 넣기 (권장)

빈 가계부는 화면이 텅 비어 있어 무엇을 하는 앱인지 알기 어렵습니다. 아래 한 줄로 **가상 가족의 데이터**를 넣으세요.

```bash
npm run seed:demo
```

들어가는 것: **인물 3명 · 계좌 3개 · 카드 3장 · 대출 3건 · 최근 3개월 거래**.
전부 가공의 **「김하늘 · 이바다 가족」** 데이터입니다. 실제 사람·계좌·거래와 관계가 없으니 마음껏 고치고 지워도 됩니다.

> 연습이 끝나고 **내 데이터로 새로 시작**하고 싶으면 더미 데이터만 지웁니다:
> ```bash
> node scripts/seed-demo.mjs --reset
> ```
> (관리자 계정과 테이블은 그대로 남습니다.)

---

## 5. 실행 & 로그인

```bash
npm run dev
```

서버가 켜질 때 터미널에 **기본 로그인(`admin` / `jadong!`)** 이 배너로 강조 표시됩니다.
브라우저에서 **http://localhost:3000** 접속 → 로그인 화면에서:

- **로그인 ID**: `admin`  ← 이메일이 아니라 **ID** 를 그대로 입력합니다
- **비밀번호**: `jadong!`

🎉 로그인 성공! 이제 킹스가계부가 내 컴퓨터에서 돌아갑니다.
(서버를 끄려면 터미널에서 `Ctrl + C`, 다시 켜려면 `npm run dev`)

> 🔐 **로그인했으면 비밀번호부터 바꾸세요.** 왼쪽 사이드바 **맨 아래의 '내 이름'을 클릭** →
> **마이페이지**에서 비밀번호를 변경할 수 있습니다. (기본값 `jadong!` 은 누구나 아는 값이라 꼭 변경 권장)

### 처음 둘러보기 (더미 데이터를 넣었다면)

1. **현금흐름** — 이번 달·다음 달에 통장에서 빠져나갈 돈이 날짜순으로 보입니다. 이 앱의 핵심 화면입니다.
2. **거래관리** — 수입·지출·통장이동 탭. 행을 클릭하면 팝업에서 수정, 상단 버튼으로 등록.
   여러 건을 한 번에 넣을 땐 팝업 아래 '여러 건 입력 (엑셀)' 링크로 붙여넣기.
3. **대출관리 · 통장내역 · 통계** — 등록한 데이터가 자동으로 집계됩니다.
4. **설정** — 계좌·지출항목 분류·인물·정기지출·예산을 여기서 관리합니다.

---

## ✅ 설치 완료 체크리스트

- [ ] `git --version` / `node -v`(20.9+) / `gh --version` / `supabase --version` / `vercel --version` 이 모두 나온다
- [ ] `npm install` 이 에러 없이 끝났다
- [ ] (권장) `gh repo create ... --source=. --push` 로 내 GitHub 저장소가 만들어졌다
- [ ] `supabase db push` 가 에러 없이 끝났고, Table Editor 에 테이블이 보인다
- [ ] `npm run setup:admin` 으로 기본 계정(**admin / jadong!**)이 생성됐다
- [ ] (권장) `npm run seed:demo` 로 더미 데이터가 들어갔다
- [ ] `npm run dev` 후 http://localhost:3000 에서 **admin / jadong!** 로 로그인된다
- [ ] 로그인 후 사이드바 하단 '내 이름' → 마이페이지에서 **비밀번호를 변경**했다

---

## 6. (선택) Vercel 로 인터넷에 배포하기

로컬(`npm run dev`)로만 써도 충분하지만, 배포하면 **어디서나(휴대폰 포함) 접속**할 수 있습니다.
7장의 문자 자동수집을 쓰려면 폰이 접속할 주소가 필요하므로 **배포가 먼저**입니다.
Claude Code 에게 **"배포해줘"** 라고 하면 아래 절차를 대신 진행해 줍니다. 직접 하려면:

```bash
# 1) 로그인 (처음 한 번, 브라우저가 열립니다 — 일반 터미널에서 실행)
vercel login

# 2) 프로젝트 생성·연결 (첫 실행 시 자동 생성)
#    ⚠️ 폴더 이름이 한글이거나 대문자·공백이 있으면 실패합니다 → --project 로 영문 이름을 지정
vercel link --yes --project my-ledger

# 3) 환경변수 등록 — .env.local 의 4개 값을 그대로 넣습니다 (각 명령 실행 후 값 붙여넣기)
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add NEXT_PUBLIC_AUTH_EMAIL_DOMAIN production

# 4) 배포
vercel --prod
```

끝나면 `https://<프로젝트명>.vercel.app` 주소가 나옵니다. 알아두세요:

- 🔐 **배포하면 그 주소를 아는 누구나 로그인 화면까지는 접근할 수 있습니다.**
  기본 비밀번호(`jadong!`)를 쓰고 있다면 **배포 전에 반드시 변경**하세요(마이페이지).
- **DB 는 그대로 Supabase** 를 쓰므로 로컬과 배포본이 **같은 데이터**를 봅니다.
- 코드를 고친 뒤에는 `vercel --prod` 만 다시 실행하면 재배포됩니다.
- **Cron(자동 배치)**: `vercel.json` 에 **매일 1회** 도는 크론이 하나 들어 있습니다
  (`/api/household/inbox/purge-raw` — 수집함에 들어온 문자 원문을 30일 뒤 지워 개인정보를 남기지 않는 정리 작업).
  무료(Hobby) 플랜에서 동작하며, 켜려면 `CRON_SECRET` 환경변수를 함께 등록해야 합니다:
  ```bash
  vercel env add CRON_SECRET production     # 아무 긴 임의 문자열
  ```
  등록하지 않으면 크론이 401 로 거절될 뿐, 앱 자체는 정상 동작합니다. 무료 플랜은 크론을 **하루 1회까지만** 허용하니
  더 자주 도는 식을 추가하면 배포가 실패합니다.

---

## 7. (심화 · 업그레이드) 폰 문자 자동수집 켜기

**기본 샘플은 이 장 없이도 완전히 동작합니다.** 수입·지출·통장이동은 화면에서 직접 입력하거나
엑셀 붙여넣기로 일괄 등록하면 됩니다. 이 장은 "카드 결제 문자가 올 때마다 폰이 알아서 가계부에 넣어 주는"
자동화를 원할 때만 보세요. 교육 본과정에서는 다루지 않는 **업그레이드 과제**입니다.

### 무엇이 되나요

1. 카드사·은행에서 **결제/입금 문자**가 폰에 도착합니다.
2. 폰의 자동화 앱(**MacroDroid**)이 그 문자를 이 앱의 주소로 보냅니다:
   `POST https://<내-배포-주소>/api/household/inbox/sms`
3. 서버가 종류(승인·취소·입금·출금·이체)·금액·가맹점을 추정해 **수집함**에 "검토 대기"로 쌓습니다.
4. 사용자가 **수집함**에서 확인·수정하고 확정하면 거래내역에 반영됩니다. 문자 원문은 30일 뒤 자동 삭제됩니다.

### 필요한 것

| 항목 | 설명 |
|------|------|
| **안드로이드 폰** | 문자를 읽어 보내는 앱이 안드로이드용입니다(아이폰은 문자 접근이 막혀 있어 불가). |
| **MacroDroid 앱** | Play 스토어에서 설치. "문자 수신 → HTTP 요청 전송" 매크로를 만듭니다. |
| **배포된 주소** | 폰이 인터넷으로 접속해야 하므로 6장의 Vercel 배포가 먼저 필요합니다. (`localhost` 는 폰에서 안 보입니다.) |
| **문자수집 토큰** | 앱에 로그인 → **[설정] ▸ 문자수집** 탭 → **토큰 발급**. 발급 화면에서 **딱 한 번만** 보이니 바로 복사하세요. (서버에는 해시만 저장됩니다.) |

- 토큰은 폰이 보내는 요청의 **헤더 `X-Ingest-Token`** 에 넣습니다. 환경변수(`.env.local`)에 넣는 값이 아닙니다.
- 토큰이 새면 남이 내 수집함에 문자를 넣을 수 있으니, 의심되면 설정 화면에서 삭제하고 다시 발급하세요.

### 절차 (요약)

1. 6장대로 배포하고 배포 주소를 확인합니다.
2. 배포본에 로그인 → **[설정] ▸ 문자수집** 에서 토큰을 발급해 복사합니다.
   같은 화면에 폰 앱에 붙여넣을 **URL · 헤더 · 본문 예시**가 함께 표시됩니다.
3. 폰에서 MacroDroid 매크로를 만듭니다 — 트리거 "문자 수신(카드사·은행 번호)", 액션 "HTTP 요청(POST, JSON)".
   화면별 캡처가 있는 따라하기: **[docs/household/MACRODROID_GALAXY.md](./docs/household/MACRODROID_GALAXY.md)**
4. 테스트 문자를 한 통 받아 **수집함**에 들어오는지 확인합니다.

- 요청 형식(JSON/form/plain)·응답 코드·문제 해결 전체: **[docs/household/SMS_FORWARDING.md](./docs/household/SMS_FORWARDING.md)**
- 예전 경로 `/api/household/sms` 도 같은 동작을 합니다(권장은 `/api/household/inbox/sms`).

> ⚠️ 이 기능은 **내 폰의 실제 결제 문자**를 다룹니다. 더미 데이터 연습과 달리 진짜 개인 금융정보가 서버에 들어가므로,
> 켜기 전에 반드시 기본 비밀번호를 바꾸고, 배포 주소와 토큰을 남과 공유하지 마세요.

---

## 자주 막히는 곳

- **`supabase db push` 에서 권한/연결 오류** → `supabase login` 과
  `supabase link --project-ref ...` 를 다시 확인하세요. 새 프로젝트면 준비(1~2분)를 기다린 뒤 재시도.
- **`supabase projects create` 가 프로젝트 수 제한으로 실패** → 무료 플랜은 조직당 활성 프로젝트 2개입니다.
  안 쓰는 프로젝트를 일시정지/삭제하거나, 다른 조직을 만들어 거기에 생성하세요.
- **로그인이 안 됨** → 1) 이메일이 아니라 **ID `admin` / 비밀번호 `jadong!`** 로 시도했는지 확인,
  2) `npm run setup:admin` 을 다시 실행해 기본 계정을 재생성(비밀번호 재설정)한 뒤 다시 시도.
- **비밀번호가 너무 짧다는 오류** → 비밀번호는 **6자 이상**이어야 합니다.
- **`npm run build`/실행 실패** → `.env.local` 에 Supabase 값(URL/anon/service_role)이 채워졌는지 확인.
- **`npm run seed:demo` 가 실패** → 4단계의 `setup:admin` 을 먼저 실행했는지, `.env.local` 의 `SUPABASE_SERVICE_ROLE_KEY` 가 채워졌는지 확인.
- **수집함이 비어 있음** → 문자수집(7장)을 안 켰다면 정상입니다. 거래관리에서 직접 입력하세요.

무엇이든 막히면 **Claude Code 에게 에러 메시지를 그대로 붙여넣고 물어보세요.**
