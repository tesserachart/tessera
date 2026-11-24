import { ContractError, RequestTimeout, ToolDenied, ToolFailed } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { ranUnread, toolCode, toolDetails, toolReason } from '../src/app/tools.ts';

const failed = new ToolFailed({
  tool: 'layout.save',
  code: 'conflict',
  message: 'the layout changed since revision 3',
  details: { revision: 4 },
  callId: 'c1',
});
const denied = new ToolDenied({
  tool: 'orders.submit',
  code: 'permission_denied',
  message: 'agents draft',
  callId: 'c2',
});

describe("a tool's failure as the app reads it", () => {
  it('names the runtime’s code for a failure or a refusal, and none for anything else', () => {
    expect(toolCode(failed)).toBe('conflict');
    expect(toolCode(denied)).toBe('permission_denied');
    expect(toolCode(new RequestTimeout({ method: 'tools.invoke', timeoutMs: 20 }))).toBeNull();
    expect(toolCode(new Error('boom'))).toBeNull();
  });

  it('says the runtime’s reason in its own words, and reads what it attached', () => {
    expect(toolReason(failed)).toBe('the layout changed since revision 3');
    expect(toolDetails(failed)).toEqual({ revision: 4 });
    expect(toolReason(new Error('socket closed'))).toBe('socket closed');
    expect(toolDetails(denied)).toBeNull();
  });

  it('tells an answer that could not be read from a call that did not go', () => {
    expect(ranUnread(new ContractError({ source: 'tool orders.submit', message: 'Missing key', ran: true }))).toBe(
      true,
    );
    expect(ranUnread(new ContractError({ source: 'tool orders.submit input', message: 'Expected number' }))).toBe(
      false,
    );
    expect(ranUnread(failed)).toBe(false);
  });
});
