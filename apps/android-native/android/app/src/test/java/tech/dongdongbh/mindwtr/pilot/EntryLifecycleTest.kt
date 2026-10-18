package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * EntryRouter's decisions (EntryLifecycle.kt), driven as the router drives them: which entry core reads, when a failed read
 * is tried again, and when an entry leaves the queue. The clock is the test's.
 */
class EntryLifecycleTest {
    @get:Rule val folder = TemporaryFolder()

    private var clock = 1_000L
    private val dir get() = File(folder.root, "entries")
    /** A new process: a new queue and lifecycle over the same folder. */
    private fun process() = EntryQueue(dir).let { queue -> queue to EntryLifecycle(queue) { clock } }

    @Test fun anEntryLeavesOnlyAfterItsScreenOpened() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        // Core answered, but the screen waits for the running action: the entry stays, and is not read twice.
        assertEquals(listOf(read), queue.all())
        assertNull(lifecycle.next(blocked = false))
        lifecycle.opened(read)
        assertTrue(queue.all().isEmpty())
    }

    @Test fun aFailureOfAnotherEntryNeverFreesTheEntryBeingRead() {
        // A file share staged in the background fails while the head entry is being read: the head is not read twice.
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        queue.add("""{"kind":"files"}""")
        val read = lifecycle.next(blocked = false)!!
        lifecycle.failed(queue.all()[1], "Staging failed")
        clock += 120_000
        assertNull(lifecycle.next(blocked = false))
        lifecycle.opened(read)
        assertEquals("""{"kind":"files"}""", lifecycle.next(blocked = false)?.input)
    }

    @Test fun workOpenedBeforeTheScreenKeepsTheEntryForALaterRead() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        lifecycle.deferred(read)
        assertNull(lifecycle.next(blocked = true))
        assertEquals(read, lifecycle.next(blocked = false))
    }

    @Test fun aFailedReadKeepsTheEntryAndTriesAgainAfterAGrowingWait() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        assertEquals(EntryLifecycle.Failure.Retry(5_000), lifecycle.failed(read, "NOT_READY: storage"))
        assertEquals(listOf(read), queue.all())
        clock += 4_999
        assertNull(lifecycle.next(blocked = false))
        clock += 1
        val again = lifecycle.next(blocked = false)!!
        assertEquals(EntryLifecycle.Failure.Retry(10_000), lifecycle.failed(again, "Core menuRead timed out"))
        clock += 10_000
        val third = lifecycle.next(blocked = false)!!
        // Waits double up to a minute; an entry that opens resets them.
        repeat(5) { lifecycle.failed(third, "SAVE_FAILED: disk"); clock += 60_000; lifecycle.next(blocked = false) }
        assertEquals(EntryLifecycle.Failure.Retry(60_000), lifecycle.failed(third, "SAVE_FAILED: disk"))
        clock += 60_000
        lifecycle.opened(lifecycle.next(blocked = false)!!)
        queue.add("""{"n":2}""")
        assertEquals(EntryLifecycle.Failure.Retry(5_000), lifecycle.failed(lifecycle.next(blocked = false)!!, "NOT_READY"))
    }

    @Test fun aRefusedEntryLeavesOnlyAfterItsNoticeShowed() {
        val (queue, lifecycle) = process()
        queue.add("""{"kind":"link"}""")
        queue.add("""{"n":2}""")
        val read = lifecycle.next(blocked = false)!!
        // Core refused the input: its words (without the code) are the notice, and the entry waits until it showed.
        assertEquals(EntryLifecycle.Failure.Refused("A link needs its URL and the app's scheme"),
            lifecycle.failed(read, "INVALID_INPUT: A link needs its URL and the app's scheme"))
        assertEquals(2, queue.all().size)
        assertNull(lifecycle.next(blocked = false))
        lifecycle.dismissed(read)
        assertEquals("""{"n":2}""", lifecycle.next(blocked = false)!!.input)
    }

    @Test fun severalQueuedEntriesOpenInOrderAcrossARestart() {
        val (queue, lifecycle) = process()
        for (n in 1..3) queue.add("""{"n":$n}""")
        val first = lifecycle.next(blocked = false)!!
        assertEquals("""{"n":1}""", first.input)
        // The process dies after core answered, before the screen opened: the new process reads the same entry again.
        val (restartedQueue, restarted) = process()
        assertEquals(first, restarted.next(blocked = false))
        restarted.opened(first)
        val second = restarted.next(blocked = false)!!
        assertEquals("""{"n":2}""", second.input)
        restarted.opened(second)
        assertEquals(listOf("""{"n":3}"""), restartedQueue.all().map { it.input })
    }
}
