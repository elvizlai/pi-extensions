import type { AgyActivity } from "./reducer.ts";

/** Missing step IDs use the same best-effort name key as replay correlation. */
export function agyToolStepKey(activity: { stepId?: number; name: string }): string {
  return activity.stepId === undefined ? `name:${activity.name}` : `step:${activity.stepId}`;
}

/** True only when the step explicitly started an agy daemon (`IsDaemon: true`). */
export function isDaemonToolStep(activity: {
  name: string;
  args?: Record<string, unknown>;
}): boolean {
  const flag = activity.args?.IsDaemon ?? activity.args?.isDaemon;
  return activity.name === "run_command" && (flag === true || flag === "true");
}

/** Repeated ACTIVE updates are idempotent; one completion cannot clear siblings. */
export function trackActiveToolStep(
  active: Set<string>,
  activity: AgyActivity,
  daemons?: Set<string>,
): void {
  if (activity.type === "tool_start") {
    const key = agyToolStepKey(activity);
    active.add(key);
    if (daemons && isDaemonToolStep(activity)) daemons.add(key);
  } else if (activity.type === "tool_done" || activity.type === "tool_error") {
    const key = agyToolStepKey(activity);
    active.delete(key);
    daemons?.delete(key);
  }
}
