// Pass D1c step 0 (design §8, code review P2): the transfer limit from check-data-device.mjs's measured rows. Pure, so its
// rule is tested apart from the phone (data-transfer-limit.test.mjs).

/** Every Data workload the limit must hold for, each measured in every shape. */
export const MEASURE_WORKLOADS = ['restore-fresh', 'merge-over', 'restore-over', 'undo', 'export-json', 'export-csv', 'export-tasknotes',
    'capture', 'import-todoist', 'import-ticktick', 'import-dgt', 'import-omnifocus', 'import-mindwtr-csv', 'cold-start', 'recovery-boot'];
export const MEASURE_SHAPES = ['rows', 'notes'];

/**
 * A row's size in MiB: the file and the library it went over, or the library it left, whichever is larger. An import counts
 * the library it left (its file is compressed and expands); an export, a capture or a start counts the library it read.
 */
export const rowBound = (row) => Math.max((row.sourceMiB ?? 0) + (row.libraryBeforeMiB ?? 0), row.libraryAfterMiB ?? 0);

/** The largest size below a workload's first failure: a failing smaller row caps it, whatever larger rows passed. */
const workloadBound = (rows) => {
    // At one size, a failure sorts first, so it caps that size too.
    const sorted = [...rows].sort((left, right) => rowBound(left) - rowBound(right) || Number(left.pass) - Number(right.pass));
    let bound = 0;
    for (const row of sorted) {
        if (!row.pass) break;
        bound = rowBound(row);
    }
    return bound;
};

const key = (row) => `${row.shape}/${row.workload}`;
const cells = (shapes, workloads) => shapes.flatMap((shape) => workloads.map((workload) => `${shape}/${workload}`));

/**
 * Half of the smallest workload bound over the whole matrix (D1a's margin), or null while any workload or shape has no row.
 * Boundary reruns ([row.boundary]) are not part of the proposal.
 */
export function proposeTransferLimit(rows, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const measured = rows.filter((row) => !row.boundary);
    const bounds = Object.fromEntries(cells(shapes, workloads).map((cell) => [cell, measured.filter((row) => key(row) === cell)]));
    const missing = Object.keys(bounds).filter((cell) => bounds[cell].length === 0);
    const sizes = Object.fromEntries(Object.entries(bounds).filter(([, list]) => list.length).map(([cell, list]) => [cell, workloadBound(list)]));
    if (missing.length) return { limitMiB: null, missing, bounds: sizes };
    const smallestMiB = Math.min(...Object.values(sizes));
    return { limitMiB: Math.floor(smallestMiB / 2), smallestMiB, missing: [], bounds: sizes };
}

/** Whether every workload and shape passed again at the proposed limit's admitted boundary ([row.boundary] rows). */
export function boundaryVerdict(rows, limitMiB, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const boundary = rows.filter((row) => row.boundary);
    const missing = cells(shapes, workloads).filter((cell) => !boundary.some((row) => key(row) === cell));
    const failed = cells(shapes, workloads).filter((cell) => boundary.some((row) => key(row) === cell && !row.pass));
    return { established: missing.length === 0 && failed.length === 0, limitMiB, missing, failed };
}
