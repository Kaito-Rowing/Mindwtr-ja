// node --test apps/android-native/scripts/check-variant-identity.test.mjs (no Gradle needed)
// Each build type's identity as Gradle merges it, built here from the app manifest and RN's widget and shortcut builders, passes
// the identity check; each broken identity is caught.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildShortcuts, buildShortcutsManifest } from './build-shortcuts.mjs';
import { buildManifest as buildWidgetManifest } from './build-widgets.mjs';
import { identityProblems } from './check-variant-identity.mjs';

const require = createRequire(import.meta.url);
const { Builder, parseStringPromise } = require('xml2js');
const app = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../mobile/app.json'), 'utf8')).expo;
const NAMESPACE = 'tech.dongdongbh.mindwtr.pilot';
const HEARTBEAT = 'https://mindwtr-analytics.mindwtr.workers.dev/';
const BENCH = { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark', scheme: 'mindwtr-native-bench', label: 'Mindwtr', rn: false };
const TYPES = {
    debug: { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev', scheme: 'mindwtr-native-dev', label: 'Mindwtr Native Dev', rn: false },
    upgradetest: { pkg: 'tech.dongdongbh.mindwtr.upgradetest', scheme: 'mindwtr-upgradetest', label: 'Mindwtr Native Dev', rn: true },
    release: { pkg: app.android.package, scheme: 'mindwtr', label: app.name, rn: true },
    benchmark: BENCH, benchmarkSeed: BENCH, benchmarkTrace: BENCH,
};

/** One build type's three files as Gradle would write them: the merged manifest, the shortcuts XML and BuildConfig.java. */
async function variant(type, { pkg, scheme, label, rn } = TYPES[type]) {
    const main = readFileSync(resolve(import.meta.dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8')
        .replaceAll('${applicationId}', pkg).replaceAll('${urlScheme}', scheme).replaceAll('${appLabel}', label);
    const root = (await parseStringPromise(main)).manifest;
    const application = root.application[0];
    for (const overlay of [buildWidgetManifest(pkg, label), buildShortcutsManifest()]) {
        const extra = (await parseStringPromise(overlay)).manifest.application[0];
        for (const [kind, nodes] of Object.entries(extra)) if (kind !== '$') application[kind] = [...(application[kind] ?? []), ...nodes];
    }
    // The merger's work: the package, the version, and names relative to the namespace made whole.
    Object.assign(root.$, { package: pkg, 'android:versionCode': type === 'release' ? String(app.android.versionCode) : '1',
        'android:versionName': type === 'release' ? app.version : 'native-dev' });
    for (const nodes of Object.values(application)) {
        for (const node of Array.isArray(nodes) ? nodes : []) {
            for (const key of ['android:name', 'android:targetActivity']) if (node.$?.[key]?.startsWith('.')) node.$[key] = NAMESPACE + node.$[key];
        }
    }
    return {
        manifest: new Builder().buildObject({ manifest: root }),
        shortcuts: buildShortcuts(scheme, pkg).xml,
        buildConfig: `  public static final boolean RN_STORAGE = ${rn};\n  public static final String URL_SCHEME = "${scheme}";\n`
            + `  public static final String ANALYTICS_HEARTBEAT_URL = "${type === 'release' ? HEARTBEAT : ''}";\n`,
    };
}
const problems = (type, files) => identityProblems(type, files.manifest, files.shortcuts, files.buildConfig);

test('every build type\'s identity passes', async () => {
    for (const type of Object.keys(TYPES)) assert.deepEqual([type, await problems(type, await variant(type))], [type, []]);
});

test('a debug or benchmark build with the production package or scheme is caught', async () => {
    const production = { ...TYPES.debug, pkg: app.android.package };
    assert.notDeepEqual(await problems('debug', await variant('debug', production)), []);
    assert.notDeepEqual(await problems('benchmarkSeed', await variant('benchmarkSeed', { ...BENCH, scheme: 'mindwtr' })), []);
    assert.notDeepEqual(await problems('debug', await variant('debug', { ...TYPES.debug, rn: true })), []);
});

test('a heartbeat outside a release is caught', async () => {
    for (const type of ['debug', 'upgradetest', 'benchmarkTrace']) {
        const files = await variant(type);
        files.buildConfig = files.buildConfig.replace('ANALYTICS_HEARTBEAT_URL = ""', `ANALYTICS_HEARTBEAT_URL = "${HEARTBEAT}"`);
        assert.notDeepEqual(await problems(type, files), [], type);
    }
});

test('a launcher alias with no activity behind it, or without the build\'s link scheme, is caught', async () => {
    const files = await variant('release');
    const broken = files.manifest.replace(`android:targetActivity="${NAMESPACE}.MainActivity"`, `android:targetActivity="${NAMESPACE}.Missing"`);
    assert.notEqual(broken, files.manifest);
    assert.notDeepEqual(await problems('release', { ...files, manifest: broken }), []);
    const root = (await parseStringPromise(files.manifest)).manifest;
    const view = root.application[0]['activity-alias'][0]['intent-filter'].find((filter) => filter.action[0].$['android:name'] === 'android.intent.action.VIEW');
    view.data[0].$['android:scheme'] = 'mindwtr-native-dev';
    assert.notDeepEqual(await problems('release', { ...files, manifest: new Builder().buildObject({ manifest: root }) }), []);
});

test('widget providers that are not exported, or lack their filter or provider XML, are caught', async () => {
    const files = await variant('release');
    const root = (await parseStringPromise(files.manifest)).manifest;
    const providers = root.application[0].receiver.filter((receiver) => receiver['meta-data']?.some((meta) => meta.$['android:name'] === 'android.appwidget.provider'));
    assert.equal(providers.length, 4);
    for (const breakIt of [(p) => { p.$['android:exported'] = 'false'; }, (p) => { delete p['intent-filter']; }, (p) => { delete p['meta-data']; }]) {
        const copy = structuredClone(root);
        breakIt(copy.application[0].receiver.find((receiver) => receiver.$['android:name'] === providers[0].$['android:name']));
        assert.notDeepEqual(await problems('release', { ...files, manifest: new Builder().buildObject({ manifest: copy }) }), []);
    }
});

test('missing or changed shortcuts are caught', async () => {
    const files = await variant('release');
    assert.notDeepEqual(await problems('release', { ...files, shortcuts: '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android"/>' }), []);
    assert.notDeepEqual(await problems('release', { ...files, shortcuts: files.shortcuts.replace('android:shortcutId="focus"', 'android:shortcutId="today"') }), []);
});
