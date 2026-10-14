import { useCallback, useRef } from 'react';
import {
    taskDraftToChangedUpdatePatch,
    flushPendingSave,
    mergeTaskDraftAttachments,
    runStoreCommand,
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
 * The editor save as one store command: the draft's attachment changes since [base] are merged over the latest row by
 * core's mergeTaskDraftAttachments (as mobile's editor does), so an attachment or tombstone a sync save brought stays.
 * Other fields are written as the draft holds them (last write wins, as before the write gate). Answers the row it
 * saved, read before any sync save can publish over it, as the base for the next save of this session.
 */
const saveDraftOnLatest = (id: string, base: Task, patch: Partial<Task>) => runStoreCommand(async () => {
    const latest = useTaskStore.getState()._tasksById.get(id);
    const updates = latest && patch.attachments
        ? { ...patch, attachments: mergeTaskDraftAttachments(latest.attachments ?? [], base.attachments ?? [], patch.attachments) }
        : patch;
    const result = await useTaskStore.getState().updateTask(id, updates);
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
        const { result, saved } = await saveDraftOnLatest(task.id, base, patch);
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
