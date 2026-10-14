import { useCallback, useRef } from 'react';
import {
    taskDraftToChangedUpdatePatch,
    flushPendingSave,
    runStoreCommand,
    taskEditValuesEqual,
    updateTaskFromBase,
    useTaskStore,
    type Attachment,
    type Task,
    type TaskDraft,
    type TaskStatus,
} from '@mindwtr/core';

type UseTaskItemSubmitParams = {
    baselineTask: Task;
    draft: TaskDraft;
    editAttachments: Attachment[] | undefined;
    editingTaskId: string | null;
    setEditingTaskId: (id: string | null) => void;
    setIsEditing: (value: boolean) => void;
    showToast: (message: string, tone?: 'info' | 'error' | 'success') => void;
    t: (key: string) => string;
    task: Task;
    beginAttachmentSave: () => boolean;
    cancelAttachmentSaveBeforeStoreUpdate: () => void;
    settlePersistedAttachmentSave: (attachments: Attachment[]) => void;
};

/**
 * The draft's attachment changes (added, edited, soft-deleted or dropped since [base]) applied by id to [latest], so an
 * attachment a sync save added that the draft never saw is kept.
 */
const mergeDraftAttachments = (
    base: Attachment[] = [],
    draft: Attachment[] = [],
    latest: Attachment[] = [],
): Attachment[] => {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const draftIds = new Set(draft.map((item) => item.id));
    const changed = new Map(draft
        .filter((item) => !taskEditValuesEqual(item, baseById.get(item.id)))
        .map((item) => [item.id, item]));
    const merged = latest
        .filter((item) => !baseById.has(item.id) || draftIds.has(item.id))
        .map((item) => changed.get(item.id) ?? item);
    const latestIds = new Set(latest.map((item) => item.id));
    return [...merged, ...[...changed.values()].filter((item) => !latestIds.has(item.id))];
};

/**
 * The editor save as one store command. Fields are refused (STALE_REVISION) when another device changed them since
 * [base] and the draft holds another value; attachments are merged by id instead. Answers the row it saved, read
 * before any sync save can publish over it, as the base for the next save of this session.
 */
const saveDraftFromBase = (id: string, base: Task, patch: Partial<Task>) => runStoreCommand(async () => {
    const latest = useTaskStore.getState()._tasksById.get(id);
    const mergeAttachments = latest && 'attachments' in patch;
    const updates = mergeAttachments
        ? { ...patch, attachments: mergeDraftAttachments(base.attachments, patch.attachments, latest.attachments) }
        : patch;
    const result = await updateTaskFromBase(id, mergeAttachments ? { ...base, attachments: latest.attachments } : base, updates);
    return { result, saved: useTaskStore.getState()._tasksById.get(id) };
});

type TaskItemSubmitOptions = {
    statusOverride?: TaskStatus;
    completedAtOverride?: string;
    timeSpentMinutesOverride?: number;
    /** Save the draft but leave the editor mounted for a chained durable action. */
    keepEditing?: boolean;
};

export function useTaskItemSubmit({
    baselineTask,
    draft,
    editAttachments,
    editingTaskId,
    setEditingTaskId,
    setIsEditing,
    showToast,
    t,
    task,
    beginAttachmentSave,
    cancelAttachmentSaveBeforeStoreUpdate,
    settlePersistedAttachmentSave,
}: UseTaskItemSubmitParams) {
    // The row this edit session last saved: the next save's base, so the editor's own saves are not conflicts.
    const savedRef = useRef<{ opened: Task; saved: Task } | null>(null);
    return useCallback(async (event?: React.FormEvent, options?: TaskItemSubmitOptions) => {
        event?.preventDefault();
        const patch = taskDraftToChangedUpdatePatch(draft, baselineTask, {
            statusOverride: options?.statusOverride,
            attachments: editAttachments,
        });
        if (!patch) return;
        if (options?.completedAtOverride !== undefined) {
            patch.completedAt = options.completedAtOverride;
        }
        // Presence check, not `!== undefined`: an explicit undefined override
        // means "the time-spent field was shown but left blank," which clears
        // timeSpentMinutes rather than leaving it untouched (mirrors mobile's
        // completed-at-picker.tsx / #896).
        if (options && 'timeSpentMinutesOverride' in options) {
            patch.timeSpentMinutes = options.timeSpentMinutesOverride;
        }

        const base = savedRef.current?.opened === baselineTask ? savedRef.current.saved : baselineTask;
        const attachmentSaveRequiresDurability = beginAttachmentSave();
        const { result, saved } = await saveDraftFromBase(task.id, base, patch);
        if (!result.success) {
            cancelAttachmentSaveBeforeStoreUpdate();
            showToast(result.error || t('task.updateFailed'), 'error');
            return result;
        }
        if (saved) savedRef.current = { opened: baselineTask, saved };
        if (attachmentSaveRequiresDurability) {
            try {
                await flushPendingSave();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || t('task.updateFailed'));
                showToast(message, 'error');
                return { success: false, error: message };
            }
            settlePersistedAttachmentSave(saved?.attachments ?? editAttachments ?? task.attachments ?? []);
        }
        if (!options?.keepEditing) {
            setIsEditing(false);
            if (editingTaskId === task.id) {
                setEditingTaskId(null);
            }
        }
        return result;
    }, [
        baselineTask,
        draft,
        editAttachments,
        editingTaskId,
        beginAttachmentSave,
        cancelAttachmentSaveBeforeStoreUpdate,
        setEditingTaskId,
        setIsEditing,
        settlePersistedAttachmentSave,
        showToast,
        t,
        task,
    ]);
}
