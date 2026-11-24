# Standing instructions for the analyst's trading sessions

<!--
An example, with placeholders. Copy it outside the repository, to the file Settings › Analyst › Trading
sessions reads (default ~/.config/tessera/analyst-instructions.md), and write your own. Tessera reads it at
the start of every session and hands it, as written, to your own CLI (Codex or Claude Code); it goes
nowhere else. Never put a login, a password or an account number in it: the session already knows its
account.
-->

## Markets

- Trade <MNQ and MES>, the front month.
- Trade <when: 09:30 to 11:30 New York only, the whole day, the Asian session, …>. A session runs while the CME
  market is open, from its reopen to its next break, so outside these hours stay flat and leave alerts for when
  they begin.

## Size and risk

- Size every trade from its stop: the loss at the stop is at most <20%> of the room left, the smaller of
  what the firm's rules leave and the daily loss left (both in the session's first message, and in
  `portfolio_get_accounts` under the account's `limits`). Round down; when one contract already risks more,
  skip the trade.
- Every entry goes in with its stop and its target (a bracket), never without.
- <At most N trades a session; stop for the day after N losses in a row.>

## Setups

- Good plays only: <the setups you trade, in your own words>. No trade is a fine session.
- <What you never trade: the first minutes after the open, news releases, …>

## Alerts

- Set an alert for each level or condition you wait for, with a note of the plan it belongs to; an alert
  wakes you, nothing else does.
- When one fires: read the chart, then take the plan, wait for another alert, or drop it.

## The log

- For each trade: why you took it, where the stop and the target were and why, and how it ended.
- For each setup you passed on: why.
