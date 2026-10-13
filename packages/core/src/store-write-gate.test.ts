import { describe, expect, it } from 'vitest';

import { runStoreCommand, runSyncStoreSave } from './store-write-gate';

describe('store write gate', () => {
    it('lets a sync save run only between commands, and a nested command join its caller', async () => {
        const order: string[] = [];
        let finishOuter!: () => void;
        const outer = runStoreCommand(async () => {
            order.push('outer start');
            await new Promise<void>((resolve) => { finishOuter = resolve; });
            // A sync save is waiting now; a nested command must still join, or the save and this command wait on each other.
            await runStoreCommand(async () => { order.push('nested'); });
            order.push('outer end');
        });
        let late: Promise<void> = Promise.resolve();
        const save = runSyncStoreSave(async () => {
            order.push('save start');
            // A command that arrives while the save holds the gate waits for it.
            late = runStoreCommand(async () => { order.push('late command'); });
            await Promise.resolve();
            order.push('save end');
        });
        finishOuter();
        await Promise.all([outer, save]);
        await late;
        expect(order).toEqual(['outer start', 'nested', 'outer end', 'save start', 'save end', 'late command']);
    });

    it('releases the gate when a sync save throws', async () => {
        await expect(runSyncStoreSave(async () => { throw new Error('refused'); })).rejects.toThrow('refused');
        await expect(runStoreCommand(async () => 'ran')).resolves.toBe('ran');
    });
});
