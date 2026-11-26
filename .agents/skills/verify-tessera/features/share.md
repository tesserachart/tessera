# Sharing

A trader shares what they see as an unlisted link: a chart's picture, an analyst conversation, or an indicator, chart template or workspace by its settings. The link opens for anyone who has it, signed out, on a Tessera-looking page with the mark and a `Try Tessera` link and nothing about the account. Nothing lists, searches or posts it. Pasting a settings link into Tessera offers to add it. The owner sees their links in Settings › App › Shares, and deleting one makes its page, picture and settings stop opening at once.

## Sub-features

- `chart` is `menuitem "Share chart…"` in a chart's menu (`button "Chart: more"`, or right-click the chart's tab) and the command `Share chart…` on ⌘⇧S / Ctrl+Shift+S, in the main window and in pop-outs, acting on the active chart. `dialog "Share chart"` opens on the picture (`Picturing the chart…`, then the picture, the lines on what is left out and what is in it, `button "Copy picture"`, `button "Cancel"` and, only while sharing is offered, `button "Create link"`). Copy picture works signed out: it puts the picture on the clipboard as `image/png` and reads `Copied`. Nothing is uploaded and `share.list` is unchanged until Create link. Then `textbox "Link"` holding `<cloud>/s/<12 letters and digits>`, `button "Copy link"`, `button "Open"` and `button "Done"`.
- `picture` is only that chart's canvas (`[data-chart-canvas="<tile id>"]`) through the feedback capture with every account's id, name and masked number hidden, paper ones too, and a small Tessera wordmark bottom-right. It never carries trading state: the orders layer, the bar countdown, the order tags (`[data-trading-state]`), toolbars, menus and dialogs are left out while it is taken.
- `conversation` is `menuitem "Share conversation…"` in the analyst's session menu (`button "Session: <title>"`), a session row's menu and the analyst tab's menu, while sharing is offered. `dialog "Share conversation"` shows `region "The conversation as it is shared"`: what was said and the steps the analyst took (each tool's own title), never a tool's arguments or answer, cards, approvals or attachments. Every account's words, links, hosts, emails and secrets are taken out, position sizes read `[size]` and money `[amount]` unless `switch "Show P/L"` is on (sizes and accounts stay hidden either way). The runtime builds it from the stored session (`share.preview_conversation`, `share.conversation`), never from what the desk sends.
- `setup` is `menuitem "Share…"` on an indicator's legend menu (`button "<name>: menu"`), a custom indicator's More menu in Indicators, one of the user's own templates in the template menu, and the workspace section of the Tessera menu (`button "Tessera menu: …"`). `dialog "Share indicator"`, `"Share template"` or `"Share workspace"` says it carries settings only, and that a custom indicator's code is on the page. The runtime builds the settings from what it stored (`share.setup`), by allowlist: a workspace keeps its charts, their indicators and the desk's arrangement, never the ticket's account, a tile's account, drawings, notes, pop-out windows or an agent's layers.
- `open` is a pasted share link anywhere on the desk outside a text field, or the command `Open a shared link…` (`dialog "Open a shared link"`, `textbox "Link"`, `button "Open"`). It works signed out and only for links on this Tessera's own Cloud (`share.open`). `dialog "Shared indicator"`, `"Shared template"` or `"Shared workspace"` shows the name, what it is, its settings (colours with a swatch) and `Brings its own code` for a custom one, with `button "Add to my charts"` (onto the active chart), `button "Use this template"` (saved, and applied to the active chart) or `button "Use this workspace"` (saved as a new workspace and shown). `share.add` creates a custom indicator from the shared code, reusing one with the same name and code.
- `pages` are on the Cloud: `GET /s/<id>` for every kind, `/s/<id>/image` for a chart and `/s/<id>/setup` (JSON) for an indicator, template or workspace, all sent `x-robots-tag: noindex, nofollow, noarchive`, `cache-control: no-store` and `referrer-policy: no-referrer`. A conversation page reads like the chat: the trader's messages, each turn's steps folded under `Worked for …`, the answer and its Measured, Observed, Hypothesis and Interpretation blocks, and a footer saying whether amounts are hidden. A settings page shows the name, its settings, each part, any custom code, and `button "Copy link"` with the line to paste it into Tessera. Every page fits a phone (390 px) without sideways scroll. An unknown or deleted id answers 404 `This link doesn’t work`.
- `list` is `region "Shares"` in Settings › App: one row per link, newest first, titled with its kind and date, with `Copy link`, `Open` and `Delete` (`Delete this link?`, then `Delete link`). With none it says `Nothing shared yet`. It is not there unless sharing is offered.

## How to get to it (user POV)

Sign in to Tessera. Share a chart from its menu or with ⌘⇧S, a conversation from the analyst's session menu, an indicator from its legend, a template from the template menu, a workspace from the Tessera menu. Paste a shared link into Tessera to add it. Settings › App › Shares lists what you shared.

## Driving it

The sim has no Tessera account, so a session alone cannot share. `../scripts/share.ts [evidence dir] [ui dir] [pr|main]` proves it end to end without a login. It starts `share-cloud.ts` (run by Bun): the real Cloud app (`apps/cloud/src/app.ts`) on a Miniflare D1 with bodies kept in memory and an identity that signs in at once and grants `early_access`. It starts the sim runtime with `TESSERA_TEST_ACCOUNTS=1` and `TESSERA_CLOUD_URL` at it, signs in through `account.sign_in`, and holds a bracketed 2-lot NQ position and a working limit on Paper. Then, on the desk:

- the chart: ⌘⇧S, Copy picture (the clipboard holds a PNG, saved as `copied-picture.png`), Create link, the page signed out at desktop and phone width;
- the conversation: the analyst runs on `stand-in-claude.mjs`, whose `Share proof:` turn reads Paper's positions and answers with the account id, `long 2 contracts` and the open P&L; the preview hides all three, Show P/L brings back only the amount, the page holds none;
- a custom indicator (`Proof EMA`) on the chart: Share… from its legend, the page shows its code, and `/setup` answers;
- a template (through `share.setup`) and the workspace (Tessera menu › Share…);
- imports: `Open a shared link…` adds the indicator to a second workspace; a second sim runtime, signed out, takes the pasted indicator link (the custom indicator arrives with its code unchanged), the template and the workspace (no ticket account);
- Settings › App › Shares lists all five kinds and deletes each; every page, picture and settings answer 404, and the second Tessera says the link doesn’t work.

Stills are `pr-*.png` in the evidence dir, with `shared-image.png`, `copied-picture.png`, the setups and `share-list*.json`. `main` with main's `dist` shoots the chart menu and Settings › App, which have no sharing.

## End states

- Shared: `share.list` holds one link of each kind; each page answers 200 signed out.
- Added: the second workspace's chart and the second Tessera's chart have a `custom` layer; the second Tessera's `indicators.get` has the same code; its `chart.list_templates` has `Proof template`; its `layout.list` has the added workspace.
- Deleted: `share.list` is empty; `/s/<id>`, `/s/<id>/image` and `/s/<id>/setup` answer 404.

## Gotchas

- Production Cloud has no share bucket, so sharing is off there until the owner binds `SHARE_IMAGES` (`apps/cloud/wrangler.jsonc`); staging binds `tessera-shares-staging`. Copy picture and opening a link need no bucket.
- The picture takes a few seconds on a busy desk, like the feedback picture.
- Tessera has no URL scheme, so a page cannot open the app; the page says to paste the link.
