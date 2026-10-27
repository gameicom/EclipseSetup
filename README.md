# 이클립스 공동 필드보스 타이머

접속한 모든 사용자가 같은 보스 시간과 리젠 주기를 보고 수정하는 웹 앱입니다. GitHub Pages는 화면을 제공하고, Supabase의 PostgreSQL과 Realtime이 공동 상태를 저장하고 전달합니다.

**Supabase 프로젝트 xywqclfppwsiiydlniba의 연결 설정과 SQL 적용을 확인했습니다.** 실제 서버에서 두 독립 클라이언트의 Realtime 구독, 동일한 보스 6개 조회, 기존 값을 유지하는 수정 요청이 성공했습니다. GitHub Pages 공개 배포는 별도로 완료해야 합니다.

대상 저장소: https://github.com/gameicom/EclipseSetup

## 1. 공용 데이터베이스 준비

현재 프로젝트의 연결 정보는 **dist/shared-config.js**에 반영되어 있습니다. 아래 절차는 다른 Supabase 프로젝트로 옮기거나 데이터베이스를 새로 준비할 때 사용합니다.

1. https://supabase.com/dashboard 에 로그인하고 프로젝트를 준비합니다.
2. SQL Editor에서 이 저장소의 **supabase/setup.sql** 전체를 실행합니다.
3. 프로젝트의 **Project URL**과 브라우저용 **Publishable key**를 확인합니다. 이전 프로젝트의 anon 키도 지원합니다.
4. **dist/shared-config.js**의 두 값을 채웁니다.

~~~js
export const sharedConfig = {
  supabaseUrl: 'https://프로젝트주소.supabase.co',
  supabasePublishableKey: 'sb_publishable_공개키'
};
~~~

위 두 값은 웹에서 사용하도록 공개되는 값입니다. 비밀 키나 service_role 키는 사용하지 않습니다. 실제 접근 범위는 데이터베이스의 RLS와 함수 권한으로 제한합니다.

SQL은 보스 6개를 담은 한 행을 만들고 Realtime publication에 등록합니다. 이미 만들어진 타이머가 있으면 다시 실행해도 현재 시간을 초기화하지 않습니다. 모든 방문자는 조회와 지정된 수정 함수를 실행할 수 있고, 테이블을 직접 삭제하거나 임의의 행을 추가할 수는 없습니다.

## 2. 로컬 확인

Node.js 22 이상에서 프로젝트 폴더를 열고 실행합니다.

~~~sh
npm ci
npm test
npm run verify:deploy
npm start
~~~

http://127.0.0.1:4173 에 접속합니다. start-web.cmd를 더블클릭해도 실행할 수 있습니다. 서버 연결 설정이 되어 있으면 로컬 주소에서도 같은 Supabase 공동 타이머에 접속합니다.

화면에 **실시간 연결**이 표시되어야 수정할 수 있습니다. 두 브라우저 또는 두 기기에서 열어 한쪽의 보스 시간을 바꾸면 다른 쪽에도 반영됩니다.

## 3. GitHub Pages 배포

1. 이 프로젝트 폴더 안의 파일을 gameicom/EclipseSetup 저장소 루트에 업로드합니다. dist와 .github가 저장소 바로 아래에 있어야 합니다. ZIP 파일 자체를 올리는 것이 아니라 압축을 풀어 내용을 올립니다.
2. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 선택합니다.
3. **Actions → Publish boss timer to GitHub Pages → Run workflow**를 실행합니다.
4. 성공 결과에 표시되는 공개 주소를 공유합니다. 예상 주소는 https://gameicom.github.io/EclipseSetup/ 입니다. 실제 배포 성공 전에는 접속 가능한 주소로 간주하지 않습니다.

main 브랜치의 관련 파일을 변경하면 자동으로 다시 배포됩니다. 배포 과정에서 테스트와 공용 데이터베이스 조회를 확인하므로, 서버 연결 값이 비어 있거나 SQL 설정이 빠진 상태는 게시되지 않습니다. 브라우저에서 각 사용자에게 Supabase 로그인은 요구하지 않습니다.

## 공동 수정 동작

