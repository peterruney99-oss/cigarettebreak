/*
 * timer.js
 * The clock is the wall clock. The only stored fact is the instant of ignition;
 * remaining time is always derived from Date.now(). Nothing counts ticks, so a
 * backgrounded tab, a sleeping laptop, or a reload cannot stretch or shrink the wait.
 */

export function createBurnClock({ durationSeconds, speed = 1, storageKey }) {
  const durationMs = durationSeconds * 1000;
  let ignitedAt = null;
  let prompt = '';

  function read() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (typeof data.ignitedAt !== 'number' || !isFinite(data.ignitedAt)) return null;
      return data;
    } catch {
      return null;
    }
  }

  function write() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ignitedAt, prompt }));
    } catch {
      /* private mode or storage disabled: the burn still runs, it just cannot survive a reload */
    }
  }

  return {
    durationMs,
    speed,

    /** Restore a burn from a previous page load. Returns true if one exists. */
    restore() {
      const data = read();
      if (!data) return false;
      ignitedAt = data.ignitedAt;
      prompt = typeof data.prompt === 'string' ? data.prompt : '';
      return true;
    },

    ignite(userPrompt = '') {
      ignitedAt = Date.now();
      prompt = userPrompt;
      write();
    },

    clear() {
      ignitedAt = null;
      prompt = '';
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* nothing to clear */
      }
    },

    get ignitedAt() {
      return ignitedAt;
    },
    get prompt() {
      return prompt;
    },
    get lit() {
      return ignitedAt !== null;
    },

    /** Milliseconds of burn left, in burn time (0..durationMs). */
    remainingMs(now = Date.now()) {
      if (ignitedAt === null) return durationMs;
      const elapsed = Math.max(0, now - ignitedAt) * speed;
      return Math.max(0, durationMs - elapsed);
    },

    /** 0 at ignition, 1 when the match is out. */
    progress(now = Date.now()) {
      return 1 - this.remainingMs(now) / durationMs;
    },

    /** Real milliseconds until the end, for scheduling the completion timeout. */
    realMsUntilDone(now = Date.now()) {
      return this.remainingMs(now) / speed;
    },
  };
}
