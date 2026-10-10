import { strToU8 } from 'fflate';
import { createPomodoroState, type PomodoroDurations, type PomodoroSessionHistory, type PomodoroState } from './pomodoro';
import { resolvePomodoroSession, serializePomodoroSession, type StoredPomodoroSession } from './pomodoro-session';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { addTimeSpentMinutes, normalizeTimeSpentMinutes } from './time-spent';
import { nextRevision } from './sync-revision';
import { taskEditValuesEqual } from './json-value-equality';

export const MAX_NATIVE_POMODORO_SESSION_BYTES = 1_000_000;
export const MAX_NATIVE_POMODORO_PLAN_BYTES = 2_000_000;
export const MAX_NATIVE_POMODORO_RESULT_BYTES = 8192;
type NativeSession = StoredPomodoroSession & { durations: PomodoroDurations; timerState: PomodoroState;
    sessionHistory: PomodoroSessionHistory; updatedAtMs: number };
export type NativePomodoroSession = { version: 1; sessionID: string; generation: number; session: NativeSession };
export type NativePomodoroSessionRead = { raw: null; state: null } | { raw: string; state: NativePomodoroSession };
export type NativePomodoroRequest =
    | { action: 'initialize'; requestId: string; observedAtMs: number; localDayKey: string; durations: PomodoroDurations }
    | { action: 'reconcile'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean } };
export type NativePomodoroTaskBefore = { id: string; row: readonly (string | number | null)[] | null };
export type NativePomodoroTaskPatch = { timeSpentMinutes: number; rev: number; revBy: string; updatedAt: string };
export type NativePomodoroResult = { sessionID: string; generation: number; completedFocusSessions: number;
    creditedMinutes: number; creditDisposition: 'credited' | 'unlinked' | 'unavailable' | 'capped' | 'none' };
export type PreparedNativePomodoroTransition = { version: 1; request: NativePomodoroRequest; sessionBefore: string | null;
    sessionAfter: string; target: NativePomodoroTaskBefore | null; taskPatch: NativePomodoroTaskPatch | null;
    deviceId: string | null; result: NativePomodoroResult };

function invalid(): never { throw new Error('Invalid native Pomodoro transition'); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => record(value)
    && required.every((name) => Object.prototype.hasOwnProperty.call(value, name)) && Object.keys(value).every((name) => required.includes(name) || optional.includes(name));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const identity = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0
    && value.length <= limit && value.trim() === value && !['__proto__', 'constructor', 'prototype'].includes(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
    && Math.abs(value) <= 8_640_000_000_000_000;
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 32
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bounded = (value: string, bytes: number): boolean => value.length <= bytes && strToU8(value).length <= bytes;
const durations = (value: unknown): value is PomodoroDurations => exact(value, ['focusMinutes', 'breakMinutes'])
    && [value.focusMinutes, value.breakMinutes].every((n) => count(n) && n >= 1 && n <= 180);

/** JSON.parse establishes syntax; this bounded walk additionally refuses duplicate names. */
const parseSession = (raw: string): unknown => {
    if (typeof raw !== 'string' || !bounded(raw, MAX_NATIVE_POMODORO_SESSION_BYTES)) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return invalid(); }
    let offset = 0;
    const space = () => { while (/\s/u.test(raw[offset] ?? '') && offset < raw.length) offset += 1; };
    const string = (): string => {
        const start = offset++;
        while (offset < raw.length) {
            const char = raw[offset++];
            if (char === '\\') offset += 1;
            else if (char === '"') return JSON.parse(raw.slice(start, offset)) as string;
        }
        return invalid();
    };
    const walk = (depth: number): void => {
        if (depth > 32) invalid();
        space();
        if (raw[offset] === '{') {
            offset += 1; space(); const names = new Set<string>();
            if (raw[offset] === '}') { offset += 1; return; }
            while (offset < raw.length) {
                space(); const name = string(); if (names.has(name)) invalid(); names.add(name);
                space(); offset += 1; walk(depth + 1); space();
                if (raw[offset++] === '}') return;
            }
        } else if (raw[offset] === '[') {
            offset += 1; space(); if (raw[offset] === ']') { offset += 1; return; }
            while (offset < raw.length) { walk(depth + 1); space(); if (raw[offset++] === ']') return; }
        } else if (raw[offset] === '"') string();
        else { while (offset < raw.length && !/[\s,\]}]/u.test(raw[offset])) offset += 1; }
    };
    walk(0);
    return parsed;
};