- 보스 기준 시각과 리젠 간격을 공동 서버에 저장합니다.
- 서로 다른 보스를 동시에 수정하면 양쪽 변경을 합칩니다.
- 같은 보스를 이전 상태에서 동시에 수정하면 나중 요청은 충돌 메시지를 표시합니다. 최신 시간을 확인하고 다시 설정합니다.
- 전체 초기화는 모든 접속자에게 적용되며, 서버의 한국시간을 사용합니다.
- 되돌리기는 내가 마지막으로 초기화/불러오기한 보스만 복원합니다. 다른 사람이 그 보스를 다시 수정하면 이전 작업으로 덮어쓰지 않습니다.
- 설정 불러오기는 파일의 6개 보스 시간을 모두에게 적용합니다.
- 알림음과 정렬은 각 기기의 개인 선택입니다. 알림음 켜기/끄기로 다른 사람의 소리 설정을 바꾸지 않습니다.
- 연결이 끊기면 마지막으로 읽은 시간을 표시하고 수정을 막습니다. 다시 연결되면 서버의 최신 시간을 받습니다. 오프라인 변경을 나중에 몰아서 덮어쓰지 않습니다.
- 서버 시간을 주기적으로 확인해 기기 시계 차이를 보정합니다.
- 5분마다 상태를 다시 읽어 유실된 이벤트와 기기 시계 오차를 보완합니다. 정상 연결 중 변경 전달은 Supabase Realtime으로 즉시 받습니다. 처음 접속하거나 재연결할 때, 탭으로 돌아올 때는 바로 조회합니다. 정기 조회는 연결 하나당 시간당 120회에서 12회로 줄었습니다.

## 기본 보스와 알림

Lv.40 / 50 / 60 / 70 / 75 / 80의 기본 주기는 8 / 8 / 10 / 12 / 12 / 15시간입니다. 최초 기준은 2026-10-22의 18:02 / 18:04 / 14:03 / 18:05 / 18:15 / 00:18 (KST)입니다. 이 PC의 저장 설정을 반영한 값입니다.

리젠은 기준 시각에서 자동 반복되며, 5분 이내 리젠을 강조합니다. 브라우저 절전/백그라운드 제한으로 소리 알림은 늦거나 생략될 수 있습니다. 새 탭에서는 소리 테스트로 오디오를 활성화합니다.

Windows 설정 파일은 %LOCALAPPDATA%\EclipseBossTimer\settings.json 에 있습니다. 불러오기 전에 기존 공동 시간을 덮어쓴다는 확인 화면을 표시합니다.

## 검증과 한계

npm test는 기본 시간 계산과 PostgreSQL 엔진(PGlite)에서 실제 SQL을 실행하는 공동 수정 검증을 포함합니다. 독립 클라이언트 두 개, 같은/다른 보스의 동시 수정, 되돌리기, 끊김/재연결, 서버 시간 보정, 유효하지 않은 입력과 권한을 검사합니다. 테스트의 이벤트 전달은 제어된 전송 계층을 사용합니다.

이는 실제 Supabase 네트워크와 여러 기기의 브라우저 검증을 대체하지 않습니다. 프로젝트 연결 후 두 기기에서 확인해야 합니다. tests/browser.mjs는 별도 Chrome 프로필에서 화면과 연결 여부를 읽기 전용으로 확인하며, 공유 데이터를 변경하지 않습니다. 이 실행 환경에서는 Chrome 페이지 연결이 제한되어 시각 검증을 완료하지 못했습니다.

## 주요 파일

- dist/core.js: 한국시간 및 반복 계산
- dist/shared.js: 서버 상태, Realtime 구독, 재연결과 수정 충돌
- dist/shared-config.js: 공용 프로젝트 연결 값
- dist/app.js: 화면, 공동 수정, 기기별 알림음
- dist/vendor/: 버전을 고정한 Supabase 브라우저 클라이언트
- supabase/setup.sql: 테이블, 데이터 검증, 공개 조회, 안전한 공동 수정 함수
- tests/shared.test.mjs: PostgreSQL 및 두 클라이언트 통합 검증
- .github/workflows/pages.yml: 검증 후 GitHub Pages 배포

공식 참고:
- https://supabase.com/docs/guides/realtime/postgres-changes
- https://supabase.com/docs/guides/database/functions
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
