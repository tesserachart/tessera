# Strategies between Research, the analyst and the journal

A frozen Research study can be handed to the analyst's trading sessions: Tessera reads the study's signal at each close of its bars, wakes the analyst when it changes, and at the close files the session's trades in the journal under a setup linked to the study. A journal setup opens back in Research: the study it is linked to, or a new draft study that replays the setup's closed trades.

## Sub-features

- `sf-trade` a frozen study's `Setup` tab has `Have the analyst trade it`. Pressed, it sets `agent.sessionRunner.studyId` and reads `Stop the analyst trading it`, beside a quiet button with the sessions' standing (`Trading sessions are off`, `Not ready: …`, `Trading since …`) that opens Settings › Analyst › Trading sessions. A draft has no such button.
- `sf-setting` Settings › Analyst › Trading sessions has `Study it trades` (`None` or a frozen study). With a study, a missing instructions file does not stop a session: its help reads `None at <path>: the study decides`.
- `sf-session` the session's opening names the study, its hypothesis, its latest run as measured on history ("That measures the past, not what it will do today"), and its signal now (`long 1 since the <time> bar, stop … and target … in price from the fill`). `research.study_signal` gives the same at any time. When the signal changes at a bar close, the analyst gets `Tessera: the study "<name>" went from <was> to <now> at the close of the <time> bar…`.
- `sf-journal` at the close the session's trades carry the setup named after the study (`journal.get_catalog` shows `studyId`); the report's log starts `Traded the Research study "<name>".`. The study pane then shows `<n> trades in the journal · net … · …% won`, which opens the journal's trades of that setup.
- `sf-back` Journal › Playbooks: a setup linked to a study has `Open its study`; a setup with closed trades and no study has `Study it in Research`, which registers `<setup> · journaled trades` (`research.study_trades`: a script replaying each trade from the open of its entry bar to the open of its exit bar, with notes naming what was left out), links the setup to it and opens it in Research.

## How to get to it (user POV)

- Research › a frozen study's run › `Setup`: `Have the analyst trade it`.
- Settings › Analyst › Trading sessions › `Study it trades`.
- Journal › Playbooks › a setup › header: `Open its study` or `Study it in Research`.

## Driving it

- **Sessions need a moving market and an analyst.** Use the busy market (`TESSERA_TEST_MARKET=busy`, `docs/dev.md` §9): its clock starts at the Friday 09:30 New York open, so `Trade every session` starts a session within seconds. Paper needs a daily loss limit, a max position and a max risk per trade (`settings.set risk.limits`).
- **An automated sim run never turns on a real model.** Point the providers at the stand-in CLIs (`analyst-queue.md`). They prove the session opens with the study, but not that the analyst trades it.
- **Real Codex, by hand only.** To watch the analyst actually trade the study, a person runs the app by hand and turns on Codex in Settings › Analyst › Models (your own ChatGPT login in `~/.codex`, HOME passed through). An agent never does this step.
- **Study.** `research.save_study` an NQ 1m EMA cross (fast 5, slow 13, stop 40 and target 80 ticks), `research.freeze_study`, `research.run_study`; Research shows its run. Then `Have the analyst trade it`, account Paper and the model in Trading sessions, and `Trade every session` on.
- **End state.** `agent.trading_session` reads phase `trading` with `setting.studyId`; `agent.get_transcript` holds the opening with the study; Paper holds the study's position. Turning `Trade every session` off closes the session out: the journal holds its trades under the study's setup.
- **Back.** Journal › Playbooks, the study's setup: `Open its study` selects the study in Research. A setup made by hand with closed trades: `Study it in Research`, then `Run` measures the replay against its placebo.

## Gotchas

- The frozen market never closes a bar, so the signal is read once at the start and never changes there.
- On the busy tape a 10-point stop is hit within seconds, so a study's trades open and close quickly.
- Playwright's `click` in Settings can wait forever for the page to be "stable" on the busy sim; click by the element's box (`page.mouse.click`).
