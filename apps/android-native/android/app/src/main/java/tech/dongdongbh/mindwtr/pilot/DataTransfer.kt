package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.SavedStateHandle
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.BackupOperations
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.RecoverySnapshots
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import tech.dongdongbh.mindwtr.pilot.core.syncDirectory
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.Date
import java.util.UUID

/*
 * Settings › Data's Backup and Import folds and Sync › Recovery snapshots (RN's use-sync-settings-backup-actions.ts and
 * lib/data-transfer.ts) on core's native backup document (native-backup-document.ts): export a JSON, CSV or TaskNotes file,
 * Restore backup, Merge backup, the five imports (Todoist, TickTick, DGT GTD, OmniFocus, Mindwtr CSV), Getting Started, and a
 * snapshot restore (a Recovery snapshots row, or a result's Undo). Kotlin keeps RN's screen state (which action runs, the
 * open question) and the platform's files: the system pickers, the staged copy, the recovery snapshot, the operation's plan
 * (BackupOperations) and the export's folder document. Every word, check and data change is core's. Design: pass D1 design.md; imports and Getting Started: pass D1b design.md.
 */

/** The measured transfer limit (design §4.1): a picked file and the library together, before anything is decoded or parsed. */
object DataTransferLimits {
    // Measured on the S23 (pass D1a, result.md measure2; heap growth limit 256 MiB): a 12 MiB file restored over a 12 MiB
    // library (24 MiB in all) peaked at 128 MiB Java heap, half the growth limit, and the limit is half of that.
    // ponytail: one fixed limit; a device with a smaller heap gets the same number. Stream the plan through a file if libraries outgrow it.
    internal const val LIMIT_BYTES = 12L * 1024 * 1024
    /** Core's MAX_BACKUP_SOURCE_BYTES: a picked JSON backup alone. */
    const val MAX_BACKUP_SOURCE_BYTES = 128L * 1024 * 1024

    /** The limit; debug builds only: `debug.mindwtr.native.transfer_limit_mb` raises it for the measurement run. */
    val MAX_DATA_TRANSFER_BYTES: Long get() = debugProperty("transfer_limit_mb").toLongOrNull()?.takeIf { it > 0 }?.let { it * 1024 * 1024 } ?: LIMIT_BYTES

    /** A frozen plan holds the library twice (the current document and the result), plus its reply. */
    val MAX_PLAN_BYTES: Long get() = 2 * MAX_DATA_TRANSFER_BYTES + 1024 * 1024
}

/** Settings › Data's own Menu commands (check-boot-gates.mjs: each is one host command): Getting Started's seed. */
internal val DATA_COMMANDS = setOf("gettingStarted")

/** RN's MIME type for a picked backup (pickBackupDocument). */
private const val BACKUP_MIME = "application/json"

class DataTransferModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val app get() = shell.getApplication<Application>()
    private val resolver: ContentResolver get() = app.contentResolver
    private val snapshots get() = File(app.filesDir, "snapshots")
    private val staging get() = File(app.noBackupFilesDir, "backup-import")
    private val exportPending get() = File(app.noBackupFilesDir, "export-pending.json")
    private fun deleteDocument(uri: String): Boolean = try {
        DocumentsContract.deleteDocument(resolver, Uri.parse(uri))
    } catch (_: java.io.FileNotFoundException) { true }
    /** Whether the folder still has [uri]'s document; null when the provider cannot say. */
    private fun documentExists(uri: String): Boolean? = try {
        resolver.query(Uri.parse(uri), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() }
    } catch (_: java.io.FileNotFoundException) { false } catch (_: Exception) { null }
    val operations get() = BackupOperations(File(app.noBackupFilesDir, "backup-operations"), snapshots, maxPlanBytes = DataTransferLimits.MAX_PLAN_BYTES)

    /**
     * RN's backupAction: the running action ("export", "export:csv", "export:tasknotes", "restore", "merge", "import:<importer>",
     * "snapshot:<name>"), or "gettingStarted" (RN's own busy flag for that row; every Data row is off while it runs).
     */
    var action by mutableStateOf<String?>(null); private set
    /** The open question (RN's Alert): `{ kind: "confirm", model, mode, stage }` or `{ kind: "snapshot", model, name, undo }`. */
    var question by mutableStateOf<JSONObject?>(null); private set
    /** A system picker the Data screen opens next ("json", "tree"); the screen launches it and clears it. */
    var launch by mutableStateOf<String?>(null); private set
    /** The document picker's types: RN's backup type, or the importer's list from core's Data model. */
    var pickTypes: Array<String> = arrayOf(BACKUP_MIME); private set
    /** A made export file waiting for the Data screen to open the share sheet. */
    var share by mutableStateOf<Pair<File, String>?>(null); private set
    /** The export made at press time (RN reads its snapshot before the folder picker), held for the picker's answer. */
    private var exportFile: JSONObject? = null

    val busy get() = action != null

    fun launched() { launch = null }

    private fun view() = menu.settings.page?.takeIf { it.screen == "data" }?.view
    private fun words() = view()?.optJSONObject("backup")
    /** Core's Import fold row for [key] (its mode and picker types). */
    private fun importRow(key: String): JSONObject? = view()?.optJSONObject("importData")?.optJSONArray("rows")?.let { rows ->
        (0 until rows.length()).map(rows::getJSONObject).firstOrNull { it.getString("key") == key }
    }

    // ---- Export ----

    /**
     * Export backup, Export CSV, Export TaskNotes (RN's exportCurrentDataBackup): core's file from the snapshot at press time,
     * then the folder picker (RN's requestDirectoryPermissionsAsync); a folder writes the file there, no folder shares it.
     */
    fun export(format: String) {
        if (busy) return
        val words = words() ?: return
        val failed = words.getString(when (format) { "csv" -> "csvFailed"; "tasknotes" -> "tasknotesFailed"; else -> "failed" })
        val running = if (format == "json") "export" else "export:$format"
        action = running
        val read = when (format) { "csv" -> "dataCsvExport"; "tasknotes" -> "dataTaskNotesExport"; else -> "dataBackup" }
        shell.anyTime({ runtime ->
            val file = runtime.menuRead(read, JSONObject().put("maxBytes", DataTransferLimits.MAX_DATA_TRANSFER_BYTES).toString()).put("format", format)
            shell.ui {
                exportFile = file
                launch = "tree"
            }
        }) { failure ->
            Log.w(CoreHost.TAG, "Export failed ${failureForLog(failure)}")
            action = null
            shell.showToast(words.getString("errorTitle"), failed, "error", durationMs = 4_200)
        }
    }

    /** The folder picker's answer: write into [tree], or (none chosen, or the write failed) RN's share fallback. */
    fun folderPicked(tree: Uri?) {
        val file = exportFile ?: run { action = null; return }
        exportFile = null
        val words = words()
        shell.anyTime({ runtime ->
            val name = file.getString("fileName")
            val bytes = if (file.getString("encoding") == "base64") Base64.getDecoder().decode(file.getString("content")) else file.getString("content").toByteArray()
            val mime = when (file.getString("format")) { "csv" -> "text/csv"; "tasknotes" -> "application/zip"; else -> "application/json" }
            val written = tree?.let { runCatching { writeToFolder(it, name, mime, bytes) }.onFailure { Log.w(CoreHost.TAG, "Export folder write failed ${failureForLog(it)}") }.isSuccess } ?: false
            if (written) {
                runtime.logLine("Native Android backup file written releaseCheck=v1.3.5/android-backup-export", JSONObject().put("releaseCheck", "v1.3.5/android-backup-export")
                    .put("format", file.getString("format")).put("route", "saf"))
                shell.ui { action = null }
            } else {
                val dir = File(app.cacheDir, "exports").apply { mkdirs() }
                dir.listFiles().orEmpty().forEach { it.delete() }
                val out = File(dir, name)
                FileOutputStream(out).use { it.write(bytes) }
                shell.ui { share = out to mime }
            }
        }) { failure ->
            Log.w(CoreHost.TAG, "Export failed ${failureForLog(failure)}")
            action = null
            words?.let { shell.showToast(it.getString("errorTitle"), it.getString("failed"), "error", durationMs = 4_200) }
        }
    }

    /**
     * RN's StorageAccessFramework.createFileAsync and writeAsStringAsync: the grant kept (as Expo takes it), the document created
     * in the folder, its URI on disk before the first byte, and deleted when the write fails. The record goes once it is closed.
     */
    private fun writeToFolder(tree: Uri, name: String, mime: String, bytes: ByteArray) {
        runCatching { resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        writeExportDocument(exportPending,
            create = { (DocumentsContract.createDocument(resolver, parent, mime, name) ?: throw IOException("The folder refused the new file")).toString() },
            write = { uri ->
                if (debugProperty("backup_stop") == "mid-export") {
                    resolver.openOutputStream(Uri.parse(uri), "w")?.use { it.write(bytes, 0, bytes.size / 2) }
                    Log.i(CoreHost.TAG, "Native Android backup stop at=mid-export")
                    android.os.Process.killProcess(android.os.Process.myPid())
                }
                (resolver.openOutputStream(Uri.parse(uri), "w") ?: throw IOException("The new file cannot be opened")).use { it.write(bytes) }
            },
            delete = ::deleteDocument, exists = ::documentExists)
    }

    /** RN's share fallback (expo-sharing): a chooser over ACTION_SEND with the file's FileProvider link and its read grant. */
    fun openShare(activity: Activity) {
        val (file, mime) = share ?: return
        share = null
        action = null
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.diagnostics", file)
            val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(null, uri)
            activity.startActivity(Intent.createChooser(send, "Export Mindwtr Backup"))
            shell.coreHost()?.let { runtime -> Thread { runtime.logLine("Native Android backup file written releaseCheck=v1.3.5/android-backup-export", JSONObject()
                .put("releaseCheck", "v1.3.5/android-backup-export").put("format", formatOf(file.name)).put("route", "share")) }.start() }
        } catch (failure: Exception) {
            Log.w(CoreHost.TAG, "Export share failed ${failureForLog(failure)}")
            words()?.let { shell.showToast(it.getString("errorTitle"), it.getString("failed"), "error", durationMs = 4_200) }
        }
    }

    private fun formatOf(name: String) = when { name.endsWith(".csv") -> "csv"; name.endsWith(".zip") -> "tasknotes"; else -> "json" }

    // ---- Restore backup, Merge backup ----

    /** Restore backup or Merge backup: RN's backup picker (application/json). */
    fun pickBackup(mode: String) {
        if (busy) return
        action = mode
        saved["dataPick"] = mode
        pickTypes = arrayOf(BACKUP_MIME)
        launch = "json"
    }

    /** An Import fold row (RN's handleImport…): the system picker with the importer's types from core's model. */
    fun pickImport(key: String) {
        if (busy) return
        val row = importRow(key) ?: return
        action = "import:$key"
        saved["dataPick"] = "import:$key"
        pickTypes = row.getJSONArray("mimeTypes").let { types -> Array(types.length()) { types.getString(it) } }
        launch = "json"
    }

    /**
     * The document picker's answer (Restore backup, Merge backup, or an import): the file staged, then core's preview (RN's
     * Alert) or RN's invalid-file warning. An import's file goes to core as base64 bytes, a backup's as strict UTF-8 text.
     */
    fun backupPicked(uri: Uri?) {
        val mode = saved.get<String>("dataPick")
        saved.remove<String>("dataPick")
        if (uri == null || mode == null) { action = null; return }
        action = mode
        val importMode = mode.removePrefix("import:").takeIf { mode.startsWith("import:") }?.let { importRow(it)?.getString("mode") }
        if (mode.startsWith("import:") && importMode == null) { action = null; return }
        // Core's operation for RN's failure title: Restore failed, Merge failed, or Import failed.
        val operation = importMode ?: if (mode == "merge") "merge" else "replace"
        whenHosted { runtime ->
            val stage = try { stage(uri) } catch (failure: Throwable) {
                Log.w(CoreHost.TAG, "Backup stage failed ${failureForLog(failure)}")
                fail(runtime, operation, failure)
                return@whenHosted
            }
            val kind = importMode ?: if (mode == "restore") "json-restore" else "json"
            val (text, preview) = try {
                previewStaged(stage.file, runtime.databaseBytes(), base64 = importMode != null) { runtime.backupInspect(it, stage.metadata.toString(), kind) }
            } catch (failure: Throwable) {
                Log.w(CoreHost.TAG, "Backup preview failed ${failureForLog(failure)}")
                fail(runtime, operation, failure)
                return@whenHosted
            }
            shell.ui {
                if (!preview.getBoolean("valid") || text == null) {
                    finish()
                    // RN's showSettingsWarning (4.2 s).
                    shell.showToast(preview.getString("errorTitle"), preview.getString("errorMessage"), "warning", durationMs = 4_200)
                } else {
                    question = JSONObject().put("kind", "confirm").put("model", preview).put("mode", mode)
                        .put("stage", stage.file.name).put("metadata", stage.metadata).apply { importMode?.let { put("importMode", it) } }
                }
            }
        }
    }

    /** The question's Cancel: nothing was written; the staged copy goes. */
    fun cancel() {
        question?.optString("stage")?.takeIf { it.isNotEmpty() }?.let { StagedCopies.release(File(staging, it)) }
        question = null
        finish()
    }

    /** The question's Restore or Merge: the operation runs (design §4.2). */
    fun confirm() {
        val open = question ?: return
        question = null
        when (open.getString("kind")) {
            "confirm" -> {
                val file = File(staging, open.getString("stage"))
                val importMode = open.optString("importMode").takeIf { it.isNotEmpty() }
                val mode = importMode ?: if (open.getString("mode") == "restore") "replace" else "merge"
                run(open.getString("mode"), mode, null, open.getJSONObject("metadata"), file.length(), staged = file) {
                    if (importMode != null) base64(file) else utf8(file)
                }
            }
            "snapshot" -> {
                val name = open.getString("name")
                action = "snapshot:$name"
                val file = File(snapshots, name)
                run("snapshot:$name", "restore", name, JSONObject().put("fileName", name).put("lastModified", 0).put("appVersion", BuildConfig.VERSION_NAME), file.length()) {
                    check(file.isFile) { "Snapshot file not found." }
                    if (file.length() > DataTransferLimits.MAX_BACKUP_SOURCE_BYTES) throw TransferTooLarge()
                    utf8(file)
                }
            }
        }
    }

    // ---- Recovery snapshots ----

    /** A Recovery snapshots row, or a result's Undo ([undo]): core's question first (RN's Alert). */
    fun askSnapshot(name: String, undo: Boolean) {
        if (busy) return
        whenHosted { runtime ->
            val model = runtime.backupSnapshotModel(name, if (undo) "undo" else "restore")
            shell.ui { question = JSONObject().put("kind", "snapshot").put("model", model).put("name", name).put("undo", undo) }
        }
    }

    // ---- The operation ----

    /**
     * Prepare, recovery snapshot, plan, journaled commit (design §4.2), then RN's result toast with Undo. [running] is RN's
     * backupAction; [snapshot] the snapshot a `restore` reads (null: a new one is named now). Debug builds only:
     * `debug.mindwtr.native.backup_stop` = `after-snapshot` or `mid-plan` ends the process at that step.
     */
    private fun run(running: String, mode: String, snapshot: String?, metadata: JSONObject, sourceBytes: Long, staged: File? = null, text: () -> String?) {
        action = running
        whenHosted { runtime ->
            val ops = operations
            val requestId = UUID.randomUUID().toString()
            try {
                val source = admittedText(sourceBytes, runtime.databaseBytes(), staged, text)
                val name = snapshot ?: RecoverySnapshots.nextName(snapshots, Date())
                // Core admits the source with the library's SQLite bytes again and freezes how far the library may grow while
                // its Undo still fits (D1b §0 fix 2).
                val prepared = runtime.backupPrepare(JSONObject().put("requestId", requestId).put("mode", mode).put("snapshotName", name)
                    .put("text", source).put("metadata", metadata)
                    .put("admission", JSONObject().put("sourceBytes", sourceBytes).put("maxTransferBytes", DataTransferLimits.MAX_DATA_TRANSFER_BYTES)).toString())
                val recovery = prepared.opt("recoveryJSON") as? String
                if (recovery != null) writeOperationSnapshot(snapshots, name, recovery)
                stop("after-snapshot")
                val reference = ops.publish(requestId, mode, prepared.getString("planJSON"), name, recovery) { stop("mid-plan") }
                val reply = runtime.backupCommit(reference, name)
                val result = runtime.backupResultModel(reply.toString())
                RecoverySnapshots.prune(snapshots, ops.protectedNames())
                shell.ui { finish(); showResult(result, if (mode == "restore") null else name) { ops.clearResult(requestId) } }
            } catch (failure: Throwable) {
                staged?.let(StagedCopies::release)
                Log.w(CoreHost.TAG, "Backup operation failed mode=$mode ${failureForLog(failure)}")
                fail(runtime, mode, failure)
            }
        }
    }

    /** RN's result toast (core's words and duration), with Undo; [shown] (the result record goes) runs once it shows (design §4.3). */
    private fun showResult(result: JSONObject, undo: String?, shown: () -> Unit) {
        val undoLabel = result.optString("undoLabel").takeIf { it.isNotEmpty() && undo != null }
        shell.showToast(result.getString("title"), result.getString("message"), "success", undoLabel,
            if (result.isNull("durationMs")) null else result.getLong("durationMs")) { undo?.let { askSnapshot(it, undo = true) } }
        Thread { runCatching(shown) }.start()
    }

    /**
     * After a start: a result record left by a death after its commit shows its toast once (design §4.3); one that did not commit
     * (stale, refused, its files unreadable) shows RN's failure toast with core's reason before it goes. Staged copies no open
     * question owns go too.
     */
    fun leftover() = whenHosted { runtime ->
        runCatching { cleanupInterruptedExport(runtime) }.onFailure { Log.w(CoreHost.TAG, "Interrupted export cleanup failed ${failureForLog(it)}") }
        runCatching { StagedCopies.sweep(staging) }.onFailure { Log.w(CoreHost.TAG, "Staged copy sweep failed ${failureForLog(it)}") }
        takeLeftover(operations, snapshots, { runtime.backupResultModel(it) }) { leftover, shown ->
            when (leftover) {
                is Leftover.Result -> shell.ui { showResult(leftover.model, leftover.undo, shown) }
                is Leftover.Failure -> {
                    val model = failureModel(runtime, leftover.operation, leftover.error)
                    shell.ui {
                        shell.showToast(model.first, model.second, "error", durationMs = 5_200)
                        Thread { runCatching(shown) }.start()
                    }
                }
            }
        }
    }

    /** At start, before any export: a folder document whose write never finished is deleted (the persisted grant allows it). */
    private fun cleanupInterruptedExport(runtime: CoreHost) {
        val outcome = cleanupExportRecord(exportPending, ::deleteDocument, ::documentExists) ?: return
        runtime.logLine("Native Android interrupted export removed releaseCheck=v1.3.5/android-export-cleanup", JSONObject().put("releaseCheck", "v1.3.5/android-export-cleanup").put("outcome", outcome))
    }

    // ---- Files ----

    private class Stage(val file: File, val metadata: JSONObject)

    /** RN's picker copy (copyToCacheDirectory) as a private file: its bytes counted while copied, stopped past the limit. */
    private fun stage(uri: Uri): Stage {
        val (name, modified) = details(uri)
        val file = StagedCopies.create(staging)
        try {
            (resolver.openInputStream(uri) ?: throw IOException("The selected file cannot be read")).use { input -> copyBounded(input, file, stageLimit()) }
        } catch (failure: Throwable) {
            StagedCopies.release(file)
            throw failure
        }
        return Stage(file, JSONObject().put("fileName", name).put("lastModified", modified).put("appVersion", BuildConfig.VERSION_NAME))
    }

    /** expo-document-picker's DocumentDetailsReader: the display name, and COLUMN_LAST_MODIFIED when the provider has it. */
    private fun details(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "import"
        var modified = 0L
        runCatching {
            resolver.query(uri, null, null, null, null)?.use { row ->
                if (row.moveToFirst()) {
                    row.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !row.isNull(it) }?.let { name = row.getString(it) }
                    row.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !row.isNull(it) }?.let { modified = row.getLong(it) }
                }
            }
        }
        return name to modified
    }

    /**
     * RN's failure toast (showSettingsErrorToast, 5.2 s) for [operation] (core's mode) that did not land: core's title and words
     * (backupDocumentFailureModel: RN's formatThrownImportError or formatThrownBackupError, core's limit text for a size refusal).
     * On the calling worker; the toast shows on the main thread and the row's spinner stops.
     */
    private fun fail(runtime: CoreHost, operation: String, failure: Throwable) {
        val error = if (failure is TransferTooLarge || failure is BackupOperations.PlanTooLarge) "TOO_LARGE" else failure.message ?: ""
        val model = failureModel(runtime, operation, error)
        shell.ui { finish(); shell.showToast(model.first, model.second, "error", durationMs = 5_200) }
    }

    /** Core's failure toast for [operation] and [error]; a failure to build it shows the error's own words (never crashes). */
    private fun failureModel(runtime: CoreHost, operation: String, error: String): Pair<String, String> = runCatching {
        val model = runtime.backupFailureModel(operation, error, DataTransferLimits.MAX_DATA_TRANSFER_BYTES / (1024 * 1024))
        model.getString("title") to model.getString("message")
    }.getOrElse { (words()?.optString("restoreFailed") ?: "") to error.substringAfter(": ") }

    private fun stop(at: String) {
        if (debugProperty("backup_stop") != at) return
        Log.i(CoreHost.TAG, "Native Android backup stop at=$at")
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    private fun finish() { action = null }

    /** [work] on a worker once the validated boot finished (a picker's answer can arrive before it, after process death). */
    private fun whenHosted(work: (CoreHost) -> Unit) {
        val runtime = shell.coreHost() ?: run { shell.ui { whenHosted(work) }; return }
        Thread({ runCatching { work(runtime) }.onFailure { failure ->
            Log.w(CoreHost.TAG, "Data transfer failed ${failureForLog(failure)}")
            shell.ui { finish(); shell.showToast(words()?.optString("restoreFailed"), (failure.message ?: "").substringAfter(": "), "error", durationMs = 5_200) }
        } }, "mindwtr-data-transfer").start()
    }

    // ---- Getting Started ----

    /**
     * RN's Getting Started row (addGettingStartedContent): core's seed under a request UUID made now and the app language core's
     * model gave the row, both journaled with the write; core commits the seed's rows and its receipt together (D1b §6). RN's
     * toasts: ready with Open (the project), not created, or failed.
     */
    fun gettingStarted() {
        if (busy) return
        val row = words()?.optJSONObject("gettingStarted") ?: return
        action = "gettingStarted"
        val input = JSONObject().put("requestId", UUID.randomUUID().toString()).put("language", row.getString("language")).toString()
        whenHosted { runtime ->
            val projectId = try {
                runtime.menuCommand("gettingStarted", input).optString("projectId").takeIf { it.isNotEmpty() && it != "null" }
            } catch (failure: Exception) {
                Log.w(CoreHost.TAG, "Getting Started failed ${failureForLog(failure)}")
                shell.ui { finish(); shell.showToast(null, row.getString("failed"), "error") }
                return@whenHosted
            }
            shell.ui {
                finish()
                if (projectId == null) shell.showToast(null, row.getString("notCreated"), "info")
                else shell.showToast(null, row.getString("ready"), "success", row.getString("open")) { menu.openProjects(projectId) }
            }
        }
    }
}

