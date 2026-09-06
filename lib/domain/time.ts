export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

