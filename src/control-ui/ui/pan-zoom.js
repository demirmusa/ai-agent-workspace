/* Pan and zoom on window.AIWSUI for canvases (AI drafts, agent hierarchy) and the image viewer. Loaded after ui/flow.js. */
(function (global) {
  'use strict';
  /** Pan and zoom for a stage whose content takes `translate(x,y) scale(scale)`: the wheel zooms around the pointer and dragging the
   *  stage pans where `canPan(event)` allows (the middle button always pans). `point(event)` gives the pointer in the content's
   *  transform-origin frame; `apply(view)` writes every change and `onUser()` runs when the person moved the view. While panning the
   *  stage carries `is-panning`. Returns the live view with `set(view)` and `zoom(factor, x, y)`. */
  function panZoom(stage, { apply, point, canPan = () => true, onUser = () => {}, min = 0.25, max = 16 }) {
    const view = { x: 0, y: 0, scale: 1 }; let drag = null;
    const set = next => { Object.assign(view, next); apply(view); };
    const zoom = (factor, cx = 0, cy = 0) => {
      const next = Math.min(max, Math.max(min, view.scale * factor)); if (next === view.scale) return;
      set({ x: cx - (cx - view.x) * next / view.scale, y: cy - (cy - view.y) * next / view.scale, scale: next });
    };
    stage.addEventListener('wheel', event => {
      event.preventDefault();
      const delta = Math.max(-120, Math.min(120, event.deltaY * (event.deltaMode === 1 ? 16 : 1)));
      zoom(Math.exp(-delta * 0.0016), ...point(event)); onUser();
    }, { passive: false });
    stage.addEventListener('pointerdown', event => {
      if (!(event.button === 1 || (event.button === 0 && canPan(event)))) return;
      if (event.button === 1) event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y }; stage.setPointerCapture?.(event.pointerId); stage.classList.add('is-panning');
    });
    stage.addEventListener('pointermove', event => { if (drag?.id !== event.pointerId) return; set({ x: event.clientX - drag.x, y: event.clientY - drag.y }); onUser(); });
    const release = () => { drag = null; stage.classList.remove('is-panning'); };
    stage.addEventListener('pointerup', release); stage.addEventListener('pointercancel', release);
    return { view, set, zoom };
  }

  global.AIWSUI = Object.freeze({ ...global.AIWSUI, panZoom });
})(window);
