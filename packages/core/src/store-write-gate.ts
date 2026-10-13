/**
 * The one writer boundary between store commands and a sync cycle's local saves.
 *
 * A sync save writes the merged document to disk and then publishes it to the store. A command
 * that ran between the two read the old store and saved it back over the merged rows: at an equal
 * revision the upsert accepted the old title, and an old settings object erased the pending
 * remote-write marker. So a command holds the gate from its store read through its save, and a sync
 * save holds it alone from its freshness check through the publish. Network waits stay outside it.
 *
 * Commands share the gate: one command may call another (nested actions, a receipt's write and its
 * save), so a command joins while any command holds it. A sync save waits for running commands to
 * finish, and commands that arrive meanwhile wait for the save.
 */
let commands = 0;
let syncSave: Promise<void> | null = null;
let onCommandsDrained: (() => void) | null = null;

/** Run a store command inside the gate. It starts at once unless a sync save holds the gate. */
export const runStoreCommand = <T>(command: () => Promise<T>): Promise<T> => {
    const held = syncSave;
    if (held && commands === 0) return held.then(() => runStoreCommand(command));
    commands += 1;
    let result: Promise<T>;
    try {
        result = Promise.resolve(command());
    } catch (error) {
        result = Promise.reject(error);
    }
    return result.finally(() => {
        commands -= 1;
        if (commands === 0) onCommandsDrained?.();
    });
};

/** Run a sync save and its store publish with no command in between. It must not call a store command. */
export const runSyncStoreSave = async <T>(save: () => Promise<T>): Promise<T> => {
    while (syncSave) await syncSave;
    let release!: () => void;
    syncSave = new Promise<void>((resolve) => { release = resolve; });
    try {
        while (commands > 0) await new Promise<void>((resolve) => { onCommandsDrained = resolve; });
        onCommandsDrained = null;
        return await save();
    } finally {
        onCommandsDrained = null;
        syncSave = null;
        release();
    }
};
