import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, getPomodoroLocalDayKey, type Task } from '@mindwtr/core';
import { logInfo } from './app-log';

vi.mock('./app-log', () => ({ logWarn: vi.fn(async () => undefined), logInfo: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { createMobilePomodoroController } from './pomodoro-controller';

const makeStorage = (stored: unknown = null) => ({
  getItem: vi.fn(async () => stored === null ? null : JSON.stringify(stored)),
  setItem: vi.fn(async () => undefined),
});

describe('mobile pomodoro controller', () => {
  let nowMs = 10_000;

  beforeEach(() => {
    nowMs = 10_000;
    vi.mocked(logInfo).mockClear();
  });

  it.each([
    ['focus', 'start', 'focus-finished'],
    ['focus', 'reset', 'focus-finished'],
    ['focus', 'switch-phase', 'focus-finished'],
    ['focus', 'dismiss', 'focus-finished'],
    ['break', 'start', 'break-finished'],
    ['break', 'reset', 'break-finished'],
    ['break', 'switch-phase', 'break-finished'],
    ['break', 'dismiss', 'break-finished'],
  ] as const)('keeps %s completion feedback through idle ticks until %s', async (phase, action, event) => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    controller.setDurations({ focusMinutes: 1, breakMinutes: 1 });
    if (phase === 'break') controller.switchPhase();
    controller.toggle();

    nowMs += 60_000;
    controller.reconcile();
    expect(controller.getSnapshot().lastEvent).toBe(event);

    for (let idleTick = 0; idleTick < 3; idleTick += 1) {
      nowMs += 1_000;
      controller.reconcile();
    }
    expect(controller.getSnapshot().lastEvent).toBe(event);

    if (action === 'start') controller.toggle();
    if (action === 'reset') controller.reset();
    if (action === 'switch-phase') controller.switchPhase();
    if (action === 'dismiss') controller.clearLastEvent();
    expect(controller.getSnapshot().lastEvent).toBeNull();
  });

  it('treats Watch actions as timestamped idempotent setters', async () => {
    const storage = makeStorage();
    const controller = createMobilePomodoroController({ storage, now: () => nowMs });
    await controller.ensureHydrated();

    expect(await controller.applyWatchCommand({ action: 'start', createdAt: new Date(20_000).toISOString() })).toBe('applied');
    expect(controller.getSnapshot().timerState.isRunning).toBe(true);
    expect(await controller.applyWatchCommand({ action: 'start', createdAt: new Date(20_000).toISOString() })).toBe('already-applied');

    nowMs = 21_000;
    expect(await controller.applyWatchCommand({ action: 'pause', createdAt: new Date(21_000).toISOString() })).toBe('applied');
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
  });

  it('keeps a command retryable until its timer session is durable', async () => {
    const storage = makeStorage();
    storage.setItem.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const controller = createMobilePomodoroController({ storage, now: () => nowMs });
    await controller.ensureHydrated();
    const command = { action: 'start' as const, createdAt: new Date(20_000).toISOString() };

    await expect(controller.applyWatchCommand(command)).rejects.toThrow('disk full');
    await expect(controller.applyWatchCommand(command)).resolves.toBe('already-applied');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('rejects an offline Watch command older than a phone-side mutation', async () => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    controller.toggle();
    expect(controller.getSnapshot().updatedAtMs).toBe(10_000);

    expect(await controller.applyWatchCommand({
      action: 'pause',
      createdAt: new Date(9_000).toISOString(),
    })).toBe('stale');
    expect(controller.getSnapshot().timerState.isRunning).toBe(true);
  });

  it('keeps a later phone action authoritative across Watch clock skew', async () => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    const watchTime = new Date(20_000).toISOString();
    expect(await controller.applyWatchCommand({ action: 'start', createdAt: watchTime })).toBe('applied');

    nowMs = 11_000;
    controller.toggle();
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
    expect(controller.getSnapshot().updatedAtMs).toBe(20_001);

    expect(await controller.applyWatchCommand({ action: 'start', createdAt: watchTime })).toBe('stale');
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
  });

  it('respects the phone link-task setting and rejects a terminal Watch task link', async () => {
    const openTask = { id: 'open', title: 'Open', status: 'next' } as Task;
    const doneTask = { id: 'done', title: 'Done', status: 'done' } as Task;
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [openTask, doneTask], updateTask: vi.fn(async () => ({ success: true })) }),
    });
    await controller.ensureHydrated();
    nowMs = 11_000;
    controller.setSelectedTaskId(openTask.id);

    expect(await controller.applyWatchCommand(
      { action: 'start', taskId: openTask.id, createdAt: new Date(20_000).toISOString() },
      {},
      { linkTaskEnabled: false },
    )).toBe('applied');
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined();

    nowMs = 20_500;
    controller.setSelectedTaskId(openTask.id);
    expect(await controller.applyWatchCommand(
      { action: 'pause', taskId: doneTask.id, createdAt: new Date(21_000).toISOString() },
      {},
      { linkTaskEnabled: true },
    )).toBe('applied');
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined();
  });

  it('credits a completed linked focus session once across repeated reconciliation', async () => {
    const task = { id: 'task-1', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const stored = {
      durations: DEFAULT_POMODORO_DURATIONS,
      timerState: {
        phase: 'focus',
        remainingSeconds: 1,
        isRunning: true,
        completedFocusSessions: 0,
      },
      selectedTaskId: task.id,
      phaseEndsAt: new Date(9_000).toISOString(),
      sessionHistory: {
        totalCompletedFocusSessions: 0,
        completedFocusSessionsByTaskId: {},
        todayDayKey: getPomodoroLocalDayKey(nowMs),
        completedTodayFocusSessions: 0,
      },
    };
    const controller = createMobilePomodoroController({
      storage: makeStorage(stored),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });

    await controller.ensureHydrated();
    controller.reconcile();
    controller.reconcile();

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(task.id, {
      timeSpentMinutes: 5 + DEFAULT_POMODORO_DURATIONS.focusMinutes,
    });
  });

  it('credits the expired old interval before replacing its durations', async () => {
    const task = { id: 'task-a', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });
    await controller.ensureHydrated();
    controller.setSelectedTaskId(task.id);
    controller.toggle();

    nowMs += 25 * 60_000;
    controller.setDurations({ focusMinutes: 50, breakMinutes: 10 });

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { timeSpentMinutes: 30 });
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('Pomodoro elapsed focus boundary resolved before action', {
      scope: 'pomodoro',
      extra: { releaseCheck: 'v1.3.5/pomodoro-rn-boundary', outcome: 'elapsed-focus-resolved' },
    });
    expect(controller.getSnapshot()).toMatchObject({
      durations: { focusMinutes: 50, breakMinutes: 10 },
      timerState: { phase: 'break', remainingSeconds: 600, isRunning: false, completedFocusSessions: 1 },
      selectedTaskId: task.id,
      lastEvent: null,
      sessionHistory: { totalCompletedFocusSessions: 1, completedFocusSessionsByTaskId: { 'task-a': 1 } },
    });
    expect(controller.getSnapshot().phaseEndsAt).toBeUndefined();
    controller.reconcile();
    controller.setDurations({ focusMinutes: 50, breakMinutes: 10 });
    await controller.flushPersistence();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('uses restored durations to credit hydration rather than the default in-memory pair', async () => {
    const task = { id: 'restored-task', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage({
        durations: { focusMinutes: 50, breakMinutes: 10 },
        timerState: { phase: 'focus', remainingSeconds: 1, isRunning: true, completedFocusSessions: 0 },
        selectedTaskId: task.id,
        phaseEndsAt: new Date(9_000).toISOString(),
      }),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });
    await controller.ensureHydrated();
    controller.reconcile();

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { timeSpentMinutes: 55 });
    expect(controller.getSnapshot()).toMatchObject({
      durations: { focusMinutes: 50, breakMinutes: 10 },
      timerState: { phase: 'break', remainingSeconds: 600, completedFocusSessions: 1 },
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it.each((['focus', 'break'] as const).flatMap((phase) => (
    [false, true].flatMap((autoStartBreaks) => (
      [false, true].flatMap((autoStartFocus) => (
        ['task-b', undefined].map((selectedTaskId) => ({ phase, autoStartBreaks, autoStartFocus, selectedTaskId }))
      ))
    ))
  )))('settles the old $phase selection with breaks=$autoStartBreaks focus=$autoStartFocus before selecting $selectedTaskId', async ({
    phase, autoStartBreaks, autoStartFocus, selectedTaskId,
  }) => {
    const taskA = { id: 'task-a', title: 'Write', timeSpentMinutes: 5 } as Task;
    const taskB = { id: 'task-b', title: 'Read', timeSpentMinutes: 10 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [taskA, taskB], updateTask }),
    });
    await controller.ensureHydrated();
    controller.setSelectedTaskId(taskA.id);
    if (phase === 'break') controller.switchPhase();
    controller.toggle();
    nowMs += (phase === 'focus' ? 25 : 5) * 60_000;
    const autoStartOptions = { autoStartBreaks, autoStartFocus };

    controller.setSelectedTaskId(selectedTaskId, autoStartOptions);

    const isRunning = phase === 'focus' ? autoStartBreaks : autoStartFocus;
    const remainingSeconds = phase === 'focus' ? 300 : 1500;
    expect(controller.getSnapshot()).toMatchObject({
      selectedTaskId,
      timerState: { phase: phase === 'focus' ? 'break' : 'focus', remainingSeconds, isRunning },
      lastEvent: phase === 'focus' ? 'focus-finished' : 'break-finished',
    });
    expect(controller.getSnapshot().phaseEndsAt).toBe(isRunning
      ? new Date(nowMs + remainingSeconds * 1000).toISOString()
      : undefined);
    if (phase === 'focus') {
      expect(updateTask).toHaveBeenCalledExactlyOnceWith(taskA.id, { timeSpentMinutes: 30 });
      expect(controller.getSnapshot().sessionHistory.completedFocusSessionsByTaskId).toEqual({ 'task-a': 1 });
    } else {
      expect(updateTask).not.toHaveBeenCalled();
    }
    controller.setSelectedTaskId(selectedTaskId, autoStartOptions);
    controller.reconcile(autoStartOptions);
    await controller.flushPersistence();
    expect(updateTask).toHaveBeenCalledTimes(phase === 'focus' ? 1 : 0);
  });
});
