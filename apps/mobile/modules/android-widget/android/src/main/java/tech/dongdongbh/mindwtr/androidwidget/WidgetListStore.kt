package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context

/** Which list each placed Tasks widget shows (#1173): SharedPreferences `mindwtr_widget_lists`, key = widget id. */
object WidgetListStore {
  const val PREFS_NAME = "mindwtr_widget_lists"
  const val DEFAULT_LIST = "focus"
  /** Kept for installed widgets that still carry a project selection. */
  const val PROJECT_PREFIX = "project:"
  const val CONTEXT_PREFIX = "context:"
  const val TAG_PREFIX = "tag:"
  fun isTokenList(id: String): Boolean = id.startsWith(CONTEXT_PREFIX) || id.startsWith(TAG_PREFIX)
  const val FILTER_PREFIX = "filter:"

  // Core's SIMPLE_TASK_TOKEN_RE: the only form quick-add parses without known-token help.
  // ponytail: spaced, dotted or hierarchical tokens get no pre-fill; quick-add's quoted @"a b" form does not round-trip yet.
  private val SIMPLE_CAPTURE_TOKEN = Regex("[\\p{L}\\p{N}_-]+")

  /** Capture text for a widget showing one context or tag (#1418), e.g. `@Todd `; empty otherwise. */
  fun captureText(listId: String): String {
    val token = when {
      listId.startsWith(CONTEXT_PREFIX) -> listId.removePrefix(CONTEXT_PREFIX).takeIf { it.startsWith("@") }
      listId.startsWith(TAG_PREFIX) -> listId.removePrefix(TAG_PREFIX).takeIf { it.startsWith("#") }
      else -> null
    } ?: return ""
    return if (SIMPLE_CAPTURE_TOKEN.matches(token.substring(1))) "$token " else ""
  }

  fun read(context: Context, appWidgetId: Int): String {
    val stored = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(appWidgetId.toString(), null)
    return stored ?: DEFAULT_LIST
  }

  fun write(context: Context, appWidgetId: Int, listId: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(appWidgetId.toString(), listId).commit()
  }

  fun remove(context: Context, appWidgetIds: IntArray) {
    val editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
    for (id in appWidgetIds) editor.remove(id.toString())
    editor.apply()
  }

  /** Distinct list ids bound to the Tasks widgets currently placed. */
  fun selections(context: Context): List<String> {
    val manager = AppWidgetManager.getInstance(context) ?: return emptyList()
    return selectionsForProviders(
      context.packageName,
      idsForProvider = { className ->
        manager.getAppWidgetIds(ComponentName(context.packageName, className))
      },
      readSelection = { appWidgetId -> read(context, appWidgetId) },
    )
  }

  internal fun selectionsForProviders(
    applicationPackage: String,
    idsForProvider: (String) -> IntArray,
    readSelection: (Int) -> String,
  ): List<String> = WidgetProviderRegistry
    .placed(applicationPackage, idsForProvider)
    .filter { it.identity.kind == WidgetKind.TASKS }
    .flatMap { it.ids.asIterable() }
    .map(readSelection)
    .distinct()
}