export function decodeNativePomodoroSession(raw: string): NativePomodoroSession {
    const value = parseSession(raw);
    if (!exact(value, ['version', 'sessionID', 'generation', 'session']) || value.version !== 1
        || !uuid(value.sessionID) || !count(value.generation)) invalid();
    const session = value.session;
    if (!exact(session, ['durations', 'timerState', 'sessionHistory', 'updatedAtMs'], ['selectedTaskId', 'phaseEndsAt'])
        || !durations(session.durations) || !time(session.updatedAtMs)
        || (Object.prototype.hasOwnProperty.call(session, 'selectedTaskId') && !identity(session.selectedTaskId, 500))) invalid();
    const timer = session.timerState; const history = session.sessionHistory;
    if (!exact(timer, ['phase', 'remainingSeconds', 'isRunning', 'completedFocusSessions'])
        || (timer.phase !== 'focus' && timer.phase !== 'break') || !count(timer.remainingSeconds)
        || timer.remainingSeconds > (timer.phase === 'focus' ? session.durations.focusMinutes : session.durations.breakMinutes) * 60
        || typeof timer.isRunning !== 'boolean' || !count(timer.completedFocusSessions)
        || (timer.isRunning ? !date(session.phaseEndsAt) : Object.prototype.hasOwnProperty.call(session, 'phaseEndsAt'))) invalid();
    if (!exact(history, ['totalCompletedFocusSessions', 'completedFocusSessionsByTaskId', 'todayDayKey', 'completedTodayFocusSessions'])
        || !count(history.totalCompletedFocusSessions) || history.totalCompletedFocusSessions !== timer.completedFocusSessions
        || !count(history.completedTodayFocusSessions) || history.completedTodayFocusSessions > history.totalCompletedFocusSessions
        || !day(history.todayDayKey) || !record(history.completedFocusSessionsByTaskId)) invalid();
    const entries = Object.entries(history.completedFocusSessionsByTaskId);
    if (entries.length > 10_000) invalid();
    let sum = 0;
    for (const [id, n] of entries) {
        if (!identity(id, 500) || !count(n) || n === 0 || n > history.totalCompletedFocusSessions) invalid();
        sum += n; if (!count(sum) || sum > history.totalCompletedFocusSessions) invalid();
    }
    return value as NativePomodoroSession;
}

const requestOf = (value: unknown): NativePomodoroRequest => {
    if (!record(value) || !uuid(value.requestId) || !time(value.observedAtMs) || !day(value.localDayKey)) invalid();
    if (value.action === 'initialize') {
        if (!exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'durations']) || !durations(value.durations)) invalid();
        return { action: 'initialize', requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
            durations: { focusMinutes: value.durations.focusMinutes, breakMinutes: value.durations.breakMinutes } };
    }
    if (value.action !== 'reconcile' || !exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'autoStart'])
        || !exact(value.autoStart, ['autoStartFocus', 'autoStartBreaks'])
        || typeof value.autoStart.autoStartFocus !== 'boolean' || typeof value.autoStart.autoStartBreaks !== 'boolean') invalid();
    return { action: 'reconcile', requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
        autoStart: { autoStartFocus: value.autoStart.autoStartFocus, autoStartBreaks: value.autoStart.autoStartBreaks } };
};
const targetOf = (value: unknown, id: string | undefined): NativePomodoroTaskBefore | null => {
    if (!id) { if (value !== null) invalid(); return null; }
    if (!exact(value, ['id', 'row']) || value.id !== id) invalid();
    if (value.row === null) return { id, row: null };
    if (!Array.isArray(value.row) || value.row.length !== TASK_SQLITE_COLUMNS.length || value.row[0] !== id
        || !value.row.every((cell) => cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell)))) invalid();
    return { id, row: [...value.row] as (string | number | null)[] };
};
const cell = (row: readonly (string | number | null)[], name: string) => row[TASK_SQLITE_COLUMNS.indexOf(name)];

