import type { ShareSetupInput } from '@tessera/protocol';
import type { Share, ShareFlow } from './store.ts';

export const NOT_ON_SCREEN = 'This chart isn’t on screen. Show it, then share again.';
export const IN_THE_PICTURE =
  'Orders, positions and P/L are left out. Drawings, notes and indicators on the chart are in the picture.';
export const NOTHING_SHARED_YET = 'Nothing is shared until you create a link.';
export const LEFT_OUT_OF_CONVERSATION =
  'Attachments, what each tool returned, account names and position sizes are left out.';
export const SETTINGS_ONLY = 'Settings only: no prices, bars or account.';
export const ITS_CODE = 'Its code is on the page.';
export const THEIR_CODE = 'The code of its custom indicators is on the page.';
const MAKING_A_LINK = 'Making a link…';

const NOT_LISTED = 'It isn’t listed anywhere. Delete it in Settings › App.';

type SetupWord = 'indicator' | 'template' | 'workspace';

function setupWord(setup: ShareSetupInput): SetupWord {
  switch (setup.kind) {
    case 'indicator':
    case 'custom_indicator':
      return 'indicator';
    case 'template':
      return 'template';
    case 'layout':
      return 'workspace';
  }
}

export function shareTitle(share: Share): string {
  switch (share.subject) {
    case 'chart':
      return 'Share chart';
    case 'conversation':
      return 'Share conversation';
    case 'setup':
      return `Share ${setupWord(share.setup)}`;
  }
}

export function failedWords(share: Share): string {
  const what = share.subject === 'setup' ? setupWord(share.setup) : share.subject;
  return `The ${what} couldn’t be shared. Try again in a moment.`;
}

function readyLines(share: Share, canLink: boolean): string[] {
  const after = canLink ? [NOTHING_SHARED_YET] : [];
  switch (share.subject) {
    case 'chart':
      return [IN_THE_PICTURE, ...after];
    case 'conversation':
      return [LEFT_OUT_OF_CONVERSATION, ...after];
    case 'setup': {
      const own = share.setup.kind === 'indicator' || share.setup.kind === 'custom_indicator';
      return [SETTINGS_ONLY, ...(share.code ? [own ? ITS_CODE : THEIR_CODE] : [])];
    }
  }
}

function sharedLine(share: Share): string {
  switch (share.subject) {
    case 'chart':
      return `Anyone with the link can see this picture. ${NOT_LISTED}`;
    case 'conversation':
      return `Anyone with the link can read this conversation. ${NOT_LISTED}`;
    case 'setup':
      return `Anyone with the link can see these settings and add them to their Tessera. ${NOT_LISTED}`;
  }
}

function preparingLine(share: Share): string {
  switch (share.subject) {
    case 'chart':
      return 'Picturing the chart…';
    case 'conversation':
      return 'Reading the conversation…';
    case 'setup':
      return '';
  }
}

export function flowLines(flow: Exclude<ShareFlow, { step: 'closed' }>, canLink: boolean): string[] {
  switch (flow.step) {
    case 'preparing':
      return [preparingLine(flow.share)].filter((line) => line !== '');
    case 'ready':
      return readyLines(flow.share, canLink);
    case 'sending':
      return [MAKING_A_LINK];
    case 'shared':
      return [sharedLine(flow.share)];
    case 'failed':
      return [flow.why];
  }
}

export function waitWords(flow: Exclude<ShareFlow, { step: 'closed' }>): string | null {
  if (flow.step === 'sending') return 'The link is being made';
  if (flow.step !== 'preparing') return null;
  switch (flow.share.subject) {
    case 'chart':
      return 'The picture is still being taken';
    case 'conversation':
      return 'The preview is still loading';
    case 'setup':
      return 'Getting it ready';
  }
}
