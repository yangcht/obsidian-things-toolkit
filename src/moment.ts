import type {
  Moment,
  MomentFormatSpecification,
  MomentInput,
} from "moment";
import { moment as obsidianMoment } from "obsidian";

export type MomentLike = Moment;

export interface MomentFactory {
  (
    input?: MomentInput,
    format?: MomentFormatSpecification,
    strict?: boolean
  ): MomentLike;
  unix(timestamp: number): MomentLike;
}

const runtimeMoment: unknown = obsidianMoment;

function isMomentFactory(value: unknown): value is MomentFactory {
  return (
    typeof value === "function" &&
    "unix" in value &&
    typeof value.unix === "function"
  );
}

export function getMoment(): MomentFactory {
  if (!isMomentFactory(runtimeMoment)) {
    throw new Error("Obsidian Moment API is unavailable.");
  }

  return runtimeMoment;
}
