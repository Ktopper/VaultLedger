/** Is `pid` a live process? `process.kill(pid, 0)` sends no signal but does the
 * existence+permission check: succeeds for a live owned process, throws EPERM
 * for a live process we don't own (still alive → true), ESRCH when none exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