/**
 * The folder documents whose write has not closed (RN's export-pending.json): `{ "pending": [{ uri, owner }…] }`, each with the
 * process that listed it. The list is replaced through a synced pending file and a rename; each change reads and writes under
 * one lock, so a start's cleanup and an export never drop each other's entries. The older one-document record `{ uri }` is read
 * too.
 */
private object ExportRecordLock

internal data class ExportEntry(val uri: String, val owner: String? = null) {
    fun json(): JSONObject = JSONObject().put("uri", uri).apply { owner?.let { put("owner", it) } }
}

/** This process's entries: a start's cleanup never touches an export still running in it. */
internal val EXPORT_OWNER: String = UUID.randomUUID().toString()

/** A test seam: runs in [cleanupExportRecord] after it read the list. */
@Volatile internal var exportCleanupPause: () -> Unit = {}

private fun exportEntries(record: File): List<ExportEntry> = runCatching {
    val parsed = JSONObject(record.readText())
    if (parsed.has("uri")) return@runCatching listOf(ExportEntry(uri = parsed.getString("uri")))
    val list = parsed.getJSONArray("pending")
    List(list.length()) { index ->
        when (val entry = list.get(index)) {
            is String -> ExportEntry(uri = entry)
            is JSONObject -> entry.optString("uri").ifEmpty { null }?.let { ExportEntry(it, entry.optString("owner").ifEmpty { null }) }
            else -> null
        }
    }.filterNotNull()
}.getOrDefault(emptyList())

