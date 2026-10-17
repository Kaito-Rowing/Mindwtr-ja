import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The installed expo-share-intent, as patches/expo-share-intent@5.1.1.patch leaves it (bun applies the patch on install;
// scripts/ci/apply_bun_patches.sh applies it to npm installs). The module has no test set, so these read its source.
const require = createRequire(import.meta.url);
const moduleSource = readFileSync(path.join(path.dirname(require.resolve('expo-share-intent/package.json')),
    'android/src/main/java/expo/modules/shareintent/ExpoShareIntentModule.kt'), 'utf8');
const body = (name: string) => {
    const start = moduleSource.indexOf(`fun ${name}(`);
    expect(start, `fun ${name}`).toBeGreaterThanOrEqual(0);
    return moduleSource.slice(start, moduleSource.indexOf('\n    }\n', start));
};

describe('expo-share-intent patch: a hostile share (Dirty Stream)', () => {
    it('never names the cache copy after the provider\'s display name', () => {
        // A provider could name its file ../files/SQLite/<db> and overwrite the app's private files.
        expect(moduleSource).not.toMatch(/File\(context\.cacheDir,\s*fileName\)/);
        expect(body('sharedCacheFile')).toMatch(/UUID\.randomUUID\(\)/);
        expect(body('getDataColumn')).toMatch(/sharedCacheFile\(/);
    });

    it('takes only content URIs from other apps, for one file and for several', () => {
        const guard = body('isForeignContentUri');
        expect(guard).toMatch(/"content"\.equals\(uri\.scheme, ignoreCase = true\)/);
        expect(guard).toMatch(/resolveContentProvider\(authority, 0\)/);
        expect(guard).toMatch(/packageName/);
        const handle = body('handleShareIntent');
        expect(handle).toMatch(/if \(uri != null && isForeignContentUri\(uri\)\)/);
        expect(handle).toMatch(/EXTRA_STREAM\)\?\.filter \{ isForeignContentUri\(it\) \}/);
    });

    it('keeps a shared-storage document path inside shared storage', () => {
        // A document id of primary:../../data/data/<pkg>/files/<db> would point the share at the app's own files.
        const resolve = body('getAbsolutePath');
        expect(resolve).toMatch(/canonicalPath/);
        expect(resolve).toMatch(/startsWith\(/);
    });
});
