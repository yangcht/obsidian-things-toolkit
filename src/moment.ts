import { moment } from "obsidian";

export type MomentFactory = typeof moment;
export type MomentLike = ReturnType<MomentFactory>;

export function getMoment(): MomentFactory {
  return moment;
}
