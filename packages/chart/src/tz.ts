const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

export interface LocalParts {
  year: number;
  month1: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  minuteOfDay: number;
}

export class ZonedClock {
  readonly timezone: string;
  private readonly dtf: Intl.DateTimeFormat;
  private readonly offsetCache = new Map<number, number>();

  constructor(timezone: string) {
    this.timezone = timezone;
    this.dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  offsetMs(utcMs: number): number {
    const key = Math.floor(utcMs / HOUR);
    let off = this.offsetCache.get(key);
    if (off === undefined) {
      off = this.computeOffset(key * HOUR);
      if (this.offsetCache.size > 50_000) this.offsetCache.clear();
      this.offsetCache.set(key, off);
    }
    return off;
  }

  private computeOffset(utcMs: number): number {
    let y = 1970;
    let mo = 1;
    let d = 1;
    let h = 0;
    let mi = 0;
    let s = 0;
    for (const p of this.dtf.formatToParts(utcMs)) {
      const v = Number(p.value);
      switch (p.type) {
        case 'year':
          y = v;
          break;
        case 'month':
          mo = v;
          break;
        case 'day':
          d = v;
          break;
        case 'hour':
          h = v;
          break;
        case 'minute':
          mi = v;
          break;
        case 'second':
          s = v;
          break;
        default:
          break;
      }
    }
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    return Math.round((asUtc - utcMs) / MINUTE) * MINUTE;
  }

  toLocalMs(utcMs: number): number {
    return utcMs + this.offsetMs(utcMs);
  }

  parts(utcMs: number): LocalParts {
    const d = new Date(this.toLocalMs(utcMs));
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    return {
      year: d.getUTCFullYear(),
      month1: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
      hour,
      minute,
      second: d.getUTCSeconds(),
      minuteOfDay: hour * 60 + minute,
    };
  }

  tradingDay(utcMs: number, dayStartMinutes: number): number {
    let local = this.toLocalMs(utcMs);
    if (dayStartMinutes > 0) {
      const mod = ((local % DAY) + DAY) % DAY;
      if (mod >= dayStartMinutes * MINUTE) local += DAY;
    }
    const d = new Date(local);
    return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayName(weekday: number): string {
  return WEEKDAY[weekday] ?? '';
}

export function monthName(month1: number): string {
  return MONTH[month1 - 1] ?? '';
}

export function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}
