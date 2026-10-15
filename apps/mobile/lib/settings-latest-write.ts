import { runStoreCommand, useTaskStore, type AppSettings } from '@mindwtr/core';

/**
 * A settings write built from the settings as stored when it is admitted (core's updateSettingsFromLatest, through
 * the screen's own updateSettings). A page that sends a whole group or list built from its rendered copy would put
 * back what another device synced since. [build] answers the updates, or null to write nothing.
 * Resolves true when it wrote.
 */
export const writeSettingsFromLatest = (
  updateSettings: (updates: Partial<AppSettings>) => Promise<unknown>,
  build: (settings: AppSettings) => Partial<AppSettings> | null | undefined,
): Promise<boolean> => runStoreCommand(async () => {
  const updates = build(useTaskStore.getState().settings ?? {});
  if (!updates) return false;
  await updateSettings(updates);
  return true;
});
