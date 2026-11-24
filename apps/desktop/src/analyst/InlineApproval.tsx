import { type Approval, type ApprovalDecision } from '@tessera/protocol';
import { Button, FormRow, TextInput, cx, useShown } from '@tessera/ui';
import { useEffect, useRef, useState } from 'react';
import { ARM_MS, applyEdit, describeApproval, editFields } from '../shell/approval.ts';
import { approve, failureText, ranUnread } from '../app/tools.ts';
import { runtimeFailureWords } from '../shell/tradeActions.ts';

export function InlineApproval({ approval }: { approval: Approval }) {
  const view = describeApproval(approval);
  const fields = editFields(approval.input);
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [armed, setArmed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const open = editing !== null;
  useEffect(() => {
    if (open) form.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const shown = useShown();
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setArmed(false);
  }
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const resolve = async (decision: ApprovalDecision, input?: Approval['input']) => {
    setBusy(decision);
    setError(null);
    try {
      await approve({
        approvalId: approval.id,
        decision,
        previewHash: approval.previewHash,
        ...(input === undefined ? {} : { input }),
      });
    } catch (err) {
      if (ranUnread(err)) return;
      setError(runtimeFailureWords(err) ?? failureText(err));
      setBusy(null);
    }
  };
  const title = view.title ?? 'Change';
  const what = view.restatement ?? view.facts.map((f) => `${f.label} ${f.value}`).join(' · ');
  const full = what ? `${title} · ${what}` : title;

  return (
    <section
      className={cx('an-ask', editing && 'is-editing')}
      aria-label={`The analyst asks: ${full}`}
      tabIndex={-1}
      data-approval-card=""
    >
      <div className="an-ask-row">
        <p className="what" title={full}>
          <b>{title}</b>
          {what ? (
            <>
              <span className="text-t2" aria-hidden="true">
                {' · '}
              </span>
              <span className="tg">{what}</span>
            </>
          ) : null}
        </p>
        <div className="act">
          {fields.length > 0 ? (
            <Button
              size="s"
              variant="quiet"
              aria-expanded={editing !== null}
              disabled={busy !== null}
              onClick={() => setEditing(editing ? null : {})}
            >
              Edit
            </Button>
          ) : null}
          <Button
            size="s"
            disabled={!armed || busy !== null || editing !== null}
            title={editing !== null ? 'Save or close the edit first' : undefined}
            onClick={() => void resolve('approve')}
          >
            {busy === 'approve' ? 'Allowing…' : 'Allow'}
          </Button>
          <Button size="s" variant="quiet" disabled={busy !== null} onClick={() => void resolve('reject')}>
            Deny
          </Button>
        </div>
      </div>
      {editing ? (
        <form
          ref={form}
          className="an-ask-edit"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              void resolve('edit', applyEdit(approval.input, fields, editing));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(null);
            }
          }}
        >
          {fields.map((f) => (
            <FormRow key={f.path} label={f.label} htmlFor={`${approval.id}-${f.path}`} layout="fill">
              <TextInput
                id={`${approval.id}-${f.path}`}
                inputMode={f.kind === 'number' ? 'decimal' : undefined}
                value={editing[f.path] ?? f.value}
                onChange={(e) => setEditing({ ...editing, [f.path]: e.target.value })}
              />
            </FormRow>
          ))}
          <div className="foot">
            <Button size="s" variant="quiet" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="s" type="submit" disabled={busy !== null}>
              {busy === 'edit' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="err" role="alert" data-selectable>
          {error}
        </p>
      ) : null}
    </section>
  );
}
