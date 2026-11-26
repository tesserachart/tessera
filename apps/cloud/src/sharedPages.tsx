import type { PropsWithChildren } from 'hono/jsx';

import { GLYPHS, type IconName } from '@tessera/ui/glyphs';

import { Markdown } from './markdown.tsx';
import { CSS } from './pages.tsx';
import type {
  ChartShare,
  ConversationShare,
  SetupDocument,
  SetupKind,
  SetupLine,
  SetupShare,
  SharedBlock,
  SharedConversation,
  SharedTurn,
  SharedWork,
} from './shares.ts';

const SHARE_CSS = `
:root{--raise:rgba(220,235,239,.06);--deep:rgba(5,7,12,.3);--aqua:#8ed1fc;--quiet:rgba(220,235,239,.6);
--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace}
.top .try{flex:none}
.gl{display:block;flex:none;width:16px;height:16px}
.gl .cut{display:none}
@media (max-resolution:1dppx){.gl .vec{display:none}.gl .cut{display:inline}}
main.chart{max-width:none;padding:clamp(8px,2vh,24px) clamp(20px,4vw,48px) 64px;display:grid;justify-items:center}
.frame{width:min(100%,var(--w),max(36rem,calc((100svh - 248px) * var(--ratio))));display:grid;gap:16px}
.frame h1{font-size:clamp(2rem,1.6rem + 1.6vw,3rem);margin:0;overflow-wrap:anywhere}
.frame img{display:block;width:100%;height:auto;border:1px solid var(--line);background:var(--ink)}
.when{color:var(--t2);font-size:14px}
.frame .when{justify-self:end;text-align:right}
main.read{max-width:44rem;padding:clamp(16px,5vh,56px) 20px 96px}
.read h1{font-size:clamp(2.25rem,1.7rem + 2.2vw,3.25rem);line-height:1.04;margin-bottom:14px;overflow-wrap:anywhere}
.read .about{color:var(--t2);font-size:17px;overflow-wrap:anywhere}
.turns{display:grid;grid-template-columns:minmax(0,1fr);gap:32px;margin-top:44px}
.you{justify-self:end;display:grid;justify-items:end;gap:6px;max-width:min(88%,36rem);min-width:0}
.you .bubble{padding:10px 14px;background:var(--raise);border:1px solid var(--line);box-shadow:inset -2px 0 0 var(--mist);white-space:pre-wrap;overflow-wrap:anywhere}
.you .files{color:var(--quiet);font-size:13px}
.said{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;min-width:0}
.work summary{display:inline-flex;align-items:center;gap:8px;padding:4px 0;color:var(--t2);font-size:14px;cursor:pointer;list-style:none;user-select:none}
.work summary::-webkit-details-marker{display:none}
.work summary:hover{color:var(--t1)}
.work .cv{transition:transform 160ms cubic-bezier(.23,1,.32,1)}
.work[open] .cv{transform:rotate(90deg)}
.steps{list-style:none;display:grid;gap:2px;margin:6px 0 2px 7px;padding:4px 0 4px 15px;border-left:1px solid var(--line)}
.step{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 0;color:var(--t2);font-size:14px;line-height:1.4}
.step .gl{color:var(--quiet)}
.step .lb{min-width:0;overflow-wrap:anywhere}
.step .mt{flex:none;color:var(--quiet);font-size:13px;font-variant-numeric:tabular-nums}
.step.is-failed .lb{color:var(--t1)}
.step.is-failed .gl,.step.is-failed .mt{color:var(--t1)}
.md{overflow-wrap:anywhere}
.md>*+*{margin-top:14px}
.md h2,.md h3,.md h4{margin-top:28px;line-height:1.3;font-weight:600}
.md h2{font:400 1.75rem/1.15 var(--serif)}
.md h3{font-size:1.06rem}
.md h4{font-size:1rem;color:var(--t2)}
.md ul,.md ol{padding-left:1.4em}
.md li+li,.md li>ul,.md li>ol{margin-top:4px}
.md li>input{margin-right:8px;vertical-align:-1px}
.md strong{font-weight:600}
.md blockquote{padding-left:14px;border-left:1px solid var(--field);color:var(--t2)}
.md hr{border:0;border-top:1px solid var(--line)}
.md :not(pre)>code{padding:1px 5px;background:var(--raise);font:.86em var(--mono)}
.md pre,.code pre{max-width:100%;overflow:auto;padding:12px 14px;background:var(--deep);border:1px solid var(--line);font:13px/1.6 var(--mono);color:var(--t1);tab-size:2}
.md .fn{color:var(--t2);font-size:14px}
.md .plain{white-space:pre-wrap}
.md .fn-label{margin-right:6px}
.md-table{max-width:100%;overflow-x:auto}
.md table{width:auto;font-size:14px;font-variant-numeric:tabular-nums}
.md th,.md td{padding:7px 18px 7px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:normal}
.md th{padding-top:0;color:var(--t2);font-weight:500}
.md .al-r{text-align:right}
.md .al-c{text-align:center}
.res{display:grid;gap:10px;min-width:0;padding:14px 16px;background:var(--raise);border:1px solid var(--line)}
.res[data-kind=hypothesis],.res[data-kind=interpretation]{border-style:dashed}
.res figcaption{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-width:0}
.res .mk{color:var(--t2);font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.res[data-kind=hypothesis] .mk,.res[data-kind=interpretation] .mk{color:var(--aqua)}
.res .rt{font-weight:500;overflow-wrap:anywhere}
.res .md{font-size:15px}
.kv>div{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:8px 0;border-top:1px solid var(--line)}
.kv>div:last-child{border-bottom:1px solid var(--line)}
.res .kv>div:last-child{border-bottom:0;padding-bottom:0}
.kv dt{min-width:0;color:var(--t2);overflow-wrap:anywhere}
.kv dd{display:flex;align-items:baseline;gap:8px;min-width:0;max-width:65%;text-align:right;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sw{flex:none;align-self:center;width:12px;height:12px;border:1px solid var(--field)}
.end{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--t2);font-size:14px}
.setup .kv{margin-top:36px}
.group{margin-top:40px;min-width:0}
.group h2{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.group h2 .gl{color:var(--t2)}
.group h2 .tag{color:var(--t2);font-weight:400}
.group .kv{margin-top:0}
.parts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr));gap:0 32px}
.parts .group{margin-top:32px}
.code pre{max-height:26rem}
.cta{display:grid;gap:12px;margin-top:48px}
.copy{display:flex;gap:8px;min-width:0}
.copy input{flex:1;min-width:0;color:var(--t2)}
.copy .btn[hidden]{display:none}
.cta p{color:var(--t2)}
`;

