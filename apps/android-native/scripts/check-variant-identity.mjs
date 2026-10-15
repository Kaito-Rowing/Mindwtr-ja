// One native Android variant's identity (plan pass O3), as its merged manifest and its app shortcuts have it: the names that
// launchers, widget hosts, the Quick Settings panel and automations stored for RN's app (inventory section 6); for a release,
// RN's package, version, number and name (apps/mobile/app.json), so it installs over RN's store app in place; and which storage
// its BuildConfig opens (RN's files in a release and the upgrade harness build, the dev database elsewhere); and RN's backup rules,
// which back up and transfer nothing.
// Gradle's checkVariantIdentity runs it for each variant (app/build.gradle.kts); it prints every problem and fails on any.
// Usage: node check-variant-identity.mjs <build type> <merged AndroidManifest.xml> <mindwtr_shortcuts.xml> <BuildConfig.java>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { parseStringPromise } = require('xml2js');
const app = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../mobile/app.json'), 'utf8')).expo;
const rnManifest = require('../../mobile/plugins/android-manifest-fixes.js').__testables;
const resXml = (name) => readFileSync(resolve(import.meta.dirname, `../android/app/src/main/res/xml/${name}.xml`), 'utf8');

const attr = (node, name) => node?.$?.[`android:${name}`];
const named = (nodes, name) => (nodes ?? []).find((node) => attr(node, 'name') === name);

/** A BuildConfig.java field's value as its source spells it ("true", or a string literal's text). */
const field = (buildConfig, name) => {
    const match = new RegExp(`\\b${name} = ("(?:[^"\\\\]|\\\\.)*"|\\w+);`).exec(buildConfig);
    return match ? (match[1].startsWith('"') ? JSON.parse(match[1]) : match[1]) : undefined;
};

/** Every problem with one variant's identity: [type] its build type; [manifest], [shortcuts] and [buildConfig] the files' text. */
export async function identityProblems(type, manifest, shortcuts, buildConfig) {
    const problems = [];
    const expect = (what, actual, wanted) => { if (actual !== wanted) problems.push(`${what} is ${actual}, not ${wanted}`); };
    const root = (await parseStringPromise(manifest)).manifest;
    const application = root.application[0];
    const pkg = root.$.package;
    if (type === 'release') {
        expect('the package', pkg, app.android.package);
        expect('the versionCode', attr(root, 'versionCode'), String(app.android.versionCode));
        expect('the versionName', attr(root, 'versionName'), app.version);
        expect('the app label', attr(application, 'label'), app.name);
    }
    // RN's "back up nothing" rules (android-manifest-fixes.js), the same files.
    expect('allowBackup', attr(application, 'allowBackup'), 'true');
    expect('fullBackupContent', attr(application, 'fullBackupContent'), '@xml/mindwtr_backup_rules');
    expect('dataExtractionRules', attr(application, 'dataExtractionRules'), '@xml/mindwtr_data_extraction_rules');
    if (resXml('mindwtr_backup_rules') !== rnManifest.BACKUP_RULES_XML) problems.push('the backup rules are not RN\'s');
    if (resXml('mindwtr_data_extraction_rules') !== rnManifest.DATA_EXTRACTION_RULES_XML) problems.push('the data extraction rules are not RN\'s');
    // The launcher's, pinned shortcuts' and widgets' component (WidgetRenderer.appIntent): RN's MainActivity name.
    const alias = named(application['activity-alias'], `${pkg}.MainActivity`);
    if (!alias) problems.push(`no ${pkg}.MainActivity`);
    else {
        expect('the MainActivity alias exported', attr(alias, 'exported'), 'true');
        if (type === 'release') expect('the MainActivity alias label', attr(alias, 'label'), app.name);
        if (!(alias['intent-filter'] ?? []).some((filter) => named(filter.action, 'android.intent.action.MAIN') && named(filter.category, 'android.intent.category.LAUNCHER'))) {
            problems.push(`${pkg}.MainActivity is not the launcher entry`);
        }
    }
    const receivers = [
        'tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider',
        'tech.dongdongbh.mindwtr.androidwidget.CompactWidgetProvider',
        'tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWidgetProvider',
        `${pkg}.widget.TasksWidget`,
        'tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver',
        'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver',
    ];
    for (const name of receivers) if (!named(application.receiver, name)) problems.push(`no receiver ${name}`);
    if (!named(application.service, 'tech.dongdongbh.mindwtr.quicksettings.CaptureTileService')) problems.push('no Quick Settings tile service');
    expect('RN_STORAGE', field(buildConfig, 'RN_STORAGE'), String(type === 'release' || type === 'upgradetest'));
    // A shortcut's explicit intent opens this app's own component.
    for (const [, target] of shortcuts.matchAll(/android:targetPackage="([^"]*)"/g)) expect('a shortcut targetPackage', target, pkg);
    return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [type, ...paths] = process.argv.slice(2);
    if (paths.length !== 3) throw new Error('usage: check-variant-identity.mjs <build type> <merged manifest> <shortcuts xml> <BuildConfig.java>');
    const [manifestPath] = paths;
    const problems = await identityProblems(type, ...paths.map((path) => readFileSync(path, 'utf8')));
    for (const problem of problems) console.error(`${type}: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(`${type}: identity ok (${manifestPath})`);
}
