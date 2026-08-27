/**
 * A progress channel for operations that take long enough to need one.
 *
 * A module-level sink rather than a parameter threaded through every op: only a
 * handful of tools run long enough to report anything, and changing the
 * signature of all thirty to serve three would be worse than this.
 *
 * The worker sets the sink per request so a report can carry the right job id,
 * and clears it afterwards — a stale sink would attribute one job's progress to
 * the next one's bar.
 */
export interface Progress {
  done: number;
  total: number;
  /** What is happening, in the user's words. Never a filename or page content. */
  label?: string;
}

type Sink = (progress: Progress) => void;

let sink: Sink | null = null;

export function setProgressSink(next: Sink | null): void {
  sink = next;
}

export function reportProgress(done: number, total: number, label?: string): void {
  sink?.({ done, total, label });
}