/** [record]'s list after [change]; throws when it cannot be written (the caller then treats its write as failed). */
private fun updateExportRecord(record: File, change: (List<ExportEntry>) -> List<ExportEntry>) {
    synchronized(ExportRecordLock) {
        val next = change(if (record.isFile) exportEntries(record) else emptyList())
        val pending = File(record.parentFile, record.name + ".pending")
        FileOutputStream(pending).use { out ->
            out.write(JSONObject().put("pending", org.json.JSONArray(next.map { it.json() })).toString().toByteArray())
            out.fd.sync()
        }
        if (!pending.renameTo(record)) { pending.delete(); throw IOException("Cannot save the export record") }
    }
}

/** [uri]'s document is gone: deleted now, or confirmed absent. False when the provider refused or cannot say. */
private fun documentGone(uri: String, delete: (String) -> Boolean, exists: (String) -> Boolean?): Boolean =
    runCatching { delete(uri) }.getOrDefault(false) || runCatching { exists(uri) }.getOrNull() == false

/**
 * RN's folder write with its guards. The created document's URI is listed (synced) in [record] right after the folder made it,
 * before the first byte; a list that cannot take it fails the export and the document goes at once. A failed write deletes the
 * document (RN's 206366cce) before the failure goes on; a document whose URI cannot leave the list after its write is deleted
 * too and the export fails, so no later start deletes a backup this one reported as written. An entry leaves the list only once
 * its document is gone. A death between the create and the listing leaves one empty document nobody owns: cleanup never looks
 * a file up by name, so it never deletes another backup that shares it.
 */
