# orchestmux

[English](README.md) · [한국어](README.ko.md)

tmux에서 돌아가는 코딩 에이전트 멀티 오케스트레이션.

Claude Code, Codex, Kimi, OpenCode, Gemini를 tmux pane에 워커로 띄우고, 작업을
배정하고, 실제로 끝날 때까지 블로킹으로 기다린다. GUI도 데몬도 없이 터미널
하나에서.

```
┌─ orchestmux ─────────────────────────────────────────┐
│ 코디네이터 (사람 또는 에이전트)                       │
├──────────────────┬───────────────────┬───────────────┤
│ w1  codex        │ w2  kimi          │ w3  opencode  │
│ [TASK t_a1b2]    │ [TASK t_c3d4]     │ 대기          │
│ 작업 중…         │ 질문 대기 중      │               │
└──────────────────┴───────────────────┴───────────────┘
```

## 왜 만들었나

에이전트 여러 개를 동시에 띄우는 건 쉽다. 어려운 건 **언제 끝났는지 아는
것**이다. orchestmux는 그 빠진 조각을 채운다. 배정된 모든 작업에 보고 프로토콜이
따라붙어서, 코디네이터는 터미널 출력을 긁어보며 추측하는 대신 **진짜 완료**에
블로킹할 수 있다.

- **진짜 pane.** 워커는 tmux pane이다. 붙어서 보고, 스크롤백을 뒤지고, 직접
  타이핑해서 작업 중인 에이전트를 가로챌 수 있다. 뷰어 뒤에 숨어있지 않다.
- **아무 CLI 에이전트나.** 터미널에서 돌아가면 워커가 될 수 있다.
- **런타임 의존성 0개.** 상태는 Node 내장 `node:sqlite`로 SQLite에 저장한다.
  네이티브 빌드도, 백그라운드 서비스도 없다.

## 요구사항

- **tmux** — 워커가 tmux pane이라 대안이 없다. macOS, Linux, WSL.
  네이티브 윈도우는 지원하지 않는다.
- **Node >= 22.5** — 내장 `node:sqlite` 모듈을 쓴다.
- **에이전트 CLI 최소 1개** — 설치되고 로그인된 상태여야 한다. orchestmux는
  자체 모델 접근을 전혀 제공하지 않는다. 모든 워커는 **그 머신의 구독**으로
  돌아가므로 각자 본인 Claude/ChatGPT/Kimi 플랜을 쓰고, orchestmux 자체는
  비용이 들지 않는다.

## 설치

```bash
npm install -g orchestmux
```

소스에서:

```bash
git clone https://github.com/younghotkim/orchestmux && cd orchestmux
npm install && npm run build && npm link
```

## 빠른 시작

```bash
orchestmux up                                        # tmux 세션 생성
orchestmux spawn --name w1 --agent codex --yolo      # 워커 pane 추가
orchestmux attach                                    # (선택) 실시간 관찰

TASK=$(orchestmux task add "packages/api에서 처리 안 된 promise rejection 감사")
orchestmux dispatch --task $TASK --to w1

orchestmux wait --timeout 900                        # w1이 보고할 때까지 블로킹
```

워커를 여러 개 띄우고 완료를 하나씩 수거:

```bash
orchestmux spawn --name w2 --agent kimi --yolo
orchestmux dispatch --task $(orchestmux task add "src/parser 테스트 작성") --to w2

for i in 1 2; do orchestmux wait --timeout 1800; done
```

## 워커 관찰하기

기본적으로 워커는 전용 `orchestmux` tmux 세션에 살고, `orchestmux attach`로 본다.

호출자가 **이미 tmux 안에 있으면** 워커가 그 창에 자동으로 split된다. 뜨는 즉시
보인다는 뜻이다. 그 창은 `$TMUX`가 아니라 **프로세스 트리로 찾는다** — 에이전트
하네스가 환경변수를 걸러내는 일이 흔하기 때문이다. 전용 세션을 쓰고 싶으면
`--no-here`를 준다.

```bash
orchestmux spawn --name w1 --agent codex --yolo
orchestmux spawn --name w2 --agent kimi  --yolo
```

tmux 밖에서 호출하면 워커는 `orchestmux` 세션으로 가는데, 기본적으로 아무도
붙어있지 않다. `orchestmux watch`가 그걸 해결한다 — 이미 attach된 터미널 창을
열어준다 (WSL은 Windows Terminal, macOS는 Terminal.app).

