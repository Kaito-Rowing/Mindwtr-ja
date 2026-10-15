import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { taskEditValuesEqual } from './json-value-equality';
import { logWarn } from './logger';
import { useTaskStore } from './store';
import type { StoreActionResult } from './store-types';
import { runStoreCommand } from './store-write-gate';
import type { Attachment, Project, Task } from './types';

/**
 * Writes that build a whole field (an attachment list, a checklist, tags) from the row as it is when the write is
 * admitted (store-write-gate.ts). A sync save admitted first publishes newer rows, so a list built from an earlier
 * read would drop what that save brought (a sibling attachment another device added) at a new revision.
 * [build] answers the updates for the latest row, or null to write nothing.
 */
const missing = (kind: string): StoreActionResult => ({ success: false, error: `${kind} not found` });

/** The one diagnostic line for a write refused because its row changed elsewhere (no task content). */
export const logStaleWriteRefused = (operation: string): void => {
    try {
        logWarn('Store write refused: the row changed on another device', {
            scope: 'store', category: 'sync',
            context: { releaseCheck: 'v1.3.7/sync-write-gate', outcome: 'stale-refused', operation },
        });
    } catch { /* a diagnostic line never fails its write */ }
};

export const updateTaskFromLatest = (
    id: string,
    build: (task: Task) => Partial<Task> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const task = useTaskStore.getState()._tasksById.get(id);
    if (!task) return missing('Task');
    const updates = build(task);
    return updates ? useTaskStore.getState().updateTask(id, updates) : { success: true, id };
});

export const updateProjectFromLatest = (
    id: string,
    build: (project: Project) => Partial<Project> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const project = useTaskStore.getState()._projectsById.get(id);
    if (!project) return missing('Project');
    const updates = build(project);
    return updates ? useTaskStore.getState().updateProject(id, updates) : { success: true, id };
});

/** batchUpdateTasks with each task's updates built from its latest row; a task that is gone is skipped. */
export const batchUpdateTasksFromLatest = (
    ids: readonly string[],
    build: (task: Task) => Partial<Task> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const byId = useTaskStore.getState()._tasksById;
    const updates = ids.flatMap((id) => {
        const task = byId.get(id);
        const next = task ? build(task) : null;
        return next ? [{ id, updates: next }] : [];
    });
    return updates.length > 0 ? useTaskStore.getState().batchUpdateTasks(updates) : { success: true, ids: [] };
});

/**
 * An updateTask for a write whose `attachments` is the shown task's list plus new ones (Process Inbox's /link
 * commands): the new ones are appended to the latest row's list instead, so an attachment a sync save brought stays.
 * Writes without attachments go to [updateTask] as they are.
 */
export const updateTaskAppendingAttachments = (
    shown: readonly Attachment[] | undefined,
    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>,
) => {
    const shownIds = new Set((shown ?? []).map((attachment) => attachment.id));
    return (id: string, updates: Partial<Task>): Promise<StoreActionResult> => (updates.attachments
        ? updateTaskFromLatest(id, (latest) => ({
            ...updates,
            attachments: [...(latest.attachments ?? []), ...updates.attachments!.filter((attachment) => !shownIds.has(attachment.id))],
        }))
        : updateTask(id, updates));
};

/** The draft's adds and removals since [base], applied to [latest]: a token another device added stays. */
const mergeTokenList = (base: readonly string[] = [], draft: readonly string[] = [], latest: readonly string[] = []): string[] => {
    const removed = new Set(base.filter((token) => !draft.includes(token)));
    const kept = latest.filter((token) => !removed.has(token));
    return [...kept, ...draft.filter((token) => !base.includes(token) && !kept.includes(token))];
};

type ChecklistItem = NonNullable<Task['checklist']>[number];
/** The draft's checklist adds, edits and removals since [base], by item id, applied to [latest]. */
const mergeChecklist = (base: readonly ChecklistItem[] = [], draft: readonly ChecklistItem[] = [], latest: readonly ChecklistItem[] = []): ChecklistItem[] => {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const draftById = new Map(draft.map((item) => [item.id, item]));
    const merged = latest.flatMap((item) => {
        const before = baseById.get(item.id);
        const after = draftById.get(item.id);
        if (before && !after) return [];
        return before && after && !taskEditValuesEqual(before, after) ? [after] : [item];
    });
    const latestIds = new Set(latest.map((item) => item.id));
    return [...merged, ...draft.filter((item) => !baseById.has(item.id) && !latestIds.has(item.id))];
};

/**
 * A draft's save as a field-level three-way merge (the editor and Process Inbox drafts): only the fields the draft
 * changed since [base] are written. When the latest row still holds [base]'s value, the draft's value is written as it
 * is (a reorder stays). When another device changed the same field too, lists merge (tags and contexts by token, the
 * checklist by item id, attachments by core's mergeTaskDraftAttachments) and a single value takes the draft's (last
 * write wins). [base] is the row the draft was opened or last saved on.
 */
export const mergeTaskDraftOntoLatest = (base: Task, updates: Partial<Task>, latest: Task): Partial<Task> => {
    const merged: Partial<Task> = {};
    for (const key of Object.keys(updates) as Array<keyof Task>) {
        const value = updates[key];
        if (taskEditValuesEqual(value, base[key])) continue;
        if (taskEditValuesEqual(latest[key], base[key])) { (merged as Record<string, unknown>)[key] = value; continue; }
        (merged as Record<string, unknown>)[key] = key === 'tags' || key === 'contexts'
            ? mergeTokenList(base[key], value as string[] | undefined, latest[key])
            : key === 'checklist'
                ? mergeChecklist(base.checklist, value as ChecklistItem[] | undefined, latest.checklist)
                : key === 'attachments'
                    ? mergeTaskDraftAttachments(latest.attachments ?? [], base.attachments ?? [], (value as Attachment[] | undefined) ?? [])
                    : value;
    }
    return merged;
};

/** Saves a task draft on the latest row inside one store command, by mergeTaskDraftOntoLatest. */
export const updateTaskFromDraft = (id: string, base: Task, updates: Partial<Task>): Promise<StoreActionResult> =>
    updateTaskFromLatest(id, (latest) => {
        const merged = mergeTaskDraftOntoLatest(base, updates, latest);
        return Object.keys(merged).length > 0 ? merged : null;
    });

/** A project draft's save, field by field as for tasks: tagIds merge by token, other fields take the draft's value. */
export const updateProjectFromDraft = (id: string, base: Project, updates: Partial<Project>): Promise<StoreActionResult> =>
    updateProjectFromLatest(id, (latest) => {
        const merged: Partial<Project> = {};
        for (const key of Object.keys(updates) as Array<keyof Project>) {
            const value = updates[key];
            if (taskEditValuesEqual(value, base[key])) continue;
            (merged as Record<string, unknown>)[key] = key === 'tagIds' && !taskEditValuesEqual(latest.tagIds, base.tagIds)
                ? mergeTokenList(base.tagIds, value as string[] | undefined, latest.tagIds)
                : value;
        }
        return Object.keys(merged).length > 0 ? merged : null;
    });

type Settings = ReturnType<typeof useTaskStore.getState>['settings'];
/**
 * A settings write built from the settings as stored when it is admitted: a page that sends a whole group (gtd, ai)
 * built from its rendered copy would put back a key another device changed since. [build] answers the updates, or null.
 */
export const updateSettingsFromLatest = (build: (settings: Settings) => Partial<Settings> | null): Promise<void> =>
    runStoreCommand(async () => {
        const updates = build(useTaskStore.getState().settings);
        if (updates) await useTaskStore.getState().updateSettings(updates);
    });