internal fun writeExportDocument(record: File, create: () -> String, write: (String) -> Unit,
                                 delete: (String) -> Boolean, exists: (String) -> Boolean?, owner: String = EXPORT_OWNER) {
    val created = create()
    val listed = ExportEntry(uri = created, owner = owner)
    try {
        updateExportRecord(record) { it + listed }
        write(created)
        updateExportRecord(record) { it - listed }
    } catch (failure: Throwable) {
        if (documentGone(created, delete, exists)) runCatching { updateExportRecord(record) { it - listed } }
        throw failure
    }
}

/**
 * At start: each document an earlier process listed (a death mid-export) is deleted by its URI, and its entry leaves once it is
 * gone; one the provider refused stays for the next start. An empty list is left as it is: an export may list its document
 * meanwhile. "deleted", "kept" (some stay), or null (nothing listed).
 */
internal fun cleanupExportRecord(record: File, delete: (String) -> Boolean, exists: (String) -> Boolean?, owner: String = EXPORT_OWNER): String? {
    val listed = synchronized(ExportRecordLock) { if (record.isFile) exportEntries(record) else emptyList() }.filter { it.owner != owner }
    exportCleanupPause()
    if (listed.isEmpty()) return null
    var kept = 0
    for (entry in listed) {
        if (documentGone(entry.uri, delete, exists)) runCatching { updateExportRecord(record) { it - entry } }.onFailure { kept += 1 } else kept += 1
    }
    return if (kept > 0) "kept" else "deleted"
}

