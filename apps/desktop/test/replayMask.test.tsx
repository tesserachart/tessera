import { Popover, PopoverContent, PopoverTrigger, PrivateHost, PrivateScope, TooltipProvider } from '@tessera/ui';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { maskAttribute, maskInput, maskText } from '../src/app/replayMask.ts';

afterEach(cleanup);

function element(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe('what a session replay may show', () => {
  it('hides every digit and leaves the words that show where the trader is', () => {
    const cell = element('<div class="tk-row"><span class="px">20,641.25</span></div>', '.px');
    expect(maskText('Buy 3 NQZ6 @ 20,641.25', cell)).toBe('Buy * NQZ* @ **,***.**');
    expect(maskText('Day P&L −$1,240.50', cell)).toBe('Day P&L −$*,***.**');
    expect(maskText('Settings', cell)).toBe('Settings');
  });

  it('shows no text at all inside a private region', () => {
    const note = element('<section data-private=""><p>chased the open again on APEX-4410</p></section>', 'p');
    expect(maskText('chased the open again on APEX-4410', note)).toBe('****** *** **** ***** ** *********');
  });

  it('hides digits in words an attribute carries, and everything in a private one, but keeps the page whole', () => {
    const button = element('<button aria-label="Account: Eval 50K, $50,120">x</button>', 'button');
    expect(maskAttribute('aria-label', 'Account: Eval 50K, $50,120', button)).toBe('Account: Eval **K, $**,***');
    expect(maskAttribute('title', '2 contracts', button)).toBe('* contracts');
    expect(maskAttribute('data-price', '20641.25', button)).toBe('*****.**');
    expect(maskAttribute('class', 'w-[560px] p-3', button)).toBe('w-[560px] p-3');
    expect(maskAttribute('style', 'width: 120px', button)).toBe('width: 120px');
    const named = element('<div data-private=""><span title="Alex Rivas">n</span></div>', 'span');
    expect(maskAttribute('title', 'Alex Rivas', named)).toBe('**** *****');
    expect(maskInput('my prompt to the analyst')).toBe('************************');
  });

  it('marks the tile’s own container and its popovers, without adding an element that takes a box', () => {
    const view = render(
      <TooltipProvider>
        <div className="dock-part">
          <PrivateScope>
            <section className="tile-root">
              <Popover open>
                <PopoverTrigger>Accounts</PopoverTrigger>
                <PopoverContent>
                  <span className="acct">Alex Rivas · Apex</span>
                </PopoverContent>
              </Popover>
            </section>
            <PrivateHost />
          </PrivateScope>
        </div>
        <Popover open>
          <PopoverTrigger>Chart</PopoverTrigger>
          <PopoverContent>
            <span className="tf">Timeframe</span>
          </PopoverContent>
        </Popover>
      </TooltipProvider>,
    );
    const part = document.querySelector('.dock-part')!;
    expect(part.hasAttribute('data-private')).toBe(true);
    expect(part.firstElementChild?.className).toBe('tile-root');
    expect([...part.children].map((c) => c.tagName)).toEqual(['SECTION', 'TEMPLATE']);
    expect(maskText('Accounts', document.querySelector('.tile-root button'))).toBe('********');
    const acct = document.querySelector('.acct')!;
    expect(acct.closest('.t-popover')!.parentElement!.closest('[data-private]')).toBeNull();
    expect(maskText('Alex Rivas · Apex', acct)).toBe('**** ***** * ****');
    expect(maskText('Timeframe', document.querySelector('.tf'))).toBe('Timeframe');
    view.unmount();
    expect(part.isConnected).toBe(false);
  });

  it('marks a region without a wrapper element, so sibling and child selectors still hold', () => {
    render(
      <TooltipProvider>
        <footer className="foot">
          <span className="slot" />
          <PrivateScope>
            <div className="notices" data-private="">
              <Popover open>
                <PopoverTrigger>Paper 2 filled</PopoverTrigger>
                <PopoverContent>
                  <span className="history">Filled on Paper 2</span>
                </PopoverContent>
              </Popover>
            </div>
          </PrivateScope>
        </footer>
      </TooltipProvider>,
    );
    expect(document.querySelector('.slot + .notices')).not.toBeNull();
    expect(maskText('Paper 2 filled', document.querySelector('.notices button'))).toBe('***** * ******');
    expect(maskText('Filled on Paper 2', document.querySelector('.history'))).toBe('****** ** ***** *');
  });
});
