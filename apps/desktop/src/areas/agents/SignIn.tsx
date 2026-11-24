import { Button, TextInput } from '@tessera/ui';
import { useState } from 'react';
import type { SignInState } from './signInState.ts';
import './agents.css';

export function SignInControls({ s }: { s: SignInState }) {
  const [text, setText] = useState('');
  if (!s.page)
    return (
      <Button size="s" disabled={s.busy} aria-label={`Sign in to ${s.name}`} onClick={s.start}>
        {s.busy ? 'Opening…' : 'Sign in'}
      </Button>
    );
  if (!s.code)
    return (
      <Button size="s" variant="quiet" onClick={s.reopen}>
        Open the page again
      </Button>
    );
  return (
    <form
      className="ag-signin-code"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) s.send(text);
      }}
    >
      <TextInput
        size="s"
        aria-label={`${s.name} sign-in code`}
        placeholder="Code"
        value={text}
        spellCheck={false}
        autoComplete="off"
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="s" type="submit" disabled={s.busy || !text.trim()}>
        Sign in
      </Button>
    </form>
  );
}