/** The transfer limit check (design §4.1): the picked file and the library together, before anything is decoded or parsed. */
internal fun admitTransfer(sourceBytes: Long, libraryBytes: Long) {
    if (sourceBytes + libraryBytes > DataTransferLimits.MAX_DATA_TRANSFER_BYTES) throw TransferTooLarge()
}

/**
 * A staged copy's text once admitted with the library ([admitTransfer] first: an oversized copy is never decoded): strict UTF-8
 * (null: not UTF-8), or an import's bytes as base64 ([base64]).
 */
internal fun readStaged(file: File, libraryBytes: Long, base64: Boolean = false): String? {
    admitTransfer(file.length(), libraryBytes)
    return if (base64) base64(file) else utf8(file)
}

/** An import's staged bytes for core's binary transport (native-backup-document.ts decodes and bounds them). */
internal fun base64(file: File): String = Base64.getEncoder().encodeToString(file.readBytes())

/** The staged copy's own bound: the transfer limit, and core's source limit for a JSON backup. */
internal fun stageLimit(): Long = minOf(DataTransferLimits.MAX_DATA_TRANSFER_BYTES, DataTransferLimits.MAX_BACKUP_SOURCE_BYTES)

/**
 * The picked files' private copies (`no_backup/backup-import`). A copy is live from its creation until its question closes or
 * its operation read it; a start sweeps every other file there, so a death after a pick (or mid-copy) leaves none behind.
 */
