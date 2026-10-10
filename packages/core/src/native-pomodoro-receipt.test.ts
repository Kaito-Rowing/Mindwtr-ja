import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeRequestReceipts, loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, prepareNativePomodoroTransition } from './native-pomodoro-session';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { flushPendingSave, getStorageAdapter, setStorageAdapter, useTaskStore } from './store';
import * as logger from './logger';
import type { AppData } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-10T00:00:00.000Z';
const now = Date.parse(AT);
const original: AppData = { tasks: [{ id: 'task', title: 'Private', status: 'next', contexts: [], tags: [], createdAt: AT,
    updatedAt: AT, rev: 1, timeSpentMinutes: 4 }], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } };
const resources: { close: () => void; directory: string }[] = [];
const root = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));
const oldAdapter = getStorageAdapter();
const oldStore = useTaskStore.getState();
const gate = () => {
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    return { release, waiting, hold: async () => { entered(); await held; } };
};
async function open() {
    mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'pomodoro-receipt-'));
    const sql = openScratchSqlite(join(directory, 'library.sqlite')); resources.push({ close: sql.close, directory });
    await new SqliteAdapter(sql.client).saveData(structuredClone(original));
    resetNativeRequestReceipts(); await loadNativeRequestReceipts(sql.client, { durableCommands: ['pomodoroTransition', 'backupDocument'] });
    const events: string[] = [];
    const hooks: { run?: (statement: string) => Promise<void>; all?: (statement: string) => Promise<void>; afterRun?: (statement: string) => Promise<void> } = {};
    const client: SqliteClient = { ...sql.client,
        run: async (statement, params) => { events.push(statement); await hooks.run?.(statement); await sql.client.run(statement, params); await hooks.afterRun?.(statement); },
        all: async <T,>(statement: string, params?: unknown[]) => { events.push(statement); await hooks.all?.(statement); return sql.client.all<T>(statement, params); } };
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await adapter.getData();
    setStorageAdapter(adapter);
    useTaskStore.setState({ ...oldStore, _allTasks: [], _tasksById: new Map(), tasks: [], settings: {}, persistenceFailure: null,
        editLockCount: 0, lastDataChangeAt: 0, error: null });
    await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
    const initialize = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: now,
        localDayKey: '2026-10-10', durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null })!;
    const running = decodeNativePomodoroSession(initialize.sessionAfter);
    running.session.timerState.isRunning = true; running.session.phaseEndsAt = AT; running.session.selectedTaskId = 'task';
    const raw = JSON.stringify(running);
    await sql.client.run('INSERT INTO native_pomodoro_session (id,state_json) VALUES (1,?)', [raw]);
    const row = (await sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks WHERE id=?', ['task']))[0];
    const plan = prepareNativePomodoroTransition({ request: { action: 'reconcile', requestId: NEXT, observedAtMs: now,
        localDayKey: '2026-10-10', autoStart: { autoStartFocus: false, autoStartBreaks: false } }, session: { raw, state: running },
        target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
    const state = async () => ({ tasks: await sql.client.all('SELECT * FROM tasks'), settings: await sql.client.all('SELECT * FROM settings'),
        sessions: await sql.client.all('SELECT * FROM native_pomodoro_session'), receipts: await sql.client.all('SELECT * FROM native_request_receipts') });
    events.length = 0;
    return { sql, client, adapter, plan, initialize, hooks, events, state };
}
afterEach(() => {
    vi.restoreAllMocks(); resetNativeRequestReceipts(); setStorageAdapter(oldAdapter); useTaskStore.setState(oldStore, true);
    for (const item of resources.splice(0).reverse()) { item.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

describe('native Pomodoro atomic storage over real SQLite', () => {
    it('commits four task cells, local session and exact receipt, adopts canonical projection and keeps JSON local-state-free', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE tasks SET recurrence=?,attachments=? WHERE id=?', [' {"opaque":true} ', ' [ ] ', 'task']);
        const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
        env.plan.target!.row = TASK_SQLITE_COLUMNS.map((name) => row[name]);
        const before = await env.state();
        const answer = await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(answer).toEqual({ result: env.plan.result, replayed: false, projectionReloaded: true });
        const after = await env.state();
        const changed = Object.keys(row).filter((name) => (before.tasks[0] as Record<string, unknown>)[name] !== (after.tasks[0] as Record<string, unknown>)[name]);
        expect(changed.sort()).toEqual(['rev', 'revBy', 'timeSpentMinutes'].sort());
        expect((after.tasks[0] as Record<string, unknown>).timeSpentMinutes).toBe(29);
        expect(after.receipts).toHaveLength(1);
        expect((after.receipts[0] as Record<string, unknown>).method).toBe(nativePomodoroReceiptPayload(env.plan));
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        const data = await env.adapter.getData(); expect(JSON.stringify(data)).not.toContain('sessionID');
        await env.adapter.saveData(data); expect((await env.state()).sessions).toEqual(after.sessions);
    });
    it.each(['UPDATE tasks', 'UPDATE native_pomodoro_session', 'INSERT INTO native_request_receipts', 'COMMIT', 'readback'])('rolls all three tables back on %s failure and retries the same preparation once', async (fault) => {
        const env = await open(); const before = await env.state(); let failures = 0;
        const info = vi.spyOn(logger, 'logInfo');
        env.hooks.run = async (statement) => { if (failures < 2 && statement.startsWith(fault)) { failures += 1; throw new Error('private driver'); } };
        env.hooks.all = async (statement) => { if (fault === 'readback' && failures < 2 && env.events.some((sql) => sql.startsWith('UPDATE tasks'))
            && statement.startsWith('SELECT id, state_json')) { failures += 1; throw new Error('private read'); } };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
            expect(await env.state()).toEqual(before);
        }
        expect(info.mock.calls.filter((call) => call[0] === 'Native Pomodoro transition confirmed')).toEqual([]);
        env.hooks.run = undefined; env.hooks.all = undefined;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result.creditedMinutes).toBe(25);
        expect((await env.state()).receipts).toHaveLength(1);
    });
    it('proves an actual lost COMMIT reply and cold replay before later task/session checks without rewriting', async () => {
        const env = await open(); let once = true;
        env.hooks.afterRun = async (statement) => { if (statement === 'COMMIT' && once) { once = false; throw new Error('lost reply'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
        env.hooks.afterRun = undefined;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,title=? WHERE id=?', [99, 'Later', 'task']);
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['unknown later owner']);
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] });
        const fresh = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(fresh);
        const before = await env.state(); env.events.length = 0;
        expect(await fresh.readPomodoroTransitionOutcome(env.plan)).toEqual(env.plan.result);
        expect((await fresh.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
        expect(await env.state()).toEqual(before);
        expect(env.events.some((s) => /^(UPDATE|INSERT)/u.test(s))).toBe(false);
    });
    it('refuses changed identity, missing known proof, malformed boot proof and overlapping UUID ranges', async () => {
        const env = await open(); await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        const before = await env.state();
        const changed = prepareNativePomodoroTransition({ request: { ...env.plan.request, observedAtMs: now + 1000 },
            session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
            target: env.plan.target, deviceId: env.plan.deviceId })!;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(changed)).rejects.toThrow(/identity/);
        await expect(env.adapter.savePomodoroTransitionWithReceipt({ ...env.plan, request: { ...env.plan.request, requestId: ID } })).rejects.toThrow();
        expect(await env.state()).toEqual(before);
        await env.sql.client.run('DELETE FROM native_request_receipts');
        await expect(env.adapter.readPomodoroTransitionOutcome(env.plan)).rejects.toThrow();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client);
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true });
        await expect(cold.savePomodoroTransitionWithReceipt({ ...env.plan, request: { ...env.plan.request, requestId: ID } })).rejects.toThrow(/baseline/);
        await env.sql.client.run('INSERT INTO native_request_receipts VALUES (?,?,?,?)', [NEXT, nativePomodoroReceiptPayload(env.plan), '{}', AT]);
        await expect(loadNativeRequestReceipts(env.sql.client)).rejects.toThrow(/Pomodoro/);
    });
    it('guards full target raw bytes and device but permits unrelated cold durable edits', async () => {
        const env = await open(); const before = await env.state();
        await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [' [ ] ', 'task']);
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/baseline/);
        expect((await env.state()).receipts).toEqual([]);
        await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [(before.tasks[0] as Record<string, unknown>).tags, 'task']);
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'other' })]);
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/identity/);
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'device', unrelated: true })]);
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
        expect((await env.state()).settings).toEqual([{ id: 1, data: JSON.stringify({ deviceId: 'device', unrelated: true }) }]);
    });
    it('retains reload fence after failed/discarded load and retries projection only from receipt', async () => {
        const env = await open(); let fail = true;
        env.hooks.all = async (statement) => { if (fail && statement.includes('FROM tasks') && !statement.includes('WHERE id')) throw new Error('read failed'); };
        const answer = await env.adapter.savePomodoroTransitionWithReceipt(env.plan); expect(answer.projectionReloaded).toBe(false);
        const before = await env.state(); fail = false;
        const data = await env.adapter.getData();
        await expect(env.adapter.saveData(data)).rejects.toThrow(/reload/);
        await expect(env.adapter.commitReceiptOnly(ID, '[]')).rejects.toThrow(/reload/);
        const retry = await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(retry).toEqual({ result: env.plan.result, replayed: true, projectionReloaded: true });
        expect(await env.state()).toEqual(before);
        await env.adapter.saveData(await env.adapter.getData());
    });
    it.each(['retired fetch', 'stale preloaded adoption', 'mutated accepted content'] as const)(
        'retains every write fence when %s happens after canonical ACK and retries without credit', async (retirement) => {
            const env = await open();
            await env.sql.client.run('UPDATE tasks SET rev=?,revBy=? WHERE id=?', [2_147_483_647, 'device', 'task']);
            await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
            const preCredit = await env.adapter.getData();
            const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
            const plan = prepareNativePomodoroTransition({ request: env.plan.request,
                session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
                target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
            const actualFetch = useTaskStore.getState().fetchData;
            const postAck = gate();
            const ownedFetch: typeof actualFetch = async (options) => {
                await actualFetch(options);
                expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
                await postAck.hold();
                if (retirement === 'retired fetch') useTaskStore.setState({ fetchData: actualFetch });
                else if (retirement === 'stale preloaded adoption') await actualFetch({ silent: true, recoveryLoad: true,
                    throwOnError: true, preloadedData: preCredit });
                else useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes = 4;
            };
            useTaskStore.setState({ fetchData: ownedFetch });
            const generationWrite = vi.fn(async () => ({ ok: true as const, value: 1 }));
            const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
            const assertFenced = async () => {
                await expect(env.adapter.saveData(preCredit)).rejects.toThrow(/busy|reload/);
                await expect(env.adapter.saveDocumentWithReceipt({ requestId: ID,
                    payload: JSON.stringify(['backupDocument', 'merge', ID, 'a'.repeat(64)]),
                    expectedCurrent: preCredit, data: preCredit, reply: { unchanged: true } })).rejects.toThrow(/busy|reload/);
                await expect(env.adapter.commitReceiptOnly(ID, '["other"]')).rejects.toThrow(/busy|reload/);
                expect(await receipts.run(ID, '["other"]', generationWrite)).toMatchObject({ ok: false });
                expect(generationWrite).not.toHaveBeenCalled();
            };
            const write = env.adapter.savePomodoroTransitionWithReceipt(plan);
            await postAck.waiting;
            try { await assertFenced(); } finally { postAck.release(); }
            const answer = await write;
            expect(answer).toEqual({ result: plan.result, replayed: false, projectionReloaded: false });
            expect(useTaskStore.getState().fetchData).toBe(retirement === 'retired fetch' ? actualFetch : ownedFetch);
            expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(retirement === 'retired fetch' ? 29 : 4);
            const saved = await env.state();
            expect((saved.tasks[0] as Record<string, unknown>).timeSpentMinutes).toBe(29);
            expect((saved.receipts[0] as Record<string, unknown>).reply).toBe(JSON.stringify(plan.result));
            await assertFenced();
            expect(await env.state()).toEqual(saved);
            useTaskStore.setState({ fetchData: actualFetch });
            env.events.length = 0;
            expect(await env.adapter.savePomodoroTransitionWithReceipt(plan)).toEqual({ result: plan.result,
                replayed: true, projectionReloaded: true });
            expect(env.events.some((sql) => sql.startsWith('UPDATE tasks') || sql.startsWith('UPDATE native_pomodoro_session')
                || sql.startsWith('INSERT INTO native_request_receipts'))).toBe(false);
            expect(await env.state()).toEqual(saved);
            expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
            await useTaskStore.getState().updateTask('task', { title: 'Ordinary edit after exact projection retry' });
            await flushPendingSave();
            expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        });
    it('excludes ordinary writes during held SQL and held projection; adapter replacement cannot acknowledge old adoption', async () => {
        const env = await open(); const held = gate();
        env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        await expect(env.adapter.getData()).rejects.toThrow(/busy/);
        await expect(env.adapter.saveData(original)).rejects.toThrow(/busy/);
        const generationWrite = vi.fn(async () => ({ ok: true as const, value: 1 }));
        const generationReceipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        try {
            expect(await generationReceipts.run(ID, '["other"]', generationWrite)).toMatchObject({ ok: false });
            expect(generationWrite).not.toHaveBeenCalled();
        } finally { held.release(); }
        env.hooks.run = undefined; await write;
        // Force a cold proof-based reload against a new adapter, then retire its owner mid-read.
        const fresh = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(fresh);
        const load = gate(); env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await load.hold(); };
        const replay = fresh.savePomodoroTransitionWithReceipt(env.plan); await load.waiting;
        await expect(fresh.saveData(original)).rejects.toThrow(/reload|busy/);
        await expect(fresh.commitReceiptOnly(ID, '[]')).rejects.toThrow(/reload|busy/);
        setStorageAdapter(oldAdapter); load.release();
        expect((await replay).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        await expect(fresh.saveData(original)).rejects.toThrow(/reload/);
    });
    it('initialization does not strand ordinary saves and corrupt local rows stay preserved outside ordinary loads', async () => {
        const env = await open(); await env.sql.client.run('DELETE FROM native_pomodoro_session');
        expect(await env.adapter.readPomodoroSession()).toEqual({ raw: null, state: null });
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.initialize)).projectionReloaded).toBe(true);
        await env.adapter.saveData(await env.adapter.getData());
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['{"version":999}']);
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow(/Pomodoro/);
        await loadNativeRequestReceipts(env.sql.client);
        await env.adapter.getData(); expect((await env.state()).sessions).toEqual([{ id: 1, state_json: '{"version":999}' }]);
    });
    it('preserves an unknown local schema and read failures while ordinary canonical data remains readable', async () => {
        const env = await open();
        env.hooks.all = async (statement) => { if (statement.startsWith('PRAGMA table_info(native_pomodoro_session)')) throw new Error('read error'); };
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow('Pomodoro session could not be read');
        env.hooks.all = undefined;
        await env.sql.client.run('ALTER TABLE native_pomodoro_session ADD COLUMN unknown TEXT');
        const before = await env.state();
        await loadNativeRequestReceipts(env.sql.client);
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow('Pomodoro session could not be read');
        await env.adapter.getData(); expect(await env.state()).toEqual(before);
    });
    it('logs only after durable proof and logger failure cannot change the result', async () => {
        const env = await open(); const info = vi.spyOn(logger, 'logInfo');
        await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(info.mock.calls.filter((call) => call[0] === 'Native Pomodoro transition confirmed')).toEqual([['Native Pomodoro transition confirmed',
            { scope: 'storage', force: true, context: { releaseCheck: 'v1.3.5/ios-pomodoro-credit', outcome: 'confirmed' } }]]);
        info.mockImplementation(() => { throw new Error('logger failed'); });
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
    });
    it('refuses Pomodoro while an ordinary write, baseline read, document write or receipt-only transaction owns the connection', async () => {
        const env = await open();
        for (const kind of ['ordinary', 'baseline', 'document'] as const) {
            const held = gate(); let operation: Promise<unknown>;
            if (kind === 'baseline') {
                env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await held.hold(); };
                operation = env.adapter.getData();
            } else {
                env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
                if (kind === 'ordinary') operation = env.adapter.saveData(await env.adapter.getData());
                else operation = env.adapter.saveDocumentWithReceipt({ requestId: ID,
                    payload: JSON.stringify(['backupDocument', 'merge', ID, 'a'.repeat(64)]),
                    expectedCurrent: await env.adapter.getData(), data: await env.adapter.getData(), reply: { unchanged: true } });
            }
            await held.waiting;
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
            held.release(); await operation;
            env.hooks.run = undefined; env.hooks.all = undefined;
        }
        await loadNativeRequestReceipts(env.sql.client);
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'held' } }) });
        const id = '44444444-4444-4444-8444-444444444444';
        await receipts.run(id, '["other"]', async () => ({ ok: true, value: 1 }));
        const held = gate(); env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const receiptOnly = env.adapter.commitReceiptOnly(id, '["other"]'); await held.waiting;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
        held.release(); await receiptOnly; env.hooks.run = undefined;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
    });
    it('does not let generic generation/receipt-only writers fabricate a Pomodoro outcome', async () => {
        const env = await open(); const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        const write = vi.fn(async () => ({ ok: true as const, value: env.plan.result }));
        expect(await receipts.run(NEXT, nativePomodoroReceiptPayload(env.plan), write)).toMatchObject({ ok: false });
        expect(write).not.toHaveBeenCalled();
        await expect(env.adapter.commitReceiptOnly(NEXT, nativePomodoroReceiptPayload(env.plan))).rejects.toThrow(/atomic/);
        expect(await env.adapter.readPomodoroTransitionOutcome(env.plan)).toBeNull();
    });
    it('keeps edits made during held projection and cannot acknowledge a discarded canonical result', async () => {
        const env = await open(); const held = gate();
        env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        const current = useTaskStore.getState()._allTasks;
        const changed = current.map((task) => ({ ...task, title: 'Retained pending edit' }));
        useTaskStore.setState({ _allTasks: changed, tasks: changed, _tasksById: new Map(changed.map((task) => [task.id, task])), lastDataChangeAt: 1 });
        held.release(); env.hooks.all = undefined;
        expect((await write).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.title).toBe('Retained pending edit');
        const discarded = await env.adapter.getData(); env.adapter.acknowledgeDataLoad(discarded);
        await expect(env.adapter.saveData(discarded)).rejects.toThrow(/reload/);
        const writer = vi.fn(async () => ({ ok: true as const, value: 1 }));
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        expect(await receipts.run(ID, '["other"]', writer)).toMatchObject({ ok: false });
        expect(writer).not.toHaveBeenCalled();
        expect((await env.adapter.readPomodoroTransitionOutcome(env.plan))!.creditedMinutes).toBe(25);
    });
    it('refuses warm reapplication after an ambiguous actual COMMIT loses its receipt even if raw BEFORE is restored', async () => {
        const env = await open(); let once = true;
        env.hooks.afterRun = async (statement) => { if (statement === 'COMMIT' && once) { once = false; throw new Error('lost'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        env.hooks.afterRun = undefined;
        await env.sql.client.run('DELETE FROM native_request_receipts');
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', [env.plan.sessionBefore]);
        const row = env.plan.target!.row!;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,rev=?,revBy=?,updatedAt=? WHERE id=?',
            ['timeSpentMinutes', 'rev', 'revBy', 'updatedAt'].map((name) => row[TASK_SQLITE_COLUMNS.indexOf(name)]).concat(['task']));
        const before = await env.state();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        expect(await env.state()).toEqual(before);
        await expect(env.adapter.readPomodoroTransitionOutcome(env.plan)).rejects.toThrow();
    });
    it('preserves edits made while SQL is held before projection reload can capture a newer owner', async () => {
        const env = await open(); const held = gate();
        env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        const changed = useTaskStore.getState()._allTasks.map((task) => ({ ...task, title: 'Edit during SQL' }));
        useTaskStore.setState({ _allTasks: changed, tasks: changed, _tasksById: new Map(changed.map((task) => [task.id, task])), lastDataChangeAt: 1 });
        held.release(); env.hooks.run = undefined;
        expect((await write).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.title).toBe('Edit during SQL');
        await expect(env.adapter.saveData(original)).rejects.toThrow(/reload/);
    });
    it('refreshes capped identical revision/timestamp and refuses forged oversized plans before BEGIN', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE tasks SET rev=?,revBy=? WHERE id=?', [2_147_483_647, 'device', 'task']);
        await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
        const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
        const plan = prepareNativePomodoroTransition({ request: env.plan.request,
            session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
            target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(plan)).projectionReloaded).toBe(true);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        const fresh = await env.adapter.getData(); await env.adapter.saveData(fresh);
        expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        await useTaskStore.getState().updateTask('task', { title: 'Ordinary edit after adoption' });
        await flushPendingSave();
        expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt({ ...plan, result: { ...plan.result, creditedMinutes: 999 } })).rejects.toThrow();
        expect(env.events).toEqual([]);
    });
    it('refuses entry while a generation callback is running before it has a pending receipt', async () => {
        const env = await open(); await loadNativeRequestReceipts(env.sql.client);
        const held = gate();
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'unsettled' } }) });
        const running = receipts.run(ID, '["other"]', async () => { await held.hold(); return { ok: true, value: 1 }; });
        await held.waiting; env.events.length = 0;
        try {
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
            expect(env.events).toEqual([]);
        } finally { held.release(); }
        expect(await running).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
    });
});
