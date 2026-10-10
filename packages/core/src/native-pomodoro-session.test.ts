import { describe, expect, it, vi } from 'vitest';
import { decodeNativePomodoroSession, MAX_NATIVE_POMODORO_PLAN_BYTES, MAX_NATIVE_POMODORO_SESSION_BYTES, nativePomodoroReceiptPayload,
    prepareNativePomodoroTransition, validatePreparedNativePomodoroTransition } from './native-pomodoro-session';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import * as logger from './logger';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const AT = Date.parse('2026-10-10T00:00:00.000Z');
const day = '2026-10-10';
const initialize = () => prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID,
    observedAtMs: AT, localDayKey: day, durations: { focusMinutes: 25, breakMinutes: 5 } },
    session: { raw: null, state: null }, target: null, deviceId: null })!;
const running = (selectedTaskId: string | undefined = 'task') => {
    const state = decodeNativePomodoroSession(initialize().sessionAfter);
    state.session.timerState!.isRunning = true;
    state.session.phaseEndsAt = new Date(AT).toISOString();
    if (selectedTaskId) state.session.selectedTaskId = selectedTaskId;
    const raw = JSON.stringify(state);
    return { raw, state };
};
const task = (extra = {}) => ({ id: 'task', row: taskToSqliteRow({ id: 'task', title: 'Private', status: 'done',
    contexts: [], tags: [], createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
    rev: 2, timeSpentMinutes: 4, ...extra }) as (string | number | null)[] });
const reconcile = (extra = {}, target = task()) => prepareNativePomodoroTransition({ request: { action: 'reconcile', requestId: NEXT,
    observedAtMs: AT, localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false } },
    session: running(), target, deviceId: 'existing-device', ...extra });

