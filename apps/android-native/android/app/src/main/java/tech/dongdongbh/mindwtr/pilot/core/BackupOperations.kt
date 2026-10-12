package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * A restore, merge or import's files between core's prepare and its journaled commit (design D1 §4), under the app's no-backup
 * `backup-operations` folder:
 *
 * - `<uuid>/plan.json`: core's frozen plan, then `<uuid>/manifest.json`: the uuid, the operation's mode, the plan's SHA-256 and
 *   size, and the recovery snapshot's name (with its SHA-256 and size when this operation wrote it). Each is written to a
 *   pending file, synced and renamed, then the folder is synced. The journal entry (`backupDocumentCommit`) holds only the
 *   reference: the uuid and the manifest's SHA-256 and size.
 * - `result.json`: the last operation's outcome and its Undo snapshot, written before any of its inputs go, so a death after the
 *   commit still shows its result once.
 *
 * [plan] checks every identity before a plan is sent: the manifest matches the reference, the plan matches the manifest, the
 * uuid is the folder's, the snapshot name is the journal's, and the snapshot this operation wrote is on disk unchanged. A
 * mismatch throws [Mismatch]; the caller sets the entry aside and never sends it.
 */
class BackupOperations(
    private val root: File,
    private val snapshots: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,
    /** The largest plan read back (the measured transfer limit's plan share). */
    private val maxPlanBytes: Long = Long.MAX_VALUE,
) {
    class Mismatch(message: String) : IllegalStateException(message)
    /** A plan over the limit [plan] reads back: refused before anything is written, so no journal entry is ever set aside for its size. */
    class PlanTooLarge : java.io.IOException("The prepared plan exceeds the transfer limit")

    companion object {
        const val METHOD = "backupDocumentCommit"
        private const val PLAN = "plan.json"
        private const val MANIFEST = "manifest.json"
        private const val RESULT = "result.json"
        private const val PENDING = ".pending"
        private const val MAX_MANIFEST_BYTES = 8192
        private const val MAX_RESULT_BYTES = 128 * 1024
        private val UUID = Regex("^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")

        /** One result record writer or clearer at a time in the process, whichever instance it goes through. */
        private val RESULT_LOCK = Any()
        /** A test seam: runs inside [clearResult] between its check and its delete. */
        @Volatile internal var clearPause: () -> Unit = {}

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    /**
     * The plan and manifest for operation [id] in [mode], on disk and synced; the journal's reference JSON. [snapshotName] is the
     * snapshot the plan's reply names; [recovery] is the text this operation wrote there (null: it wrote none). The file must
     * still hold exactly that text, or nothing is published ([Mismatch]); its hash is then checked before every send.
     */
    fun publish(id: String, mode: String, planJson: String, snapshotName: String, recovery: String?, beforeManifest: () -> Unit = {}): String {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        val plan = planJson.toByteArray()
        // An import can grow far past its file (100 000 short rows): a plan [plan] would refuse at its identity check is refused here.
        if (plan.size > maxPlanBytes) throw PlanTooLarge()
        val dir = File(root, id)
        dir.mkdirs()
        writeSynced(dir, PLAN, plan)
        beforeManifest()
        val manifest = JSONObject().put("version", 1).put("id", id).put("mode", mode)
            .put("planSha256", sha256(plan)).put("planBytes", plan.size.toLong()).put("snapshotName", snapshotName)
        if (recovery != null) {
            val snapshot = File(snapshots, snapshotName).takeIf { it.isFile }?.readBytes()
            if (snapshot == null || !snapshot.contentEquals(recovery.toByteArray())) throw Mismatch("The recovery snapshot is missing or changed")
            manifest.put("snapshotSha256", sha256(snapshot)).put("snapshotBytes", snapshot.size.toLong())
        }
        val manifestBytes = manifest.toString().toByteArray()
        check(manifestBytes.size <= MAX_MANIFEST_BYTES) { "Backup manifest too large" }
        writeSynced(dir, MANIFEST, manifestBytes)
        syncDirectory(root)
        return JSONObject().put("id", id).put("sha256", sha256(manifestBytes)).put("byteCount", manifestBytes.size).toString()
    }

    /** Operation [referenceJson]'s plan text, after every identity check; throws [Mismatch] otherwise. */
    fun plan(referenceJson: String, snapshotName: String): String {
        val manifest = manifest(referenceJson)
        if (manifest.getString("snapshotName") != snapshotName) throw Mismatch("The journal names another snapshot")
        val planFile = File(File(root, manifest.getString("id")), PLAN)
        val size = planFile.length()
        if (!planFile.isFile || size != manifest.getLong("planBytes")) throw Mismatch("The backup plan is missing or changed")
        if (size > maxPlanBytes) throw Mismatch("The backup plan exceeds the transfer limit")
        val plan = planFile.readBytes()
        if (sha256(plan) != manifest.getString("planSha256")) throw Mismatch("The backup plan changed")
        if (manifest.has("snapshotSha256")) {
            val snapshot = File(snapshots, snapshotName)
            if (!snapshot.isFile || snapshot.length() != manifest.getLong("snapshotBytes") || sha256(snapshot.readBytes()) != manifest.getString("snapshotSha256")) {
                throw Mismatch("The recovery snapshot is missing or changed")
            }
        }
        return String(plan, Charsets.UTF_8)
    }

    /** The operation's mode from its manifest (for the result record when its plan cannot be sent); null when unreadable. */
    fun mode(referenceJson: String): String? = runCatching { manifest(referenceJson).getString("mode") }.getOrNull()

    private fun manifest(referenceJson: String): JSONObject {
        val reference = runCatching { JSONObject(referenceJson) }.getOrNull() ?: throw Mismatch("Invalid backup reference")
        val id = reference.optString("id")
        if (!UUID.matches(id)) throw Mismatch("Invalid backup reference")
        val file = File(File(root, id), MANIFEST)
        if (!file.isFile || file.length() > MAX_MANIFEST_BYTES) throw Mismatch("The backup manifest is missing")
        val bytes = file.readBytes()
        if (bytes.size != reference.optInt("byteCount", -1) || sha256(bytes) != reference.optString("sha256")) throw Mismatch("The backup manifest changed")
        val manifest = JSONObject(String(bytes, Charsets.UTF_8))
        if (manifest.optInt("version") != 1 || manifest.optString("id") != id) throw Mismatch("The backup manifest names another operation")
        return manifest
    }

    /** Operation [id]'s folder is gone (after its journal entry left); true once it is. */
    fun discard(id: String): Boolean {
        val dir = File(root, id)
        if (!UUID.matches(id) || !dir.exists()) return true
        dir.listFiles().orEmpty().forEach { it.delete() }
        val gone = dir.delete() || !dir.exists()
        if (gone) runCatching { syncDirectory(root) }
        return gone
    }

    /** At start, before boot: every operation folder no journal entry names goes (its commit was never sent, or it settled). */
    fun cleanup(retaining: Set<String>) {
        root.listFiles().orEmpty().filter { it.isDirectory && it.name !in retaining }.forEach { discard(it.name) }
        root.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(PENDING) }.forEach { it.delete() }
    }

    /** The snapshot names no prune may remove: each open operation's, and the result record's Undo snapshot. */
    fun protectedNames(): Set<String> {
        val names = HashSet<String>()
        root.listFiles().orEmpty().filter { it.isDirectory }.forEach { dir ->
            runCatching { JSONObject(File(dir, MANIFEST).readText()).getString("snapshotName") }.getOrNull()?.let(names::add)
        }
        result()?.optString("undoSnapshot")?.takeIf { it.isNotEmpty() }?.let(names::add)
        return names
    }

    /** The result record (`{ requestId, operation, outcome, reply, undoSnapshot }`), replacing the last one; synced. */
    fun writeResult(record: JSONObject): Unit = synchronized(RESULT_LOCK) {
        root.mkdirs()
        val bytes = record.toString().toByteArray()
        check(bytes.size <= MAX_RESULT_BYTES) { "Backup result too large" }
        writeSynced(root, RESULT, bytes)
        syncDirectory(root)
    }

    /** The result record left on disk, or null. */
    fun result(): JSONObject? = File(root, RESULT).takeIf { it.isFile && it.length() <= MAX_RESULT_BYTES }
        ?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }

    /** The result of [requestId] was shown: its record goes (a newer operation's record stays, even one written meanwhile). */
    fun clearResult(requestId: String) {
        synchronized(RESULT_LOCK) {
            if (result()?.optString("requestId") != requestId) return
            clearPause()
            File(root, RESULT).delete()
            runCatching { syncDirectory(root) }
        }
    }

    private fun writeSynced(dir: File, name: String, bytes: ByteArray) {
        val pending = File(dir, name + PENDING)
        try {
            FileOutputStream(pending).use { out -> out.write(bytes); out.fd.sync() }
            check(pending.renameTo(File(dir, name))) { "Cannot save $name" }
        } catch (failure: Throwable) {
            pending.delete()
            throw failure
        }
        syncDirectory(dir)
    }
}
