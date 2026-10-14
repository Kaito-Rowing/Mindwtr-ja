import { taskEditValuesEqual } from './json-value-equality';
import { useTaskStore } from './store';
import type { StoreActionResult } from './store-types';
import { runStoreCommand } from './store-write-gate';
import type { Project, Task } from './types';

/**
 * Writes that build a whole field (an attachment list, a checklist, tags) from the row as it is when the write is
 * admitted (store-write-gate.ts). A sync save admitted first publishes newer rows, so a list built from an earlier
 * read would drop what that save brought (a sibling attachment another device added) at a new revision.
 * [build] answers the updates for the latest row, or null to write nothing.
 */
const missing = (kind: string): StoreActionResult => ({ success: false, error: `${kind} not found` });

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
 * A draft's save against the row the editor opened with ([base]): refused (STALE_REVISION) when a field it writes was
 * changed since and the draft holds another value, as SQLite refused a lower-revision write before the gate. [base] is the
 * row the draft was last opened or saved on, so the editor's own earlier saves are not conflicts.
 */
export const updateTaskFromBase = (
    id: string,
    base: Task,
    updates: Partial<Task>,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const task = useTaskStore.getState()._tasksById.get(id);
    if (!task) return missing('Task');
    const conflict = (Object.keys(updates) as Array<keyof Task>).some((key) => (
        !taskEditValuesEqual(task[key], base[key]) && !taskEditValuesEqual(updates[key], task[key])
    ));
    if (conflict) return { success: false, error: 'STALE_REVISION: The task changed on another device; reopen it to edit' };
    return useTaskStore.getState().updateTask(id, updates);
});
