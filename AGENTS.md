# 킹스가계부 — 프로젝트 작업 지침 (AI 에이전트용)

이 저장소는 **가계부 샘플 템플릿**입니다. 실제 개인 재무 데이터는 들어 있지 않으며, 들어와서도 안 됩니다.

## 데이터 취급
- 코드·문서·테스트 픽스처의 이름·계좌 끝자리·금액은 모두 **더미값**(본인 김하늘, 배우자 이바다)입니다.
  실제 이름·전화번호·전체 계좌번호·토큰·비밀번호를 코드나 문서에 넣지 마세요.
- `.env*`·`outputs/`·`backups/`·`hh_backups/`·`*.xlsx` 는 git 에 올리지 않습니다(`.gitignore` 참고).

## 실행 함정
- PowerShell 실행 정책 때문에 `npm`/`npx` 가 막히면 `npm.cmd` / `cmd.exe /d /c "npx …"` 로 실행합니다.
- `npm test` 는 DB 없이 도는 합성 테스트 체인입니다. `test:inbox-cancel`·`test:table-render`·`test:sms-ingest`·
  `test:cross-sweep-live`·`test:sweep-rpc` 는 라이브 DB·dev 서버가 필요해 체인 밖에 있습니다.
- 스키마를 바꾸면 `supabase/migrations/` 에 파일을 만들고 `supabase db push` 로 적용합니다(한 사이클로).
- 도메인·규칙·스키마 설명은 `docs/household/02~05` 와 `docs/UI_UX_GUIDELINES.md` 를 먼저 읽습니다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
