# orchestmux

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/younghotkim/orchestmux/actions/workflows/ci.yml/badge.svg)](https://github.com/younghotkim/orchestmux/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orchestmux.svg)](https://www.npmjs.com/package/orchestmux)

**에이전트를 여러 개 띄우는 건 쉽습니다. 어려운 건 언제 끝났는지 아는 일입니다.**

`orchestmux`는 Claude Code, Codex, Kimi, OpenCode, Gemini 워커에 작업을 배정하고,
워커가 **실제로 보고할 때까지 블로킹**합니다. 터미널 출력을 훑으며 추측하지
않습니다. 워커는 진짜 tmux pane이라 작업 중간에 붙어서 직접 넘겨받을 수도
있습니다. GUI도 데몬도 없이 터미널 하나로 끝납니다.

![orchestmux demo](https://raw.githubusercontent.com/younghotkim/orchestmux/main/docs/demo.gif)

*codex와 opencode에 같은 작업을 배정하고, 두 보고를 수거하기까지.*

---

**[어떻게 돌아가나](#실제로는-이렇게-씁니다)** · [설치](#설치) · [왜 만들었나](#왜-만들었나요) · [명령어](#명령어) · [슬래시 커맨드](#슬래시-커맨드) · [에이전트](#에이전트) · [범위](#범위)

## 실제로는 이렇게 씁니다

대부분은 아래 명령어를 직접 칠 일이 없습니다. Claude Code에 그냥 시키면, Claude가
코디네이터 역할을 맡습니다.

```
/orchestmux:run codex랑 kimi 둘 다 packages/api의 재시도 로직 보고
                개선안 뽑아줘
```

이 한 줄에서 벌어지는 일입니다.

1. **일의 모양을 먼저 정합니다.** 같은 질문을 여러 에이전트에게 던지거나(**앙상블**),
   서로 다른 조각을 각 워커에 나눠 맡깁니다(**분할**). 위 예시는 앙상블입니다.
   "개선안을 내라"는 판단이 필요한 일이고 모델마다 답이 실제로 갈리니, 두 번 값을
   치를 만하기 때문입니다. 반대로 "파서 테스트 짜고 문서도 고쳐줘"는 분할입니다.
   서로 무관한 두 작업이라 같은 일을 두 번 시킬 이유가 없습니다.
2. **에이전트마다 pane을 하나씩 엽니다.** 각 워커에 작업 내용과 함께 "다 끝나면
   이렇게 보고하라"는 짧은 프로토콜을 같이 넘깁니다.
3. **세트가 다 모일 때까지 기다립니다.** 먼저 끝난 하나에 반응하지 않습니다.
   답이 하나뿐이면 비교할 수가 없으니까요.
4. **답들을 읽고 하나로 정리해 줍니다.** 여러 에이전트가 **동의한 지점**이 먼저
   나옵니다. 서로 독립적인 모델이 같은 말을 하는 건 가장 강한 신호이기 때문입니다.
   **이견이 갈린 부분**은 Claude가 직접 코드를 확인하고 어느 쪽이 맞는지 알려 줍니다.
   **한쪽만 찾아낸 것**은 검증한 뒤에 전달합니다. 단독 발견은 가장 값진 결과이거나,
   아니면 환각이기 때문입니다.

결과로는 각 에이전트의 좋은 부분만 합쳐진 **하나의 답**을 받게 되고, 눈에 띄는
발견에는 누가 찾았는지가 함께 적힙니다.

이 흐름에서 두 가지만 알아 두면 됩니다.

- **비교와 판단은 이 도구가 아니라 Claude가 합니다.** orchestmux가 하는 일은 작업을
  넘기고, 돌아온 답을 기록하고, 그것을 코디네이터에게 온전히 전달하는 것까지입니다.
  어느 답이 더 나은지에 대한 의견은 갖고 있지 않으며, [이는 의도된 것입니다](#범위).
- **pane은 계속 열려 있습니다.** 평범한 tmux pane이라 에이전트가 일하는 걸 지켜보거나,
  스크롤을 올려 근거를 확인하거나, 직접 타이핑해서 중간에 넘겨받을 수 있습니다.
  들여다볼 수 없는 곳에서 벌어지는 일은 없습니다.

이 아래 내용은 그 밑에서 도는 CLI입니다. 직접 스크립트를 짤 게 아니라면
플러그인이 알아서 호출하므로 안 읽어도 됩니다.

---

## 설치

들어오는 길은 두 가지입니다. Claude Code를 쓴다면 첫 번째가 편합니다. CLI까지
알아서 깔아 주거든요.

**Claude Code 플러그인으로** (제일 쉬움)

```
/plugin marketplace add younghotkim/orchestmux
/plugin install orchestmux@orchestmux
```

그다음 `/orchestmux:doctor`를 한 번 실행하면 됩니다. tmux와 Node, 설치돼 있는
에이전트 CLI를 점검하고, orchestmux CLI가 없으면 대신 깔아 줍니다. 플러그인은
스킬과 커맨드만 배포하고 바이너리는 배포하지 않아서 이 단계가 자동은 아닙니다.
어쨌든 에디터 밖으로 나갈 일은 없습니다.

**CLI만 따로**

```bash
npm install -g orchestmux
```

소스에서 받으려면:

```bash
git clone https://github.com/younghotkim/orchestmux && cd orchestmux
npm install && npm run build && npm link
```

플러그인은 쓰기 싫은데 스킬만 필요하다면 직접 링크해도 됩니다.

```bash
ln -s "$(npm root -g)/orchestmux/skills/orchestmux" ~/.claude/skills/orchestmux
```

---

## 왜 만들었나요

보통은 폴링으로 해결합니다. pane을 지켜보다가 프롬프트가 돌아오면 끝난 걸로
칩니다. 하지만 입력을 기다리며 멈춰 선 에이전트를 완료로 오독하고, 바뀌지도 않은
출력을 계속 다시 읽느라 코디네이터 자신의 컨텍스트를 태웁니다.

orchestmux는 이걸 뒤집습니다. 배정되는 모든 작업에 **보고 프로토콜**이 함께
주입되므로, 완료는 추론이 아니라 **기록된 사실**입니다. `orchestmux wait`이
풀리는 이유는 휴리스틱이 끝난 것 같다고 판단해서가 아니라, 워커가 끝났다고
말했기 때문입니다. 이 채널은 역방향으로도 흐릅니다 — 막힌 워커는 `ask`할 수 있고,
코디네이터는 작업을 처음부터 다시 시키지 않고 `reply`로 답합니다.

- **새로 익힐 인터페이스가 없습니다.** 보드도, 대시보드도, 데몬도, 별도의 창 관리
  체계도 없습니다. 이미 열려 있는 터미널에서 그대로 돌아가고, 달라지는 건 pane 몇
  개가 스스로 보고하기 시작한다는 것뿐입니다.
- **진짜 pane입니다.** 워커는 tmux pane이므로 스크롤백을 뒤지고, 직접 타이핑하고,
  작업 중인 에이전트를 중간에 넘겨받을 수 있습니다. 뷰어 뒤에 숨겨져 있지 않습니다.
- **어떤 CLI 에이전트든 됩니다.** 터미널에서 돌아가면 워커가 될 수 있습니다.
- **런타임 의존성이 없습니다.** 상태는 Node 내장 `node:sqlite`에 저장합니다.
  네이티브 빌드도, 백그라운드 서비스도 필요 없습니다.

---

## 요구사항

| 항목 | 내용 |
| --- | --- |
| **tmux** | 워커가 tmux pane이므로 필수입니다. macOS · Linux · WSL에서 동작하며, **네이티브 Windows는 지원하지 않습니다.** |
| **Node 22.13 이상** | 내장 `node:sqlite` 모듈을 사용합니다. 22.13(또는 23.4) 미만에서는 이 모듈이 플래그 뒤에 있어 실행되지 않습니다. |
| **에이전트 CLI 1개 이상** | 설치 및 로그인이 되어 있어야 합니다. |

> **비용에 관하여**
> orchestmux는 자체 모델 접근을 전혀 제공하지 않습니다. 모든 워커는 **그 머신에
> 설치된 CLI와 그 사람의 구독**으로 실행됩니다. 즉 각자 본인의 Claude / ChatGPT /
> Kimi 플랜을 사용하며, orchestmux 자체로 발생하는 비용은 없습니다.

---

## 빠른 시작

```bash
orchestmux up                                        # tmux 세션 생성
orchestmux spawn --name w1 --agent codex --yolo      # 워커 pane 추가

TASK=$(orchestmux task add "packages/api에서 처리되지 않은 promise rejection을 감사해줘")
orchestmux dispatch --task $TASK --to w1

orchestmux wait --timeout 900                        # w1이 보고할 때까지 블로킹
```

여러 워커를 띄우고 완료를 하나씩 수거할 수도 있습니다.

```bash
orchestmux spawn --name w2 --agent kimi --yolo
orchestmux dispatch --task $(orchestmux task add "src/parser 테스트 작성") --to w2

for i in 1 2; do orchestmux wait --timeout 1800; done
```

---

## 워커 관찰하기

호출자가 **이미 tmux 안에 있다면** 워커는 그 창에 자동으로 split됩니다. 별도 조작
없이, 뜨는 즉시 눈앞에 보입니다.

이때 창은 `$TMUX` 환경변수가 아니라 **프로세스 트리로 찾습니다.** 에이전트 하네스가
도구를 실행할 때 환경변수를 걸러내는 경우가 많아, 환경변수만 믿으면 tmux 안에
있으면서도 밖으로 오인되기 때문입니다. 전용 세션을 쓰고 싶다면 `--no-here`를
지정하면 됩니다.

```bash
orchestmux spawn --name w1 --agent codex --yolo
orchestmux spawn --name w2 --agent kimi  --yolo
```

```
┌─ 내 창 ─────────────────────────────────────────┐
│ $ orchestmux wait          │ w1  codex          │
│ (코디네이터 = 내 셸)       │ 작업 중…           │
│                            ├────────────────────┤
│                            │ w2  kimi           │
└────────────────────────────┴────────────────────┘
```

tmux 밖에서 호출한 경우 워커는 `orchestmux` 세션으로 들어가는데, 기본적으로는
아무도 붙어 있지 않습니다. 이때는 `orchestmux watch`를 쓰면 됩니다. 이미
attach된 터미널 창을 열어 줍니다(WSL은 Windows Terminal, macOS는 Terminal.app).

### pane은 왜 자동으로 닫히지 않나요

워커가 보고를 마쳐도 pane은 **의도적으로 열어 둡니다.**

스크롤백은 그 워커가 결론에 *어떻게* 도달했는지 남아 있는 유일한 기록이며,
에이전트의 보고는 틀릴 수 있습니다. `done` 시점에 pane을 닫아 버리면 정작 그 보고를
검증해야 할 때 근거가 사라집니다. 결과를 모두 확인한 뒤 한 번에 정리하세요.

```bash
orchestmux sweep --dry-run   # 무엇이 지워질지 미리 확인
orchestmux sweep             # 아직 작업 중인 워커는 그대로 유지됩니다
```

보고 전에 pane이 죽어 버린 워커는 해당 작업도 `failed`로 표시됩니다. 아무것도
`dispatched` 상태로 남아 진행 중인 척하지 않도록 하기 위해서입니다.

---

## dispatch는 어떻게 동작하나요

`dispatch`는 워커 pane에서 에이전트를 다시 띄우면서, 작업 명세와 짧은 프로토콜
블록을 **실행 인자로** 전달합니다.

```
[ORCHESTMUX TASK t_a1b2c3d4]

<작업 명세>

--- reporting protocol (required) ---
A coordinator is blocked waiting on you. When the work is finished, run exactly:
  orchestmux done --task t_a1b2c3d4 --body "<3-5 sentence summary>"

If you are blocked and need a decision before you can continue, run:
  orchestmux ask --task t_a1b2c3d4 --question "<your question>"
```

워커 pane은 `ORCHESTMUX_WORKER` 환경변수가 설정된 상태로 뜨기 때문에, `done`과
`ask`는 별도 플래그 없이도 누가 호출했는지 알 수 있습니다. **이 콜백이 메커니즘의
전부입니다.** 완료는 스크롤백에서 추론한 결과가 아니라 기록된 사실이 됩니다.

> **왜 붙여넣지 않고 실행 인자로 전달하나요**
> 살아 있는 composer에 프롬프트를 타이핑하는 방식은 세 가지 경쟁에서 모두 이겨야
> 합니다. 에이전트가 마운트되어 있어야 하고, bracketed paste가 제출키보다 먼저
> 끝나야 하며, pane이 tmux copy-mode가 아니어야 합니다. 이 중 하나라도 어긋나면
> **아무런 오류 없이 프롬프트가 전송되지 않은 채 방치됩니다.** 실행 인자에는 그런
> 실패 모드가 없어, dispatch마다 깨끗한 컨텍스트로 에이전트를 다시 띄웁니다.

### ask — 워커가 막혔을 때

`ask`는 코디네이터가 답할 때까지 워커를 블로킹합니다.

```bash
# 코디네이터 쪽
orchestmux wait                       # → [ask] w1 … id=m_9f8e7d6c
orchestmux reply --id m_9f8e7d6c --body "v2 엔드포인트를 사용하세요."
```

---

## 명령어

### 코디네이터가 사용하는 명령

| 명령 | 설명 |
| --- | --- |
| `up` | tmux 세션을 생성합니다 |
| `spawn --name <w> --agent <a> [--yolo] [--here]` | 워커 pane을 추가합니다 |
| `task add "<명세>"` | 작업을 생성하고 id를 출력합니다 |
| `task list [--json]` | 작업 목록을 조회합니다 |
| `task update --id <id> --status <s>` | `dispatched`에 갇힌 작업을 복구합니다 |
| `task rm --id <id>` | 작업을 삭제합니다 |
| `dispatch --task <id> --to <w>` | 작업과 프로토콜을 워커에 전달합니다 |
| `wait [--types done,ask] [--timeout 900]` | 워커 보고까지 블로킹합니다 |
| `wait --count <n>` / `wait --all` | n개 보고를 모을 때까지 / 쌓인 것 전부 |
| `report [--task <id>] [--json]` | `wait`이 수거한 보고를 다시 읽습니다 |
| `reply --id <msg> --body "<답변>"` | 워커의 `ask`에 답변합니다 |
| `ps [--json]` | 워커·작업·미확인 보고를 조회합니다 |
| `attach` / `watch` | 세션에 붙기 / attach된 터미널 창 열기 |
| `sweep [--dry-run]` | 할 일이 없는 워커를 정리합니다 |
| `kill --name <w>` / `down` | 워커 1개 제거 / 전체 정리 |

### 워커(스폰된 pane 안)가 사용하는 명령

| 명령 | 설명 |
| --- | --- |
| `done --task <id> --body "<요약>" [--failed]` | 완료를 보고합니다 |
| `ask --task <id> --question "<질문>"` | 코디네이터에게 블로킹 질문을 합니다 |

### 알아 두면 좋은 두 가지 규칙

**하나. 워커 하나는 한 번에 작업 하나만 수행합니다.**
작업 중인 워커에 다시 dispatch하면 그 에이전트를 중간에 끊어 버려 **첫 번째 보고가
유실**되므로, `dispatch`가 이를 거부합니다. 병렬성은 워커를 더 띄워서 얻는 것이지
dispatch를 더 해서 얻는 것이 아닙니다.

**둘. `wait`의 타임아웃(exit `2`)은 실패가 아니라 체크포인트입니다.**
실제 코딩 작업은 15~60분을 넘기는 일이 흔합니다. 오류로 처리하지 마시고 루프를
돌리면 됩니다.

```bash
until orchestmux wait --timeout 600; do echo "아직 작업 중입니다…"; done
```

---

## 슬래시 커맨드

| 커맨드 | 용도 |
| --- | --- |
| `/orchestmux:doctor` | 사전 요구사항 점검 및 CLI 설치 제안 |
| `/orchestmux:run <할 일>` | 워커 스폰 → 배정 → 대기 → 보고까지 한 번에 |
| `/orchestmux:ps` | 워커·작업·미확인 보고 조회 |
| `/orchestmux:down` | 워커 정리 |

```
/orchestmux:run packages/api의 처리되지 않은 promise rejection을 감사해줘
/orchestmux:run 파서 테스트를 codex와 kimi에 나눠서 맡겨줘
```

평문으로 말해도 스킬이 반응합니다 — "codex랑 kimi 병렬로 X 해줘" 같은 식이죠.
커맨드는 발견하기 쉬우라고 있는 것이지 필수는 아닙니다.

---

## 에이전트

`claude` · `codex` · `kimi` · `opencode` · `gemini` · `shell`

`--yolo`는 각 에이전트의 "승인 프롬프트 없이 실행" 플래그를 붙여 줍니다
(Claude Code는 `--dangerously-skip-permissions`, Codex는
`--dangerously-bypass-approvals-and-sandbox`, Gemini는 `--yolo`).

**기본값은 꺼져 있습니다.** 승인 프롬프트에서 멈추는 에이전트는 코디네이터를
무한정 붙잡아 두지만, 무인 쓰기 권한을 부여하는 것은 명시적으로 내려야 할 판단이기
때문입니다.

> **codex에 `--yolo`를 쓰면 codex 설정 파일도 함께 수정됩니다.**
> codex는 어떤 플래그로도 답할 수 없는 디렉토리 신뢰 프롬프트에서 멈추기 때문에,
> `--yolo`로 codex 워커를 띄우면 해당 작업 디렉토리를 `~/.codex/config.toml`의
> 신뢰 목록에 추가합니다. 그러지 않으면 워커가 그 프롬프트에 멈춰 선 채 작업을
> 영영 읽지 못합니다. 실제로 수정이 일어나면 그 사실을 출력하며, 이 경우를 제외하면
> orchestmux는 자신의 상태 디렉토리 밖에 아무것도 쓰지 않습니다.

플래그 뒤에 오는 추가 인자는 그대로 에이전트에 전달됩니다.

```bash
orchestmux spawn --name w1 --agent codex --yolo -- --model gpt-5.5
```

> `shell`은 일반 셸입니다. 프로토콜을 손으로 시험해 볼 때 유용하지만, 맨 셸은
> 전달된 preamble을 한 줄씩 실행해 버립니다. `dispatch` 대상으로 사용하면서
> 에이전트와 같은 동작을 기대하면 안 됩니다.

---

## 병렬 작업의 두 가지 형태

**앙상블(Ensemble)** — 같은 작업을 여러 에이전트에게 동시에 맡기고, 결과를 비교해
가장 나은 답을 조합합니다. 사용자가 여러 에이전트를 지목했거나, 설계·개선안처럼
모델별 판단이 실제로 갈리는 작업에 적합합니다.

```bash
SPEC="qa-service 개선안을 코드 근거와 함께 제안해줘"
for a in codex kimi; do
  orchestmux spawn --name w_$a --agent $a --yolo
  orchestmux dispatch --task "$(orchestmux task add "$SPEC")" --to w_$a
done
orchestmux wait --count 2 --timeout 1800    # 둘 다 답할 때까지 붙잡습니다
```

`wait`은 보고를 한 번만 소비하므로, 종합을 정리하는 동안(또는 pane을 정리한
뒤에) 다시 읽으려면 `orchestmux report`를 사용하세요.

결과를 종합할 때는 단순히 이어 붙이지 마세요. **여러 에이전트가 동의한 지점**이
가장 강한 신호이므로 그것부터 제시하고, **이견이 갈린 부분**은 직접 코드로 확인한
뒤 어느 쪽이 옳은지 밝히며, **한쪽만 발견한 항목**은 검증한 뒤에 포함하는 것이
좋습니다. 이 종합은 의도적으로 사용자(또는 코디네이터 에이전트)의 몫으로
남겨 두었습니다 — [범위](#범위)를 참고하세요.

**분할(Split)** — 서로 독립적인 조각을 각 워커에 나누어 맡깁니다. 작업이 깔끔하게
분해되고 서로 겹치지 않을 때 적합합니다.

---

## 상태 저장

모든 상태는 `~/.orchestmux/state.db`에 저장됩니다(`ORCHESTMUX_HOME`으로 변경
가능). 워커, 작업, 메시지 로그가 이곳에 기록됩니다.

세션은 기본적으로 tmux 세션 `orchestmux`를 사용하며(`--session` 또는
`ORCHESTMUX_SESSION`으로 변경), 독립된 여러 무리를 나란히 운영할 수 있습니다.

---

## 범위

현재는 코어 루프에 집중하고 있습니다 — spawn · dispatch · wait · report · ask.

아래 항목들은 빠진 것이 아니라 **의도적으로 넣지 않은 것**입니다.

- **워커의 보고를 판정하거나 병합하는 기능.** 합의, best-of-N, 한 에이전트의 diff를
  다른 에이전트가 자동 리뷰하는 기능 모두 없습니다.
- **worktree 격리 및 병합.** 워커들은 지정한 디렉토리를 공유하며, 편집이 서로 부딪히지
  않게 하는 것은 사용자의 몫입니다.
- **작업 의존성 그래프, decision gate, 코디네이터 자동 루프.**
- **재시도 · 비용 · 타임아웃 정책.**

이 중 첫 번째가 핵심 판단입니다. 이 도구의 유일한 주장은 완료가 터미널 출력에서
추론한 결과가 아니라 **기록된 사실**이라는 것인데, "두 답 중 어느 쪽이 더 나은가"는
정확히 그 도구가 대신 하지 않기로 한 종류의 추론입니다. 게다가 코디네이터는 대개
에이전트이고, 그 판단은 여기에 넣을 수 있는 어떤 규칙보다 에이전트가 훨씬 잘합니다.
그래서 orchestmux는 보고를 온전히 전달하는 데까지만 하고 멈춥니다.

나머지 항목은 코어가 실사용에서 충분히 검증될 때까지 보류합니다.

---

## 라이선스

MIT