internal object StagedCopies {
    private val live = HashSet<String>()

    fun create(dir: File): File = synchronized(this) {
        dir.mkdirs()
        File(dir, UUID.randomUUID().toString()).also { live += it.name }
    }

    fun release(file: File): Unit = synchronized(this) {
        file.delete()
        live -= file.name
    }

    fun sweep(dir: File): Unit = synchronized(this) {
        dir.listFiles().orEmpty().filter { it.name !in live }.forEach { it.delete() }
    }
}

/** A start's leftover result: a committed one's toast model and Undo snapshot, or one that did not commit (core's operation and its error, for core's failure toast). */
internal sealed class Leftover {
    class Result(val model: JSONObject, val undo: String?) : Leftover()
    class Failure(val operation: String, val error: String) : Leftover()
}

/**
 * A start's result record, [present]ed first; it leaves the disk only once [present] calls back (its toast showed), so a death
 * in between shows it again. A committed record whose reply core cannot read goes at once (its data change is already in).
 */
internal fun takeLeftover(ops: BackupOperations, snapshots: File, resultModel: (String) -> JSONObject?, present: (Leftover, shown: () -> Unit) -> Unit) {
    val record = ops.result() ?: return
    val requestId = record.optString("requestId")
    val shown = { ops.clearResult(requestId) }
    val reply = record.optJSONObject("reply")
    if (record.optString("outcome") != "committed" || reply == null) {
        present(Leftover.Failure(record.optString("operation"), record.optString("error").ifEmpty { record.optString("outcome") }), shown)
        return
    }
    val model = runCatching { resultModel(reply.toString()) }.getOrNull() ?: return shown()
    present(Leftover.Result(model, record.optString("undoSnapshot").takeIf { it.isNotEmpty() && File(snapshots, it).isFile }), shown)
}

