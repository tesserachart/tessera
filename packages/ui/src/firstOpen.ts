export interface FirstOpen {
  intro: string;
  steps: readonly string[];
  alternative?: string;
}

export const MAC_FIRST_OPEN: FirstOpen = {
  intro:
    'The alpha is not notarized by Apple yet, so the first time you open Tessera, macOS stops it until you allow it. You do this once.',
  steps: [
    'Open Tessera from Applications. macOS says it could not verify Tessera; close that message.',
    'Open System Settings › Privacy & Security and scroll down to Security, where it says “Tessera” was blocked to protect your Mac. Choose Open Anyway. If the button is not there, open Tessera once more and come back.',
    'Confirm with your password or Touch ID, then choose Open Anyway when macOS asks again. Tessera opens, and from then on it opens like any other app.',
  ],
  alternative:
    'On macOS 13 or 14 there is a shorter way: Control-click Tessera in Applications, choose Open, then Open again.',
};

export const WINDOWS_FIRST_OPEN: FirstOpen = {
  intro:
    'The alpha is not signed for Windows yet, so the first time you run the installer, Microsoft Defender SmartScreen stops it until you allow it. You do this once.',
  steps: [
    'If your browser says the file is not commonly downloaded, keep it: in Edge, open the downloads list, choose … next to the file, then Keep, then Show more › Keep anyway.',
    'Open the installer. Windows says it protected your PC; choose More info, then Run anyway.',
    'Follow the installer, then open Tessera from the Start menu. From then on it updates itself.',
  ],
};

export const LINUX_FIRST_OPEN: FirstOpen = {
  intro: 'The AppImage runs on most x86_64 distributions without installing anything.',
  steps: [
    'Make it executable: right-click the file › Properties › Permissions › Allow executing file as program, or chmod +x it.',
    'Open it. When Tessera updates, it replaces the file itself.',
  ],
  alternative:
    'On Debian or Ubuntu you can install the .deb instead, with sudo apt install ./Tessera-latest-linux-amd64.deb. Its updates ask for your password.',
};

export function firstOpenText({ intro, steps, alternative }: FirstOpen): string {
  return [intro, ...steps.map((step, i) => `${String(i + 1)}. ${step}`), ...(alternative ? [alternative] : [])].join(
    '\n',
  );
}
