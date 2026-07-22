# orchestmux

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/layl-labs/orchestmux/actions/workflows/ci.yml/badge.svg)](https://github.com/layl-labs/orchestmux/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orchestmux.svg)](https://www.npmjs.com/package/orchestmux)

**경량 tmux 기반 멀티 에이전트 도구입니다.** Claude Code에 평소 쓰는 말로
지시하면, 이미 구독 중인 코딩 CLI들 — Codex, Kimi, Gemini, OpenCode — 을
병렬로 굴려 줍니다. 워커는 전부 눈으로 보고 직접 개입할 수 있는 진짜 터미널
pane입니다.

![Claude Code에서 orchestmux를 구동하는 모습](https://raw.githubusercontent.com/layl-labs/orchestmux/main/docs/demo-claude.gif)

*실제 세션입니다: 평소 말로 한 줄 지시하면 — Claude가 codex와 opencode를
tmux pane으로 띄우고, 둘 다 보고할 때까지 기다렸다가, 이견은 파고들어 확인한
뒤, 하나의 답으로 정리해 다음 지시를 받을 준비까지 마칩니다.*

## 무엇을 해 주나요

Claude Code에 한 줄만 입력하면 됩니다.

```
/orchestmux:run codex랑 kimi한테 packages/api 재시도 로직 리뷰시켜줘
```

인터페이스는 이게 전부입니다. 이후 Claude가:

1. **작업의 형태를 고릅니다.** 판단이 갈리는 작업이면 같은 질문을 여러
   에이전트에 동시에 던져 답을 비교하고(*앙상블*), 독립적인 조각으로 나뉘는
   작업이면 조각별로 다른 에이전트에 맡깁니다(*분할*). 사용자가 고를 필요가
   없습니다.
2. **에이전트마다 tmux pane을 하나씩 엽니다.** 지금 쓰고 있는 그 터미널
   안에서요.
3. **각 워커가 실제로 보고할 때까지 기다립니다.** 워커가 끝나면 스스로
   보고를 남기므로, "완료"는 터미널 출력을 보고 때려 맞춘 추측이 아니라
   기록된 사실입니다.
4. **답들을 읽고 하나로 정리해 줍니다.** 에이전트들이 동의한 지점을 먼저,
   이견은 코드로 직접 확인해서, 한쪽만 발견한 내용은 검증한 뒤에 전달합니다.

슬래시 커맨드 없이 "codex랑 kimi 병렬로 돌려서 X 해줘"라고 말해도 똑같이
동작합니다.

## 다른 오케스트레이션 도구 대신 이걸 쓰는 이유

- **새로 배울 게 없습니다.** 기존 멀티 에이전트 도구들은 보드, 설정 파일,
  전용 문법부터 익혀야 합니다. 여기서는 코디네이터가 Claude Code 그 자체라서,
  쓰던 터미널에서 쓰던 말로 지시하면 됩니다.
- **구독 중인 모델들을 동시에 씁니다.** 워커는 이미 설치하고 로그인해 둔
  CLI입니다. orchestmux 자체는 모델 접근을 제공하지 않고 API 비용도 없습니다
  — Claude, ChatGPT/Codex, Kimi, Gemini 요금제가 나란히 일하게 만들 뿐입니다.
- **아무것도 숨기지 않습니다.** 워커는 평범한 tmux pane입니다. 생각하는 걸
  지켜보고, 스크롤백을 되짚고, 필요하면 직접 타이핑해서 넘겨받으면 됩니다.
- **실패가 조용히 묻히지 않습니다.** 워커가 작업 중에 죽으면 타임아웃을
  기다리는 대신 즉시 알려 줍니다. 보고는 pane이 사라진 뒤에도 남습니다.
  "진행 중인 척"하는 유령 작업이 생기지 않습니다.
- **띄워 둘 것이 없습니다.** 데몬도, 서버도, GUI도 없습니다. 상태는 Node
  내장 모듈로 쓰는 SQLite 파일 하나입니다.

## 설치

Claude Code를 쓴다면 플러그인이 가장 쉽습니다. CLI까지 대신 설치해 줍니다.

```
/plugin marketplace add layl-labs/orchestmux
/plugin install orchestmux@orchestmux
```

설치 후 `/orchestmux:doctor`를 한 번 실행하세요. tmux, Node, 설치된 에이전트
CLI를 점검하고 `orchestmux` CLI 설치까지 제안합니다.

CLI만 따로 쓰려면:

```bash
npm install -g orchestmux
```

**요구사항:** tmux (macOS·Linux·WSL) · Node 22.13 이상 · 로그인된 에이전트
CLI 1개 이상.

## 병렬 작업의 두 가지 형태

**앙상블(Ensemble)** — 같은 작업을 여러 에이전트에 동시에 맡기고 답을
비교합니다. 설계, 리뷰, "이 코드 뭐가 문제야"처럼 모델별 판단이 실제로
갈리는 작업에서 두 배의 토큰 값을 합니다. 정리할 때는 에이전트들이 동의한
것부터, 이견은 코드로 검증해서, 한쪽만 찾은 것은 확인 후에 포함합니다.

**분할(Split)** — 독립적인 조각을 각각 다른 에이전트에 맡깁니다. "파서
테스트 작성이랑 문서 업데이트"처럼 서로 겹치지 않는 일이면 같은 작업을 두 번
할 이유가 없으니까요.

어느 쪽일지는 Claude가 요청을 보고 고르며, 원하는 쪽을 직접 말해서 바꿀 수도
있습니다.

## 알아 두면 좋은 것

- **`--yolo`는 무인 쓰기 권한입니다.** 각 에이전트의 "승인 프롬프트 생략"
  플래그를 붙여 줍니다. 없으면 에이전트가 승인을 기다리며 멈춰 서지만,
  기본값으로 켜지 않는 건 의도입니다 — 이 권한은 사용자가 직접 내릴 판단이라서요.
  codex의 경우 어떤 플래그로도 답할 수 없는 디렉토리 신뢰 프롬프트가 있어,
  `--yolo` 사용 시 작업 디렉토리를 `~/.codex/config.toml` 신뢰 목록에
  추가하며 그 사실을 출력합니다.
- **보고가 끝나도 pane은 열려 있습니다.** 스크롤백은 그 답이 *어떻게*
  나왔는지 남은 유일한 기록이고, 답은 틀릴 수 있습니다. 결과를 읽은 뒤
  `sweep`으로 정리하세요.
- **워커가 죽어도 방치되지 않습니다.** 해당 작업은 failed로 표시되고, 기다리던
  코디네이터에게 즉시 알림이 갑니다. 워커를 중단시키거나 kill하거나 세션을
  내릴 때도 진행 중이던 작업이 같은 방식으로 정리됩니다.
- **스웜은 세션 단위로 격리됩니다.** 두 프로젝트가 동시에 오케스트레이션해도
  (`--session`) 서로의 작업이나 보고를 절대 가로채지 않습니다.

## 내부 구조 — CLI

위의 모든 동작은 Claude가 작은 CLI를 조작하는 것입니다. 직접 스크립트로 쓸
수도 있습니다.

![orchestmux CLI를 직접 조작하는 모습](https://raw.githubusercontent.com/layl-labs/orchestmux/main/docs/demo.gif)

*CLI를 손으로 직접 조작하는 화면입니다 — 평소에는 이 명령들을 Claude가 대신
입력합니다. 하나의 작업을 codex와 opencode에 보내고 두 보고를 수거하는 모습.*

루프 전체가 이게 답니다.

```bash
orchestmux up                                      # tmux 세션 생성
orchestmux spawn --name w1 --agent codex --yolo    # 워커 pane 추가
TASK=$(orchestmux task add "packages/api의 unhandled rejection 감사")
orchestmux dispatch --task $TASK --to w1           # 작업 + 보고 프로토콜 전달
orchestmux wait                                    # w1이 보고할 때까지 블로킹
```

`dispatch`는 워커 pane을 다시 띄우면서 작업 명세와 함께 "끝나면
`orchestmux done --task <id> --body "<요약>"`을 실행하라"는 짧은 프로토콜을
전달합니다(막히면 `ask`로 블로킹 질문을 되돌려 보낼 수도 있습니다). 이
콜백이 메커니즘의 전부입니다.

<details>
<summary><b>전체 명령어 레퍼런스</b></summary>

| 명령 | 설명 |
| --- | --- |
| `up` | tmux 세션을 생성합니다 |
| `spawn --name <w> --agent <a> [--yolo] [--here] [-- <인자…>]` | 워커 pane 추가 (`--here`는 현재 창 분할, `--` 뒤 인자는 에이전트에 전달) |
| `task add "<명세>"` | 작업을 생성하고 id를 출력합니다 |
| `task list [--json]` | 작업 목록 |
| `task update --id <id> --status <s>` | `dispatched`에 갇힌 작업 복구 |
| `task rm --id <id>` / `task clear` | 작업 1개 삭제 / 끝난 작업 전부 정리 |
| `dispatch --task <id> --to <w> [--force]` | 작업과 프로토콜을 워커에 전달 |
| `wait [--types done,ask] [--timeout 900]` | 보고까지 블로킹 (타임아웃 시 exit 2) |
| `wait --count <n>` / `wait --all` | n개 모일 때까지 / 쌓인 것 전부 |
| `report [--task <id>] [--json]` | 수거한 보고 다시 읽기 |
| `reply --id <msg> --body "<답변>"` | 워커의 `ask`에 답변 |
| `ps [--json]` | 워커·작업·미확인 보고 |
| `attach` / `watch` | 세션에 붙기 / attach된 터미널 열기 |
| `sweep [--dry-run]` | 할 일 없는 워커 정리 |
| `kill --name <w>` / `down` | 워커 1개 제거 / 세션 전체 정리 |

워커(스폰된 pane 안)가 쓰는 명령:

| 명령 | 설명 |
| --- | --- |
| `done --task <id> --body "<요약>" [--failed]` | 완료 보고 |
| `ask --task <id> --question "<질문>"` | 코디네이터에게 블로킹 질문 |

중요한 규칙:

- **워커 하나, 작업 하나.** 작업 중인 워커에 다시 dispatch하면 보고가
  유실되므로 거부됩니다(`--force`는 끊되 버려진 작업을 failed로 기록).
  병렬성은 워커를 더 띄워서 얻습니다.
- **이미 보고된 작업은 두 번째 `done`을 거부합니다** — 에이전트는 출력을
  놓친 명령을 재시도하곤 하는데, 그 중복이 다른 워커의 답으로 집계되면 안
  되기 때문입니다.
- **`wait`의 exit 2는 실패가 아니라 체크포인트입니다.** 실제 작업은
  15~60분씩 걸립니다: `until orchestmux wait --timeout 600; do :; done`
- **`wait`이 돌려주는 `escalation`은 워커가 작업 중 죽었다는 뜻입니다.**
  작업은 이미 failed 처리됐고, 원인은 pane 스크롤백에 남아 있습니다.

에이전트: `claude` · `codex` · `kimi` · `opencode` · `gemini` · `shell`
(`shell`은 프로토콜을 손으로 시험하는 용도 — `dispatch` 대상은 아닙니다).

상태는 `~/.orchestmux/state.db`에 저장되며(`ORCHESTMUX_HOME`으로 이동),
세션 단위로 격리됩니다(`--session` / `ORCHESTMUX_SESSION`, 기본
`orchestmux`).

</details>

## 범위

지금 있는 것은 코어 루프입니다 — spawn · dispatch · wait · report · ask.
워커 보고의 판정·병합(코디네이터 에이전트가 어떤 규칙보다 잘합니다),
worktree 격리, 의존성 그래프, 재시도/비용 정책은 **의도적으로** 넣지
않았습니다. 도구는 사실을 기록해 코디네이터에게 온전히 전달하는 데서 멈추고,
판단은 코디네이터의 몫으로 남깁니다.

## 라이선스

MIT
