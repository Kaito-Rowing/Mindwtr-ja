import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import { createMobileSyncService, type MobileSyncServiceHost } from './mobile-sync-service';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { getInMemoryAppDataSnapshot } from './sync-client-helpers';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { performSyncCycle } from './sync';
import { createNativeHostContract } from './native-host-contract';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts, revisionOf } from './native-request-receipts';
import { CLOUD_PROVIDER_KEY, CLOUD_TOKEN_KEY, CLOUD_URL_KEY, SYNC_BACKEND_KEY } from './sync-storage-keys';
import type { AppData, Project, Task } from './types';

// A command that lands while a sync cycle waits on the network, after its first local save,
// must act on what that save wrote: the store must not lag the disk (D9b change 0).
const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
}; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const NEWER = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const task = (extra: Partial<Task>): Task => ({
    id: 'shared', title: 'old', status: 'next', tags: [], contexts: [], createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'this-device',
    ...extra,
} as Task);
const project = (extra: Partial<Project>): Project => ({
    id: 'starred', title: 'Project', status: 'active', color: '#94a3b8', order: 0, tagIds: [], isFocused: false,
    createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'this-device', ...extra,
} as Project);
const doc = (tasks: Task[], settings: AppData['settings'] = {}, projects: Project[] = []): AppData => ({ tasks, projects, sections: [], areas: [], people: [], settings });

const databases: Database[] = [];

async function openStore(guarded: boolean, receipts = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(':memory:'); databases.push(db);
    const client: SqliteClient = {
        run: async (sql, params = []) => { db.prepare(sql).run(...params); },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)[0] as T | undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    await new SqliteAdapter(client).saveData(doc([task({})], { deviceId: 'this-device' }, [project({})]));
    const options = guarded ? { rejectConcurrentWrites: true } : {};
    const adapter = receipts ? new NativeReceiptSqliteAdapter(client, options) : new SqliteAdapter(client, options);
    setStorageAdapter(adapter);
    await useTaskStore.getState().fetchData({ silent: true });
    return adapter;
}

function createHost(adapter: SqliteAdapter, remote: AppData) {
    const values = new Map<string, string>([
        [SYNC_BACKEND_KEY, 'cloud'], [CLOUD_PROVIDER_KEY, 'selfhosted'], [CLOUD_URL_KEY, 'https://cloud.example.test'],
    ]);
    const storage = {
        getItem: vi.fn(async (key: string) => values.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { values.delete(key); }),
    };
    let releasePut: () => void = () => undefined;
    const held: { start: () => void } = { start: () => undefined };
    const putStarted = new Promise<void>((started) => {
        held.start = started;
    });
    const put = vi.fn(async () => {
        if (put.mock.calls.length > 1) return { fingerprint: 'remote-after-put' };
        held.start();
        await new Promise<void>((release) => { releasePut = release; });
        return { fingerprint: 'remote-after-put' };
    });
    const host = {
        storage,
        getSecureConfigValue: async (key: string) => (key === CLOUD_TOKEN_KEY ? 'token' : null),
        platform: { os: () => 'android', isFossBuild: false, dropboxAppKey: () => '' },
        network: {
            getState: async () => ({ isConnected: true, isInternetReachable: true, isAirplaneModeEnabled: false }),
            subscribe: () => ({ remove: () => undefined }),
        },
        localData: { getData: () => adapter.getData(), saveData: (data: AppData) => adapter.saveData(data) },
        log: { info: () => undefined, warn: () => undefined, syncError: async () => null, sanitize: (message: string) => message },
        externalCalendars: { load: async () => [], save: async () => undefined },
        fetch: vi.fn(async () => { throw new Error('no network in tests'); }),
        crypto: {},
        attachments: {
            syncWebdav: async () => false, syncCloud: async () => false, syncDropbox: async () => false, syncFile: async () => false,
            cleanupTempFiles: async () => undefined, hasCompletedPresenceReconciliation: async () => false,
            hasPendingWork: async () => false, runCleanup: async ({ appData }: { appData: AppData }) => ({ appData, shouldInvalidateFastSyncState: false }),
        },
        core: {
            useTaskStore, flushPendingSave, getInMemoryAppDataSnapshot, performSyncCycle,
            isSandboxMode: () => false, isWorkspaceTransitionActive: () => false,
            withRetry: async <T,>(operation: () => Promise<T>) => operation(),
            cloudGetJson: vi.fn(async () => JSON.parse(JSON.stringify(remote))),
            cloudPutJson: put,
            acquireSyncRemoteMutationFence: vi.fn(async () => ({
                assertHeld: async () => undefined, renew: async () => undefined, release: async () => undefined,
            })),
        },
    } as unknown as MobileSyncServiceHost<unknown>;
    return { host, putStarted, releasePut: () => releasePut(), put };
}

const runCycle = async (service: ReturnType<typeof createMobileSyncService>) => {
    const result = await service.performMobileSync(undefined, { manual: true });
    service.__mobileSyncTestUtils.clearFollowUpForTests();
    await flushPendingSave();
    return result;
};

