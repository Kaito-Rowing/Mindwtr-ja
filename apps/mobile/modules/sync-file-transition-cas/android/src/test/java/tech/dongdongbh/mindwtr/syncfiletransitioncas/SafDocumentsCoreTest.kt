package tech.dongdongbh.mindwtr.syncfiletransitioncas

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SafDocumentsCoreTest {
    private open class FakeProvider : SafDocumentProvider {
        var children: List<SafDocumentRow>? = emptyList()
        var childrenError: Throwable? = null
        var document: SafDocumentQuery = SafDocumentQuery.Missing
        var documentError: Throwable? = null
        var reachable = true

        override fun queryChildren(dirUri: String): List<SafDocumentRow>? {
            childrenError?.let { throw it }
            return children
        }

        override fun queryDocument(uri: String): SafDocumentQuery {
            documentError?.let { throw it }
            return document
        }

        override fun isReachable(uri: String) = reachable
    }

    private fun row(name: String) = SafDocumentRow("content://p/tree/t/document/$name", name, null, 3, 0, null)

    private fun assertUnavailable(block: () -> Unit) {
        try {
            block()
            fail("expected SafDocumentUnavailableException")
        } catch (error: SafDocumentUnavailableException) {
            assertTrue(error.message!!.startsWith(SafDocumentsCore.UNAVAILABLE))
        }
    }

    @Test
    fun listingReturnsWhatTheProviderListed() {
        val provider = FakeProvider().apply { children = listOf(row("data.json")) }
        assertEquals(listOf("data.json"), SafDocumentsCore(provider).listChildren("content://p/tree/t").map { it.name })
        provider.children = emptyList()
        assertTrue(SafDocumentsCore(provider).listChildren("content://p/tree/t").isEmpty())
    }

    @Test
    fun aListingWithNoCursorIsAnErrorNotAnEmptyFolder() {
        val provider = FakeProvider().apply { children = null }
        assertUnavailable { SafDocumentsCore(provider).listChildren("content://p/tree/t") }
    }

    @Test
    fun aListingTheProviderFailsIsAnErrorNotAnEmptyFolder() {
        val provider = FakeProvider().apply { childrenError = IllegalStateException("query failed") }
        assertUnavailable { SafDocumentsCore(provider).listChildren("content://p/tree/t") }
    }

    @Test
    fun statAnswersNullOnlyWhenTheProviderAnsweredAnEmptyCursor() {
        val provider = FakeProvider()
        assertNull(SafDocumentsCore(provider).stat("content://p/tree/t/document/x"))
    }

    @Test
    fun aLookupWithNoCursorIsAnErrorEvenFromAReachableProvider() {
        // No cursor proves nothing: DocumentsProvider.query answers null for a vanished document and for a provider that
        // failed the query alike, so only an empty cursor means "absent".
        val provider = FakeProvider().apply { document = SafDocumentQuery.NoCursor }
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
        provider.reachable = false
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
    }

    @Test
    fun statThrowsWhenThePermissionIsGone() {
        val provider = FakeProvider().apply { documentError = SecurityException("Permission Denial") }
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
    }

    @Test
    fun statReturnsTheRow() {
        val provider = FakeProvider().apply { document = SafDocumentQuery.Found(row("data.json")) }
        assertEquals("data.json", SafDocumentsCore(provider).stat("content://p/tree/t/document/data.json")?.name)
    }
}
