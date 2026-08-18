/**
 * Keep a pointer-driven resize active after the cursor leaves the original
 * handle, then cleanly release every listener on completion. The global resize
 * class temporarily removes iframe hit-testing, so embedded documents cannot
 * swallow the move/up sequence.
 */
export function beginPointerResize(
  pointerId: number,
  onMove: (clientX: number) => void,
  onEnd?: () => void,
): void {
  let finished = false;
  let moveFrame = 0;
  let pendingClientX: number | null = null;

  const flushMove = () => {
    moveFrame = 0;
    if (pendingClientX === null) return;
    const clientX = pendingClientX;
    pendingClientX = null;
    onMove(clientX);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    window.cancelAnimationFrame(moveFrame);
    flushMove();
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", finish, true);
    window.removeEventListener("blur", finish);
    document.body.classList.remove("is-resizing-column");
    onEnd?.();
    window.dispatchEvent(new Event("stacks:resize-end"));
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    // If the pointer was released outside the window, the next move is the
    // first reliable completion signal available to the page.
    if (event.buttons === 0) {
      finish();
      return;
    }
    pendingClientX = event.clientX;
    if (!moveFrame) moveFrame = window.requestAnimationFrame(flushMove);
  };

  document.body.classList.add("is-resizing-column");
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);
  window.addEventListener("blur", finish);
}
