import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft, useTaskStore, type Attachment, type Task } from '@mindwtr/core';

import { useTaskItemSubmit } from './useTaskItemSubmit';
import { holdSyncSave } from '../../test/hold-sync-save';

const flushPendingSaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, flushPendingSave: flushPendingSaveMock };
});

const task: Task = {
    id: 'task-1',
    title: 'Original',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
};

const initialTaskState = useTaskStore.getState();
/** The editor saves through the store: [stored] is the row it finds, [updateTask] the store write it reaches. */
const seedStore = (stored: Task, updateTask = vi.fn().mockResolvedValue({ success: true })) => {
    useTaskStore.setState({ _allTasks: [stored], updateTask });
    return updateTask;
};

describe('useTaskItemSubmit attachment durability', () => {
    beforeEach(() => {
        flushPendingSaveMock.mockReset();
        flushPendingSaveMock.mockResolvedValue(undefined);
    });
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
    });

    it('keeps the editor and attachment files unsettled until persistence completes', async () => {
        let resolveDurability!: () => void;
        flushPendingSaveMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDurability = resolve;
        }));
        const beginAttachmentSave = vi.fn();
        const settlePersistedAttachmentSave = vi.fn();
        const setIsEditing = vi.fn();
        const editAttachments = [{
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: '/data/mindwtr/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        }];
        const draft = createTaskDraft(task);
        draft.title = 'Edited';
        seedStore(task);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task,
            draft,
            editAttachments,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing,
            showToast: vi.fn(),
            t: (key) => key,
            task,
            beginAttachmentSave: beginAttachmentSave.mockReturnValue(true),
            cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave,
        }));

        let submit!: ReturnType<typeof result.current>;
        await act(async () => {
            submit = result.current();
            await Promise.resolve();
        });
        expect(beginAttachmentSave).toHaveBeenCalledOnce();
        expect(settlePersistedAttachmentSave).not.toHaveBeenCalled();
        expect(setIsEditing).not.toHaveBeenCalled();

        resolveDurability();
        await act(async () => {
            await submit;
        });
        expect(settlePersistedAttachmentSave).toHaveBeenCalledWith(editAttachments);
        expect(setIsEditing).toHaveBeenCalledWith(false);
    });

    it('retains the attachment save guard when persistence fails', async () => {
        flushPendingSaveMock.mockRejectedValueOnce(new Error('sqlite unavailable'));
        const settlePersistedAttachmentSave = vi.fn();
        const cancelAttachmentSaveBeforeStoreUpdate = vi.fn();
        const showToast = vi.fn();
        const draft = createTaskDraft(task);
        draft.title = 'Edited';
        seedStore(task);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task,
            draft,
            editAttachments: [{
                id: 'draft-file',
                kind: 'file',
                title: 'draft.txt',
                uri: '/data/mindwtr/attachments/draft-file.txt',
                createdAt: '2026-08-27T00:00:00.000Z',
                updatedAt: '2026-08-27T00:00:00.000Z',
            }],
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing: vi.fn(),
            showToast,
            t: (key) => key,
            task,
            beginAttachmentSave: vi.fn(() => true),
            cancelAttachmentSaveBeforeStoreUpdate,
            settlePersistedAttachmentSave,
        }));

        let outcome;
        await act(async () => {
            outcome = await result.current();
        });
        expect(outcome).toEqual({ success: false, error: 'sqlite unavailable' });
        expect(settlePersistedAttachmentSave).not.toHaveBeenCalled();
        expect(cancelAttachmentSaveBeforeStoreUpdate).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('sqlite unavailable', 'error');
    });

    it('does not submit untouched fields changed after the edit session opened', async () => {
        const baselineTask: Task = {
            ...task,
            description: 'Opening description',
            tags: ['#opening'],
        };
        const liveTask: Task = {
            ...baselineTask,
            description: 'Concurrent description',
            tags: ['#concurrent'],
            updatedAt: '2026-08-27T01:00:00.000Z',
        };
        const draft = createTaskDraft(baselineTask);
        draft.title = 'Edited title';
        const updateTask = seedStore(liveTask);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask,
            draft,
            editAttachments: baselineTask.attachments,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing: vi.fn(),
            showToast: vi.fn(),
            t: (key) => key,
            task: liveTask,
            beginAttachmentSave: vi.fn(() => false),
            cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave: vi.fn(),
        }));

        await act(async () => {
            await result.current();
        });

        expect(updateTask).toHaveBeenCalledWith(task.id, { title: 'Edited title' });
    });

    describe('behind a sync save', () => {
        const file = (id: string): Attachment => ({
            id, kind: 'file', title: `${id}.pdf`, uri: `/data/attachments/${id}.pdf`,
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        });
        const opened: Task = { ...task, rev: 1, attachments: [file('A')] };
        const submitHook = (draftTask: Partial<Task>, editAttachments = opened.attachments, showToast = vi.fn()) => {
            const draft = createTaskDraft({ ...opened, ...draftTask });
            return renderHook((props: { draft: typeof draft }) => useTaskItemSubmit({
                baselineTask: opened,
                draft: props.draft,
                editAttachments,
                editingTaskId: task.id,
                setEditingTaskId: vi.fn(),
                setIsEditing: vi.fn(),
                showToast,
                t: (key) => key,
                task: opened,
                beginAttachmentSave: vi.fn(() => false),
                cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
                settlePersistedAttachmentSave: vi.fn(),
            }), { initialProps: { draft } });
        };
        const submitBehind = async (submit: () => Promise<unknown>, published: Partial<Task>) => {
            const finish = holdSyncSave(() => useTaskStore.setState({ _allTasks: [{ ...opened, rev: 3, ...published }] }));
            let outcome: unknown;
            await act(async () => {
                const saving = submit();
                await finish();
                outcome = await saving;
            });
            return outcome;
        };

        it('merges the draft attachment onto the attachments a sync save published, keeping the synced sibling', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result } = submitHook({}, [file('A'), file('D')]);
            await submitBehind(() => result.current(), { attachments: [file('A'), file('B')] });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.attachments?.map((item) => item.id)).toEqual(['A', 'B', 'D']);
        });

        it('refuses a field another device changed since the editor opened and shows the save error', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const showToast = vi.fn();
            const { result } = submitHook({ title: 'Draft title' }, opened.attachments, showToast);
            const outcome = await submitBehind(() => result.current(), { title: 'Remote title' });
            expect(outcome).toMatchObject({ success: false, error: expect.stringMatching(/^STALE_REVISION/) });
            expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^STALE_REVISION/), 'error');
            expect(useTaskStore.getState()._tasksById.get(task.id)?.title).toBe('Remote title');
        });

        it('takes its own earlier save as the base, so a second save of the same field is not refused', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result, rerender } = submitHook({ title: 'First' });
            await act(async () => { await result.current(undefined, { keepEditing: true }); });
            rerender({ draft: createTaskDraft({ ...opened, title: 'Second' }) });
            let outcome: unknown;
            await act(async () => { outcome = await result.current(undefined, { keepEditing: true }); });
            expect(outcome).toMatchObject({ success: true });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.title).toBe('Second');
        });
    });
});
