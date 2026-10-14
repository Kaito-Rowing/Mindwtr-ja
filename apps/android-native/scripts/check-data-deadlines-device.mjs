// Settings › Data's size-scaled deadlines on the S23 (pass D1c design §3.4): check-data-device.mjs's DL1-DL5 rows alone, each
// with its failing control first, so neither run passes the batch's one hour per check. Same arguments and exit codes.
//   node apps/android-native/scripts/check-data-deadlines-device.mjs <adb-serial>
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve(import.meta.dirname, 'check-data-device.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, D1C_PART: 'deadlines' } });
process.exit(run.status ?? 1);