describe('strict native Pomodoro preparation', () => {
    it('initializes only paused zero history and derives task credit from the completion cursor', () => {
        const initial = initialize();
        expect(initial.taskPatch).toBeNull();
        expect(decodeNativePomodoroSession(initial.sessionAfter).session.timerState).toEqual({ phase: 'focus', remainingSeconds: 1500,
            isRunning: false, completedFocusSessions: 0 });
        const plan = reconcile()!;
        expect(plan.taskPatch).toEqual({ timeSpentMinutes: 29, rev: 3, revBy: 'existing-device', updatedAt: new Date(AT).toISOString() });
        expect(plan.result).toMatchObject({ creditedMinutes: 25, completedFocusSessions: 1, creditDisposition: 'credited' });
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('retains raw before bytes and declines countdown-only ticks and clock rollback', () => {
        const session = running();
        session.state.session.phaseEndsAt = new Date(AT + 60_000).toISOString();
        session.raw = JSON.stringify(session.state, null, 2);
        expect(reconcile({ session })).toBeNull();
        expect(reconcile({ session, request: { action: 'reconcile', requestId: NEXT, observedAtMs: AT - 1,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } } })).toBeNull();
        session.state.session.phaseEndsAt = new Date(AT).toISOString();
        session.raw = JSON.stringify(session.state, null, 2);
        expect(reconcile({ session })!.sessionBefore).toBe(session.raw);
    });
    it.each([{ deletedAt: new Date(AT).toISOString() }, { status: 'archived' }])('does not credit unavailable task %j', (extra) => {
        const plan = reconcile({}, task(extra))!;
        expect(plan.taskPatch).toBeNull();
        expect(plan.result.creditDisposition).toBe('unavailable');
    });
    it('consumes missing, unlinked and capped completions without generating a device identity', () => {
        expect(reconcile({ target: { id: 'task', row: null }, deviceId: null })!.result.creditDisposition).toBe('unavailable');
        expect(reconcile({ session: running(''), target: null, deviceId: null })!.result.creditDisposition).toBe('unlinked');
        expect(reconcile({ deviceId: null }, task({ timeSpentMinutes: 100_000 }))!.result.creditDisposition).toBe('capped');
        expect(() => reconcile({ deviceId: null })).toThrow();
    });
    it('rejects forged after, result, target and revision and does not log during capped pure validation', () => {
        const warn = vi.spyOn(logger, 'logWarn');
        const plan = reconcile({}, task({ rev: 2_147_483_647 }))!;
        expect(plan.taskPatch!.rev).toBe(2_147_483_647);
        validatePreparedNativePomodoroTransition(plan);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        for (const forged of [{ ...plan, result: { ...plan.result, creditedMinutes: 999 } },
            { ...plan, taskPatch: { ...plan.taskPatch!, rev: 0 } }, { ...plan, sessionAfter: initialize().sessionAfter },
            { ...plan, target: { ...plan.target!, id: 'other' } }]) expect(() => validatePreparedNativePomodoroTransition(forged)).toThrow();
    });
    it('refuses duplicate members, unknown shapes, invalid dates/counters and ambiguous history identities', () => {
        const raw = initialize().sessionAfter;
        expect(() => decodeNativePomodoroSession(raw.replace('"version":1', '"version":1,"version":1'))).toThrow();
        expect(() => decodeNativePomodoroSession(raw.replace('"version":1', '"version":2'))).toThrow();
        for (const modify of [(state: ReturnType<typeof decodeNativePomodoroSession>) => { state.generation = Number.MAX_SAFE_INTEGER + 1; },
            (state: ReturnType<typeof decodeNativePomodoroSession>) => { state.session.phaseEndsAt = 'bad'; },
            (state: ReturnType<typeof decodeNativePomodoroSession>) => { state.session.sessionHistory!.completedFocusSessionsByTaskId = { ' task ': 1 }; }]) {
            const state = JSON.parse(raw); modify(state); expect(() => decodeNativePomodoroSession(JSON.stringify(state))).toThrow();
        }
        expect(TASK_SQLITE_COLUMNS.length).toBe(task().row.length);
    });
    it('accepts the exact escaped receipt byte bound and refuses one more byte before granting write authority', () => {
        const target = task(); const index = TASK_SQLITE_COLUMNS.indexOf('description'); target.row[index] = '';
        const baseline = reconcile({}, target)!;
        const bytes = new TextEncoder().encode(nativePomodoroReceiptPayload(baseline)).length;
        target.row[index] = 'x'.repeat(MAX_NATIVE_POMODORO_PLAN_BYTES - bytes);
        const boundary = reconcile({}, target)!;
        expect(new TextEncoder().encode(nativePomodoroReceiptPayload(boundary)).length).toBe(MAX_NATIVE_POMODORO_PLAN_BYTES);
        target.row[index] += 'x'; expect(() => reconcile({}, target)).toThrow();
        target.row[index] = '漢'.repeat(700_000); expect(() => reconcile({}, target)).toThrow();
    });
    it('validates the exact local cell byte boundary and refuses multibyte overflow without truncating history', () => {
        const state = decodeNativePomodoroSession(initialize().sessionAfter);
        const entries: [string, number][] = Array.from({ length: 2000 }, (_, i) => [String(i).padStart(4, '0') + 'h'.repeat(486), 1]);
        state.session.timerState.completedFocusSessions = 2000;
        state.session.sessionHistory.totalCompletedFocusSessions = 2000;
        state.session.sessionHistory.completedFocusSessionsByTaskId = Object.fromEntries(entries);
        let remaining = MAX_NATIVE_POMODORO_SESSION_BYTES - JSON.stringify(state).length;
        expect(remaining).toBeGreaterThan(0);
        for (const entry of entries) {
            const more = Math.min(10, remaining); entry[0] += 'x'.repeat(more); remaining -= more;
        }
        expect(remaining).toBe(0);
        state.session.sessionHistory.completedFocusSessionsByTaskId = Object.fromEntries(entries);
        const raw = JSON.stringify(state); expect(raw.length).toBe(MAX_NATIVE_POMODORO_SESSION_BYTES);
        expect(decodeNativePomodoroSession(raw).session.sessionHistory.totalCompletedFocusSessions).toBe(2000);
        expect(() => decodeNativePomodoroSession(raw.replace('h', '漢'))).toThrow();
    });
    it('uses bounded catchup for huge ranges but refuses unsafe completion/history totals and generation overflow', () => {
        const session = running();
        const huge = reconcile({ session, request: { action: 'reconcile', requestId: NEXT, observedAtMs: AT + 10_000_000_000_000,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } } })!;
        expect(huge.result.completedFocusSessions).toBeGreaterThan(1_000_000);
        expect(huge.taskPatch!.timeSpentMinutes).toBe(100_000);
        session.state.generation = Number.MAX_SAFE_INTEGER; session.raw = JSON.stringify(session.state);
        expect(() => reconcile({ session })).toThrow();
        session.state.generation = 0;
        session.state.session.timerState.completedFocusSessions = Number.MAX_SAFE_INTEGER;
        session.state.session.sessionHistory.totalCompletedFocusSessions = Number.MAX_SAFE_INTEGER;
        session.raw = JSON.stringify(session.state); expect(() => reconcile({ session })).toThrow();
    });
});