/** A backup operation's recovery snapshot, before its plan and its journaled commit: never pruned there, so an operation that never commits costs no older recovery point. */
internal fun writeOperationSnapshot(dir: File, name: String, recovery: String, syncDirectory: (File) -> Unit = ::syncDirectory): String =
    RecoverySnapshots.write(dir, name, recovery, exact = true, prune = false, syncDirectory = syncDirectory)

/**
 * A staged pick to its question: admitted with the library first (an oversized copy is never decoded), strict UTF-8, then core's
 * preview ([inspect]). The copy stays only for a valid preview; a refusal, an invalid file or a failure releases it.
 */
internal fun previewStaged(file: File, libraryBytes: Long, base64: Boolean = false, inspect: (String) -> JSONObject): Pair<String?, JSONObject> {
    try {
        val text = readStaged(file, libraryBytes, base64)
        val preview = inspect(text ?: "")
        if (!preview.optBoolean("valid") || text == null) StagedCopies.release(file)
        return text to preview
    } catch (failure: Throwable) {
        StagedCopies.release(file)
        throw failure
    }
}

/** An operation's source text: admitted with the library before [text] reads it; the staged copy goes once read or refused. */
internal fun admittedText(sourceBytes: Long, libraryBytes: Long, staged: File?, text: () -> String?): String {
    try {
        admitTransfer(sourceBytes, libraryBytes)
        return text() ?: throw IllegalStateException("INVALID_INPUT: Backup file is not valid UTF-8")
    } finally {
        staged?.let(StagedCopies::release)
    }
}

/** A picked file, or it with the library, over the measured transfer limit (design §4.1). */
internal class TransferTooLarge : IOException("The selected file is too large")

/** [input] into [file], synced; refuses once it passes [limit] bytes (the caller deletes [file]). */
internal fun copyBounded(input: InputStream, file: File, limit: Long) {
    var total = 0L
    FileOutputStream(file).use { out ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > limit) throw TransferTooLarge()
            out.write(buffer, 0, read)
        }
        out.fd.sync()
    }
}

/** [file]'s text as strict UTF-8 (iOS refuses invalid bytes too); null when it is not. */
internal fun utf8(file: File): String? = try {
    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(file.readBytes())).toString()
} catch (_: CharacterCodingException) { null }
