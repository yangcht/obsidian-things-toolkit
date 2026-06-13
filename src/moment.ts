export interface MomentLike {
  unix(): number;
  startOf(unit: string): MomentLike;
  endOf(unit: string): MomentLike;
  format(pattern?: string): string;
  diff(input: string | MomentLike, unit?: string): number;
  clone(): MomentLike;
  subtract(amount: number, unit: string): MomentLike;
  add(amount: number, unit: string): MomentLike;
  isSameOrBefore(input: MomentLike, unit?: string): boolean;
  isBefore(input: MomentLike, unit?: string): boolean;
  isAfter(input: MomentLike, unit?: string): boolean;
  isSame(input: MomentLike, unit?: string): boolean;
  isoWeek(): number;
  year(): number;
  month(): number;
  date(): number;
  fromNow(): string;
}

export interface MomentFactory {
  (): MomentLike;
  (input: string, format?: string, strict?: boolean): MomentLike;
  unix(timestamp: number): MomentLike;
}

declare global {
  interface Window {
    moment: MomentFactory;
  }
}

export function getMoment(): MomentFactory {
  return window.moment;
}