const COPY_SCRIPT = `for(const b of document.querySelectorAll('[data-copy]')){const f=document.getElementById(b.dataset.copy);if(!f)continue;b.hidden=false;f.addEventListener('focus',()=>f.select());b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(f.value);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy link'},1600)}catch{f.focus();f.select()}})}`;

const SHARED_ON = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

function sharedOn(share: { createdAt: string }): string {
  return SHARED_ON.format(new Date(share.createdAt));
}

interface Page {
  title: string;
  description: string;
  pageUrl: string;
  siteUrl: string;
  image?: { url: string; width: number; height: number };
}

function SharePage(props: PropsWithChildren<Page & { main: string }>) {
  const { title, description, pageUrl, siteUrl, image, main, children } = props;
  const full = `${title} · Tessera`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="referrer" content="no-referrer" />
        <meta name="theme-color" content="#003648" />
        <meta name="description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Tessera" />
        <meta property="og:title" content={full} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={pageUrl} />
        {image === undefined ? null : (
          <>
            <meta property="og:image" content={image.url} />
            <meta property="og:image:width" content={String(image.width)} />
            <meta property="og:image:height" content={String(image.height)} />
          </>
        )}
        <meta name="twitter:card" content={image === undefined ? 'summary' : 'summary_large_image'} />
        <title>{full}</title>
        <link rel="icon" href={`${siteUrl}/favicon.svg`} type="image/svg+xml" />
        <link rel="preload" href="/assets/instrument-sans.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <style dangerouslySetInnerHTML={{ __html: CSS + SHARE_CSS }} />
      </head>
      <body>
        <header class="top">
          <a class="brand" href={siteUrl} aria-label="Tessera">
            <img src="/assets/wordmark.svg" alt="" width="84" height="26" />
          </a>
          <a class="btn btn-s btn-quiet try" href={siteUrl}>
            Try Tessera
          </a>
        </header>
        <main class={main}>{children}</main>
      </body>
    </html>
  );
}

