package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Pass D1a's operation files (design §4.2-4.3): publish, the identity check before every send, cleanup, protection, the result record. */
class BackupOperationsTest {
    @get:Rule val folder = TemporaryFolder()
    private val snapshots get() = File(folder.root, "snapshots").apply { mkdirs() }
    private fun ops(maxPlanBytes: Long = Long.MAX_VALUE) = BackupOperations(File(folder.root, "ops"), snapshots, syncDirectory = {}, maxPlanBytes = maxPlanBytes)
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    private val name = "data.2026-08-09T12-34-05.123.snapshot.json"
    private val TASKS = "{\"tasks\":[]}"
    private fun snapshot(text: String = TASKS) = File(snapshots, name).apply { writeText(text) }

    private fun refused(work: () -> Unit) = runCatching(work).exceptionOrNull() is BackupOperations.Mismatch

    @Test fun aPublishedPlanReadsBackExactly() {
        snapshot()
        val ref = ops().publish(a, "merge", "{\"plan\":1}", name, recovery = TASKS)
        assertEquals("{\"plan\":1}", ops().plan(ref, name))
        assertEquals("merge", ops().mode(ref))
        assertTrue(JSONObject(ref).getInt("byteCount") <= 8192)
    }

    // D1b: an import's plan can grow far past its file; one over the read-back limit is refused before anything is written, so the
    // journal never gets an entry its identity check would set aside, and an import's mode publishes like a merge's.
    @Test fun aPlanOverTheLimitIsRefusedBeforeAnyFile() {
        snapshot()
        val failure = runCatching { ops(maxPlanBytes = 8).publish(a, "todoist", "{\"plan\":\"too long\"}", name, recovery = TASKS) }.exceptionOrNull()
        assertTrue(failure is BackupOperations.PlanTooLarge)
        assertFalse(File(folder.root, "ops/$a").exists())
        val ref = ops(maxPlanBytes = 64).publish(a, "todoist", "{\"plan\":1}", name, recovery = TASKS)
        assertEquals("todoist", ops().mode(ref))
    }

    @Test fun swappedManifestsOrPlansAreRefused() {
        snapshot()
        val refA = ops().publish(a, "merge", "{\"plan\":\"a\"}", name, recovery = TASKS)
        val refB = ops().publish(b, "merge", "{\"plan\":\"b\"}", name, recovery = TASKS)
        val root = File(folder.root, "ops")
        // B's plan under A: A's manifest no longer matches its plan.
        File(root, "$b/plan.json").copyTo(File(root, "$a/plan.json"), overwrite = true)
        assertTrue(refused { ops().plan(refA, name) })
        // B's manifest under A: A's reference no longer matches its manifest.
        File(root, "$b/manifest.json").copyTo(File(root, "$a/manifest.json"), overwrite = true)
        assertTrue(refused { ops().plan(refA, name) })
        assertEquals("{\"plan\":\"b\"}", ops().plan(refB, name))
        // Another snapshot name than the journal's.
        assertTrue(refused { ops().plan(refB, "data.2026-08-09T12-34-06.000.snapshot.json") })
    }

    @Test fun aMissingOrTornPlanAndAChangedSnapshotAreRefused() {
        snapshot()
        val ref = ops().publish(a, "replace", "{\"plan\":1}", name, recovery = TASKS)
        File(snapshots, name).writeText("{\"tasks\":[1]}")
        assertTrue(refused { ops().plan(ref, name) })
        snapshot()
        assertEquals("{\"plan\":1}", ops().plan(ref, name))
        File(folder.root, "ops/$a/plan.json").delete()
        assertTrue(refused { ops().plan(ref, name) })
        // A death mid-publish: the plan's pending file is there, the manifest never was.
        val torn = runCatching { ops().publish(b, "merge", "{\"plan\":2}", name, recovery = null) { error("killed") } }
        assertTrue(torn.isFailure)
        assertTrue(refused { ops().plan(JSONObject().put("id", b).put("sha256", "0".repeat(64)).put("byteCount", 10).toString(), name) })
    }

    @Test fun aRestoreReadsAnExistingSnapshotWithoutCheckingItsBytes() {
        val ref = ops().publish(a, "restore", "{\"plan\":1}", name, recovery = null)
        assertEquals("{\"plan\":1}", ops().plan(ref, name))
    }

    @Test fun aPlanPastTheLimitIsNeverRead() {
        val ref = ops().publish(a, "merge", "x".repeat(100), name, recovery = null)
        assertTrue(refused { ops(maxPlanBytes = 50).plan(ref, name) })
    }

    @Test fun cleanupKeepsOnlyTheJournalsOperations() {
        snapshot()
        ops().publish(a, "merge", "{}", name, recovery = TASKS)
        ops().publish(b, "merge", "{}", name, recovery = null)
        ops().cleanup(setOf(b))
        assertFalse(File(folder.root, "ops/$a").exists())
        assertTrue(File(folder.root, "ops/$b/manifest.json").isFile)
    }

    @Test fun openOperationsAndTheResultProtectTheirSnapshots() {
        ops().publish(a, "merge", "{}", name, recovery = null)
        val undo = "data.2026-08-09T12-34-06.000.snapshot.json"
        ops().writeResult(JSONObject().put("requestId", b).put("outcome", "committed").put("undoSnapshot", undo))
        assertEquals(setOf(name, undo), ops().protectedNames())
        ops().discard(a)
        assertEquals(setOf(undo), ops().protectedNames())
    }

    @Test fun theResultRecordGoesOnlyForItsOwnRequest() {
        ops().writeResult(JSONObject().put("requestId", a).put("outcome", "committed"))
        ops().clearResult(b)
        assertEquals(a, ops().result()!!.getString("requestId"))
        ops().clearResult(a)
        assertNull(ops().result())
    }

    // D1a review P1-1: another writer replaced the snapshot between this operation's write and its plan; nothing is published.
    @Test fun aSnapshotThatIsNotTheOperationsOwnTextIsNeverPublished() {
        snapshot("")
        assertTrue(refused { ops().publish(a, "merge", "{\"plan\":1}", name, recovery = TASKS) })
        assertFalse(File(folder.root, "ops/$a/manifest.json").exists())
        File(snapshots, name).delete()
        assertTrue(refused { ops().publish(b, "merge", "{\"plan\":1}", name, recovery = TASKS) })
    }

    // D1a review P2-6: A's clear checked its record, then B's operation wrote its own; A's delete must not take B's.
    @Test fun clearingOneResultNeverDeletesANewerOneWrittenMeanwhile() {
        ops().writeResult(JSONObject().put("requestId", a).put("outcome", "committed"))
        val checked = java.util.concurrent.CountDownLatch(1)
        val resume = java.util.concurrent.CountDownLatch(1)
        BackupOperations.clearPause = { checked.countDown(); resume.await(2, java.util.concurrent.TimeUnit.SECONDS) }
        try {
            val clearing = Thread { ops().clearResult(a) }.apply { start() }
            assertTrue(checked.await(2, java.util.concurrent.TimeUnit.SECONDS))
            val writing = Thread { ops().writeResult(JSONObject().put("requestId", b).put("outcome", "committed")) }.apply { start() }
            writing.join(300)
            resume.countDown()
            clearing.join(2_000)
            writing.join(2_000)
        } finally {
            BackupOperations.clearPause = {}
        }
        assertEquals(b, ops().result()?.getString("requestId"))
    }
}
