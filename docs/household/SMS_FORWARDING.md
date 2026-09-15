# 결제문자 자동수집 — 폰 설정 가이드 (payload 명세)

갤럭시(안드로이드)로 들어오는 **카드사·은행 거래 문자**를 가계부 수집함(inbox)에 자동으로 모읍니다.
폰의 문자전달 앱이 문자를 아래 엔드포인트로 HTTPS POST 하면, 서버가 종류·금액·가맹점을 추정해
**pending 후보**로 저장합니다. 사용자가 수집함에서 확인하면 거래내역에 반영됩니다.

> 수집된 원문(raw_text)은 **30일 후 자동 삭제**되며, 화면에서는 카드번호 등 민감정보가 마스킹됩니다.

---

## 1. 엔드포인트

```
POST https://<배포주소>/api/household/inbox/sms
```
(기존 경로 `…/api/household/sms` 도 동일하게 동작합니다.)

## 2. 인증 — 인제스트 토큰

앱이 로그인 세션이 없으므로 **per-user 토큰**으로 인증합니다.

1. 웹앱 로그인 → **가계부 ▸ 설정 ▸ 문자수집** 탭.
2. **토큰 발급** → 표시되는 토큰을 복사(이 화면에서 1회만 보입니다. 서버엔 해시만 저장).
3. 폰 앱의 요청 **헤더**에 넣습니다:
   ```
   X-Ingest-Token: <발급받은 토큰>
   ```
   (헤더를 못 넣는 앱이면 `Authorization: Bearer <토큰>`, `X-Device-Token`, 본문/쿼리의 `token`·`device_token`·`ingest_token`도 허용)

## 3. 본문 형식 (셋 중 아무거나)

**① JSON (권장)** — `Content-Type: application/json`
```json
{ "text": "[Web발신] 삼성카드 승인 12,345원 일시불 06/21 14:30 스타벅스", "sender": "15881111" }
```
**② form** — `Content-Type: application/x-www-form-urlencoded`
```
text=<문자원문>&sender=<발신번호>
```
**③ plain** — `Content-Type: text/plain` : 본문에 문자 원문 그대로.

- 문자 원문 필드는 `text`, `message`, `body`, `sms`, `raw_message`, `sms_message` 중 하나를 허용합니다.
- 발신자 필드는 `sender`, `from`, `address`, `phone`, `sms_sender` 중 하나를 허용합니다.

## 4. 응답
| 상황 | HTTP | 본문 |
|---|---|---|
| 수집 성공 | 201 | `{ "success": true, "id": "...", "kind": "approve", "amount": 12345 }` |
| 중복(이미 수집) | 200 | `{ "success": true, "duplicate": true }` |
| 토큰 없음/무효 | 401 | `{ "error": "Unauthorized: ..." }` |
| 빈 본문 | 400 | `{ "error": "Empty body" }` |

`kind` = `approve`(카드승인) · `cancel`(승인취소) · `deposit`(입금) · `withdraw`(출금) · `transfer`(이체) · `autopay`(자동이체) · `unknown`. 추출 실패해도 원문은 항상 저장됩니다.

---

## 5. 앱별 설정 예시

### A. SMS Forwarder 류 범용 앱 (가장 간단)
- 규칙 추가: **발신자 필터** = 카드사/은행 번호(예: 15881111, 1599…) 또는 "전체".
- 전달 방식 = **Webhook(POST)**, URL = 위 엔드포인트.
- 헤더 = `X-Ingest-Token: <토큰>`, `Content-Type: application/json`.
- 본문 템플릿(앱이 제공하는 치환변수 사용):
  ```json
  { "text": "%message%", "sender": "%sender%" }
  ```
  (변수명은 앱마다 다름: `{{message}}`, `%text%`, `$msg` 등)

### B. MacroDroid
- 트리거: **수신 SMS**(발신자 조건 지정 가능).
- 액션: **HTTP 요청(POST)** → URL = 엔드포인트.
  - Content-Type: `text/plain`
  - 헤더: `X-Ingest-Token: <토큰>`
  - 본문: `[sms_message]`
  - 발신자까지 보내고 싶을 때만 JSON 본문 `{"text":"[sms_message]","sender":"[sms_sender]"}` 사용

### C. Tasker
- 프로필: **Event ▸ Phone ▸ Received Text**.
- 태스크: **Net ▸ HTTP Request**
  - Method: POST, URL: 엔드포인트
  - Headers: `X-Ingest-Token:<토큰>` (줄바꿈으로 추가 `Content-Type:application/json`)
  - Body: `{"text":"%SMSRB","sender":"%SMSRF"}` (Tasker 변수 `%SMSRB`=본문, `%SMSRF`=발신자)

---

## 6. 테스트 (curl)
```bash
curl -X POST "https://<도메인>/api/household/inbox/sms" \
  -H "X-Ingest-Token: <토큰>" -H "Content-Type: application/json" \
  -d '{"text":"[Web발신] 신한카드 승인 9,900원 06/21 12:00 메가커피","sender":"15447200"}'
```
성공 시 `{"success":true,"id":"...","kind":"approve","amount":9900}` → 수집함에 pending 후보로 나타납니다.

## 7. 주의
- HTTPS 전용. 토큰은 외부 노출 금지(노출되면 설정에서 폐기·재발급).
- 카드번호·잔액이 포함된 원문은 30일 후 자동 비워지고, 화면에선 마스킹됩니다.
- 파서는 한국 카드사/은행 일반 패턴 기반입니다. 자주 틀리면 실제 문자 샘플을 모아 정확도를 높일 수 있습니다.
