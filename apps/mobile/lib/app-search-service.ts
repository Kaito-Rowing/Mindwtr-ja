import { nameNotifyListener, useTaskStore } from '@mindwtr/core';

import { logInfo, logWarn } from '@/lib/app-log';
import {
    removeAppSearchDocuments,
    upsertAppSearchDocuments,
    wipeAppSearchIndexNative,
} from '@/modules/app-search';

import { buildAppSearchDelta, buildFullAppSearchIndex } from './app-search-projection';
import {
    clearAppSearchWipeOwed,
    isAppSearchSupported,
    readAppSearchIndexingEnabled,
    readAppSearchWipeOwed,
} from './app-search-preference';

/**
 * Orchestrates the Android AppSearch secondary index (#1017): arms a debounced
 * store subscription that keeps the disposable projection in sync with the
 * visible tasks/projects/areas, with a zero-overhead early exit whenever the
 * feature is off or unsupported. AppSearch is a mirror, not a source of
 * truth — every failure here is logged and swallowed, never surfaced as a
 * core-data error.
 *
 * Mutation-hook placement: subscribes to the same whole-store `useTaskStore`
 * used by the mobile reminder rescheduler
 * (`lib/notification-service-local.ts`), reference-comparing only the
 * `tasks`/`projects`/`areas` slices so unrelated store writes (sync status,
 * editor UI state) are free. Work is debounced so a bulk edit does one index
 * round-trip, not N.
 */

const REINDEX_DEBOUNCE_MS = 2_000;

let storeUnsubscribe: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastIndexedTasks: ReturnType<typeof useTaskStore.getState>['tasks'] = [];
let lastIndexedProjects: ReturnType<typeof useTaskStore.getState>['projects'] = [];
let lastIndexedAreas: ReturnType<typeof useTaskStore.getState>['areas'] = [];

export function isAppSearchIndexingArmed(): boolean {
    return storeUnsubscribe !== null;
}

async function applyDelta(prev: {
    tasks: typeof lastIndexedTasks;
    projects: typeof lastIndexedProjects;
    areas: typeof lastIndexedAreas;
}, next: {
    tasks: typeof lastIndexedTasks;
    projects: typeof lastIndexedProjects;
    areas: typeof lastIndexedAreas;
}): Promise<void> {
    const delta = buildAppSearchDelta({
        prevTasks: prev.tasks,
        nextTasks: next.tasks,
        prevProjects: prev.projects,
        nextProjects: next.projects,
        prevAreas: prev.areas,
        nextAreas: next.areas,
    });
    if (delta.upserts.length === 0 && delta.removeIds.length === 0) return;
    // Removals are the privacy-relevant half (a completed/deleted task must
    // stop appearing in system search): run both independently so a failed
    // upsert can never suppress a removal that was due in the same batch.
    const [upsertResult, removeResult] = await Promise.allSettled([
        upsertAppSearchDocuments(delta.upserts),
        removeAppSearchDocuments(delta.removeIds),
    ]);
    for (const result of [upsertResult, removeResult]) {
        if (result.status !== 'rejected') continue;
        void logWarn('AppSearch index update failed; local data is unaffected', {
            scope: 'app-search',
            extra: { error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        });
    }
}

/** Arms the debounced store subscription. Idempotent and a no-op when unsupported. */
export function armAppSearchIndexing(): void {
    if (!isAppSearchSupported()) return;
    if (storeUnsubscribe) return;

    const seed = useTaskStore.getState();
    lastIndexedTasks = seed.tasks;
    lastIndexedProjects = seed.projects;
    lastIndexedAreas = seed.areas;

    storeUnsubscribe = useTaskStore.subscribe(nameNotifyListener('app-search-reindex', (state, prevState) => {
        if (state.tasks === prevState.tasks && state.projects === prevState.projects && state.areas === prevState.areas) {
            return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const next = { tasks: state.tasks, projects: state.projects, areas: state.areas };
            const prev = { tasks: lastIndexedTasks, projects: lastIndexedProjects, areas: lastIndexedAreas };
            lastIndexedTasks = next.tasks;
            lastIndexedProjects = next.projects;
            lastIndexedAreas = next.areas;
            void applyDelta(prev, next);
        }, REINDEX_DEBOUNCE_MS);
    }));
}

/** Disarms the subscription without touching the native index (see `wipeAppSearchIndex` for toggle-off). */
export function disarmAppSearchIndexing(): void {
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

/**
 * Rebuilds the index from scratch: wipe, then upsert every currently
 * indexable task/project/area. Used on toggle-on and as the drift-recovery
 * strategy (called again whenever indexing is (re-)armed after being off —
 * simplest way to guarantee the on-device index matches the store after any
 * period of not observing it, at the cost of one full rewrite rather than a
 * cleverer drift-detection pass).
 */
export async function runFullAppSearchReindex(): Promise<void> {
    if (!isAppSearchSupported()) return;
    const state = useTaskStore.getState();
    const docs = buildFullAppSearchIndex({ tasks: state.tasks, projects: state.projects, areas: state.areas });
    try {
        await wipeAppSearchIndexNative();
        // The wipe landed: any wipe a toggle-off still owed is done.
        await clearAppSearchWipeOwed();
        await upsertAppSearchDocuments(docs);
    } catch (error) {
        void logWarn('AppSearch full reindex failed; local data is unaffected', {
            scope: 'app-search',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}

/**
 * Runs a full reindex, then arms — but only if the device-local preference
 * still reads on by the time the reindex finishes. A toggle-off landing
 * mid-reindex must win: the reindex's own upserts just repopulated the
 * index, so this re-checks and wipes again rather than leaving documents
 * behind (and a live subscription) while the setting reads OFF.
 */
export async function enableAppSearchIndexing(): Promise<void> {
    if (!isAppSearchSupported()) return;
    await runFullAppSearchReindex();
    if (await readAppSearchIndexingEnabled()) {
        armAppSearchIndexing();
        return;
    }
    try {
        await wipeAppSearchIndexNative();
    } catch (error) {
        void logWarn('AppSearch post-toggle-off wipe failed', {
            scope: 'app-search',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}

/** Wipes the native index and disarms — used when the user turns the setting off. */
export async function wipeAppSearchIndex(): Promise<void> {
    disarmAppSearchIndexing();
    if (!isAppSearchSupported()) return;
    try {
        await wipeAppSearchIndexNative();
        await clearAppSearchWipeOwed();
    } catch (error) {
        void logWarn('AppSearch wipe failed', {
            scope: 'app-search',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}

/**
 * Reads the persisted device-local preference and arms (with a seeding full
 * reindex) or leaves the index disarmed to match it. Safe to call from
 * multiple mount points — arming is idempotent.
 */
export async function syncAppSearchIndexingWithPreference(): Promise<void> {
    if (!isAppSearchSupported()) return;
    const enabled = await readAppSearchIndexingEnabled();
    if (!enabled) {
        // A toggle-off whose wipe never landed: finish it now, so titles do not stay in system search.
        if (!(await readAppSearchWipeOwed())) return;
        let outcome = 'wiped';
        try {
            await wipeAppSearchIndexNative();
            await clearAppSearchWipeOwed();
        } catch {
            outcome = 'failed';
        }
        void logInfo('AppSearch owed wipe finished at start', {
            scope: 'app-search',
            extra: { releaseCheck: 'v1.3.7/app-search-owed-wipe', outcome },
        });
        return;
    }
    if (isAppSearchIndexingArmed()) return;
    await runFullAppSearchReindex();
    armAppSearchIndexing();
}
