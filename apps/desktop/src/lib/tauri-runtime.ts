/**
 * Tauri runtime detection.
 *
 * The desktop app can run in two places:
 *
 *   - inside the Tauri webview (the shipped app) — Tauri injects
 *     `window.__TAURI_INTERNALS__`
 *   - in a plain browser via `vite dev` — no Tauri runtime, and
 *     therefore **no OS keychain**
 *
 * Phase A / A1 uses this to decide whether the agent's private key can
 * live in the OS keychain. The decision is never made silently: every
 * caller is expected to report which mode it is in (see
 * `agent-service.ts` and the Home screen banner).
 */

export interface TauriInvoke {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

/** The Tauri invoke bridge, or `null` when not running under Tauri. */
export function getTauriInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const w = window as TauriWindow;
  const inv = w.__TAURI_INTERNALS__?.invoke;
  if (typeof inv !== 'function') return null;
  return {
    invoke: <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
      inv.call(w.__TAURI_INTERNALS__, cmd, args) as Promise<T>,
  };
}

/** True when the app runs inside the Tauri runtime. */
export function isTauriRuntime(): boolean {
  return getTauriInvoke() !== null;
}
