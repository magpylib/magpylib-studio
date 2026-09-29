/**
 * A drag of the 3D view's handles, from its first frame to its release: what
 * a view does with the renderer's `dragstart` and `objecttransform` events.
 *
 * Here, in the package, because two views do it: the studio's panel in VS
 * Code, and the notebook widget once it edits. The extension copies this file
 * (`harness/copy-widget.js`); nothing here knows which view it is in. Each
 * says how a pose reaches its engine -- messages to the extension's host, or
 * the kernel connection -- and what to show while one is on its way.
 *
 * ## Pacing
 *
 * Mid-drag poses are paced by the round trip rather than by a timer: one is
 * in flight at a time and the newest waiting pose wins, so the rate settles
 * wherever the scene's cost puts it -- measured from 1.4 ms for two magnets
 * to 180 ms for a thousand. Any fixed interval would be wrong at one end of
 * that or the other, and a queue would only make the view lag further behind
 * the pointer the longer the drag went on.
 *
 * ## Redrawing around the drag
 *
 * Moving a magnet moves more than the magnet: a field's arrows are computed
 * from it and have to be asked for again. This is the expensive half of the
 * round trip, so it runs *inside* the pacing loop rather than beside it --
 * the next pose is not sent until the scene it caused has been drawn, which
 * keeps a heavy scene sending fewer poses instead of falling behind.
 *
 * Pacing stops the work queueing up; it does not stop one slow redraw from
 * stuttering the drag it is meant to illustrate. So the first redraw of each
 * gesture is timed, and if building the scene costs more than a frame, the
 * rest of that drag goes without: the object under the pointer keeps up, and
 * the scene catches up when the drag ends. A big scene on a slow machine then
 * loses the thing that was never going to look right anyway, rather than the
 * smoothness of the gesture.
 */

/** How long building the scene may take before a drag stops waiting for it.
 *
 * Well under a frame at 60 Hz. Whatever else a drag updates may live in
 * another webview and cannot slow the pointer down; this runs in the view,
 * so it is the only thing that can make the gesture itself feel heavy. */
export const REDRAW_BUDGET_MS = 8;

/** Take the drags on `host`, the element the renderer draws in.
 *
 * What the view supplies:
 *
 * - `begin({ objectIds, mode })`: a drag has started. Open the undo group --
 *   the edits it is about to make are one thing to undo -- and say anything
 *   it will supersede, before rather than after.
 * - `preview(pose)`: a pose reached mid-drag. Returns a promise, settled once
 *   the engine has taken it; the next is not sent until then.
 * - `commit(pose)`: the pose the drag ended on. Record it and close the group.
 * - `scene()`: a promise of the scene as it is now, to redraw around the drag.
 * - `render(payload, { keep })`: draw it, keeping the nodes of `keep`, the
 *   objects the handles hold, which are already where the pointer put them.
 * - `patterned()`: the sources whose copies would not follow an edit, as a
 *   Set. A lone one of those is rebuilt from the scene rather than kept.
 * - `drawing()`: whether the 3D view is what is on screen (default: yes).
 * - `showPose(pose)`: optional, the numbers at pointer rate.
 *
 * Returns a function that stops taking them.
 */
export function watchDrags(host, view) {
  const drawing = view.drawing ?? (() => true);
  let dragging = null; // { keep, tooSlow } while a handle is held
  let pending = null; // the newest pose not yet sent
  let inFlight = false;

  async function redrawAround() {
    if (!drawing() || !dragging || dragging.tooSlow) return;
    const payload = await view.scene();
    if (!dragging) return; // released while the scene was on its way
    // Timed around the render alone. The request before it is the engine's
    // time, not the view's: it delays the next pose without blocking this one.
    const started = performance.now();
    view.render(payload, { keep: dragging.keep });
    dragging.tooSlow = performance.now() - started > REDRAW_BUDGET_MS;
  }

  function send() {
    if (inFlight || !pending) return;
    inFlight = true;
    const pose = pending;
    pending = null;
    Promise.resolve(view.preview(pose))
      // On the next frame, not on the reply: a small scene answers in under
      // two milliseconds, and rebuilding it several hundred times a second to
      // show it sixty is work the screen throws away. Whichever is slower
      // decides -- and the object under the pointer is not waiting on any of
      // it, since the handles move its node locally.
      .then(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      .then(redrawAround)
      .catch(() => {}) // a failed preview or redraw must not end the drag
      .finally(() => {
        inFlight = false;
        send(); // whatever the pointer reached while that one was away
      });
  }

  function onStart(event) {
    const { objectIds, mode } = event.detail;
    // Nothing is kept where the picture has to come from the engine to be
    // right: aiming a polarization redraws the magnet's colours, and a
    // patterned source's copies move by the mirror or the pitch of the drag
    // rather than with it, which only a rebuild knows. Neither has the
    // handles on that node, so there is nothing to swap out from under them.
    //
    // Several objects at once is the exception: they are hung on the rig for
    // the length of the drag, and a rebuild that took their nodes away would
    // leave them drawn twice, once on the rig and once from the payload. They
    // keep their nodes, and a pattern among them catches up at the release.
    const rebuilt =
      mode === "polarization" ||
      (objectIds.length === 1 && view.patterned().has(objectIds[0]));
    dragging = { keep: rebuilt ? null : objectIds, tooSlow: false };
    view.begin({ objectIds, mode });
  }

  function onTransform(event) {
    const pose = event.detail;
    if (pose.preview) {
      // Read out at pointer rate rather than at engine rate: the numbers are
      // already known here, and waiting for the round trip to show them
      // would make a fast drag on a heavy scene look like it had stopped.
      view.showPose?.(pose);
      pending = pose;
      send();
      return;
    }
    dragging = null;
    pending = null; // the pose it ended on supersedes anything still waiting
    view.commit(pose);
  }

  host.addEventListener("dragstart", onStart);
  host.addEventListener("objecttransform", onTransform);
  return () => {
    host.removeEventListener("dragstart", onStart);
    host.removeEventListener("objecttransform", onTransform);
  };
}
