import {
  Approve,
  AuditLine,
  Button,
  Check,
  Choice,
  CommandLine,
  DraftCard,
  EnvWord,
  Field,
  Icon,
  Key,
  Kv,
  Log,
  LogEntry,
  LogFold,
  NowLine,
  PlanStrip,
  PlatformProvider,
  Price,
  PriceInput,
  QtyField,
  Radio,
  Readback,
  Segmented,
  Slip,
  Stat,
  StatusLine,
  Table,
  TextInput,
  TBody,
  TGroup,
  THead,
  Th,
  Tr,
  Td,
  Trust,
  type DraftCardProps,
  type EnvKind,
  PRICE_TEXT,
  STRONG_TEXT,
  META_TEXT,
  FIGURE_CARD_TEXT,
  FIGURE_TEXT,
  formatMoney,
} from '@tessera/ui';
import type { CSSProperties, ReactNode } from 'react';
import { PageShared } from './ControlsKit.tsx';

const noop = () => undefined;
const sel = (v: string) => v;

function Head({ page }: { page: string }) {
  return (
    <header className="kit-head">
      <span>
        <b>Tessera</b> system · 4 Oct 2026
      </span>
      <span>{page}</span>
    </header>
  );
}

function H({
  children,
  small,
  r,
  style,
}: {
  children: ReactNode;
  small?: ReactNode;
  r?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="kit-h" style={style}>
      {children} {small ? <small>{small}</small> : null}
      {r ? <span className="r">{r}</span> : null}
    </div>
  );
}

function ButtonMatrix() {
  const states = ['', 'is-hover', 'is-press', 'is-focus', 'is-disabled'];
  return (
    <div className="btn-m">
      <span />
      {['rest', 'hover', 'press', 'focus', 'disabled'].map((h) => (
        <span key={h} className="h">
          {h}
        </span>
      ))}
      <span className="h">Primary</span>
      {states.map((s) => (
        <span key={s}>
          <Button variant="primary" className={s || undefined}>
            Keep
          </Button>
        </span>
      ))}
      <span className="h">Secondary</span>
      {states.map((s) => (
        <span key={s}>
          <Button className={s || undefined}>Reconnect</Button>
        </span>
      ))}
      <span className="h">Quiet</span>
      {['', 'is-hover', 'is-hover', 'is-focus', 'is-disabled'].map((s, i) => (
        <span key={i}>
          <Button variant="quiet" className={s || undefined}>
            Dismiss
          </Button>
        </span>
      ))}
      <span className="h">Destructive</span>
      {states.map((s) => (
        <span key={s}>
          <Button variant="destructive" what="key" className={s || undefined}>
            Remove
          </Button>
        </span>
      ))}
    </div>
  );
}

function ApproveCell({ env, children, cap }: { env: EnvKind; children: ReactNode; cap: ReactNode }) {
  return (
    <div className="cell" data-env={env}>
      {children}
      <div className="kit-cap">{cap}</div>
    </div>
  );
}