```
┌─ 내 창 ─────────────────────────────────────────┐
│ $ orchestmux wait          │ w1  codex          │
│ (코디네이터 = 내 셸)       │ 작업 중…           │
│                            ├────────────────────┤
│                            │ w2  kimi           │
└────────────────────────────┴────────────────────┘
```

pane은 진짜다. 스크롤백을 보고, 직접 입력하고, 작업 중인 에이전트를 넘겨받을 수
있다. `orchestmux down`은 워커 pane만 제거하고, 내가 앉아있는 세션은 절대 죽이지
않는다.

## dispatch가 하는 일

`dispatch`는 워커 pane에서 에이전트를 다시 띄우면서, 작업 명세와 짧은 프로토콜
블록을 **실행 인자로** 넘긴다:

```
[ORCHESTMUX TASK t_a1b2c3d4]

<작업 명세>

--- reporting protocol (required) ---
A coordinator is blocked waiting on you. When the work is finished, run exactly:
  orchestmux done --task t_a1b2c3d4 --body "<3-5 sentence summary>"

If you are blocked and need a decision before you can continue, run:
  orchestmux ask --task t_a1b2c3d4 --question "<your question>"
```

워커 pane은 `ORCHESTMUX_WORKER`가 설정된 채로 뜨기 때문에, `done`과 `ask`는
별도 플래그 없이 누가 호출했는지 안다. 이 콜백이 메커니즘의 전부다 — 완료는
스크롤백에서 추론한 게 아니라 **기록된 사실**이 된다.

프롬프트를 살아있는 composer에 타이핑하지 않는다. 그 방식은 세 가지 경쟁을 모두
이겨야 한다 — 에이전트가 마운트됐을 것, bracketed paste가 제출키보다 먼저 끝날
것, pane이 tmux copy-mode가 아닐 것 — 그리고 하나라도 지면 **에러 없이 프롬프트가
전송되지 않은 채 방치된다.** 실행 인자는 그런 실패 모드가 없어서, dispatch마다
깨끗한 컨텍스트로 에이전트를 다시 띄운다.

`ask`는 코디네이터가 답할 때까지 워커를 블로킹한다:

```bash
# 코디네이터
orchestmux wait                       # → [ask] w1 … id=m_9f8e7d6c
orchestmux reply --id m_9f8e7d6c --body "v2 엔드포인트를 써라."
```

## 명령어

| 명령 | 설명 |
| --- | --- |
| `up` | tmux 세션 생성 |
| `spawn --name <w> --agent <a> [--yolo] [--here]` | 워커 pane 추가 (`--here`는 현재 창 split) |
| `task add "<명세>"` | 작업 생성, id 출력 |
| `task list [--json]` | 작업 목록 |
| `task update --id <id> --status <s>` | `dispatched`에 갇힌 작업 복구 |
| `task rm --id <id>` | 작업 삭제 |
| `dispatch --task <id> --to <w>` | 작업+프로토콜을 워커에 주입 |
| `wait [--types done,ask] [--timeout 900]` | 워커 보고까지 블로킹 |
| `reply --id <msg> --body "<답>"` | 워커의 `ask`에 답변 |
| `send --to <w> --body "<텍스트>"` | 워커에게 메시지 |
| `ps [--json]` | 워커·작업·안 읽은 보고 수 |
| `attach` | tmux 세션에 붙기 |
| `watch` | 이미 attach된 터미널 창 열기 |
| `kill --name <w>` / `down` | 워커 1개 제거 / 전체 정리 |

워커(스폰된 pane 안)가 호출하는 것:

| 명령 | 설명 |
| --- | --- |
| `done --task <id> --body "<요약>" [--failed]` | 완료 보고 |
| `ask --task <id> --question "<질문>"` | 코디네이터에게 블로킹 질문 |

워커 하나는 한 번에 작업 하나만 한다. 작업 중인 워커에 다시 dispatch하면 그
에이전트를 끊어버려서 **첫 보고가 유실**되므로 `dispatch`가 거부한다. 병렬성은
워커를 더 띄워서 얻는 것이지 dispatch를 더 해서 얻는 게 아니다.

`wait`는 타임아웃 시 exit `2`로 끝난다. 이건 **실패가 아니라 체크포인트**다.
긴 작업은 창 하나를 넘기기 일쑤이므로 에러로 취급하지 말고 루프를 돌린다:

