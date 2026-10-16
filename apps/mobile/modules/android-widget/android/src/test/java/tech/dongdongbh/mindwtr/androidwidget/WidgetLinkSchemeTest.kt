package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetLinkSchemeTest {
  @Test
  fun anAppLinkTakesTheAppsSchemeAndEverythingElseStays() {
    assertEquals("mindwtr:///inbox", WidgetRenderer.linkInScheme("mindwtr:///inbox", "mindwtr"))
    assertEquals("mindwtr-native-dev:///inbox", WidgetRenderer.linkInScheme("mindwtr:///inbox", "mindwtr-native-dev"))
    assertEquals("mindwtr-upgradetest:///widget-list/next", WidgetRenderer.linkInScheme("mindwtr:///widget-list/next", "mindwtr-upgradetest"))
    assertEquals("mindwtr-widget://task/t1", WidgetRenderer.linkInScheme("mindwtr-widget://task/t1", "mindwtr-native-dev"))
    assertEquals("https://example.com/", WidgetRenderer.linkInScheme("https://example.com/", "mindwtr-native-dev"))
  }

  @Test
  fun rnsAppKeepsItsMindwtrLinks() {
    // The module's default mindwtr_link_scheme is RN's, so RN's widgets open exactly the payload's links.
    val context = ApplicationProvider.getApplicationContext<Context>()
    assertEquals("mindwtr:///focus", WidgetRenderer.appIntent(context, "mindwtr:///focus").dataString)
  }
}
