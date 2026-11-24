# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
- **Desktop:** Tauri 2 shell around a React/TypeScript/Vite UI, with a local Rust runtime sidecar. The same UI also runs in a plain browser.
- **Cloud:** Tessera Cloud, one Cloudflare Worker for accounts, alpha access and check-ins; a build without it has no accounts.
- **Source of truth:** `docs/architecture.md`.

## Users
- **Primary:** professional futures and prop-firm traders.
  - They trade NQ and ES on one or more prop accounts.
  - They are used to DeepCharts-class order-flow tools and gamma levels from paid services.
  - They spend hours a day in the app during US cash hours, with research and journaling before the open and after the close.
- **Secondary:** the same people working as quant researchers, testing ideas without writing code.
- **Scope:** the alpha is for futures traders, on macOS, Windows and Linux. Market data and instruments come from the trader's own Rithmic login; the core stays multi-asset for connections that serve more.

## Product Purpose
- **What it is:** an agent-first trading terminal. The user's own AI works inside the platform as an operator. It reads charts and levels, runs event studies and backtests, reviews the journal and portfolio, and drafts orders the user approves.
- **What success means:**
  - the trader acts faster and with more evidence;
  - the trader never loses control of what gets sent.

## Positioning
- **AI:** the user brings their own. Tessera drives their ChatGPT/Codex or Claude subscription CLI, or any MCP client drives Tessera. There is no house AI and no API keys.
- **Data:** all market data comes from the user's own connections: Rithmic today, for any prop firm or broker on it (market data, accounts and orders), and the intelligence subscriptions they add themselves: any levels API, from its docs, through the analyst. Tradovate, ProjectX, TopstepX and NinjaTrader trades come into the journal as file imports, not as live connections. Tessera sells no data.
- **Tools:** one tool system is shared by the UI, the agent and MCP.
- **Orders:** an agent drafts and the human approves, unless the user gives that agent session Full access.

## Operating Context
- **Sessions and hardware:** long live sessions, dense data, often multi-monitor, keyboard-heavy. A trader watching price must not be distracted.
- **Moments:** pre-market prep, RTH execution, research after hours, and journal review.
- **Environments:** paper, evaluation, funded and live, which must always be unmistakable.

## Capabilities and Constraints
- **Trading surface:** charts with order flow (footprint, volume profile), gamma levels with vendor identity preserved, and a DOM ladder with order entry.
- **Accounts:** a paper broker, prop firm rules and risk limits, and a trade copier.
- **Research and journal:** research engine (event studies, backtests, experiment budget), and a fills-first journal.
- **Agent and integrations:** analyst sessions with a transcript and approvals, sessions the analyst trades on its own, and an MCP server for the user's own agents.
- **Order safety:** every agent order is a draft that waits for explicit human approval, unless the user turned on Full access for that session. Approval never fires on Enter, and the environment is shown in plain words.
- **Data honesty:** vendor gamma levels keep their vendor identity, and converted levels are labelled.
- **Undecided:** paid fonts (none licensed yet) and a light theme.

## Brand Commitments
- **Binding (owner):** the name **Tessera** (domain TesseraChart.com). The meaning (a Roman tessera: a mosaic tile, and a token broken in two whose halves prove a pact) is available as a story, not mandated.
- **Owner preferences** (stated in conversation, not marked binding):
  - the layout of the first direction: a Codex/T3-style quiet left sidebar, a full-bleed chart stage, a right agent conversation column, a bottom positions strip;
  - DeepCharts and the Codex desktop app as layout references.
- **Owner rejections, repeated:**
  - "vibe coded" fonts, colour schemes and icons;
  - big bold AI titles and H1/H2 headline patterns;
  - base shadcn-looking components;
  - a soulless 4-block logo;
  - loud saturated palettes ("attack on the senses").

## Evidence on Hand
- **Real integrations verified:** a gamma-levels API added through the analyst from its public docs; a Rithmic login (Apex) with trades and depth by order.
- **Missing:** no testimonials, customers, metrics or press exist. Do not invent them.

## Product Principles
1. **The chart is the room.** Nothing covers price while the trader is executing.
2. **The agent is an operator, not a chatbot.** It shows what it did, what it measured, how sure it is, and what it needs from you.
3. **Nothing financial moves without your half.** Every agent order is a draft until you approve it in plain, unmistakable terms, or until you give that session Full access yourself.
4. **Honest evidence.** Measured vs observed vs hypothesis vs interpretation. Sample sizes and variants tried are always visible.
5. **Your data, your AI.** Tessera never pretends to own the user's data or intelligence.

## Accessibility & Inclusion
- **Colour:** up/down colours must stay distinguishable for colour-blind traders. Sign and shape cues back up colour.
- **Long sessions:** dense screens with sufficient contrast for nine-hour use.
