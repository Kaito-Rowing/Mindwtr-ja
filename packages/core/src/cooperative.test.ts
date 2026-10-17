import { describe, expect, it } from 'vitest';
import { createSlicer, runSliced, runToEnd, type CooperativePass } from './cooperative';
import { mergeAppDataWithStats, mergeAppDataWithStatsPass } from './sync';
import { validateMergedSyncData, validateMergedSyncDataPass } from './sync-normalization';
import {
    computeStableValueFingerprint,
    computeSyncChangeFingerprint,
    computeSyncChangeFingerprintPass,
    fingerprintStableSyncJsonPass,
    sanitizeAppDataForRemote,
    sanitizeAppDataForRemotePass,
    toStableSyncJson,
    toStableSyncJsonPass,
} from './sync-helpers';
import { remoteSyncDocumentStableJsonPass, toRemoteSyncDocument } from './sync-document';
import { cloneAppData, cloneAppDataPass } from './sync-runtime-utils';
import type { AppData, Task } from './types';

// D9: every pass a sync cycle runs in slices must return exactly what the same work returns at once. The slicer here yields
// after every step, the most interleaved run there can be.

const AT = '2026-07-01T00:00:00.000Z';
const LATER = '2026-07-02T00:00:00.000Z';
const task = (i: number, extra: Partial<Task> = {}): Task => ({
    id: `t-${String(i).padStart(4, '0')}`, title: `Task ${i} ✓`, status: (['inbox', 'next', 'waiting', 'someday', 'done'] as const)[i % 5],
    tags: [`#t${i % 7}`], contexts: [`@c${i % 4}`], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local',
    ...(i % 9 === 0 ? { checklist: [{ id: `c-${i}`, title: 'step', isCompleted: i % 2 === 0 }] } : {}),
    ...(i % 11 === 0 ? { attachments: [{ id: `a-${i}`, kind: 'link', title: 'x', uri: 'https://example.com', createdAt: AT, updatedAt: AT }] } : {}),
    ...(i % 13 === 0 ? { projectId: 'p-1' } : {}),
    ...extra,
} as Task);
const library = (tasks: Task[]): AppData => ({
    tasks,
    projects: [{ id: 'p-1', title: 'Project', status: 'active', color: '#94a3b8', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local' }],
    sections: [], areas: [{ id: 'a-1', name: 'Area', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local' }], people: [],
    settings: { language: 'en' },
} as AppData);
const local = library(Array.from({ length: 400 }, (_, i) => task(i)));
// The other device: a third edited, some deleted, some only there; the first ones missing there.
const incoming = library([
    ...Array.from({ length: 380 }, (_, j) => {
        const i = j + 20;
        if (i % 3 === 0) return task(i, { title: `Task ${i} (remote)`, rev: 2, revBy: 'remote', updatedAt: LATER });
        if (i % 17 === 0) return task(i, { deletedAt: LATER, rev: 2, revBy: 'remote', updatedAt: LATER });
        return task(i);
    }),
    ...Array.from({ length: 30 }, (_, j) => task(1000 + j, { revBy: 'remote' })),
]);

const everyStep = () => {
    let yields = 0;
    const slicer = createSlicer(async () => { yields += 1; }, 0);
    return { slicer, yields: () => yields };
};
const sliced = async <T>(pass: CooperativePass<T>) => {
    const { slicer, yields } = everyStep();
    const value = await runSliced('test', pass, slicer);
    return { value, yields: yields() };
};

describe('cooperative passes give the result of the same work done at once', () => {
    it('merge', async () => {
        const at = { nowIso: '2026-07-03T00:00:00.000Z' };
        const { value, yields } = await sliced(mergeAppDataWithStatsPass(local, incoming, at));
        expect(yields).toBeGreaterThan(10);
        expect(value).toEqual(mergeAppDataWithStats(local, incoming, at));
        expect(runToEnd(mergeAppDataWithStatsPass(local, incoming, at))).toEqual(value);
    });

    it('validation, a valid and an invalid document', async () => {
        const merged = mergeAppDataWithStats(local, incoming).data;
        const broken = { ...merged, tasks: merged.tasks.map((row, i) => (i % 50 === 0 ? { ...row, projectId: 'missing', updatedAt: 'x' } : row)) };
        for (const data of [merged, broken]) {
            const { value, yields } = await sliced(validateMergedSyncDataPass(data));
            expect(yields).toBeGreaterThan(1);
            expect(value).toEqual(validateMergedSyncData(data));
        }
        expect(validateMergedSyncData(broken).length).toBeGreaterThan(0);
    });

    it('remote document, stable JSON and fingerprints', async () => {
        const doc = toRemoteSyncDocument(local);
        expect((await sliced(sanitizeAppDataForRemotePass(local))).value).toEqual(sanitizeAppDataForRemote(local));
        expect((await sliced(toStableSyncJsonPass(doc))).value).toBe(toStableSyncJson(doc));
        expect((await sliced(remoteSyncDocumentStableJsonPass(local))).value).toBe(toStableSyncJson(doc));
        const json = toStableSyncJson(doc);
        expect((await sliced(fingerprintStableSyncJsonPass(json))).value).toBe(computeStableValueFingerprint(doc));
        expect((await sliced(computeSyncChangeFingerprintPass(local))).value).toBe(computeSyncChangeFingerprint(local));
    });

    it('a copy of the library', async () => {
        const { value, yields } = await sliced(cloneAppDataPass(local));
        expect(yields).toBeGreaterThan(1);
        expect(value).toEqual(cloneAppData(local));
        expect(value.tasks[0]).not.toBe(local.tasks[0]);
    });
});
