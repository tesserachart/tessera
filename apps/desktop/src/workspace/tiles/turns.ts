import { animationFrame, type FrameScheduler } from '../../app/frame.ts';

interface Turn {
  first: boolean;
  go: () => void;
}

export class Turns {
  private readonly queue: Turn[] = [];
  private cancel: (() => void) | null = null;

  constructor(private readonly frame: FrameScheduler = animationFrame) {}

  take(first: boolean, go: () => void): () => void {
    const turn: Turn = { first, go };
    const after = first ? this.queue.findIndex((t) => !t.first) : -1;
    if (after < 0) this.queue.push(turn);
    else this.queue.splice(after, 0, turn);
    this.schedule();
    return () => {
      const i = this.queue.indexOf(turn);
      if (i >= 0) this.queue.splice(i, 1);
    };
  }

  get waiting(): number {
    return this.queue.length;
  }

  private schedule(): void {
    if (this.cancel || this.queue.length === 0) return;
    this.cancel = this.frame(() => {
      this.cancel = null;
      const turn = this.queue.shift();
      try {
        turn?.go();
      } finally {
        this.schedule();
      }
    });
  }
}

export const tileTurns = new Turns();
