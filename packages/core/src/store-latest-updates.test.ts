import { afterEach, describe, expect, it } from 'vitest';

import { flushPendingSave, resetForTests, useTaskStore } from './store';
import {
    batchUpdateTasksFromLatest, mergeTaskDraftOntoLatest, updateProjectFromDraft, updateProjectFromLatest, updateSettingsFromLatest,
    updateTaskFromDraft, updateTaskFromLatest,
} from './store-latest-updates';
import { runSyncStoreSave } from './store-write-gate';
import type { Attachment, Project, Task } from './types';

const AT = new Date(Date.now() - 60_000).toISOString();
const file = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
    id, kind: 'file', title: `${id}.pdf`, uri: '', localStatus: 'missing', createdAt: AT, updatedAt: AT, ...extra,
} as Attachment);
const task = (extra: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Task', status: 'next', tags: ['a'], contexts: [], attachments: [file('A')], rev: 1, createdAt: AT, updatedAt: AT, ...extra,
} as Task);
const project = (extra: Partial<Project> = {}): Project => ({
    id: 'p1', title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: [], attachments: [file('A')],
    rev: 1, createdAt: AT, updatedAt: AT, ...extra,
} as Project);

/** A sync save holds the gate while [write] is called, then publishes [publish] before the write is admitted. */
async function behindSyncSave<T>(publish: () => void, write: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => { await held; publish(); });
    const written = write();
    release();
    await save;
    return written;
}

describe('writes built from the latest row', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); });

    it('builds a project attachment list on the row a sync save published while the write waited', async () => {
        useTaskStore.setState({ _allProjects: [project()] });
        const result = await behindSyncSave(
            () => useTaskStore.setState({ _allProjects: [project({ rev: 3, attachments: [file('A'), file('B')] })] }),
            () => updateProjectFromLatest('p1', (latest) => ({
                attachments: (latest.attachments ?? []).map((item) => item.id === 'A' ? { ...item, localStatus: 'available' as const } : item),
            })),
        );
        expect(result.success).toBe(true);
        expect(useTaskStore.getState()._projectsById.get('p1')?.attachments?.map((item) => [item.id, item.localStatus]))
            .toEqual([['A', 'available'], ['B', 'missing']]);
    });

    it('adds a tag to each task on its latest row', async () => {
        useTaskStore.setState({ _allTasks: [task()] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, tags: ['a', 'remote'] })] }),
            () => batchUpdateTasksFromLatest(['t1'], (latest) => ({ tags: [...latest.tags, 'added'] })),
        );
        expect(useTaskStore.getState()._tasksById.get('t1')?.tags).toEqual(['a', 'remote', 'added']);
    });

    it('builds a task checklist on its latest row', async () => {
        useTaskStore.setState({ _allTasks: [task({ checklist: [{ id: 'c1', title: 'One', isCompleted: false }] })] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, checklist: [{ id: 'c1', title: 'One', isCompleted: false }, { id: 'c2', title: 'Two', isCompleted: false }] })] }),
            () => updateTaskFromLatest('t1', (latest) => ({
                checklist: (latest.checklist ?? []).map((item) => item.id === 'c1' ? { ...item, isCompleted: true } : item),
            })),
        );
        expect(useTaskStore.getState()._tasksById.get('t1')?.checklist?.map((item) => [item.id, item.isCompleted]))
            .toEqual([['c1', true], ['c2', false]]);
    });

    it('saves a settings group built from the settings a sync save published while the write waited', async () => {
        useTaskStore.setState({ settings: { gtd: { defaultScheduleTime: '09:00' } } as never });
        await behindSyncSave(
            () => useTaskStore.setState({ settings: { gtd: { defaultScheduleTime: '09:00', autoArchiveDays: 3 } } as never }),
            () => updateSettingsFromLatest((latest) => ({ gtd: { ...latest.gtd, defaultScheduleTime: '10:00' } })),
        );
        expect(useTaskStore.getState().settings.gtd).toMatchObject({ defaultScheduleTime: '10:00', autoArchiveDays: 3 });
    });
});

describe('a draft saved field by field on the latest row', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); });
    const item = (id: string, isCompleted = false) => ({ id, title: id, isCompleted });

    it('writes only the fields the draft changed, and merges a list both sides changed', () => {
        const base = task({ title: 'Old', tags: ['a', 'b'], checklist: [item('c1'), item('c2')], priority: 'low' });
        const latest = task({ title: 'Remote title', tags: ['a', 'b', 'remote'], checklist: [item('c1'), item('c2', true), item('c3')], priority: 'high' });
        const draft = { title: 'Old', tags: ['b', 'mine'], checklist: [item('c1', true), item('c2'), item('c4')], priority: 'medium' as const };
        expect(mergeTaskDraftOntoLatest(base, draft, latest)).toEqual({
            // The draft kept the title: the other device's title stays (nothing written).
            tags: ['b', 'remote', 'mine'],
            checklist: [item('c1', true), item('c2', true), item('c3'), item('c4')],
            priority: 'medium',
        });
    });

    it('writes the draft list as it is (a reorder stays) when nobody else changed that list', () => {
        const base = task({ checklist: [item('c1'), item('c2')] });
        expect(mergeTaskDraftOntoLatest(base, { checklist: [item('c2'), item('c1')] }, task({ title: 'Remote', checklist: [item('c1'), item('c2')] })))
            .toEqual({ checklist: [item('c2'), item('c1')] });
    });

    it('saves a task draft and a project draft on the rows a sync save published while they waited', async () => {
        const base = task({ tags: ['a'] });
        const projectBase = project({ tagIds: ['t1'] });
        useTaskStore.setState({ _allTasks: [base], _allProjects: [projectBase] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, title: 'Remote', tags: ['a', 'remote'] })], _allProjects: [project({ rev: 3, title: 'Remote', tagIds: ['t1', 't2'] })] }),
            async () => {
                await updateTaskFromDraft('t1', base, { title: base.title, tags: ['a', 'mine'] });
                await updateProjectFromDraft('p1', projectBase, { title: projectBase.title, tagIds: ['t1', 't3'] });
            },
        );
        expect(useTaskStore.getState()._tasksById.get('t1')).toMatchObject({ title: 'Remote', tags: ['a', 'remote', 'mine'] });
        expect(useTaskStore.getState()._projectsById.get('p1')).toMatchObject({ title: 'Remote', tagIds: ['t1', 't2', 't3'] });
    });
});
