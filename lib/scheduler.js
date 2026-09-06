/**
 * lib/scheduler.js — Nightly Auto-Restart Scheduler
 *
 * Schedules a daily callback at a specified UTC time (default: 00:00 UTC).
 * Calculates delay to the next target UTC timestamp, accounts for leap years / month boundaries,
 * and automatically reschedules itself every 24 hours.
 */

class NightlyScheduler {
  /**
   * @param {object} options
   * @param {string} [options.targetTimeUtc='00:00'] - Target time in "HH:MM" UTC format
   * @param {function} options.onTrigger - Async callback to run when target time arrives
   * @param {object} [options.logger] - Logger instance
   */
  constructor({ targetTimeUtc = '00:00', onTrigger, logger } = {}) {
    this.targetTimeUtc = targetTimeUtc;
    this.onTrigger = onTrigger;
    this.logger = logger || console;
    this.timer = null;
    this._running = false;

    const [h, m] = (targetTimeUtc || '00:00').split(':').map(n => parseInt(n, 10));
    this.targetHour = isNaN(h) ? 0 : Math.min(Math.max(h, 0), 23);
    this.targetMinute = isNaN(m) ? 0 : Math.min(Math.max(m, 0), 59);
  }

  /**
   * Calculate milliseconds and Date for the next occurrence of target UTC time.
   * @returns {{ delayMs: number, nextDate: Date }}
   */
  getNextOccurrence() {
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      this.targetHour,
      this.targetMinute,
      0,
      0
    ));

    // If target time for today has already passed, schedule for tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const delayMs = next.getTime() - now.getTime();
    return { delayMs, nextDate: next };
  }

  /**
   * Formats a duration in milliseconds into a friendly "Xh Ym Zs" string.
   * @param {number} ms
   * @returns {string}
   */
  static formatDuration(ms) {
    const totalSecs = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  /**
   * Start the scheduler.
   */
  start() {
    this._running = true;
    this._scheduleNext();
  }

  /**
   * Stop the scheduler and clear pending timers.
   */
  stop() {
    this._running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _scheduleNext() {
    if (!this._running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const { delayMs, nextDate } = this.getNextOccurrence();
    const countdown = NightlyScheduler.formatDuration(delayMs);
    const targetStr = `${String(this.targetHour).padStart(2, '0')}:${String(this.targetMinute).padStart(2, '0')} UTC`;

    if (this.logger && this.logger.info) {
      this.logger.info(`Nightly auto-restart scheduled for ${targetStr} (${nextDate.toISOString()}) — in ${countdown}.`);
    }

    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this._running) return;

      if (this.logger && this.logger.info) {
        this.logger.info(`Nightly auto-restart timer fired for ${targetStr}.`);
      }

      try {
        if (this.onTrigger) {
          await this.onTrigger();
        }
      } catch (err) {
        if (this.logger && this.logger.error) {
          this.logger.error('Error during scheduled auto-restart execution:', { error: err?.message || String(err) });
        }
      } finally {
        // Reschedule for the next night if still running
        if (this._running) {
          this._scheduleNext();
        }
      }
    }, delayMs);

    if (this.timer && this.timer.unref && process.env.NODE_ENV === 'test') {
      this.timer.unref();
    }
  }
}

module.exports = NightlyScheduler;
