import type { Child, PropsWithChildren } from 'hono/jsx';

import { chosenFirst, type Download, type Platform, PLATFORM_NAMES } from '@tessera/ui/downloads';

import type { Applicant, Application, Invite, User } from './store.ts';

export const CSS = `
@font-face{font-family:'Instrument Sans';src:url(/assets/instrument-sans.woff2) format('woff2');font-weight:400 700;font-display:swap}
@font-face{font-family:'Instrument Serif';src:url(/assets/instrument-serif.woff2) format('woff2');font-weight:400;font-display:swap}
:root{color-scheme:dark;--petrol:#003648;--mist:#dcebef;--mist-press:#c5d8dd;--t1:#dcebef;--t2:#96b1ba;--ink:#05070c;--teal:#18849a;
--line:rgba(220,235,239,.16);--field:rgba(220,235,239,.38);--field-hover:rgba(220,235,239,.5);--well:rgba(5,7,12,.18);
--serif:'Instrument Serif','Times New Roman',serif;--sans:'Instrument Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
*,*::before,*::after{box-sizing:border-box;margin:0}
body{min-height:100svh;background:var(--petrol);color:var(--t1);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;font-synthesis:none}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--field);text-underline-offset:.22em;text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--t1)}
::selection{background:rgba(24,132,154,.6)}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.top{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px clamp(20px,4vw,48px)}
.top .brand{display:block;padding:4px 0}
.top img{display:block;height:26px;width:auto}
.who{display:flex;align-items:center;gap:20px;color:var(--t2);font-size:14px;min-width:0}
.who .email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who form{display:contents}
.plain{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:var(--field);text-underline-offset:.22em}
.plain:hover{color:var(--t1);text-decoration-color:var(--t1)}
main{width:100%;max-width:36rem;margin:0 auto;padding:clamp(32px,8vh,96px) 20px 96px}
main.wide{max-width:1360px;padding-inline:clamp(20px,4vw,48px)}
h1{font:400 clamp(2.5rem,1.7rem + 3vw,3.75rem)/1 var(--serif);letter-spacing:-.008em;margin-bottom:20px;text-wrap:balance}
.wide h1{font-size:clamp(2rem,1.6rem + 1.4vw,2.75rem);margin-bottom:28px}
.lede{color:var(--t2);font-size:17px;margin-bottom:40px;text-wrap:pretty}
.lede strong{color:var(--t1);font-weight:500}
form.apply{display:grid;gap:28px}
.field{display:grid;gap:8px}
.label{font-weight:500;font-size:15px}
.hint{color:var(--t2);font-size:14px}
.problem{font-size:14px;font-weight:500}
input[type=text],input[type=email]{width:100%;height:48px;padding:0 14px;background:var(--well);color:var(--t1);border:1px solid var(--field);border-radius:0;font:inherit}
input[type=text]:hover,input[type=email]:hover{border-color:var(--field-hover)}
input[type=text][aria-invalid=true],input[type=email][aria-invalid=true]{border-color:var(--t1)}
input::placeholder{color:var(--t2);opacity:.75}
fieldset{border:0;padding:0;display:grid;gap:8px;min-width:0}
legend{padding:0;margin-bottom:8px}
.choices{display:flex;flex-wrap:wrap;gap:8px}
.choice{position:relative;display:block}
.choice input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.choice span{display:inline-flex;align-items:center;height:44px;padding:0 20px;border:1px solid var(--field);transition:background-color 120ms linear,color 120ms linear,border-color 120ms linear}
.choice input:hover+span{border-color:var(--field-hover)}
.choice input:checked+span{background:var(--mist);border-color:var(--mist);color:var(--ink);font-weight:500}
.choice input:focus-visible+span{outline:2px solid var(--teal);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 26px;background:var(--mist);color:var(--ink);border:1px solid var(--mist);font:600 16px/1 var(--sans);text-decoration:none;cursor:pointer;white-space:nowrap;transition:background-color 120ms linear,transform 120ms cubic-bezier(.23,1,.32,1)}
.btn:hover{background:#eef6f8}
.btn:active{background:var(--mist-press);transform:scale(.98)}
.btn-s{height:34px;padding:0 14px;font-size:14px}
.btn-field{height:48px}
.btn-quiet{background:transparent;color:var(--t1);border-color:var(--field)}
.btn-quiet:hover{background:transparent;border-color:var(--field-hover)}
.btn-quiet:active{background:transparent}
.submit{justify-self:start}
.foot{margin-top:48px;color:var(--t2);font-size:14px}
dl.answers{display:grid;grid-template-columns:max-content 1fr;gap:12px 32px;padding-block:24px;border-block:1px solid var(--line);margin-bottom:24px}
dl.answers dt{color:var(--t2)}
.downloads{display:grid;gap:32px;margin-bottom:40px}
.download{display:grid;gap:12px;justify-items:start}
.meta{color:var(--t2);font-size:14px}
.note{color:var(--t2);max-width:34rem}
.first-open{display:grid;gap:12px}
.first-open ol{display:grid;gap:8px;padding-left:1.25em}
.filters{display:flex;gap:28px;border-bottom:1px solid var(--line);margin-bottom:8px;overflow-x:auto}
.filters a{padding:12px 0;margin-bottom:-1px;border-bottom:2px solid transparent;text-decoration:none;color:var(--t2);white-space:nowrap}
.filters a:hover{color:var(--t1)}
.filters a[aria-current=page]{color:var(--t1);border-bottom-color:var(--mist)}
.filters .n{margin-left:6px;font-variant-numeric:tabular-nums}
.table{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.45}
th{text-align:left;font-weight:500;color:var(--t2);padding:12px 12px 12px 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:16px 12px 16px 0;border-bottom:1px solid var(--line);vertical-align:top}
td .sub{display:block;color:var(--t2)}
td.trading{max-width:22rem}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.invite{max-width:44rem;display:grid;gap:24px;margin-bottom:40px}
.invite-row{display:flex;gap:8px;align-items:flex-start}
.invite-row input{flex:1;min-width:0}
.waiting{display:grid;gap:4px}
.waiting ul{list-style:none;padding:0;display:grid}
.waiting li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 16px;padding:12px 0;border-bottom:1px solid var(--line)}
.waiting .person{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.waiting .person .sub{display:inline;margin-left:12px;color:var(--t2)}
.waiting input{grid-column:1/-1;height:36px;font-size:14px;color:var(--t2)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.empty{padding:48px 0;color:var(--t2)}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
`;

