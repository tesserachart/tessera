import { Button, Icon, ScrollArea } from '@tessera/ui';

const SESSIONS = [
  { group: 'Today', titles: ['NQ opening range read', 'Levels for the London session'] },
  { group: 'This week', titles: ['Gamma levels on ES', 'Review of yesterday’s trades', 'CL inventory reaction'] },
];

const STARTERS = [
  { q: 'What is the market doing right now?', n: 'NQ Z6 · 5m' },
  { q: 'Where are the levels that matter today?', n: 'Gamma and volume' },
  { q: 'Plan a trade from here', n: 'Entry, stop and target' },
];

function SessionColumnSample() {
  return (
    <aside className="ag-side an-sessions" aria-label="Sessions">
      <div className="ag-side-head">
        <Button variant="quiet" className="ag-new">
          New session
        </Button>
      </div>
      <ScrollArea className="ag-side-list">
        {SESSIONS.map((g) => (
          <section key={g.group} className="ag-sgroup" aria-label={g.group}>
            <h3>{g.group}</h3>
            <ul>
              {g.titles.map((t) => (
                <li key={t} className="ag-srow">
                  <button type="button" className="ag-sbtn">
                    <span className="tt">{t}</span>
                    <time className="tm">00m</time>
                  </button>
                  <button type="button" className="ag-smore" aria-label="More">
                    <Icon name="more" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </ScrollArea>
    </aside>
  );
}

function ComposerSample() {
  return (
    <form className="ag-compose is-narrow">
      <textarea rows={1} aria-label="Ask the analyst" placeholder="Ask, or type an order" readOnly />
      <div className="ag-compose-foot">
        <button type="button" className="ag-attach" aria-label="Attach files">
          <Icon name="attach" />
        </button>
        <button type="button" className="ag-ctl ag-model">
          <Icon name="analyst" />
          <span className="tt">Model 0.0</span>
          <Icon name="chevron-down" className="cv" />
        </button>
        <button type="button" className="ag-ctl ag-effort">
          <span className="tt">Medium</span>
          <Icon name="chevron-down" className="cv" />
        </button>
        <button type="button" className="ag-send" aria-label="Send">
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}

export function AnalystSample() {
  return (
    <div className="an-wide">
      <SessionColumnSample />
      <section className="an" aria-label="Analyst">
        <div className="an-bar" role="toolbar" aria-label="Session">
          <button type="button" className="an-session">
            <span className="tt">Sessions</span>
            <Icon name="chevron-down" />
          </button>
        </div>
        <div className="an-body">
          <div className="ag-conv is-narrow">
            <div className="ag-history">
              <ScrollArea className="ag-scroll" viewportClassName="ag-scroll-view">
                <div className="ag-empty">
                  <div className="an-open">
                    <ul className="an-starters" aria-label="Ask the analyst">
                      {STARTERS.map((s) => (
                        <li key={s.q}>
                          <button type="button">
                            <span className="q">{s.q}</span>
                            <span className="n">{s.n}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
        <ComposerSample />
      </section>
    </div>
  );
}
