package tech.dongdongbh.mindwtr.pilot.core

import android.system.Os
import android.system.OsConstants
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * The core's storage port.
 *
 * The core builds every SQL statement through its own `SqliteAdapter`. This
 * class only runs them and turns rows into JSON. It knows no Mindwtr table or
 * column name.
 *
 * It uses androidx's **bundled** SQLite, not the one built into Android. This
 * phone's own SQLite has no FTS5, the full-text search engine the core's schema
 * creates, so creating the schema failed outright with it.
 */
class SqliteBridge(databaseFile: File) {

    private val checkpointFile = File(databaseFile.parentFile, "${databaseFile.name}.prewrite")

    private val connection: SQLiteConnection = BundledSQLiteDriver().open(databaseFile.absolutePath).apply {
        // A connection setting: it writes nothing to the file.
        prepare("PRAGMA foreign_keys = ON").use { it.step() }
    }

    /** Prepared statements are reused: re-preparing the same SQL is pure waste. */
    private val statements = HashMap<String, SQLiteStatement>()

    /**
     * Run before core schema setup or any task write. Never replace the first snapshot.
     * The journal settings come only after the snapshot exists: switching a
     * rollback-journal database to WAL rewrites its header.
     */
    fun ensureRecoveryCheckpoint() {
        checkIntegrity(connection)
        if (checkpointFile.exists()) {
            BundledSQLiteDriver().open(checkpointFile.absolutePath).use(::checkIntegrity)
            syncCheckpoint(checkpointFile)
        } else {
            val partial = File(checkpointFile.parentFile, "${checkpointFile.name}.building")
            if (partial.exists()) check(partial.delete()) { "Cannot remove incomplete recovery checkpoint" }
            try {
                val path = partial.absolutePath.replace("'", "''")
                exec("VACUUM INTO '$path'")
                BundledSQLiteDriver().open(partial.absolutePath).use(::checkIntegrity)
                syncFile(partial)
                check(partial.renameTo(checkpointFile)) { "Cannot promote recovery checkpoint" }
                syncDirectory(checkpointFile.parentFile!!)
            } catch (error: Throwable) {
                partial.delete()
                throw error
            }
        }
        // Write-ahead logging, the same journal mode the app uses. A committed
        // row can still live in the -wal file, so anything that inspects this
        // database must close it first or copy .db, -wal and -shm together.
        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA synchronous = FULL")
    }

    private fun syncCheckpoint(file: File) {
        syncFile(file)
        syncDirectory(file.parentFile!!)
    }

    private fun checkIntegrity(database: SQLiteConnection) {
        database.prepare("PRAGMA quick_check").use { statement ->
            check(statement.step() && statement.getText(0) == "ok" && !statement.step()) {
                "SQLite recovery integrity check failed"
            }
        }
    }

    private fun statementFor(sql: String): SQLiteStatement =
        statements.getOrPut(sql) { connection.prepare(sql) }.also {
            it.reset()
            it.clearBindings()
        }

    /** Debug-only fault: set solely by CoreHost's `BuildConfig.DEBUG`-gated hook. */
    @Volatile var failCommits = false

    /**
     * Debug-only fault (check-data-device.mjs E4c, `debug.mindwtr.native.commit_stop=<method>`): set by CoreHost's
     * `BuildConfig.DEBUG`-gated hook as that journaled write is sent (and cleared as any other is); the process dies right after
     * the next COMMIT, before core reloads or replies. A replay never sets it.
     */
    @Volatile var stopAfterCommit = false

    /**
     * Debug-only delay (check-data-device.mjs's deadline rows, pass D1c): `debug.mindwtr.native.sql_read_delay_ms`, set by
     * CoreHost's `BuildConfig.DEBUG`-gated hook and read again at each page, so a check can slow one operation's reads only;
     * each page of a full library read waits this long first.
     */
    @Volatile var readDelayMs: () -> Long = { 0L }

    fun run(sql: String, paramsJson: String) {
        // The core's adapter then runs ROLLBACK, as after a real commit failure.
        if (failCommits && sql == "COMMIT") throw IllegalStateException("Injected commit failure")
        val statement = statementFor(sql)
        bind(statement, JSONArray(paramsJson))
        // A statement that returns no rows still needs one step to execute.
        while (statement.step()) { /* drain: PRAGMA and RETURNING answer with rows */ }
        if (stopAfterCommit && sql == "COMMIT") {
            android.util.Log.i(CoreHost.TAG, "Native Android commit stop at=after-commit")
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    fun exec(sql: String) {
        connection.prepare(sql).use { statement -> while (statement.step()) { /* drain */ } }
    }

    fun all(sql: String, paramsJson: String): String {
        if (sql.startsWith("SELECT rowid as _rowid")) readDelayMs().takeIf { it > 0 }?.let(Thread::sleep)
        val statement = statementFor(sql)
        bind(statement, JSONArray(paramsJson))
        val rows = JSONArray()
        // Column names are read after the first row arrives. Asking a prepared
        // but un-stepped statement for them gave empty names here, and every row
        // then decoded into an object with no `id` — 5,000 rows read, 0 tasks in
        // the store, and no error anywhere.
        var columnCount = 0
        var names: Array<String> = emptyArray()
        while (statement.step()) {
            if (names.isEmpty()) {
                columnCount = statement.getColumnCount()
                names = Array(columnCount) { statement.getColumnName(it) }
            }
            val row = JSONObject()
            for (column in 0 until columnCount) {
                if (statement.isNull(column)) {
                    row.put(names[column], JSONObject.NULL)
                    continue
                }
                when (statement.getColumnType(column)) {
                    COLUMN_INTEGER -> row.put(names[column], statement.getLong(column))
                    COLUMN_FLOAT -> row.put(names[column], statement.getDouble(column))
                    COLUMN_BLOB -> row.put(names[column], JSONObject.NULL)
                    else -> row.put(names[column], statement.getText(column))
                }
            }
            rows.put(row)
        }
        return rows.toString()
    }

    private fun bind(statement: SQLiteStatement, params: JSONArray) {
        for (index in 0 until params.length()) {
            val position = index + 1
            when (val value = if (params.isNull(index)) null else params.get(index)) {
                null -> statement.bindNull(position)
                is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
                is Int -> statement.bindLong(position, value.toLong())
                is Long -> statement.bindLong(position, value)
                // JSON has one number type, so a whole number arrives as a
                // double. Store it as an integer or `rev` columns become floats.
                is Double ->
                    if (!value.isInfinite() && value == Math.floor(value)) statement.bindLong(position, value.toLong())
                    else statement.bindDouble(position, value)
                else -> statement.bindText(position, value.toString())
            }
        }
    }

    fun close() {
        statements.values.forEach { it.close() }
        statements.clear()
        connection.close()
    }

    private companion object {
        // androidx.sqlite.SQLITE_DATA_* constants, spelled out to avoid a
        // top-level-property import from Kotlin.
        const val COLUMN_INTEGER = 1
        const val COLUMN_FLOAT = 2
        const val COLUMN_BLOB = 4
    }
}

/** Also used for the RN state checkpoint (LegacyRnStoreGuard). */
internal fun syncFile(file: File) {
    RandomAccessFile(file, "r").use { it.fd.sync() }
}

internal fun syncDirectory(directory: File) {
    val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
}