export interface Chrome {
  title: string;
  siteUrl: string;
  signedIn?: { user: User; csrf: string };
  here?: 'apply' | 'admin';
  wide?: boolean;
}

export function Layout(props: PropsWithChildren<Chrome>) {
  const { title, siteUrl, signedIn, here, wide, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#003648" />
        <title>{`${title} · Tessera`}</title>
        <link rel="icon" href={`${siteUrl}/favicon.svg`} type="image/svg+xml" />
        <link rel="preload" href="/assets/instrument-sans.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="top">
          <a class="brand" href={siteUrl} aria-label="Tessera">
            <img src="/assets/wordmark.svg" alt="" width="84" height="26" />
          </a>
          {signedIn === undefined ? null : (
            <div class="who">
              <span class="email">{signedIn.user.email}</span>
              {signedIn.user.role !== 'admin' || here === undefined ? null : here === 'admin' ? (
                <a href="/apply">Your access</a>
              ) : (
                <a href="/admin">Admin</a>
              )}
              <form method="post" action="/auth/sign-out">
                <input type="hidden" name="csrf" value={signedIn.csrf} />
                <button class="plain" type="submit">
                  Sign out
                </button>
              </form>
            </div>
          )}
        </header>
        <main class={wide === true ? 'wide' : undefined}>{children}</main>
      </body>
    </html>
  );
}

export interface ApplyValues {
  name?: string;
  propFirm?: string;
  platform?: string;
  trading?: string;
}
export type ApplyErrors = Partial<Record<keyof ApplyValues, string>>;