export function SharedChart(props: { share: ChartShare; imageUrl: string; pageUrl: string; siteUrl: string }) {
  const { share, imageUrl, pageUrl, siteUrl } = props;
  const frame = `--w:${String(share.width)}px;--ratio:${(share.width / share.height).toFixed(4)}`;
  return (
    <SharePage
      title={share.title}
      description="A chart shared from Tessera."
      pageUrl={pageUrl}
      siteUrl={siteUrl}
      image={{ url: imageUrl, width: share.width, height: share.height }}
      main="chart"
    >
      <div class="frame" style={frame}>
        <h1>{share.title}</h1>
        <img src={imageUrl} alt={share.title} width={share.width} height={share.height} />
        <p class="when">Shared from Tessera on {sharedOn(share)}</p>
      </div>
    </SharePage>
  );
}

export function SharedConversationPage(props: {
  share: ConversationShare;
  conversation: SharedConversation;
  pageUrl: string;
  siteUrl: string;
}) {
  const { share, conversation, pageUrl, siteUrl } = props;
  return (
    <SharePage
      title={share.title}
      description="A conversation with the analyst in Tessera."
      pageUrl={pageUrl}
      siteUrl={siteUrl}
      main="read"
    >
      <h1>{share.title}</h1>
      <p class="about">A conversation with the analyst</p>
      <div class="turns">
        {conversation.turns.map((turn) => (turn.role === 'user' ? <You turn={turn} /> : <Said turn={turn} />))}
      </div>
      <p class="end">
        Shared from Tessera on {sharedOn(share)}. {conversation.amounts ? 'Amounts shown.' : 'P/L and amounts hidden.'}
      </p>
    </SharePage>
  );
}

function You(props: { turn: Extract<SharedTurn, { role: 'user' }> }) {
  const { text, files } = props.turn;
  return (
    <div class="you">
      {text === '' ? null : <p class="bubble">{text}</p>}
      {files === 0 ? null : <p class="files">{`${count(files, 'attachment')} not shared`}</p>}
    </div>
  );
}

function Said(props: { turn: Extract<SharedTurn, { role: 'analyst' }> }) {
  const { work, workedMs, answer, blocks } = props.turn;
  return (
    <article class="said">
      {work.length === 0 ? null : (
        <details class="work">
          <summary>
            <Glyph name="chevron-right" extra="cv" />
            {foldWords(work, workedMs)}
          </summary>
          <ol class="steps">
            {work.map((step) => (
              <Step step={step} />
            ))}
          </ol>
        </details>
      )}
      {answer === '' ? null : <Markdown text={answer} />}
      {blocks.map((block) => (
        <Result block={block} />
      ))}
    </article>
  );
}

function Step(props: { step: SharedWork }) {
  const { ns, label, meta, failed } = props.step;
  return (
    <li class={failed ? 'step is-failed' : 'step'}>
      <Glyph name={failed ? 'attention' : stepIcon(ns)} />
      <span class="lb">{label}</span>
      {meta === null && !failed ? null : <span class="mt">{meta ?? 'failed'}</span>}
    </li>
  );
}

const EPISTEMIC: Record<SharedBlock['kind'], string> = {
  measured: 'Measured',
  observed: 'Observed',
  hypothesis: 'Hypothesis',
  interpretation: 'Interpretation',
};

function Result(props: { block: SharedBlock }) {
  const { kind, title, text, rows } = props.block;
  return (
    <figure class="res" data-kind={kind}>
      <figcaption>
        <span class="mk">{EPISTEMIC[kind]}</span>
        {title === null || title === '' ? null : <span class="rt">{title}</span>}
      </figcaption>
      {text === '' ? null : <Markdown text={text} />}
      {rows.length === 0 ? null : <Lines lines={rows.map(([label, value]) => ({ label, value }))} />}
    </figure>
  );
}

