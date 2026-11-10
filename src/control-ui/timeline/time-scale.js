/* Time scale of the run timeline (timeline.js): the selectable ranges, how spans and run lengths read, which run an agent's chip
 * names, and the stacking of overlapping runs into lanes. */
(function (global) {
  'use strict';
  const t = value => global.AIWSI18n.text(value);
  const minute = 60000, hour = 60 * minute, rangeKey = 'aiws.timeline-range';
  // Every range reads as six equal steps back from now.
  const ranges = [['30m', 30 * minute], ['1h', hour], ['6h', 6 * hour], ['24h', 24 * hour]].map(([id, span]) => ({ id, span, step: span / 6 }));
  // Zoom stays between six one-minute steps and ninety days, and one press scales the span by half.
  const minSpan = 6 * minute, maxSpan = 90 * 24 * hour, zoomStep = 1.5;
  const unit = (value, name) => `${value} ${t(name)}`;
  /** Whole minutes below an hour and whole hours above it: how the range control and the axis read a span. */
  const amount = ms => ms < hour ? unit(Math.round(ms / minute), 'dk') : unit(Math.round(ms / hour), 'sa');
  /** A run's length in its two largest units: 45 sn, 16 dk, 2 sa 5 dk, 1 gün 3 sa. */
  function length(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    const parts = days ? [[days, 'gün'], [hours % 24, 'sa']] : hours ? [[hours, 'sa'], [minutes % 60, 'dk']] : [[minutes || seconds, minutes ? 'dk' : 'sn']];
    return parts.filter(([value], index) => value || !index).map(([value, name]) => unit(value, name)).join(' ');
  }
  // An agent's chip names its open run that most needs attention; with no open run the agent is idle.
  const urgency = ['needs', 'running', 'failed', 'idle', 'done'];
  function rowState(bars) {
    const open = bars.filter(bar => bar.end === null).sort((a, b) => urgency.indexOf(a.tone) - urgency.indexOf(b.tone))[0];
    return open ? [open.tone, open.label] : ['idle', t('Boşta')];
  }
  /** Puts each bar (sorted by start) into the first lane where it overlaps no earlier bar, keeping a gap; returns the lane count. */
  function stack(bars, lanes, now, gap) {
    const ends = [];
    for (const bar of bars) {
      let lane = ends.findIndex(end => end + gap <= bar.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = Math.max(bar.end ?? now, bar.start + gap); lanes.set(bar.id, lane);
    }
    return Math.max(1, ends.length);
  }
  function storedRange() {
    try { const value = global.localStorage.getItem(rangeKey); return ranges.some(range => range.id === value) ? value : ranges[0].id; }
    catch { return ranges[0].id; }
  }
  global.AIWSTimelineScale = Object.freeze({ ranges, amount, length, rowState, stack, storedRange, rangeKey, minSpan, maxSpan, zoomStep });
})(window);
