import type { SetupDisplay, SetupLine, SharedItem } from '@tessera/protocol';
import { Button, Dialog, DialogContent, TextInput, Tooltip } from '@tessera/ui';
import { Fragment, type SyntheticEvent } from 'react';
import { useActiveChart } from '../state/workspace.ts';
import {
  addingWords,
  addPlan,
  addShared,
  closeOpen,
  isColour,
  openTitle,
  setLinkText,
  submitLink,
  useOpenFlow,
  type OpenFlow,
} from './open.ts';

function Lines({ lines }: { lines: readonly SetupLine[] }) {
  if (lines.length === 0) return null;
  return (
    <dl className="sh-lines-list">
      {lines.map((line, i) => (
        <Fragment key={i}>
          <dt>{line.label}</dt>
          <dd>
            {isColour(line.value) ? (
              <span className="sh-swatch" style={{ background: line.value }} aria-hidden="true" />
            ) : null}
            {line.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Display({ display }: { display: SetupDisplay }) {
  return (
    <div className="sh-item">
      <p className="sh-name">{display.name}</p>
      {display.about ? <p className="sh-about">{display.about}</p> : null}
      <Lines lines={display.lines} />
      {display.parts.map((part, i) => (
        <section key={i} className="sh-part" aria-label={part.name}>
          <h3>{part.name}</h3>
          <Lines lines={part.lines} />
        </section>
      ))}
      {display.code.length > 0 ? (
        <details className="sh-code">
          <summary>Brings its own code</summary>
          {display.code.map((c, i) => (
            <pre key={i} aria-label={c.name}>
              <code>{c.code}</code>
            </pre>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function Ask({ text, why }: { text: string; why: string | null }) {
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void submitLink();
  };
  return (
    <form className="sh-ask" onSubmit={submit}>
      <TextInput
        aria-label="Link"
        placeholder="https://…/s/…"
        value={text}
        autoFocus
        spellCheck={false}
        onChange={(e) => setLinkText(e.target.value)}
      />
      {why ? (
        <p className="sh-why" role="alert">
          {why}
        </p>
      ) : null}
      <div className="sh-acts">
        <Button variant="quiet" onClick={closeOpen}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Open
        </Button>
      </div>
    </form>
  );
}

function Item({ item, adding }: { item: SharedItem; adding: boolean }) {
  const plan = addPlan(item.kind, useActiveChart() !== null);
  return (
    <>
      <Display display={item.display} />
      <p className="sh-line" role="status">
        {adding ? addingWords(item.kind) : plan.line}
      </p>
      {adding ? null : (
        <div className="sh-acts">
          <Button variant="quiet" onClick={closeOpen}>
            Cancel
          </Button>
          {plan.blocked ? (
            <Tooltip content={plan.blocked}>
              <span>
                <Button variant="primary" disabled>
                  {plan.label}
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button variant="primary" autoFocus onClick={() => void addShared()}>
              {plan.label}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function Body({ flow }: { flow: Exclude<OpenFlow, { step: 'closed' }> }) {
  switch (flow.step) {
    case 'asking':
      return <Ask text={flow.text} why={flow.why} />;
    case 'reading':
      return (
        <>
          <p className="sh-line" role="status">
            Reading the link…
          </p>
          <div className="sh-acts">
            <Button variant="quiet" onClick={closeOpen}>
              Cancel
            </Button>
          </div>
        </>
      );
    case 'shown':
    case 'adding':
      return <Item item={flow.item} adding={flow.step === 'adding'} />;
    case 'failed':
      return (
        <>
          <p className="sh-line" role="status">
            {flow.why}
          </p>
          <div className="sh-acts">
            <Button variant="primary" onClick={closeOpen}>
              Close
            </Button>
          </div>
        </>
      );
  }
}

export function SharedLinkDialog() {
  const flow = useOpenFlow();
  if (flow.step === 'closed') return null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeOpen())}>
      <DialogContent className="sh-dialog" title={openTitle(flow)} data-open-flow={flow.step}>
        <div className="ui-dialog-body sh-body">
          <Body flow={flow} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
