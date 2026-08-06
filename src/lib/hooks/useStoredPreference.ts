"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A UI preference held in `localStorage`.
 *
 * The obvious implementation — `useState` plus a `useEffect` that reads storage
 * on mount — is what this replaces. That pattern renders once with the default,
 * then calls `setState` inside the effect, which is a cascading render on every
 * mount and is what `react-hooks/set-state-in-effect` objects to. Reading
 * storage *during* render instead is worse: the server has no `localStorage`,
 * so the markup and the first client paint disagree, and this project already
 * carries one hydration mismatch.
 *
 * `useSyncExternalStore` is the thing built for exactly this. It takes a
 * server snapshot (the default) and a client snapshot (storage), so React uses
 * the default for SSR and hydration and switches afterwards without a mismatch
 * and without an effect.
 *
 * Subscribing to `storage` is a free bonus rather than the point: a staff
 * member with two tabs open gets one sidebar, not two that disagree.
 */

/** Bumped whenever this tab writes, so `useSyncExternalStore` re-reads. */
let localVersion = 0;
const listeners = new Set<() => void>();

function notify() {
  localVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  // `storage` only fires in *other* tabs, which is why the local bump above
  // exists as well.
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // A blocked or unavailable store must not take the navigation down with it.
    return null;
  }
}

/**
 * `getSnapshot` must return a referentially stable value between changes, or
 * React re-renders forever. Parsed objects are therefore cached against the raw
 * string *and* the local write counter that produced them.
 */
const cache = new Map<string, { raw: string | null; version: number; value: unknown }>();

export function useStoredPreference<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T
): [T, (next: T) => void] {
  const getSnapshot = useCallback((): T => {
    const raw = readRaw(key);
    const cached = cache.get(key);
    if (cached && cached.raw === raw && cached.version === localVersion) return cached.value as T;
    let value: T;
    try {
      value = raw === null ? fallback : parse(raw);
    } catch {
      // A corrupt entry falls back rather than throwing during render.
      value = fallback;
    }
    cache.set(key, { raw, version: localVersion, value });
    return value;
  }, [fallback, key, parse]);

  // SSR and the first hydrating render both see the default, so the markup the
  // server produced is the markup the client expects.
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Private mode, quota, or a blocked store. The control still works. */
      }
      notify();
    },
    [key]
  );

  return [value, setValue];
}

/** `JSON.parse` narrowed to a string array, for the list-shaped preferences. */
export function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}
