import { runStoreCommand, useTaskStore, type AppSettings } from '@mindwtr/core';

/**
 * Core's updateSettingsFromLatest through a page's own settings writer: [build] runs on the settings as stored
 * when the write is admitted, so a group built from a rendered copy does not put back a key another device
 * synced since. [build] answers the updates, or null to write nothing.
 */
export const updateSettingsFromLatestWith = (
    updateSettings: (updates: Partial<AppSettings>) => Promise<void>,
    build: (latest: AppSettings) => Partial<AppSettings> | null,
): Promise<void> => runStoreCommand(async () => {
    const updates = build(useTaskStore.getState().settings ?? {});
    if (updates) await updateSettings(updates);
});
