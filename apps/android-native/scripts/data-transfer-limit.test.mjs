// Pass D1c step 0 (design §8, code review P2): the transfer limit check-data-device.mjs proposes from its measured rows.
import { describe, expect, it } from 'bun:test';
import { boundaryVerdict, MEASURE_SHAPES, MEASURE_WORKLOADS, proposeTransferLimit, rowBound } from './data-transfer-limit.mjs';

const row = (shape, workload, fields) => ({ shape, workload, sourceMiB: 0, libraryBeforeMiB: 0, libraryAfterMiB: 0, pass: true, ...fields });
/** Every workload and shape, each passing at [mib] over nothing. */
const everyWorkload = (mib) => MEASURE_SHAPES.flatMap((shape) => MEASURE_WORKLOADS.map((workload) => row(shape, workload, { sourceMiB: mib })));

describe('the step 0 transfer limit', () => {
    it('is half of the smallest workload bound when every workload and shape has rows', () => {
        const rows = [...everyWorkload(64), row('notes', 'merge-over', { sourceMiB: 20, libraryBeforeMiB: 20 }), row('notes', 'merge-over', { sourceMiB: 30, libraryBeforeMiB: 30, pass: false })];
        expect(proposeTransferLimit(rows.filter((item) => !(item.shape === 'notes' && item.workload === 'merge-over' && item.sourceMiB === 64)))).toMatchObject({ limitMiB: 20, smallestMiB: 40 });
    });

    it('a failing smaller row caps its workload, whatever larger rows passed (8 MiB fails, 16 passes: no limit above 0)', () => {
        const rows = everyWorkload(64).filter((item) => !(item.shape === 'rows' && item.workload === 'restore-fresh'));
        rows.push(row('rows', 'restore-fresh', { sourceMiB: 8, pass: false }), row('rows', 'restore-fresh', { sourceMiB: 16 }));
        expect(proposeTransferLimit(rows)).toMatchObject({ limitMiB: 0 });
    });

    it('proposes nothing while a workload or shape has no row', () => {
        const rows = everyWorkload(64).filter((item) => !(item.shape === 'notes' && item.workload === 'capture'));
        const proposal = proposeTransferLimit(rows);
        expect(proposal.limitMiB).toBeNull();
        expect(proposal.missing).toEqual(['notes/capture']);
    });

    it('counts an import by the library it left, not its compressed file over the library before', () => {
        expect(rowBound(row('rows', 'import-todoist', { sourceMiB: 1, libraryBeforeMiB: 40, libraryAfterMiB: 140 }))).toBe(140);
        expect(rowBound(row('rows', 'restore-over', { sourceMiB: 30, libraryBeforeMiB: 40, libraryAfterMiB: 35 }))).toBe(70);
    });

    it('is established only once every workload and shape passed again at its admitted boundary', () => {
        const boundary = everyWorkload(20).map((item) => ({ ...item, boundary: true }));
        expect(boundaryVerdict(boundary, 20)).toMatchObject({ established: true });
        const failed = boundary.map((item) => (item.workload === 'undo' && item.shape === 'rows' ? { ...item, pass: false } : item));
        expect(boundaryVerdict(failed, 20)).toMatchObject({ established: false, failed: ['rows/undo'] });
        expect(boundaryVerdict(boundary.filter((item) => item.workload !== 'cold-start'), 20)).toMatchObject({ established: false, missing: ['rows/cold-start', 'notes/cold-start'] });
    });
});
