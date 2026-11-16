import { ForbiddenError } from "@/lib/permissions";
import { STEP_UP_WINDOW_SECONDS } from "@/lib/session-policy";
import { STEP_UP_REQUIRED } from "@/lib/step-up";

/**
 * The step-up check used by sensitive services (ADR 0002). Kept free of
 * Next.js and Better Auth imports so services stay loadable from CLI scripts
 * (e.g. `pnpm staff:invite`, the break-glass path).
 */

export class StepUpRequiredError extends ForbiddenError {
  constructor() {
    super(STEP_UP_REQUIRED);
    this.name = "StepUpRequiredError";
  }
}

/** True when the viewer completed a step-up within the allowed window. */
export function hasFreshStepUp(viewer: { stepUpAt: string | null }, now = Date.now()): boolean {
  return viewer.stepUpAt !== null && now - Date.parse(viewer.stepUpAt) <= STEP_UP_WINDOW_SECONDS * 1000;
}

export function requireFreshStepUp(viewer: { stepUpAt: string | null }): void {
  if (!hasFreshStepUp(viewer)) throw new StepUpRequiredError();
}