const CALL_TO_ACTION: Record<SetupKind, string> = {
  indicator: 'Paste this link into Tessera to add it to your charts.',
  template: 'Paste this link into Tessera to use this template.',
  layout: 'Paste this link into Tessera to use this workspace.',
};

export function SharedSetupPage(props: {
  share: SetupShare;
  document: SetupDocument;
  pageUrl: string;
  siteUrl: string;
}) {
  const { share, document, pageUrl, siteUrl } = props;
  const { display } = document;
  const partIcon: IconName = share.kind === 'layout' ? 'chart' : 'indicators';
  return (
    <SharePage
      title={share.title}
      description={CALL_TO_ACTION[share.kind]}
      pageUrl={pageUrl}
      siteUrl={siteUrl}
      main="read setup"
    >
      <h1>{display.name}</h1>
      {display.about === '' ? null : <p class="about">{display.about}</p>}
      {display.lines.length === 0 ? null : <Lines lines={display.lines} />}
      {display.parts.length === 0 ? null : (
        <div class="parts">
          {display.parts.map((part) => (
            <section class="group">
              <h2>
                <Glyph name={partIcon} />
                {part.name}
              </h2>
              <Lines lines={part.lines} />
            </section>
          ))}
        </div>
      )}
      {display.code.map((custom) => (
        <section class="group code">
          <h2>
            <Glyph name="file" />
            {custom.name}
            <span class="tag">Code</span>
          </h2>
          <pre>
            <code>{custom.code}</code>
          </pre>
        </section>
      ))}
      <div class="cta">
        <div class="copy">
          <input type="text" id="share-link" readonly value={pageUrl} aria-label="Link" />
          <button class="btn btn-field" type="button" data-copy="share-link" hidden>
            Copy link
          </button>
        </div>
        <p>{CALL_TO_ACTION[share.kind]}</p>
      </div>
      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </SharePage>
  );
}

const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function Lines(props: { lines: readonly SetupLine[] }) {
  if (props.lines.length === 0) return null;
  return (
    <dl class="kv">
      {props.lines.map(({ label, value }) => (
        <div>
          <dt>{label}</dt>
          <dd>
            {COLOUR.test(value) ? <span class="sw" style={`background:${value}`} /> : null}
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const NAMESPACE_ICONS = new Map<string, IconName>([
  ['chart', 'chart'],
  ['indicators', 'indicators'],
  ['market', 'ticket'],
  ['orders', 'ticket'],
  ['portfolio', 'ticket'],
  ['broker', 'ticket'],
  ['levels', 'levels'],
  ['intel', 'levels'],
  ['concepts', 'levels'],
  ['drawings', 'trend-line'],
  ['settings', 'settings'],
  ['appearance', 'appearance'],
  ['workspace', 'desk'],
  ['layout', 'desk'],
  ['areas', 'desk'],
  ['research', 'research'],
  ['strategy', 'research'],
  ['journal', 'journal'],
  ['connections', 'accounts'],
]);

function stepIcon(ns: string): IconName {
  return NAMESPACE_ICONS.get(ns) ?? 'command';
}

function Glyph(props: { name: IconName; extra?: string }) {
  const glyph = GLYPHS[props.name];
  return (
    <svg
      class={props.extra === undefined ? 'gl' : `gl ${props.extra}`}
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <g class="vec">
        {glyph.stroke === '' ? null : (
          <path
            d={glyph.stroke}
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="square"
            stroke-linejoin="miter"
          />
        )}
        {glyph.fills.map((d) => (
          <path d={d} fill="currentColor" />
        ))}
      </g>
      <path class="cut" d={glyph.cuts[16]} transform="scale(1.25)" fill="currentColor" shape-rendering="crispEdges" />
    </svg>
  );
}

function foldWords(work: readonly SharedWork[], workedMs: number | null): string {
  const failed = work.filter((step) => step.failed).length;
  return [
    workedMs === null ? 'Worked' : `Worked for ${duration(workedMs)}`,
    count(work.length, 'step'),
    failed === 0 ? null : `${String(failed)} failed`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}
