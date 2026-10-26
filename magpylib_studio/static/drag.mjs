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
 * the pointer the longer the drag went on. No more than one is sent a frame:
 * a small scene answers in under two milliseconds, and building it several
 * hundred times a second to show it sixty is work the screen throws away.
 *
 * ## Redrawing around the drag
 *
 * Moving a magnet moves more than the magnet: a field's arrows are computed
 * from it and have to be asked for again. The engine builds the scene for
 * the next pose while the view draws the last one: the newest answer is
 * drawn on the next frame, and an answer overtaken before then is dropped.
 * Done in turn instead -- answer, frame, draw, then the next pose -- a round
 * trip a little longer than a frame cost two, and the demo's Halbach with
 * field lines drew 30 scenes a second where it now draws 51 (#45). Nothing
 * queues: one pose is in flight, and one scene waits to be drawn.
 *
 * Pacing stops the work queueing up; it does not stop slow redraws from
 * stuttering the drag they are meant to illustrate. So each is timed, and
 * the next waits for as long again as it took, twice: redraws take no more
 * than a third of the view's time (`REDRAW_SHARE`), and the frames between
 * them move the object under the pointer. A redraw a frame long comes every
 * third frame, and the scene follows the drag at whatever rate the machine
 * affords -- a hard stop at 8 ms, which this replaces, stopped it outright
 * on a machine a quarter as fast, where the demo's Halbach redraws in 7 to
 * 10. Only a scene that freezes the gesture outright, past `HEAVY_REDRAW_MS`
 * twice in a row, goes without for the rest of the drag, and catches up
 * when it ends. Not judged on the first redraw: it pays for what a drag
 * makes once (#45).
 */

/** The most of the view's time a drag's redraws may take: after one that
 *  took `t`, the next waits `2t`. The rest is the frames that move what the
 *  handles hold, which is what a drag feels like. */
export const REDRAW_SHARE = 1 / 3;

/** How long a redraw may take before the drag stops waiting for them: six
 *  frames at 60 Hz, a freeze the gesture cannot hide, however seldom. */
export const HEAVY_REDRAW_MS = 100;

/** Take the drags on `host`, the element the renderer draws in.
 *
 * What the view supplies:
 *
 * - `begin({ objectIds, mode })`: a drag has started moving. Open the undo
 *   group -- the edits it is about to make are one thing to undo -- and say
 *   anything it will supersede, before rather than after. Not on the press:
 *   the renderer reports nothing for a handle clicked and let go, so a group
 *   opened then would never be closed, and swallow the next edit made.
 * - `preview(pose, { scene, since })`: a pose reached mid-drag. Returns a
 *   promise, settled once the engine has taken it; the next is not sent until
 *   then. `scene` says the drag will redraw from what the pose made, which
 *   the answer may carry -- see `scene()`. `since`: when the first of the
 *   poses it stands for was reached, the pointer having moved on while the
 *   one before was away.
 * - `commit(pose)`: the pose the drag ended on. Record it and close the group.
 * - `cancel()`: Esc in a drag that had begun: close the group and take it
 *   back, as if it had never been made.
 * - `scene()`: a promise of the scene as it is now, to redraw around the drag.
 *   Spared when `preview` answers with a `scene` of its own: one message
 *   where there were two, for a host whose every message costs.
 * - `render(payload, { keep })`: draw it, keeping the nodes of `keep`, the
 *   objects the handles hold, which are already where the pointer put them.
 * - `drawing()`: whether the 3D view is what is on screen (default: yes).
 * - `showPose(pose)`: optional, the numbers at pointer rate.
 *
 * Returns a function that stops taking them.
 */
export function watchDrags(host, view) {
  const drawing = view.drawing ?? (() => true);
  let dragging = null; // { keep, tooSlow, redraws, slow, nextAt, begun } while a handle is held
  let pending = null; // the newest pose not yet sent
  let pendingSince = null; // when the first pose it replaced was reached
  let inFlight = false;
  let ticked = true; // a frame has begun since the last pose was sent
  let toDraw = null; // { drag, carried }: the newest answer, for the next frame
  let drawAsked = false; // a frame is asked for to draw it
  let redrawing = false; // a redraw is waiting on the scene it asked for

  async function redrawAround(carried) {
    if (!drawing() || !dragging || dragging.tooSlow) return;
    const drag = dragging;
    const payload = carried ?? (await view.scene());
    if (dragging !== drag) return; // released while the scene was on its way
    // Timed around the render alone. The request before it is the engine's
    // time, not the view's: it delays the next pose without blocking this one.
    const started = performance.now();
    view.render(payload, { keep: dragging.keep });
    const ended = performance.now();
    const cost = ended - started;
    dragging.nextAt = ended + cost * (1 / REDRAW_SHARE - 1);
    dragging.redraws += 1;
    const heavy = cost > HEAVY_REDRAW_MS && dragging.redraws > 1;
    dragging.slow = heavy ? dragging.slow + 1 : 0;
    dragging.tooSlow = dragging.slow >= 2;
  }

  function send() {
    if (inFlight || !pending || !ticked) return;
    inFlight = true;
    ticked = false;
    requestAnimationFrame(() => {
      ticked = true;
      send();
    });
    const pose = pending;
    const since = pendingSince;
    pending = pendingSince = null;
    const drag = dragging;
    // Asked for with the pose only while it will be drawn: a drag that has
    // stopped redrawing would have the scene built on every step for nothing.
    const scene = drawing() && Boolean(dragging) && !dragging.tooSlow;
    Promise.resolve(view.preview(pose, { scene, since }))
      .then((answer) => {
        if (scene) drawSoon(drag, answer && answer.scene ? answer.scene : null);
      })
      .catch(() => {}) // a failed preview must not end the drag
      .finally(() => {
        inFlight = false;
        send(); // whatever the pointer reached while that one was away
      });
  }

  /** Draw what `carried` shows on the next frame, unless a newer answer
   *  comes first -- or, with no scene carried, what the engine has then. The
   *  object under the pointer waits on none of it: the handles move its node
   *  locally. */
  function drawSoon(drag, carried) {
    toDraw = { drag, carried };
    if (drawAsked || redrawing) return;
    drawAsked = true;
    // no sooner than the last redraw's cost allows: see `REDRAW_SHARE`
    const wait = Math.max((drag?.nextAt ?? 0) - performance.now(), 0);
    const frame = (draw) =>
      wait > 1
        ? setTimeout(() => requestAnimationFrame(draw), wait)
        : requestAnimationFrame(draw);
    frame(async () => {
      drawAsked = false;
      const next = toDraw;
      toDraw = null;
      if (!next || next.drag !== dragging) return; // let go since
      redrawing = true;
      try {
        await redrawAround(next.carried);
      } catch {
        // a failed redraw must not end the drag
      } finally {
        redrawing = false;
      }
      if (toDraw) drawSoon(toDraw.drag, toDraw.carried);
    });
  }

  function onStart(event) {
    const { objectIds, mode, redrawn } = event.detail;
    // Nothing is kept where the picture has to come from the engine to be
    // right: aiming a polarization redraws the magnet's colours, a patterned
    // source's copies move by the mirror or the pitch of the drag rather than
    // with it, which only a rebuild knows, and a sensor resized spreads its
    // pixels without stretching them. The renderer says which (`redrawn`):
    // none has the handles on that node, so there is nothing to swap out
    // from under them.
    //
    // Several objects at once never are: they are hung on the rig for the
    // length of the drag, and a rebuild that took their nodes away would
    // leave them drawn twice, once on the rig and once from the payload. They
    // keep their nodes, and a pattern among them catches up at the release.
    dragging = {
      keep: redrawn ? null : objectIds,
      tooSlow: false,
      redraws: 0, // redraws in this drag, and heavy ones in a row
      slow: 0,
      nextAt: 0, // when the next may start, by the last one's cost
      begun: false,
      objectIds,
      mode,
    };
  }

  /** Open the gesture on its first report, not on the press -- see `begin`. */
  function begun() {
    if (!dragging || dragging.begun) return;
    dragging.begun = true;
    view.begin({ objectIds: dragging.objectIds, mode: dragging.mode });
  }

  function onTransform(event) {
    const pose = event.detail;
    if (pose.cancel) {
      // Esc: what the drag sent is taken back, nothing more is
      const began = dragging?.begun;
      dragging = null;
      pending = pendingSince = null;
      toDraw = null;
      if (began) view.cancel?.();
      return;
    }
    begun();
    if (pose.preview) {
      // Read out at pointer rate rather than at engine rate: the numbers are
      // already known here, and waiting for the round trip to show them
      // would make a fast drag on a heavy scene look like it had stopped.
      view.showPose?.(pose);
      pending = pose;
      pendingSince ??= performance.now();
      send();
      return;
    }
    dragging = null;
    // the pose it ended on supersedes anything still waiting
    pending = pendingSince = null;
    toDraw = null;
    view.commit(pose);
  }

  host.addEventListener("dragstart", onStart);
  host.addEventListener("objecttransform", onTransform);
  return () => {
    host.removeEventListener("dragstart", onStart);
    host.removeEventListener("objecttransform", onTransform);
  };
}
