/* Motion helpers on window.AIWSUI that animate only what is new or has moved: keyed entrances, FLIP glides, text crossfades and
 * number tweens, all off under reduced motion (the motion preference below). Loaded right after ui-common.js. */
(function (global) {
  'use strict';
  // The motion preference: 'full' (the default) animates even when the system asks for less, 'system' follows the system and
  // 'reduced' turns motion off. It is kept per browser and published as :root[data-motion] for the stylesheets.
  const motionKey = 'aiws.motion', motionChoices = ['full', 'system', 'reduced'];
  const motionQuery = typeof global.matchMedia === 'function' ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let motionChoice = 'full';
  try { const saved = global.localStorage?.getItem(motionKey); if (motionChoices.includes(saved)) motionChoice = saved; } catch { /* Storage may be disabled. */ }
  /** Whether motion is off; every motion helper checks it on each call. */
  function reducedMotion() { return motionChoice === 'reduced' || motionChoice === 'system' && Boolean(motionQuery?.matches); }
  function applyMotion() { const root = global.document?.documentElement; if (root) root.dataset.motion = reducedMotion() ? 'reduced' : 'full'; }
  /** The saved motion preference. */
  const motionPreference = () => motionChoice;
  /** Saves a motion preference and applies it at once. */
  function setMotionPreference(choice) {
    if (!motionChoices.includes(choice)) return;
    motionChoice = choice; applyMotion();
    try { global.localStorage?.setItem(motionKey, choice); } catch { /* Storage may be disabled. */ }
  }
  motionQuery?.addEventListener?.('change', applyMotion); applyMotion();

  // Durations and easing come from the theme tokens in styles.css (--dur, --dur-slow, --dur-enter, --ease-out), read once on first use
  // (deferred scripts run after the stylesheets); the fallbacks are the same values. Lists longer than flipLimit change without measuring.
  const flipLimit = 200;
  let tokens = null;
  function timing() {
    if (tokens) return tokens;
    const style = global.document?.documentElement && typeof global.getComputedStyle === 'function' ? global.getComputedStyle(global.document.documentElement) : null;
    const read = name => String(style?.getPropertyValue(name) || '').trim(), ms = (name, fallback) => { const value = read(name), number = parseFloat(value); return Number.isFinite(number) ? /\ds$/.test(value) ? number * 1000 : number : fallback; };
    tokens = { base: ms('--dur', 180), slow: ms('--dur-slow', 280), enter: ms('--dur-enter', 340), easing: read('--ease-out') || 'cubic-bezier(.16,1,.3,1)' };
    return tokens;
  }
  const seenKeys = new WeakMap(), entering = new WeakMap(), flights = new WeakMap(), counts = new WeakMap(), entranceClasses = ['ui-enter', 'ui-enter-fade'];
  const canAnimate = () => typeof global.Element?.prototype?.animate === 'function', clock = () => global.performance?.now?.() ?? Date.now();
  /** Drops the entrance class once its own animation ends or is cancelled, so a re-appended element does not replay it. */
  function settle(event) {
    const element = event.currentTarget;
    if (event.target !== element || !/^ui-(enter|fade|rise|slide)$/.test(event.animationName)) return;
    element.classList.remove(...entranceClasses); element.style.removeProperty('--enter-delay');
    element.removeEventListener('animationend', settle); element.removeEventListener('animationcancel', settle);
  }
  /** One staggered entrance for an element that just appeared; the class leaves when its own animation ends, so moving it later
   * never replays it. */
  function once(element, delay = 0) {
    if (!element || reducedMotion()) return;
    element.style.setProperty('--enter-delay', `${delay}ms`);
    element.addEventListener('animationend', settle); element.addEventListener('animationcancel', settle);
    element.classList.add('ui-enter');
  }
  /** Hides an element and calls `done` (removal, cleanup) once its CSS exit transition has ended, or at once when none applies
   * (reduced motion, a test DOM). The `[hidden]` rule of popup menus gives them that transition. */
  function dismiss(element, done) {
    if (!element) { done?.(); return; }
    element.hidden = true;
    const duration = global.getComputedStyle?.(element).transitionDuration ?? '';
    if (!/[1-9]/.test(duration)) { done?.(); return; }
    let finished = false; const finish = () => { if (finished) return; finished = true; element.removeEventListener('transitionend', finish); done?.(); };
    element.addEventListener('transitionend', finish); global.setTimeout(finish, 400);
  }
  /** After a render, gives elements whose key was absent at the previous call a staggered one-shot entrance and remembers the keys per
   * container. A re-render during an entrance continues it on the replacement element (negative delay) instead of cutting it short.
   * `delays` (key → ms) replaces the index stagger for the keys it names, so a tree can enter parent before child. More than `limit`
   * new elements (a screen opening on a long list) would each animate on a layer of their own, so such a batch enters as one: the
   * container fades in once when everything in it is new, and a long batch added to a list already shown simply appears. */
  function enter(container, selector, keyAttr, { stagger = 40, max = 8, className = 'ui-enter', delays = null, limit = 24 } = {}) {
    if (!container?.querySelectorAll) return;
    const previous = seenKeys.get(container), running = entering.get(container), keys = new Set(), live = new Map(), items = [], now = clock(), { enter: enterMs, easing } = timing();
    for (const element of container.querySelectorAll(selector)) { const key = element.getAttribute(keyAttr); if (key !== null) { keys.add(key); items.push([element, key]); } }
    seenKeys.set(container, keys); entering.set(container, live);
    if (reducedMotion() || global.document?.hidden) return;
    const fresh = delays ? 0 : items.reduce((count, [, key]) => count + (previous?.has(key) ? 0 : 1), 0);
    if (fresh > limit) {
      if (fresh === items.length && typeof container.animate === 'function') container.animate([{ opacity: 0 }, { opacity: 1 }], { duration: enterMs, easing });
      return;
    }
    let index = 0;
    for (const [element, key] of items) {
      let start = running?.get(key);
      if (!previous?.has(key)) start = now + (delays?.get(key) ?? Math.min(index++, max) * stagger);
      else if (start === undefined || now - start >= enterMs) continue;
      live.set(key, start);
      if (element.classList.contains(className)) continue;
      element.style.setProperty('--enter-delay', `${Math.round(start - now)}ms`);
      element.addEventListener('animationend', settle); element.addEventListener('animationcancel', settle);
      element.classList.add(className);
    }
  }
  /** Forgets the keys enter() remembered for a container, so its next call enters every element again. */
  function forget(container) { seenKeys.delete(container); entering.delete(container); }
  /** Removes a keyed element from its list: it fades out through its `.is-leaving` style, then the others glide into its place.
   * Under reduced motion it goes at once. */
  function leave(container, selector, keyAttr, element) {
    const remove = () => flip(container, selector, keyAttr, () => element.remove());
    if (reducedMotion()) { remove(); return; }
    if (element.classList.contains('is-leaving')) return;
    element.classList.add('is-leaving'); element.inert = true; global.setTimeout(remove, timing().base);
  }
  /** Measures keyed elements, runs mutate (usually a render), glides the ones that moved from their old place and enters new ones;
   * returns mutate's result. Elements still entering are left to their entrance. */
  function flip(container, selector, keyAttr, mutate, options) {
    const before = new Map(), running = entering.get(container), now = clock(), { enter: enterMs, slow, easing } = timing();
    if (container?.isConnected && canAnimate() && !reducedMotion() && !global.document?.hidden && container.getClientRects().length) {
      const elements = container.querySelectorAll(selector);
      if (elements.length <= flipLimit) for (const element of elements) {
        const key = element.getAttribute(keyAttr), start = running?.get(key);
        if (key !== null && !before.has(key) && !(start !== undefined && now - start < enterMs)) before.set(key, element.getBoundingClientRect());
      }
    }
    const result = mutate();
    if (before.size) {
      // Writes, then reads, then writes: one layout pass however many elements moved.
      // Screen distances are divided by the container's own scale, so a zoomed canvas glides its nodes the right distance.
      const elements = [...container.querySelectorAll(selector)].filter(element => before.has(element.getAttribute(keyAttr)));
      for (const element of elements) flights.get(element)?.cancel();
      const scale = container.offsetWidth ? container.getBoundingClientRect().width / container.offsetWidth || 1 : 1;
      const moved = elements.map(element => { const old = before.get(element.getAttribute(keyAttr)), rect = element.getBoundingClientRect(); return [element, (old.left - rect.left) / scale, (old.top - rect.top) / scale]; }).filter(([, dx, dy]) => Math.abs(dx) > 1 || Math.abs(dy) > 1);
      for (const [element, dx, dy] of moved) flights.set(element, element.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: slow, easing }));
    }
    enter(container, selector, keyAttr, options);
    return result;
  }
  /** Fades and lifts an element in once, for content that replaces its loading placeholder. */
  function reveal(element) {
    if (!reducedMotion() && typeof element?.animate === 'function') { const { enter: duration, easing } = timing(); element.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration, easing }); }
  }
  /** Replaces an element's text with a short fade-and-settle crossfade (opacity and transform only, no blur filter, so frequent swaps
   * stay on the compositor); does nothing when the text is unchanged. */
  function swapText(element, text) {
    const value = String(text ?? '');
    if (!element || element.textContent === value) return;
    element.textContent = value;
    if (!reducedMotion() && typeof element.animate === 'function') { const { base: duration, easing } = timing(); element.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration, easing }); }
  }
  /** Tweens a displayed number from the value it showed last to value over ~400 ms, formatting every frame; jumps the first time and under reduced motion. Without format, frames keep the target's decimal places. */
  function countTo(element, value, format) {
    if (!element) return;
    const target = Number(value), state = counts.get(element);
    if (state?.frame) global.cancelAnimationFrame?.(state.frame);
    if (!Number.isFinite(target)) { element.textContent = format ? format(value) : String(value ?? ''); counts.delete(element); return; }
    const places = Math.min(3, (String(value).split('.')[1] || '').length), show = format || (number => String(Math.round(number * 10 ** places) / 10 ** places));
    const from = state?.value, finish = () => { element.textContent = show(target); counts.set(element, { value: target, frame: 0 }); };
    if (!Number.isFinite(from) || from === target || reducedMotion() || typeof global.requestAnimationFrame !== 'function') return finish();
    const started = clock(), tween = { value: from, frame: 0 };
    counts.set(element, tween);
    const step = time => {
      const progress = Math.max(0, Math.min(1, ((Number.isFinite(time) ? time : clock()) - started) / 400));
      if (!(progress < 1) || !element.isConnected) return finish();
      tween.value = from + (target - from) * (1 - (1 - progress) ** 3); element.textContent = show(tween.value);
      tween.frame = global.requestAnimationFrame(step);
    };
    tween.frame = global.requestAnimationFrame(step);
  }

  global.AIWSUI = Object.freeze({ ...global.AIWSUI, reducedMotion, motionPreference, setMotionPreference, motion: Object.freeze({ enter, once, dismiss, forget, leave, flip, reveal, swapText, countTo }) });
})(window);