```bash
until orchestmux wait --timeout 600; do echo "아직 작업 중…"; done
```

## 에이전트

`claude`, `codex`, `kimi`, `opencode`, `gemini`, `shell`.

`--yolo`는 각 에이전트의 "승인 프롬프트 없이 실행" 플래그를 붙인다
(Claude Code는 `--dangerously-skip-permissions`, Codex는
`--dangerously-bypass-approvals-and-sandbox`, Gemini는 `--yolo`).
**기본값은 꺼짐**이다. 승인에서 멈추는 에이전트는 코디네이터를 무한정 붙잡지만,
무인 쓰기 권한을 주는 건 명시적으로 내려야 할 판단이기 때문이다. 플래그 뒤의
추가 인자는 에이전트로 전달된다:

```bash
orchestmux spawn --name w1 --agent codex --yolo -- --model gpt-5.5
```

`shell`은 그냥 셸이다. 프로토콜을 손으로 시험해볼 때 쓸모 있지만, 맨 셸은
붙여넣은 preamble을 **한 줄씩 실행해버린다** — `dispatch` 대상으로 쓰고 에이전트
같은 동작을 기대하면 안 된다. 대신 `done`을 직접 호출하면 된다.

## Claude Code에서 쓰기

orchestmux는 Claude Code 플러그인으로도 배포된다. 에이전트가 코디네이터 역할을
하도록 가르치는 스킬과 슬래시 커맨드가 들어있다.

```bash
npm i -g orchestmux
```
```
/plugin marketplace add younghotkim/orchestmux
/plugin install orchestmux@orchestmux
```

플러그인 설치가 **CLI까지 깔아주지는 않는다** — Claude Code 플러그인은 스킬과
커맨드를 배포하지 바이너리를 배포하지 않는다. 새 머신에서는
`/orchestmux:doctor`부터 실행하면 된다. tmux, Node, 에이전트 CLI를 점검하고
CLI가 없으면 `npm i -g orchestmux`를 대신 실행해주겠다고 물어보므로, 온보딩이
에디터 밖으로 나갈 일이 없다.

| 커맨드 | 용도 |
| --- | --- |
| `/orchestmux:doctor` | 사전 요구사항 점검, CLI 설치 제안 |
| `/orchestmux:run <할 일>` | 워커 스폰 → 배정 → 대기 → 보고 |
| `/orchestmux:ps` | 워커·작업·안 읽은 보고 |
| `/orchestmux:down` | 워커 정리 |

```
/orchestmux:run packages/api에서 처리 안 된 promise rejection 감사해줘
/orchestmux:run parser 테스트를 codex랑 kimi로 나눠서 작성해줘
```

스킬은 자연어에도 반응하므로("codex랑 kimi 병렬로 X 해줘") 슬래시 커맨드는
필수가 아니라 **발견성**을 위한 것이다.

플러그인 없이 쓰고 싶으면 스킬만 심링크로 걸면 된다:

```bash
ln -s "$(npm root -g)/orchestmux/skills/orchestmux" ~/.claude/skills/orchestmux
```

## 상태 저장

모든 상태는 `~/.orchestmux/state.db`에 있다 (`ORCHESTMUX_HOME`으로 변경 가능).
워커, 작업, 메시지 로그가 들어간다. 세션은 기본적으로 tmux 세션 `orchestmux`를
쓰며 (`--session` 또는 `ORCHESTMUX_SESSION`으로 변경), 독립된 여러 무리를 나란히
돌릴 수 있다.

## 범위

지금은 코어 루프다 — spawn, dispatch, wait, report, ask. 작업 의존성 그래프,
decision gate, 코디네이터 자동 루프는 코어가 실사용에서 검증될 때까지 의도적으로
넣지 않았다.

## 크레딧

여기 쓰인 조율 모델 — 작업, 보고 preamble을 주입하는 dispatch, 워커 완료에 대한
블로킹 대기 — 은 같은 문제를 자체 데스크톱 앱 안에서 푸는
[Orca](https://github.com/stablyai/orca) (MIT)에서 배웠다. orchestmux는 Orca와
코드를 공유하지 않는다. tmux pane과 로컬 SQLite 저장소를 중심으로 새로 만든
독립 구현이다.

## 라이선스

MIT