const winner = () => doc([task({ title: 'winner', rev: 2, revBy: 'other-device', updatedAt: NEWER })], {},
    [project({ isFocused: true, rev: 2, revBy: 'other-device', updatedAt: NEWER })]);

describe.each([false, true])('a command during the remote write (guarded adapter: %s)', (guarded) => {
    beforeEach(() => { vi.useRealTimers(); });
    afterEach(async () => {
        await flushPendingSave(); resetForTests();
        for (const db of databases.splice(0)) db.close();
    });

    it('acts on the merged row, so the remote title survives the completion', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner());
        const service = createMobileSyncService(fake.host);
        const cycle = service.performMobileSync(undefined, { manual: true });
        try {
            await fake.putStarted;
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await flushPendingSave();
            fake.releasePut();
            await cycle;
            service.__mobileSyncTestUtils.clearFollowUpForTests();
            await flushPendingSave();
            const saved = (await adapter.getData()).tasks.find((row) => row.id === 'shared');
            expect(saved?.status).toBe('done');
            expect(saved?.title).toBe('winner');
        } finally {
            fake.releasePut();
            await cycle.catch(() => undefined);
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('keeps the pending remote-write marker through a settings command', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner());
        const service = createMobileSyncService(fake.host);
        const cycle = service.performMobileSync(undefined, { manual: true });
        try {
            await fake.putStarted;
            await useTaskStore.getState().updateSettings({ theme: 'dark' });
            await flushPendingSave();
            const during = (await adapter.getData()).settings;
            expect(during.theme).toBe('dark');
            expect(during.pendingRemoteWriteAt).toBeTruthy();
            fake.releasePut();
            await cycle;
            service.__mobileSyncTestUtils.clearFollowUpForTests();
            await flushPendingSave();
            const after = (await adapter.getData()).settings;
            expect(after.theme).toBe('dark');
            // The cycle ended on a stale exit after its remote write: the marker stays for the next cycle to settle.
            expect(after.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            fake.releasePut();
            await cycle.catch(() => undefined);
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('defers a command that arrives between the first save commit and its store publish', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let command: Promise<unknown> | null = null;
        fake.host.localData.saveData = async (data: AppData) => {
            await adapter.saveData(data);
            // The commit has landed; the cycle has not published it yet.
            command ??= useTaskStore.getState().updateTask('shared', { status: 'done' });
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            await command;
            await flushPendingSave();
            const saved = (await adapter.getData()).tasks.find((row) => row.id === 'shared');
            expect(saved?.status).toBe('done');
            expect(saved?.title).toBe('winner');
            expect((await adapter.getData()).settings.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('publishes what disk holds when the save fails after its commit', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let failed = false;
        fake.host.localData.saveData = async (data: AppData) => {
            await adapter.saveData(data);
            if (!failed) {
                failed = true;
                // A post-save check (the File Sync lease) refuses after the rows are committed.
                throw new Error('lease lost after commit');
            }
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            await useTaskStore.getState().updateTask('shared', { status: 'done' });
            await useTaskStore.getState().updateSettings({ theme: 'dark' });
            await flushPendingSave();
            const saved = await adapter.getData();
            expect(saved.tasks.find((row) => row.id === 'shared')).toMatchObject({ title: 'winner', status: 'done' });
            expect(saved.settings.pendingRemoteWriteAt).toBeTruthy();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });

    it('takes back the published document when the save fails before its commit', async () => {
        const adapter = await openStore(guarded);
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        fake.host.localData.saveData = async () => { throw new Error('disk full before commit'); };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            // Nothing landed, so the store shows the disk again, not the merge it was handed first.
            expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('old');
            expect(useTaskStore.getState().settings.pendingRemoteWriteAt).toBeUndefined();
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });
});

describe('a native command during the sync save', () => {
    afterEach(async () => {
        await flushPendingSave(); resetForTests();
        for (const db of databases.splice(0)) db.close();
    });

    it('reads, checks and writes the project star on the published store, never the one the save replaced', async () => {
        const adapter = await openStore(true, true);
        await flushPendingSave();
        const contract = createNativeHostContract();
        const activated = await contract.activate({ writeSafetyReady: true });
        expect(activated).toEqual({ ok: true, value: null });
        await flushPendingSave();
        const shown = revisionOf(useTaskStore.getState()._projectsById.get('starred')!);
        const fake = createHost(adapter, winner());
        fake.put.mockImplementation(async () => ({ fingerprint: 'remote-after-put' }));
        let command: Promise<unknown> | null = null;
        fake.host.localData.saveData = async (data: AppData) => {
            await adapter.saveData(data);
            // The first save has committed the other device's star, inside the sync's hold of the gate.
            command ??= contract.setProjectFocus({ id: 'starred', focused: true, projectRevision: shown });
        };
        const service = createMobileSyncService(fake.host);
        try {
            await runCycle(service);
            await command;
            await flushPendingSave();
            expect((await adapter.getData()).projects.find((row) => row.id === 'starred')?.isFocused).toBe(true);
            expect(useTaskStore.getState()._projectsById.get('starred')?.isFocused).toBe(true);
        } finally {
            service.__mobileSyncTestUtils.reset();
        }
    });
});