export function prepareNativePomodoroTransition(input: { request: NativePomodoroRequest; session: NativePomodoroSessionRead;
    target: NativePomodoroTaskBefore | null; deviceId: string | null }): PreparedNativePomodoroTransition | null {
    const request = requestOf(input.request);
    if (!exact(input.session, ['raw', 'state'])) invalid();
    let after: NativePomodoroSession; let target: NativePomodoroTaskBefore | null = null;
    let taskPatch: NativePomodoroTaskPatch | null = null; let delta = 0; let creditedMinutes = 0;
    let creditDisposition: NativePomodoroResult['creditDisposition'] = 'none';
    let deviceId: string | null = null;
    if (request.action === 'initialize') {
        if (input.session.raw !== null || input.session.state !== null || input.target !== null || input.deviceId !== null) invalid();
        after = { version: 1, sessionID: request.requestId, generation: 0, session: { durations: request.durations,
            timerState: createPomodoroState(request.durations), sessionHistory: { totalCompletedFocusSessions: 0,
                completedFocusSessionsByTaskId: {}, todayDayKey: request.localDayKey, completedTodayFocusSessions: 0 }, updatedAtMs: request.observedAtMs } };
    } else {
        if (typeof input.session.raw !== 'string') invalid();
        const before = decodeNativePomodoroSession(input.session.raw);
        if (!taskEditValuesEqual(before, input.session.state)) invalid();
        target = targetOf(input.target, before.session.selectedTaskId);
        if (input.deviceId !== null && !identity(input.deviceId, 200)) invalid();
        if (request.observedAtMs < before.session.updatedAtMs) return null;
        const resolved = resolvePomodoroSession(before.session, request.observedAtMs, request.autoStart, request.localDayKey);
        // A display countdown alone does not own a SQL transition or generation.
        const structural = { ...serializePomodoroSession(resolved), timerState: { ...resolved.timerState,
            remainingSeconds: before.session.timerState.remainingSeconds } };
        const { updatedAtMs: _mutationClock, ...previous } = before.session;
        if (taskEditValuesEqual(structural, previous)) return null;
        if (before.generation === Number.MAX_SAFE_INTEGER) invalid();
        after = { version: 1, sessionID: before.sessionID, generation: before.generation + 1,
            session: { ...serializePomodoroSession(resolved), durations: resolved.durations, timerState: resolved.timerState,
                sessionHistory: resolved.sessionHistory, updatedAtMs: request.observedAtMs } };
        delta = after.session.sessionHistory.totalCompletedFocusSessions - before.session.sessionHistory.totalCompletedFocusSessions;
        if (!count(delta)) invalid();
        if (delta > 0) {
            if (!target) creditDisposition = 'unlinked';
            else if (!target.row || cell(target.row, 'deletedAt') || cell(target.row, 'status') === 'archived') creditDisposition = 'unavailable';
            else {
                const rawMinutes = cell(target.row, 'timeSpentMinutes'); const rawRev = cell(target.row, 'rev');
                if ((rawMinutes !== null && typeof rawMinutes !== 'number') || (rawRev !== null && !count(rawRev))) invalid();
                const increment = delta * before.session.durations.focusMinutes;
                if (!count(increment)) invalid();
                const oldMinutes = normalizeTimeSpentMinutes(rawMinutes) ?? 0;
                const minutes = addTimeSpentMinutes(rawMinutes, increment) ?? 0;
                creditedMinutes = minutes - oldMinutes;
                if (creditedMinutes === 0) creditDisposition = 'capped';
                else {
                    if (!identity(input.deviceId, 200)) invalid();
                    deviceId = input.deviceId;
                    taskPatch = { timeSpentMinutes: minutes, rev: nextRevision(rawRev, { warn: false }), revBy: deviceId,
                        updatedAt: new Date(request.observedAtMs).toISOString() };
                    creditDisposition = 'credited';
                }
            }
        }
    }
    const sessionAfter = JSON.stringify(after);
    decodeNativePomodoroSession(sessionAfter);
    const result: NativePomodoroResult = { sessionID: after.sessionID, generation: after.generation,
        completedFocusSessions: after.session.sessionHistory.totalCompletedFocusSessions, creditedMinutes, creditDisposition };
    const plan: PreparedNativePomodoroTransition = { version: 1, request, sessionBefore: input.session.raw, sessionAfter,
        target, taskPatch, deviceId, result };
    if (!bounded(JSON.stringify(result), MAX_NATIVE_POMODORO_RESULT_BYTES)
        || !bounded(JSON.stringify(plan), MAX_NATIVE_POMODORO_PLAN_BYTES)
        || !bounded(JSON.stringify(['pomodoroTransition', plan]), MAX_NATIVE_POMODORO_PLAN_BYTES)) invalid();
    return plan;
}

export function validatePreparedNativePomodoroTransition(value: unknown): PreparedNativePomodoroTransition {
    if (!exact(value, ['version', 'request', 'sessionBefore', 'sessionAfter', 'target', 'taskPatch', 'deviceId', 'result'])
        || value.version !== 1 || (value.sessionBefore !== null && typeof value.sessionBefore !== 'string')
        || !exact(value.result, ['sessionID', 'generation', 'completedFocusSessions', 'creditedMinutes', 'creditDisposition'])
        || (value.taskPatch !== null && !exact(value.taskPatch, ['timeSpentMinutes', 'rev', 'revBy', 'updatedAt']))) invalid();
    const prepared = prepareNativePomodoroTransition({ request: value.request as NativePomodoroRequest,
        session: value.sessionBefore === null ? { raw: null, state: null } : { raw: value.sessionBefore, state: decodeNativePomodoroSession(value.sessionBefore) },
        target: value.target as NativePomodoroTaskBefore | null, deviceId: value.deviceId as string | null });
    if (!prepared || !taskEditValuesEqual(value, prepared)) invalid();
    return prepared;
}
export function nativePomodoroReceiptPayload(plan: PreparedNativePomodoroTransition): string {
    return JSON.stringify(['pomodoroTransition', validatePreparedNativePomodoroTransition(plan)]);
}
