# Sharing

A signed-in trader shares what a chart shows as an unlisted link. The link opens for anyone who has it, signed out: the chart's picture, its instrument and timeframe, and the Tessera mark, never the account. Nothing lists, searches or posts it. The owner sees their links in Settings › App › Shares and deleting one makes the link and its picture stop opening at once.

## Sub-features

- `offer` is `menuitem "Share chart…"` in a chart's menu (`button "Chart: more"`, or right-click the chart's tab). It shows only while the account is signed in with access and Tessera Cloud says it can keep pictures (the `share` entitlement on `account.status`). Signed out, on a Cloud with no picture bucket, or on main, it is not there.
- `dialog` is `dialog "Share chart"`. It opens on the picture (`Picturing the chart…`, then the picture with `Orders, positions and P/L are left out. Nothing is shared until you create a link.`, `button "Cancel"` and `button "Create link"`). Nothing is uploaded and `share.list` is unchanged until Create link. Then `Making a link…`, then `textbox "Link"` holding `<cloud>/s/<12 letters and digits>`, `button "Copy link"`, `button "Open"` and `button "Done"`. A failure says what happened in plain words and ends on `button "Close"`.
- `picture` is only that chart's canvas (`[data-chart-canvas="<tile id>"]`), not its bar, the layer strip or the ticket. It goes through the feedback capture (`apps/desktop/src/feedback/capture.ts`) with every account's id, name and masked number hidden, paper ones too. It never carries trading state: while it is taken the chart hides its `orders` layer (order and position lines with their size and P/L) and the bar countdown (`apps/desktop/src/share/quiet.ts`), and the order tags (`[data-trading-state]`), toolbars, menus and dialogs are left out. The chart on screen gets them back as soon as the picture is taken.
- `page` is `GET /s/<id>` on the Cloud: the Tessera wordmark linking to the site, `<instrument> · <timeframe>` large under it, the picture and `Shared from Tessera on <date>`. It fits a phone (390 px) without sideways scroll. It and `/s/<id>/image` are sent `x-robots-tag: noindex, nofollow, noarchive`, `cache-control: no-store` and `referrer-policy: no-referrer`. An unknown or deleted id answers 404 `This link doesn’t work`.
- `list` is `region "Shares"` in Settings › App: one row per link, newest first, titled by the chart with `Shared <date>` and `Copy link`, `Open`, `Delete`. Delete asks `Delete this link?` then `Delete link`. With none it says `Nothing shared yet`. It is not there unless sharing is offered.

## How to get to it (user POV)

Sign in to Tessera, open a chart's menu and pick Share chart…. Settings › App › Shares lists what you shared.

## Driving it

The sim has no Tessera account, so a session alone cannot share. `../scripts/share.ts [evidence dir] [ui dir] [pr|main]` proves it end to end without a login: it starts `share-cloud.ts` (run by Bun), the real Cloud app (`apps/cloud/src/app.ts`) on a Miniflare D1 with pictures kept in memory and an identity that signs in at once and grants `early_access`, then the sim runtime with `TESSERA_TEST_ACCOUNTS=1` and `TESSERA_CLOUD_URL` at it. It signs in through `account.sign_in`, holds a bracketed 2-lot NQ position and a working limit on Paper so the chart shows order and position tags with P/L, opens the desk as the desktop app, picks Share chart… on the first chart, checks nothing is shared before Create link, creates the link, opens the link in a fresh signed-out browser and checks the mark, the title, the headers and that no account id or email is on the page, opens it again at phone width and checks it does not scroll sideways, closes the dialog with Done, then deletes the link from Settings › App › Shares and checks the page and picture answer 404. It shoots `pr-chart-menu.png`, `pr-share-ready.png`, `pr-shared-dialog.png`, `pr-shared-page.png`, `pr-shared-page-phone.png`, `pr-settings-shares.png`, `pr-settings-delete-confirm.png`, `pr-settings-shares-empty.png` and `pr-deleted-link.png`, and saves `shared-image.png` (the uploaded picture: it must show no order or position tag, line or P/L, and no countdown under the last price), `share-list.json` and `share-list-after-delete.json`. `main` with main's `dist` shoots the chart menu and Settings › App, which have no sharing.

## End states

- Shared: `share.list` holds one link whose `url` matches the dialog's; the page answers 200 signed out.
- Deleted: `share.list` is empty; `/s/<id>` and `/s/<id>/image` answer 404.

## Gotchas

- Production Cloud has no picture bucket, so sharing is off there until the owner binds `SHARE_IMAGES` (`apps/cloud/wrangler.jsonc`); staging binds `tessera-shares-staging`.
- The picture takes a few seconds on a busy desk, like the feedback picture.
