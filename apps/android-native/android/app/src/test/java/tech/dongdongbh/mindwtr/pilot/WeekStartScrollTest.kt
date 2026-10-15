package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** The week's first place (RN's getCalendarWeekInitialScrollX): the selected day at the left, as far as the week allows. */
class WeekStartScrollTest {
    @Test fun deadlineWideColumnsOpenOnTheSelectedDay() {
        // 260 dp deadline columns on a 304 dp viewport: one day fits, so Thursday (index 4) leads, not the density's Tuesday.
        assertEquals(1040, weekStartScroll(start = 4, dayCount = 7, columnPx = 260f, availablePx = 304f))
        assertEquals(7 * 260 - 304, weekStartScroll(start = 6, dayCount = 7, columnPx = 260f, availablePx = 304f))
    }

    @Test fun densityColumnsStopWhereTheLastDayMeetsTheEdge() {
        assertEquals(120, weekStartScroll(start = 6, dayCount = 7, columnPx = 60f, availablePx = 300f))
        assertEquals(0, weekStartScroll(start = 4, dayCount = 7, columnPx = 40f, availablePx = 280f))
    }
}
