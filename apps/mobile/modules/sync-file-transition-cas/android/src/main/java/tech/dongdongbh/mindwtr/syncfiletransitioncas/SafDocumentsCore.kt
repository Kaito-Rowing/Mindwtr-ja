package tech.dongdongbh.mindwtr.syncfiletransitioncas

/**
 * File Sync's Storage Access Framework document calls, with no Android type in sight so the JVM tests drive them through a
 * fake provider. React Native's Expo module and the native Android app both call this one file.
 *
 * The rule every call keeps: a provider failure is an error, never an answer. androidx's TreeDocumentFile.listFiles returns
 * what it has (often nothing) when the children query throws, and DocumentFile.exists reads any error as "absent"; sync then
 * mistook an unreadable folder for an empty one.
 */
class SafDocumentsCore(private val provider: SafDocumentProvider) {
    /** The documents in folder [dirUri]. Empty only when the provider listed an empty folder. */
    fun listChildren(dirUri: String): List<SafDocumentRow> {
        val rows = try {
            provider.queryChildren(dirUri)
        } catch (error: SafDocumentUnavailableException) {
            throw error
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not list the folder", error)
        }
        return rows ?: throw SafDocumentUnavailableException("$UNAVAILABLE: the provider returned no folder listing")
    }

    /** [uri]'s row, or null when the provider answered an empty cursor: only a successful query proves absence. */
    fun stat(uri: String): SafDocumentRow? {
        val answer = try {
            provider.queryDocument(uri)
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not describe the document", error)
        }
        return when (answer) {
            is SafDocumentQuery.Found -> answer.row
            SafDocumentQuery.Missing -> null
            // DocumentsProvider.query answers no cursor both for a vanished document and for a query the provider failed,
            // and so does a provider that is not installed: no cursor proves nothing, so it is never "absent". Callers
            // that must know a document is gone confirm it by listing its folder.
            SafDocumentQuery.NoCursor -> throw SafDocumentUnavailableException(
                if (provider.isReachable(uri)) "$UNAVAILABLE: the provider gave no answer for the document"
                else "$UNAVAILABLE: the document provider is not available",
            )
        }
    }

    companion object {
        const val UNAVAILABLE = "SAF_DOCUMENT_UNAVAILABLE"
    }
}

/** One document as the provider describes it. [uri] is its tree document URI; [name] is its display name. */
data class SafDocumentRow(
    val uri: String,
    val name: String?,
    val mime: String?,
    val size: Long?,
    val flags: Long,
    val lastModified: Long?,
)

sealed class SafDocumentQuery {
    data class Found(val row: SafDocumentRow) : SafDocumentQuery()
    /** A cursor with no row. */
    object Missing : SafDocumentQuery()
    /** The provider answered no cursor at all. */
    object NoCursor : SafDocumentQuery()
}

/** The part of Android's ContentResolver and DocumentsContract that [SafDocumentsCore] reads through. */
interface SafDocumentProvider {
    /** The children of [dirUri] (a tree URI or a tree document URI); null when the provider answered no cursor. */
    fun queryChildren(dirUri: String): List<SafDocumentRow>?
    fun queryDocument(uri: String): SafDocumentQuery
    /** Whether [uri]'s authority names an installed provider this app can reach. */
    fun isReachable(uri: String): Boolean
}

class SafDocumentUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)