export function ApplyForm(props: {
  user: User;
  csrf: string;
  values: ApplyValues;
  errors: ApplyErrors;
  askName: boolean;
  available: readonly Platform[];
  siteUrl: string;
  editing: boolean;
}) {
  const { user, csrf, values, errors, askName, available, siteUrl, editing } = props;
  const coming = (Object.keys(PLATFORM_NAMES) as Platform[]).filter((p) => !available.includes(p));
  return (
    <>
      <h1>{editing ? 'Your answers' : 'Request access'}</h1>
      <p class="lede">
        {editing ? (
          <>Change anything while your request waits.</>
        ) : (
          <>
            Tessera's alpha is for futures traders. Tell us how you trade, and we'll email <strong>{user.email}</strong>{' '}
            when your account is ready.
          </>
        )}
      </p>
      <form class="apply" method="post" action="/apply" novalidate>
        <input type="hidden" name="csrf" value={csrf} />
        {askName ? (
          <TextField name="name" label="Your name" value={values.name} error={errors.name} autocomplete="name" />
        ) : null}
        <TextField
          name="propFirm"
          label="Prop firm"
          hint="Or your broker, if you trade your own account."
          placeholder="The firm you trade with"
          value={values.propFirm}
          error={errors.propFirm}
        />
        <fieldset aria-describedby={errors.platform === undefined ? 'platform-hint' : 'platform-problem'}>
          <legend class="label">Platform</legend>
          <div class="choices">
            {(Object.keys(PLATFORM_NAMES) as Platform[]).map((p) => (
              <label class="choice">
                <input type="radio" name="platform" value={p} checked={values.platform === p} required />
                <span>{PLATFORM_NAMES[p]}</span>
              </label>
            ))}
          </div>
          {errors.platform === undefined ? null : (
            <p class="problem" id="platform-problem">
              {errors.platform}
            </p>
          )}
          {available.length === 0 || coming.length === 0 ? null : (
            <p class="hint" id="platform-hint">
              {`Tessera runs on ${list(available.map((p) => PLATFORM_NAMES[p]))} today; ${list(coming.map((p) => PLATFORM_NAMES[p]))} ${coming.length === 1 ? 'is' : 'are'} coming.`}
            </p>
          )}
        </fieldset>
        <TextField
          name="trading"
          label="How you trade"
          hint="One line is plenty."
          placeholder="NQ and ES, order flow, a few trades a day"
          value={values.trading}
          error={errors.trading}
        />
        <button class="btn submit" type="submit">
          {editing ? 'Save' : 'Request access'}
        </button>
      </form>
      <p class="foot">
        We use your answers only to decide on access. <a href={`${siteUrl}/privacy`}>Privacy policy</a>
      </p>
    </>
  );
}

