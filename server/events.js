/**
 * @typedef {{ type: string, id: number | string | null, label?: string }} EventTarget
 * @typedef {{ actor?: { id: number, email: string } | null, target?: EventTarget, detail?: Record<string, unknown> }} AppEvent
 * @typedef {(name: string, event: AppEvent) => void} Observer
 */

/**
 * A tiny in-process event bus. Code that changes something announces it ("course.published") and doesn't know or care
 * who is listening. Today the only listener is the audit log; email or analytics would be added the same way.
 * Observers run straight away, one after another, and one that throws never breaks the request that caused the event.
 */
export function createEvents() {
  /** @type {Observer[]} */
  const observers = [];
  return {
    /** Listens to every event. */
    observe(/** @type {Observer} */ fn) {
      observers.push(fn);
    },
    /**
     * @param {string} name for example "user.role_changed": the thing, a dot, what happened
     * @param {AppEvent} [event]
     */
    emit(name, event = {}) {
      for (const fn of observers) {
        try {
          fn(name, event);
        } catch (err) {
          console.error(`An observer failed on ${name}:`, err);
        }
      }
    },
  };
}

/** Builds an event target: `target("course", 4, "Safety basics")`. */
export const target = (type, id, label = "") => ({ type, id, label });