function PageControls() {
  return (
    <section className="kit-page" id="p2">
      <Head page="02 Controls" />
      <div className="abs" style={{ left: 96, top: 104, width: 860 }}>
        <H small="words, square, one mist block per region" r="32 high · small 28 · nothing under 28 × 28">
          Buttons
        </H>
        <ButtonMatrix />
        <div className="kit-note" style={{ marginTop: 12 }}>
          <b>Destructive is never red:</b> red is a loss. It names what it destroys, and runs on one click.
        </div>

        <H
          style={{ marginTop: 24 }}
          small="the one control that commits money"
          r="a button, tabindex −1 · arms after 600 ms · then one click on every environment"
        >
          Approve
        </H>
        <div className="cardband">
          <div className="row" style={{ gap: 12 }}>
            <ApproveCell
              env="paper"
              cap={
                <>
                  <b>Arming</b>, 0–600 ms. aria-disabled.
                </>
              }
            >
              <Approve env="paper" envLabel="on paper" onApprove={noop} still={{ state: 'arming', p: 0.45 }} />
            </ApproveCell>
            <ApproveCell
              env="paper"
              cap={
                <>
                  <b>Armed.</b> Never focused for you.
                </>
              }
            >
              <Approve env="paper" envLabel="on paper" onApprove={noop} still={{ state: 'armed' }} />
            </ApproveCell>
            <ApproveCell
              env="paper"
              cap={
                <>
                  <b>Click.</b> Paper commits here.
                </>
              }
            >
              <Approve
                env="paper"
                envLabel="on paper"
                onApprove={noop}
                still={{ state: 'armed' }}
                className="is-press"
              />
            </ApproveCell>
            <ApproveCell
              env="paper"
              cap={
                <>
                  <b>Approved.</b> Then the audit line.
                </>
              }
            >
              <Approve
                env="paper"
                envLabel="on paper"
                onApprove={noop}
                approved={{ l1: 'Approved', l2: 'on paper · 14:42:31' }}
              />
            </ApproveCell>
            <ApproveCell
              env="eval"
              cap={
                <>
                  <b>Refused</b> before sending. Says why.
                </>
              }
            >
              <Approve
                env="eval"
                envLabel="on Eval 50K"
                onApprove={noop}
                refused={{ l1: 'Refused by risk', l2: '$690.00 of $690.00 left. Not sent.' }}
              />
            </ApproveCell>
          </div>
          <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
            <ApproveCell
              env="eval"
              cap={
                <>
                  <b>Eval:</b> one click, the line in brass.
                </>
              }
            >
              <Approve env="eval" envLabel="on Eval 50K" onApprove={noop} still={{ state: 'armed' }} />
            </ApproveCell>
            <ApproveCell
              env="live"
              cap={
                <>
                  <b>Live:</b> the same as every account.
                </>
              }
            >
              <Approve env="live" envLabel="live · Rithmic 4410" onApprove={noop} still={{ state: 'armed' }} />
            </ApproveCell>
            <ApproveCell
              env="eval"
              cap={
                <>
                  <b>Disarmed:</b> the reason is the label.
                </>
              }
            >
              <Approve
                env="eval"
                envLabel="on Eval 50K"
                onApprove={noop}
                disarmed={{ l1: 'Price 2.4 s behind', l2: 'Rithmic · paused' }}
              />
            </ApproveCell>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="col gap8"
                style={{ background: 'var(--color-ink)', padding: 12, alignItems: 'flex-start' }}
              >
                <div className="row gap12" style={{ alignItems: 'center' }} data-env="paper">
                  <span className="text-t3" style={{ fontSize: 11.5, width: 96 }}>
                    Ticket strip
                  </span>
                  <Approve env="paper" envLabel="on paper" onApprove={noop} inline still={{ state: 'armed' }} />
                </div>
                <div className="row gap12" style={{ alignItems: 'center' }} data-env="eval">
                  <span className="text-t3" style={{ fontSize: 11.5, width: 96 }}>
                    Rail slip
                  </span>
                  <Approve env="eval" envLabel="on Eval 50K" onApprove={noop} inline still={{ state: 'armed' }} />
                </div>
              </div>
              <div className="kit-cap">
                <b>Inline, on ink</b>, only where a draft has no card: the ticket strip with the analyst closed, and the
                collapsed-rail slip. A draft has exactly one approve control on screen.
              </div>
            </div>
          </div>
        </div>

        <H style={{ marginTop: 24 }} small="square, panel ground, a 3:1 edge, teal on focus">
          Fields
        </H>
        <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
          <Field label="User ID" help="Rithmic 01 · Chicago 4 ms" className="kit-w190" htmlFor="kit-user">
            <TextInput id="kit-user" className="is-focus" defaultValue="APEX-48211" />
          </Field>
          <Field label="Password" error="Rithmic refused: password." className="kit-w190" htmlFor="kit-pw">
            <TextInput id="kit-pw" type="password" defaultValue="password" unit="Keyring" />
          </Field>
          <Field label="Limit price" help="↑↓ 1 tick $5.00 · ⇧ 4 ticks" className="kit-w196" htmlFor="kit-limit">
            <PriceInput id="kit-limit" value="20,615.00" onChange={noop} onStep={noop} />
          </Field>
          <div className="t-field">
            <span className="lab">Quantity</span>
            <div className="row gap16">
              <QtyField mode="qty" onModeChange={noop} value="2" onChange={noop} />
              <QtyField mode="risk" onModeChange={noop} value="$680.00" onChange={noop} />
            </div>
            <span className="help">Click the label: Qty ↔ Risk</span>
          </div>
        </div>
        <H style={{ marginTop: 22 }}>The approve contract</H>
        <div className="kit-note kit-contract">
          <span>
            <b>Keys.</b> A &lt;button tabindex=&quot;-1&quot;&gt;: never in the tab order, never focused for you. Focus
            lands on the card; ↓ reaches Approve. A click or ⏎ approves, on every environment.
          </span>
          <span>
            <b>Disarm at once</b> (aria-disabled) when a field changes, the analyst revises, the account switches, the
            price is stale or 2 s behind, or the draft expires.
          </span>
          <span>
            <b>Re-arm</b> 600 ms after the cause clears, from zero. Approval is the human&apos;s act; the broker&apos;s
            answer is the audit line&apos;s second line.
          </span>
        </div>
      </div>

      <div className="abs" style={{ left: 1012, top: 104, width: 812 }}>
        <H small="one grammar, a named Enter" r="no placeholder · the right end says what ⏎ does">
          Command line
        </H>
        <div className="cmdgrid">
          <div className="kit-lab">
            An order you type: parsed here, never by the analyst. The read-back is the confirmation
          </div>
          <div className="cmdbox">
            <Readback>
              <span className="v">Buy 2</span> NQ Z6 <span className="text-t4">·</span> limit{' '}
              <span className={PRICE_TEXT}>20,615.00</span> <span className="text-t4">·</span> stop{' '}
              <span className={PRICE_TEXT}>20,598.00</span> <span className="text-t4">·</span> target{' '}
              <span className={PRICE_TEXT}>20,700.00</span> <span className="text-t4">·</span> risk{' '}
              <span className="v">$680.00</span> <span className="text-t4">·</span> 5.0R{' '}
              <span className="text-t4">·</span> paper
            </Readback>
            <CommandLine
              aria-label="Order"
              value="b 2 615 s 598 t 700"
              onChange={noop}
              readOnly
              enter={[{ shortcut: 'enter', label: 'stage' }]}
            />
          </div>
          <div className="row gap16">
            <div style={{ flex: 1 }}>
              <div className="kit-lab">A question: the line goes to the analyst, so the prompt is aqua</div>
              <div className="cmdbox">
                <CommandLine
                  aria-label="Question"
                  to="analyst"
                  value="why did the flip hold"
                  onChange={noop}
                  readOnly
                  enter={[{ shortcut: 'enter', label: 'ask' }]}
                />
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="kit-lab">A symbol, with a second reading on Tab</div>
              <div className="cmdbox">
                <CommandLine
                  aria-label="Symbol"
                  value="es"
                  onChange={noop}
                  readOnly
                  enter={[
                    { shortcut: 'tab', label: 'ask' },
                    { shortcut: 'enter', label: 'chart' },
                  ]}
                />
              </div>
            </div>
          </div>
          <div className="kit-lab">Inert: the rule binds, so Enter does nothing and says why</div>
          <div className="cmdbox">
            <Readback rule="$690.00 left today · max 1 at this stop ($340.00 + $5.00 slip) · ⇥ size to fit">
              <span className="v">Buy 4</span> NQ Z6 <span className="text-t4">·</span> limit{' '}
              <span className={PRICE_TEXT}>20,615.00</span> <span className="text-t4">·</span> stop{' '}
              <span className={PRICE_TEXT}>20,598.00</span> <span className="text-t4">·</span> risk{' '}
              <span className="v">$1,360.00</span> <span className="text-t4">·</span>{' '}
              <span className="v">Eval 50K</span>
            </Readback>
            <CommandLine
              aria-label="Order"
              value="b 4 615 s 598 @eval"
              onChange={noop}
              readOnly
              enter={{ inert: 'exceeds room' }}
            />
          </div>
        </div>
        <div className="kit-note" style={{ marginTop: 10 }}>
          Typed values t1, assumed values t2; the account always ends the read-back. <b>Colour of the prompt</b>: t2
          while the line is yours (orders, symbols, commands), aqua when it goes to the analyst. Mist is the human, aqua
          the analyst, teal is focus.
        </div>

        <div className="row" style={{ gap: 40, marginTop: 20 }}>
          <div style={{ width: 380 }}>
            <H small="every word a 28 px target">Choices</H>
            <div className="col gap8">
              <div className="row kit-choice-row">
                <span className="kit-note">Segmented, underline</span>
                <Segmented
                  label="Interval"
                  value="5m"
                  onChange={noop}
                  options={['1m', '5m', '15m', '1h', '4h', 'D'].map((v) => ({ value: v, label: v }))}
                />
              </div>
              <div className="row kit-choice-row">
                <span className="kit-note">Toggle: two words, never a switch</span>
                <Choice
                  label="Toggle"
                  value="on"
                  onChange={noop}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'On' },
                  ]}
                />
              </div>
              <div className="row kit-choice-row">
                <span className="kit-note">Choice of three</span>
                <Choice
                  label="On a breach"
                  value="ask"
                  onChange={sel}
                  options={[
                    { value: 'mark', label: 'Mark' },
                    { value: 'ask', label: 'Ask first' },
                    { value: 'block', label: 'Block' },
                  ]}
                />
              </div>
              <div className="row kit-choice-row">
                <span className="kit-note">Checkbox</span>
                <span className="row gap16">
                  <Check checked={false} onChange={noop}>
                    Off
                  </Check>
                  <Check checked onChange={noop}>
                    On
                  </Check>
                  <Check checked="mixed" onChange={noop}>
                    Some
                  </Check>
                  <Check checked={false} disabled onChange={noop}>
                    Off
                  </Check>
                </span>
              </div>
              <div className="row kit-choice-row">
                <span className="kit-note">Radio: the tile</span>
                <span className="row gap16">
                  <Radio name="kit-unit" checked={false} onChange={noop}>
                    $
                  </Radio>
                  <Radio name="kit-unit" checked onChange={noop}>
                    Ticks
                  </Radio>
                  <Radio name="kit-unit" checked={false} onChange={noop} className="kit-focus-box">
                    R
                  </Radio>
                  <Radio name="kit-unit" checked={false} disabled onChange={noop}>
                    %
                  </Radio>
                </span>
              </div>
            </div>
            <H style={{ marginTop: 18 }}>Key hints</H>
            <div className="row gap16">
              {[false, true].map((shown) => (
                <div
                  key={String(shown)}
                  className={shown ? 'navcol show-keys' : 'navcol'}
                  style={{ width: 180, padding: '6px 0' }}
                >
                  <div className="t-areas">
                    <div className="t-area is-on">
                      Trade
                      <Key shortcut="mod+1" />
                    </div>
                    <div className="t-area">
                      Research
                      <Key shortcut="mod+2" />
                    </div>
                    <div className="t-area">
                      Journal
                      <Key shortcut="mod+3" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="kit-cap">
              At rest no keys print. Hold ⌘ 400 ms and they appear beside their words at t3, no keycaps. The card&apos;s
              controls never print a key.
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <H small="each on its layer">Menu, popover, tooltip</H>
            <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
              <div className="t-menu" style={{ width: 196, minWidth: 0 }}>
                <div className="t-menu-item is-on">
                  Chart
                  <Key shortcut="enter" />
                </div>
                <div className="t-menu-item is-hover">
                  Split
                  <Key shortcut="shift+enter" />
                </div>
                <div className="t-menu-item">
                  Ladder
                  <Key shortcut="l" />
                </div>
                <div className="t-menu-item">
                  Footprint
                  <Key shortcut="f" />
                </div>
                <div className="t-menu-sep" />
                <div className="t-menu-item">
                  Copy price
                  <Key shortcut="mod+c" />
                </div>
                <div className="t-menu-item">
                  Study touches<span className="r">Research</span>
                </div>
                <div className="t-menu-item is-disabled">
                  Add to watchlist<span className="r">added</span>
                </div>
              </div>
              <div className="col gap16">
                <div className="t-popover" style={{ width: 178, padding: '12px 14px 13px' }}>
                  <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
                    <span className={STRONG_TEXT} style={{ fontWeight: 500 }}>
                      Flip
                    </span>
                    <Price text="20,610" />
                  </div>
                  <Kv
                    style={{ marginTop: 6, '--row-h-kv': '22px' } as CSSProperties}
                    rows={[
                      { label: 'Source', value: 'Acme 14:30' },
                      { label: 'Touches', value: '3 today' },
                      { label: 'Last', value: 'held 14:36' },
                    ]}
                  />
                </div>
                <span className="t-tip">
                  Trend line <Key shortcut="alt+t" />
                </span>
                <span className="t-tip" style={{ alignSelf: 'flex-start' }}>
                  Last trade <span className="w">6 s</span>
                </span>
              </div>
            </div>
            <div className="kit-cap">
              On panel and raise, t3 lifts to t3-raised (5.0:1). Menu 40, palette 50, tooltip 60: above the chart
              overlay (10), never under it.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PageData() {
  return (
    <section className="kit-page" id="p3">
      <Head page="03 Data" />
      <div className="abs" style={{ left: 96, top: 104, width: 256 }}>
        <H>Watchlist</H>
        <div className="navcol" style={{ padding: '6px 0 0' }}>
          <div className="t-wl is-on">
            <span className="sym">
              NQ Z6 <i className="t-halftile" />
            </span>
            <Price text="20,641.25" />
            <span className="chg down">−0.21%</span>
          </div>
          <div className="t-wl">
            <span className="sym">
              ES Z6 <span className="pos">+2</span>
            </span>
            <Price text="5,583.25" />
            <span className="chg up">+0.30%</span>
          </div>
          <div className="t-wl">
            <span className="sym">
              RTY Z6 <i className="ord" />
            </span>
            <Price text="2,214.60" />
            <span className="chg down">−0.14%</span>
          </div>
          <div className="t-group" style={{ marginTop: 6, paddingTop: 4 }} />
          {[
            ['YM Z6', '42,618', '+0.15%'],
            ['CL Z6', '71.84', '+0.08%'],
            ['GC Z6', '2,652.30', '+0.32%'],
          ].map(([s, p, c]) => (
            <div key={s} className="t-wl">
              <span className="sym">{s}</span>
              <Price text={p} />
              <span className="chg up">{c}</span>
            </div>
          ))}
          <div
            className="t-wl"
            style={{ background: 'var(--color-raise)', '--t3': 'var(--color-t3-raised)' } as CSSProperties}
          >
            <span className="sym">MNQ Z6</span>
            <Price text="20,641.25" />
            <span className="chg up">+0.22%</span>
          </div>
          <div className="t-wl">
            <span className="sym">MES Z6</span>
            <Price text="5,583.25" />
            <span className="chg down">−0.62%</span>
          </div>
          <div className="t-group" style={{ marginTop: 6, paddingTop: 4 }} />
          <div className="t-wl is-stale">
            <span className="sym">
              6E Z6 <span className="age">38 s</span>
            </span>
            <Price text="1.0842" />
            <span className="chg">+0.28%</span>
          </div>
          <div className="t-wl">
            <span className="sym">ZN Z6</span>
            <span className="none">—</span>
            <span />
          </div>
          <div className="t-acct" style={{ marginTop: 12 }}>
            <span className="who">
              <EnvWord env="paper" account="Paper" inherit />
            </span>
            <span className="nl">$124,820.00</span>
            <span className="day up tabular-nums whitespace-nowrap">+$842.00 today</span>
          </div>
        </div>
        <div className="kit-cap">
          <b>Rows</b>: symbol 500, price in Figures 15, change in sans. <b>Selected</b>: the 2 px mist rule, no fill;
          hover raises. <b>Marks</b>: <i className="t-halftile" /> a draft, <span className="text-t2">+2</span> a
          position, a hairline for a working order. <b>Stale</b>: t4-fig plus its age in t2; never red.{' '}
          <b>No line serves it</b>: a dash, never a made-up price.
        </div>
      </div>

      <div className="abs" style={{ left: 408, top: 104, width: 770 }}>
        <H
          small="one order as one sentence, from any source"
          r="the left rule is the chart line · the state is a fixed column"
        >
          The slip
        </H>
        <Slips />
        <div className="kit-cap" style={{ marginTop: 8 }}>
          <b>Draft</b> dashed aqua · <b>staged</b> dashed mist (yours) · <b>working</b> solid ·{' '}
          <b>moving, cancelling</b> dotted until the broker answers · <b>filled</b> the tile · <b>cancelled</b> t3 ·{' '}
          <b>rejected</b> struck, with the reason · <b>unconfirmed</b> an open tile · <b>expired</b> dashed. A rule line
          only when it binds: t3 at caution, brass with a brass rule when it blocks.
        </div>

        <H style={{ marginTop: 20 }} small="orders and fills (O)" r="selected: the mist rule · hover: raise">
          Table
        </H>
        <Table>
          <THead>
            <tr>
              <Th>Time</Th>
              <Th>Order</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Price</Th>
              <Th>Source</Th>
              <Th>Account</Th>
              <Th align="right">State</Th>
            </tr>
          </THead>
          <TBody>
            <TGroup colSpan={7}>Working</TGroup>
            <Tr selected>
              <Td className="tabular-nums whitespace-nowrap">14:42:31</Td>
              <Td>
                <b>Buy limit</b> NQ Z6
              </Td>
              <Td align="right">2</Td>
              <Td className="p">
                <Price text="20,615.00" />
              </Td>
              <Td>analyst draft, approved by you</Td>
              <Td>Paper</Td>
              <Td align="right">512 ahead</Td>
            </Tr>
            <TGroup colSpan={7}>Filled today</TGroup>
            {[
              ['11:24:31', 'Buy stop', '1', '20,613.00', 'you · bracket', '−$180.00', 'down'],
              ['10:12:40', 'Buy limit', '2', '20,548.00', 'you · ladder', '+$360.00', 'up'],
              ['09:52:18', 'Buy limit', '1', '20,547.00', 'you · ladder', '+$240.00', 'up'],
            ].map(([t, o, q, p, s, pl, tone]) => (
              <Tr key={t}>
                <Td className="tabular-nums whitespace-nowrap">{t}</Td>
                <Td>
                  <b>{o}</b> NQ Z6
                </Td>
                <Td align="right">{q}</Td>
                <Td className="p">
                  <Price text={p} />
                </Td>
                <Td>{s}</Td>
                <Td>Eval 50K</Td>
                <Td align="right" className={tone}>
                  {pl}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>

      <div className="abs" style={{ left: 1240, top: 104, width: 584 }}>
        <H small="time, fact, number" r="aqua tick: the analyst wrote it · times t3">
          Log
        </H>
        <Log style={{ background: 'var(--color-ink-2)', border: '1px solid var(--color-line)', padding: '6px 0' }}>
          <LogEntry time="09:31" by="analyst">
            Opened under the flip.
          </LogEntry>
          <LogEntry time="11:20">
            Off plan. Short 1, stopped. <span className="down tabular-nums whitespace-nowrap">−$180.00</span>
          </LogEntry>
          <LogFold>13:00–13:58 · 2 notes</LogFold>
          <LogEntry time="13:58" by="analyst">
            Rejected at VWAP twice. No trade.
          </LogEntry>
          <LogEntry
            time="14:36"
            by="analyst"
            src="First touches of max gamma revert 61.7% vs 51.9% · NQ 5m · n 183 · Gamma reversion v3"
          >
            Reclaimed the flip on 1.8× volume. <b>Plan A</b> triggered.
          </LogEntry>
          <LogEntry time="14:40" by="you">
            you · why did the flip hold
          </LogEntry>
          <LogEntry time="14:42" by="sealed">
            <b>Approved on paper</b> · Buy 2 NQ Z6 at <Price text="20,615.00" /> · you
          </LogEntry>
        </Log>

        <H style={{ marginTop: 20 }} small="ordered by trigger; now slides between">
          Plan strip
        </H>
        <div style={{ background: 'var(--color-ink-2)', border: '1px solid var(--color-line)', padding: '4px 0' }}>
          <PlanStrip
            name="Plan A"
            side="long"
            trigger={
              <>
                reclaim <Price text="20,610" />
              </>
            }
            state="triggered"
            status="triggered 14:36"
            go={{ label: 'draft ›', onClick: noop }}
          />
          <NowLine price="20,641.25" away="Plan B 81.25 away" />
          <PlanStrip
            name="Plan B"
            side="short"
            trigger={
              <>
                under <Price text="20,560" />
              </>
            }
            state="armed"
            status="armed"
            away="81.25 away"
          />
          <PlanStrip
            name="Plan C"
            side="long"
            trigger={
              <>
                over <Price text="20,700" /> <span className="text-t4">·</span> stop{' '}
                <span className="text-t4-fig line-through decoration-1">20,680</span> <Price text="20,684" />
              </>
            }
            state="proposed"
            status={
              <>
                proposed · <span className="accept">accept</span> <Key shortcut="a" held />
              </>
            }
          />
        </div>
        <div className="kit-cap">
          At 1440 and 1280 the distance leaves the strip for the now line, so trigger and state never meet.
        </div>

        <H style={{ marginTop: 18 }} small="tokens read as text until touched">
          Question
        </H>
        <div className="t-question">
          First touch of <span className="t-token">max gamma</span> · <span className="t-token is-hover">NQ 5m</span> ·{' '}
          <span className="t-token">2022-01-03 → 2026-09-30</span> · reverts{' '}
          <span className="t-token is-focus">0.20%</span> before <span className="t-token">0.20%</span> through · within{' '}
          <span className="t-token">24 bars</span> · vs <span className="t-token is-open">matched random times</span>
        </div>
        <div className={META_TEXT} style={{ marginTop: 6 }}>
          1,190 sessions · about 0:50 <span className="text-t4">·</span> hover: dotted · focus: the teal underline, no
          fill · unresolved: dotted, regular
        </div>

        <H
          style={{ marginTop: 18 }}
          small="label · figure · delta · source"
          r="21 by default · .is-focal is the one 30"
        >
          Stat
        </H>
        <div className="row" style={{ gap: 36, alignItems: 'flex-start' }}>
          <Stat
            focal
            label="First touches that reverted"
            figure="61.7%"
            delta="+9.8 pts vs 51.9% baseline"
            src="54.7–68.7 · n 183 · NQ 5m · 2022–2026"
          />
          <Stat label="Net liq · Paper" figure="$124,820.00" delta="+$842.00 today" />
          <Stat weak label="Profit factor" figure="1.72" src="5–95% of shuffled runs">
            <div
              className="t-range"
              style={{ '--lo': '12%', '--hi': '70%', '--at': '84%', width: 110, marginTop: 3 } as CSSProperties}
            >
              <i />
            </div>
          </Stat>
        </div>
        <H style={{ marginTop: 18 }} small="the account sheet" r="label t3 · value t1 · money in Figures">
          Key-value
        </H>
        <Kv
          style={{ width: 380 }}
          rows={[
            {
              label: (
                <>
                  Balance <span className="text-t3">· Eval 50K</span>
                </>
              ),
              value: <Price text="$51,240.00" />,
            },
            {
              label: (
                <>
                  Daily loss left <span className="text-t3">· of $1,000.00</span>
                </>
              ),
              value: <Price text="$690.00" style={{ color: 'var(--color-brass)' }} />,
            },
            {
              label: (
                <>
                  Firm’s drawdown <span className="text-t3">· $3,040.00 above</span>
                </>
              ),
              value: <Price text="$48,200.00" />,
            },
          ]}
        />
      </div>
    </section>
  );
}

function Slips() {
  return (
    <>
      <Slip
        state="draft"
        verb="Buy 2 NQ Z6"
        parts={[
          { w: 'limit', price: '20,615.00' },
          { w: 'stop', price: '20,598.00' },
          { w: 'target', price: '20,700.00' },
          { w: 'risk', text: '$680.00' },
        ]}
        env="paper"
        status="draft"
        statusMore="· 10:30 left"
      />
      <Slip
        state="staged"
        verb="Sell 1 NQ Z6"
        parts={[
          { w: 'limit', price: '20,700.00' },
          { w: 'stop', price: '20,712.00' },
          { w: 'risk', text: '$240.00' },
        ]}
        env="paper"
        status="staged · you · typed"
      />
      <Slip
        state="working"
        verb="Buy 2 NQ Z6"
        parts={[
          { w: 'limit', price: '20,615.00' },
          { w: 'stop', price: '20,598.00' },
          { w: 'target', price: '20,700.00' },
        ]}
        env="paper"
        status="working · 512 ahead"
      />
      <Slip
        state="working"
        verb="Buy 2 NQ Z6"
        parts={[{ w: 'limit', price: '20,615.00' }]}
        env="paper"
        status="1 of 2 filled"
        progress={0.5}
      />
      <Slip
        state="moving"
        verb="Buy 2 NQ Z6"
        parts={[{ w: 'limit', was: '20,615.00', price: '20,618.00' }]}
        env="paper"
        status="moving · sent 14:43:02"
      />
      <Slip
        state="cancelling"
        verb="Sell 1 NQ Z6"
        parts={[{ w: 'limit', price: '20,700.00' }]}
        env="paper"
        status="cancelling · sent 14:50:02"
      />
      <Slip
        state="filled"
        verb="Long 2 NQ Z6"
        parts={[
          { w: 'at', price: '20,615.00' },
          { w: 'stop', price: '20,598.00' },
          { w: 'target', price: '20,700.00' },
          { text: <span className="up tabular-nums whitespace-nowrap">+$1,050.00</span> },
        ]}
        status="filled 14:44:07"
      />
      <Slip
        state="cancelled"
        verb="Sell 1 NQ Z6"
        parts={[{ w: 'limit', price: '20,700.00' }]}
        env="paper"
        status="cancelled 14:50"
      />
      <Slip
        state="rejected"
        verb="Buy 2 NQ Z6"
        parts={[{ w: 'limit', price: '20,615.00' }]}
        env="Eval 50K"
        status="rejected 14:43"
        rule={{ text: 'Rejected by Rithmic: price outside the daily limit. No order working.' }}
      />
      <Slip
        state="unconfirmed"
        verb="Buy 2 NQ Z6"
        parts={[{ w: 'limit', price: '20,615.00' }]}
        env="Eval 50K"
        status="unconfirmed · Tradovate offline"
      />
      <Slip
        state="expired"
        verb="Buy 2 NQ Z6"
        parts={[{ w: 'limit', price: '20,615.00' }]}
        env="paper"
        status="expired 14:53 · not sent"
      />
      <Slip
        state="staged"
        verb="Buy 2 NQ Z6"
        parts={[
          { w: 'limit', price: '20,615.00' },
          { w: 'stop', price: '20,598.00' },
          { w: 'risk', text: '$680.00' },
        ]}
        env="Eval 50K"
        status="staged · blocked"
        rule={{
          text: '$680.00 risk + $10.00 slip = $690.00: all of today’s $690.00. Daily loss blocks it.',
          block: true,
          act: (
            <>
              Size to fit → 1 <Key shortcut="f" />
            </>
          ),
        }}
      />
    </>
  );
}

type CardSpec = Partial<DraftCardProps> & {
  env?: EnvKind;
  qty?: number;
  risk?: number;
  reward?: number;
  cap: ReactNode;
};

function KitDraft({ env = 'paper', qty = 2, risk = 680, reward = 3400, cap, ...rest }: CardSpec) {
  const acct = env === 'paper' ? 'Paper' : env === 'eval' ? 'Eval 50K' : 'Rithmic 4410';
  return (
    <div className="dcell" data-env={env}>
      <DraftCard
        env={env}
        account={acct}
        plan="Plan A · 14:36"
        left="10:30 left"
        order={`Buy ${String(qty)} NQ Z6`}
        price="20,615.00"
        post="limit"
        distance="26.25 below last"
        distanceWide=" · 105 ticks"
        rows={[
          { label: 'Stop', price: '20,598.00', value: formatMoney(-risk) },
          { label: 'Target', price: '20,700.00', value: formatMoney(reward, { signed: true }) },
          { label: 'After fill', text: `Long ${String(qty)}`, value: '5.0R', wide: true },
        ]}
        sum={`${formatMoney(-risk)} · ${formatMoney(reward, { signed: true })} · 5.0R`}
        envLabel={env === 'paper' ? 'on paper' : 'on Eval 50K'}
        onApprove={noop}
        onEdit={noop}
        onReject={noop}
        tabIndex={-1}
        {...rest}
      />
      <div className="kit-cap">{cap}</div>
    </div>
  );
}

function PageTrading() {
  const audit = (state: 'sending' | 'working' | 'rejected' | 'unconfirmed', text: ReactNode, p?: number) => (
    <div
      className="t-audit"
      data-state={state}
      style={{ width: 'auto', padding: '6px 2px 7px', borderTop: 0, ...(p ? { '--p': p } : {}) }}
    >
      <div className="a2" style={{ margin: 0 }}>
        {text}
      </div>
    </div>
  );
  return (
    <section className="kit-page" id="p4">
      <Head page="04 Trading" />
      <div className="abs" style={{ left: 96, top: 104, width: 1150 }}>
        <H
          small="the analyst's proposal · the seam · the human's control"
          r="headed by the keyed T; its analyst half is aqua while the draft waits"
        >
          The draft card
        </H>
        <div className="kit-drafts">
          <KitDraft
            still={{ approve: { state: 'armed' }, mark: { state: 'draft' } }}
            cap={
              <>
                <b>Waiting.</b> The analyst’s half is aqua, one crossbar low. Approve is unfocused.
              </>
            }
          />
          <KitDraft
            env="eval"
            qty={1}
            risk={340}
            reward={1700}
            still={{ approve: { state: 'armed' }, mark: { state: 'rise', p: 0.55 } }}
            room={{
              text: (
                <>
                  $340.00 risk + $5.00 slip uses <b>$345.00</b> of today’s $690.00
                </>
              ),
            }}
            cap={
              <>
                <b>Approved</b> on eval, the half rising. Sized to fit, so the room line is caution, not brass.
              </>
            }
          />
          <KitDraft
            approved={{ at: '14:42:31', l2: 'on paper · 14:42:31' }}
            cap={
              <>
                <b>Approved.</b> The head says so at once; no countdown. The seam lights teal on the card, once; then
                the audit line.
              </>
            }
          />
          <KitDraft
            env="eval"
            refused={{ l1: 'Refused by risk', l2: 'Daily loss: $690.00 left. Not sent.' }}
            room={{
              block: true,
              text: (
                <>
                  $680.00 + $10.00 slip = <b>$690.00</b>, all of today’s room.
                </>
              ),
              fit: 'Size to fit → 1 · F',
            }}
            cap={
              <>
                <b>Refused</b> before sending: the sum, the rule, the fix.
              </>
            }
          />
          <KitDraft
            expired={{ l1: 'Expired 14:53', l2: 'Not sent' }}
            left="expired 14:53"
            cap={
              <>
                <b>Expired.</b> The card goes quiet, the mark rests; then one log line.
              </>
            }
          />
          <div className="dcell">
            <div className="kit-lab" style={{ margin: '2px 0 8px' }}>
              Revised: the old value stays struck; approve re-arms from zero
            </div>
            <div
              style={{
                background: 'var(--color-card)',
                padding: '10px 12px',
                display: 'grid',
                gridTemplateColumns: '1fr 136px',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <div className="t-card" style={{ display: 'block', background: 'none' }}>
                <div className="o2" style={{ margin: 0 }}>
                  at<span className={FIGURE_CARD_TEXT}>20,618.00</span>
                  <span className="was">20,615.00</span>
                </div>
              </div>
              <Approve
                env="paper"
                envLabel="on paper"
                onApprove={noop}
                still={{ state: 'arming', p: 0.3 }}
                className="kit-approve-s"
              />
            </div>
            <div className="kit-lab" style={{ margin: '16px 0 0' }}>
              After approval: your act, then the broker’s answer
            </div>
            <div
              style={{
                borderTop: '1px solid var(--color-line)',
                borderBottom: '1px solid var(--color-line)',
                padding: '4px 0 2px',
              }}
            >
              <AuditLine
                act="Approved on paper"
                at="14:42:31 · you"
                style={{ width: 'auto', padding: '8px 2px 6px', border: 0 }}
              />
              {audit(
                'sending',
                <>
                  <b>Sending</b>
                  <span className="text-t4">·</span>Buy 2 NQ Z6
                  <Price text="20,615.00" />
                </>,
                0.45,
              )}
              {audit(
                'working',
                <>
                  <b>Working</b>
                  <span className="text-t4">·</span>
                  <Price text="20,615.00" />
                  <span className="text-t4">·</span>512 ahead
                </>,
              )}
              {audit(
                'rejected',
                <>
                  <b>Rejected by Rithmic</b>
                  <span className="text-t4">·</span>no order working
                </>,
              )}
              {audit(
                'unconfirmed',
                <>
                  <Icon name="attention" />
                  <b>Unconfirmed</b>
                  <span className="text-t4">·</span>Tradovate silent, checking
                </>,
              )}
            </div>
            <div className="kit-cap">
              One of the four follows the approval line. Never “sent” until the broker says so.
            </div>
          </div>
        </div>
      </div>

      <div className="abs" style={{ left: 1300, top: 104, width: 524 }}>
        <H small="shown on the number itself" r="nothing · dim · hatch">
          Trust
        </H>
        {(
          [
            ['Live', 'Talking, lag under 1 s. Nothing is shown.', 'live', '20,641.25', undefined],
            ['Quiet', 'Talking, no new prints. Nothing; the age shows on hover.', 'quiet', '20,641.25', undefined],
            ['Behind', 'Prints arrive late. t3 and the lag. Disarms at 2 s.', 'behind', '20,641.25', '1.8 s behind'],
            [
              'Stale',
              'Silent past the threshold. t4-fig (3.5:1) and the age in t2. Disarms.',
              'stale',
              '20,641.25',
              'No ticks 4 s · approval paused',
            ],
            [
              'Invalid',
              'Computed from a down source. Hatched, with its as-of.',
              'invalid',
              '+$1,050.00',
              'at 20,641.25 · 14:42:30',
            ],
          ] as const
        ).map(([nm, note, trust, fig, age]) => (
          <div key={nm} className="trust-row">
            <span className="nm">{nm}</span>
            <span className="kit-note">{note}</span>
            <Trust trust={trust} age={age}>
              <span className={FIGURE_TEXT}>{fig}</span>
            </Trust>
          </div>
        ))}
        <div className="kit-note" style={{ marginTop: 10 }}>
          Red never means stale. A stale or invalid number disarms every send and approve that depends on it, and the
          reason is the label.
        </div>

        <H
          style={{ marginTop: 22 }}
          small="fact · consequence · next"
          r="a 1 px rule: t3 caution, brass when money is at risk"
        >
          Status lines
        </H>
        <div className="col" style={{ gap: 8 }}>
          <StatusLine kind="caution" src="Rithmic" fact="quiet 12s." next="Checking." />
          <StatusLine
            kind="exposure"
            src="Tradovate"
            fact="dropped."
            exposure="Long 2 held at Tradovate."
            next="2nd try."
            action={{ label: 'Tradovate', shortcut: 'mod+o', onClick: noop }}
          />
          <StatusLine kind="receipt" src="Back 14:44:02" next="out 1m 31s. Bracket matches. No fills while out." />
          <StatusLine
            kind="caution"
            src="Acme"
            fact="levels 72 min old."
            next="Retrying 14:45."
            more={1}
            className="kit-more"
          />
          <StatusLine
            band
            kind="caution"
            src="Rithmic"
            fact="4 s behind."
            next="Drafts paused."
            style={{ background: 'var(--color-ink-2)' }}
          >
            <span className="text-t3" style={{ width: '100%', fontSize: 11.5 }}>
              The analyst&apos;s band: the same line inside the column, one at a time.
            </span>
          </StatusLine>
        </div>
        <div className="kit-cap">
          The stage&apos;s slot: one 36 px line under the instrument line; it pushes the chart down.
        </div>
      </div>

      <div className="abs" style={{ left: 96, top: 830, width: 1728 }}>
        <H
          style={{ marginBottom: 10 }}
          small="always visible, one source of truth"
          r="data-env on <html>; every word and label reads it · every account looks alike, the word names it"
        >
          Environment
        </H>
        {(['paper', 'eval', 'live'] as const).map((env) => (
          <div key={env} className="envbar" data-env={env}>
            <span className="nm">{env[0]!.toUpperCase() + env.slice(1)}</span>
            <div className="frame">
              <header className="kit-stagebar">
                <div className="t-instr">
                  <b>NQ Z6</b>
                  <span>E-mini Nasdaq-100 · CME</span>
                </div>
                <div className="t-quote">
                  <span className={FIGURE_TEXT}>20,641.25</span>
                  <span className="down tabular-nums whitespace-nowrap">−42.50 · −0.21%</span>
                </div>
                <span className="t-interval">5m</span>
                <div className="t-ctx">
                  <span className="ph">
                    Regular <span className="text-t4">·</span> closes in 1:17:30
                  </span>
                </div>
                <span className="t-vr" />
                <span className="t-src">Rithmic</span>
                <span className="t-vr" />
                <EnvWord
                  env={env}
                  inherit
                  style={{ display: 'inline-flex' }}
                  account={env === 'paper' ? 'Paper' : env === 'eval' ? 'Eval 50K' : 'Rithmic 4410'}
                  left={env === 'eval' ? '$690.00 left today' : undefined}
                />
              </header>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PageSizes() {
  return (
    <section className="kit-page kit-fluid" id="p14">
      <Head page="14 Sizes · this window" />
      <div className="abs" style={{ left: 96, top: 104 }}>
        <div className="row" style={{ gap: 48, alignItems: 'flex-start' }}>
          <div>
            <H small="--analyst-w: 392 · 344; the distance moves to the now line at 1599 and under">Plan rack</H>
            <div className="kit-col">
              <PlanStrip
                name="Plan A"
                side="long"
                trigger={
                  <>
                    reclaim <Price text="20,610" />
                  </>
                }
                state="triggered"
                status="triggered 14:36"
              />
              <NowLine price="20,641.25" away="Plan B 81.25 away" />
              <PlanStrip
                name="Plan B"
                side="short"
                trigger={
                  <>
                    under <Price text="20,560" />
                  </>
                }
                state="armed"
                status="armed"
                away="81.25 away"
              />
              <PlanStrip
                name="Plan C"
                side="short"
                trigger={
                  <>
                    under <Price text="20,520" />
                  </>
                }
                state="void"
                status="void 13:58"
              />
            </div>
            <H style={{ marginTop: 24 }} small="one line, under the instrument line">
              Status line
            </H>
            <div className="kit-col">
              <StatusLine kind="caution" src="Rithmic" fact="quiet 12s." next="Checking." />
            </div>
          </div>
          <div>
            <H small="--draft-w: 360 · 312; under 330 one money line, no After fill">The draft card</H>
            <KitDraft
              cap={
                <>
                  <b>Waiting.</b> The card follows the column; the approve block is 136 or 112.
                </>
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function Kit({ page }: { page: string }) {
  return (
    <PlatformProvider value="mac">
      {page === '3' ? (
        <PageData />
      ) : page === '4' ? (
        <PageTrading />
      ) : page === '5' ? (
        <PageShared />
      ) : page === '14' ? (
        <PageSizes />
      ) : (
        <PageControls />
      )}
    </PlatformProvider>
  );
}