function TextField(props: {
  name: keyof ApplyValues;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string | undefined;
  error: string | undefined;
  autocomplete?: string;
}) {
  const { name, label, hint, placeholder, value, error, autocomplete } = props;
  const described = [hint === undefined ? null : `${name}-hint`, error === undefined ? null : `${name}-problem`]
    .filter((id) => id !== null)
    .join(' ');
  return (
    <div class="field">
      <label class="label" for={name}>
        {label}
      </label>
      <input
        type="text"
        id={name}
        name={name}
        value={value ?? ''}
        placeholder={placeholder}
        maxlength={name === 'trading' ? 200 : 80}
        autocomplete={autocomplete ?? 'off'}
        required
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={described === '' ? undefined : described}
      />
      {error === undefined ? null : (
        <p class="problem" id={`${name}-problem`}>
          {error}
        </p>
      )}
      {hint === undefined ? null : (
        <p class="hint" id={`${name}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Waiting(props: { user: User; application: Application }) {
  const { user, application } = props;
  return (
    <>
      <h1>You're on the list.</h1>
      <p class="lede">
        We'll email <strong>{user.email}</strong> when your account is ready.
      </p>
      <dl class="answers">
        <dt>Prop firm</dt>
        <dd>{application.propFirm ?? '—'}</dd>
        <dt>Platform</dt>
        <dd>{application.platform === null ? '—' : PLATFORM_NAMES[application.platform]}</dd>
        <dt>How you trade</dt>
        <dd>{application.trading ?? '—'}</dd>
      </dl>
      {application.status === 'pending' ? <a href="/apply?edit">Change your answers</a> : null}
    </>
  );
}

export function Approved(props: {
  user: User;
  platform: Platform | null;
  downloads: readonly Download[];
  siteUrl: string;
}) {
  const { user, platform, downloads, siteUrl } = props;
  const missing = platform !== null && !downloads.some((d) => d.platform === platform) ? platform : null;
  const steps = (d: Download) => platform === null || missing !== null || d.platform === platform;
  return (
    <>
      <h1>You're in.</h1>
      {downloads.length === 0 ? (
        <p class="lede">
          Download Tessera from <a href={`${siteUrl}/download`}>the download page</a> and sign in with{' '}
          <strong>{user.email}</strong>.
        </p>
      ) : (
        <>
          <p class="lede">
            Download Tessera and sign in with <strong>{user.email}</strong>.
          </p>
          <div class="downloads">
            {chosenFirst(downloads, platform).map((d) => (
              <div class="download">
                <a class="btn" href={d.url}>
                  Download for {PLATFORM_NAMES[d.platform]}
                </a>
                <p class="meta">{d.meta}</p>
                {steps(d) ? (
                  <div class="note first-open">
                    <p>{d.firstOpen.intro}</p>
                    <ol>
                      {d.firstOpen.steps.map((step) => (
                        <li>{step}</li>
                      ))}
                    </ol>
                    {d.firstOpen.alternative === undefined ? null : <p>{d.firstOpen.alternative}</p>}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {missing === null ? null : <p class="note">Tessera for {PLATFORM_NAMES[missing]} is not out yet.</p>}
          <p class="foot">
            <a href={`${siteUrl}/download`}>Install steps</a>
          </p>
        </>
      )}
    </>
  );
}

export function Declined() {
  return (
    <>
      <h1>Not this time.</h1>
      <p class="lede">We can't offer you a place in this alpha. Thank you for asking.</p>
    </>
  );
}

export function Notice(props: { title: string; text: string; action?: { href: string; label: string } }) {
  const { title, text, action } = props;
  return (
    <>
      <h1>{title}</h1>
      <p class="lede">{text}</p>
      {action === undefined ? null : (
        <a class="btn" href={action.href}>
          {action.label}
        </a>
      )}
    </>
  );
}

export const FILTERS = ['pending', 'approved', 'declined'] as const;
export type Filter = (typeof FILTERS)[number];

const FILTER_NAMES: Record<Filter, string> = { pending: 'Pending', approved: 'Approved', declined: 'Declined' };

export function filterOf(applicant: Applicant): Filter | null {
  switch (applicant.access) {
    case 'full':
      return 'approved';
    case 'pending':
      return 'pending';
    case 'declined':
      return 'declined';
    case 'none':
      return applicant.application?.status === 'approved' ? 'approved' : null;
  }
}

export interface InviteForm {
  value: string;
  problem: string | null;
}

export function Admin(props: {
  applicants: readonly Applicant[];
  counts: Readonly<Record<Filter, number>> & { all: number };
  filter: Filter | null;
  csrf: string;
  staleBefore: Date;
  invites: readonly Invite[];
  origin: string;
  invite: InviteForm;
}) {
  const { applicants, counts, filter, csrf, staleBefore, invites, origin, invite } = props;
  return (
    <>
      <h1>Applicants</h1>
      <Invites invites={invites} origin={origin} form={invite} csrf={csrf} filter={filter} />
      <nav class="filters" aria-label="Filter">
        <a href="/admin" aria-current={filter === null ? 'page' : undefined}>
          All<span class="n">{counts.all}</span>
        </a>
        {FILTERS.map((f) => (
          <a href={`/admin?status=${f}`} aria-current={filter === f ? 'page' : undefined}>
            {FILTER_NAMES[f]}
            <span class="n">{counts[f]}</span>
          </a>
        ))}
      </nav>
      {applicants.length === 0 ? (
        <p class="empty">No one here yet.</p>
      ) : (
        <div class="table">
          <table>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Prop firm</th>
                <th scope="col">Platform</th>
                <th scope="col">How they trade</th>
                <th scope="col">Applied</th>
                <th scope="col">Last opened the app</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {applicants.map((a) => (
                <Row applicant={a} csrf={csrf} filter={filter} staleBefore={staleBefore} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Invites(props: {
  invites: readonly Invite[];
  origin: string;
  form: InviteForm;
  csrf: string;
  filter: Filter | null;
}) {
  const { invites, origin, form, csrf, filter } = props;
  const back = filter === null ? null : <input type="hidden" name="back" value={filter} />;
  return (
    <section class="invite" aria-label="Invites">
      <form class="field" method="post" action="/admin/invites" novalidate>
        <input type="hidden" name="csrf" value={csrf} />
        {back}
        <label class="label" for="invite-email">
          Invite someone
        </label>
        <div class="invite-row">
          <input
            type="email"
            id="invite-email"
            name="email"
            value={form.value}
            placeholder="Their email"
            autocomplete="off"
            required
            aria-invalid={form.problem === null ? undefined : 'true'}
            aria-describedby={form.problem === null ? 'invite-hint' : 'invite-problem invite-hint'}
          />
          <button class="btn btn-field" type="submit">
            Invite
          </button>
        </div>
        {form.problem === null ? null : (
          <p class="problem" id="invite-problem">
            {form.problem}
          </p>
        )}
        <p class="hint" id="invite-hint">
          Access is theirs once they sign in with this address. Send them the link.
        </p>
      </form>
      {invites.length === 0 ? null : (
        <div class="waiting">
          <h2 class="label">Waiting to sign in</h2>
          <ul>
            {invites.map((invite) => (
              <li>
                <span class="person">
                  {invite.email}
                  <span class="sub">Invited {day(invite.createdAt)}</span>
                </span>
                <form method="post" action={`/admin/invites/${invite.token}/revoke`}>
                  <input type="hidden" name="csrf" value={csrf} />
                  {back}
                  <button class="btn btn-s btn-quiet" type="submit">
                    Revoke
                  </button>
                </form>
                <input
                  type="text"
                  readonly
                  value={`${origin}/invite/${invite.token}`}
                  aria-label={`Invite link for ${invite.email}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Row(props: { applicant: Applicant; csrf: string; filter: Filter | null; staleBefore: Date }) {
  const { applicant: a, csrf, filter, staleBefore } = props;
  const app = a.application;
  const platform = app?.platform ?? null;
  const checkin = a.lastCheckin;
  return (
    <tr>
      <td>
        {a.user.name ?? a.user.email}
        {a.user.name === null ? null : <span class="sub">{a.user.email}</span>}
      </td>
      <td>{app?.propFirm ?? '—'}</td>
      <td>{platform === null ? '—' : PLATFORM_NAMES[platform]}</td>
      <td class="trading">{app?.trading ?? '—'}</td>
      <td class="num">{app === null || a.invitedAt !== null ? '—' : day(a.since)}</td>
      <td>
        {checkin === null ? (
          <span class="sub">Never</span>
        ) : (
          <>
            <span class="num">{moment(checkin.at)}</span>
            <span class="sub">{[checkin.appVersion, checkin.platform, checkin.channel].join(' · ')}</span>
          </>
        )}
      </td>
      <td>
        <Standing applicant={a} />
        <Actions applicant={a} csrf={csrf} filter={filter} staleBefore={staleBefore} />
      </td>
    </tr>
  );
}

function Standing(props: { applicant: Applicant }) {
  const { applicant: a } = props;
  const decided = a.application?.decidedAt ?? null;
  switch (filterOf(a)) {
    case 'approved':
      if (a.invitedAt !== null) return <>{`Invited ${day(a.invitedAt)}`}</>;
      return <>{decided === null ? 'Approved' : `Approved ${day(decided)}`}</>;
    case 'declined':
      return <>{decided === null ? 'Declined' : `Declined ${day(decided)}`}</>;
    case 'pending':
      return <>Pending</>;
    case null:
      return <span class="sub">Not applied</span>;
  }
}

function Actions(props: { applicant: Applicant; csrf: string; filter: Filter | null; staleBefore: Date }) {
  const { applicant: a, csrf, filter, staleBefore } = props;
  const action = (verb: 'approve' | 'decline' | 'resend', label: string, quiet: boolean): Child => (
    <form method="post" action={`/admin/users/${a.user.id}/${verb}`}>
      <input type="hidden" name="csrf" value={csrf} />
      {filter === null ? null : <input type="hidden" name="back" value={filter} />}
      <button class={quiet ? 'btn btn-s btn-quiet' : 'btn btn-s'} type="submit">
        {label}
      </button>
    </form>
  );
  const standing = filterOf(a);
  if (standing === 'approved') {
    const email = a.approvalEmail;
    if (email === null) return null;
    const failed = email.state === 'failed' || (email.state === 'sending' && new Date(email.at) < staleBefore);
    if (!failed)
      return <span class="sub">{email.state === 'sent' ? `Emailed ${day(email.at)}` : 'Sending email'}</span>;
    return (
      <>
        <span class="sub">{email.error === null ? 'Email failed' : `Email failed: ${email.error}`}</span>
        <div class="actions">{action('resend', 'Resend email', true)}</div>
      </>
    );
  }
  return (
    <div class="actions">
      {action('approve', 'Approve', false)}
      {standing === 'pending' ? action('decline', 'Decline', true) : null}
    </div>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MOMENT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

function day(iso: string): string {
  return DAY.format(new Date(iso));
}

function moment(iso: string): string {
  return `${MOMENT.format(new Date(iso))} UTC`;
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}
