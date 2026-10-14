package com.taptap.core

import kotlin.test.*

class JudgeTest {
    @Test fun gradesByTimingWindow() {
        val j = Judge(listOf(Note(1000, 0), Note(2000, 1), Note(3000, 2)))
        assertEquals(Grade.PERFECT, j.onPress(0, 1030)!!.grade)
        assertEquals(Grade.GREAT, j.onPress(1, 2090)!!.grade)
        assertEquals(Grade.GOOD, j.onPress(2, 2850)!!.grade)
        assertNull(j.onPress(2, 3000)) // already consumed
    }

    @Test fun missesAndStreakMultiplier() {
        val notes = (0 until 25).map { Note(1000 + it * 500, 0) }
        val j = Judge(notes)
        for (n in notes.take(10)) j.onPress(0, n.timeMs)
        assertEquals(2, j.multiplier)
        for (n in notes.subList(10, 20)) j.onPress(0, n.timeMs)
        assertEquals(3, j.multiplier)
        val ev = j.update(notes[20].timeMs + Judge.GOOD_MS + 1)
        assertEquals(1, ev.size); assertEquals(Grade.MISS, ev[0].grade)
        assertEquals(0, j.streak); assertEquals(20, j.bestStreak); assertEquals(1, j.multiplier)
    }

    @Test fun wrongLaneOrTooEarlyDoesNothing() {
        val j = Judge(listOf(Note(1000, 1)))
        assertNull(j.onPress(0, 1000)); assertNull(j.onPress(1, 500))
        assertEquals(0, j.counts.sum())
    }

    @Test fun holdPaysOutAndEarlyReleaseBreaks() {
        val j = Judge(listOf(Note(1000, 0, 1000), Note(3000, 1, 1000)))
        j.onPress(0, 1000); j.update(1500); assertTrue(j.score > 100); assertTrue(j.isHolding(0))
        assertNull(j.onRelease(0, 2000)); j.update(2100)
        assertFalse(j.isHolding(0)); assertEquals(1, j.streak)
        j.onPress(1, 3000); j.update(3200)
        assertEquals(Grade.MISS, j.onRelease(1, 3300)!!.grade); assertEquals(0, j.streak)
        assertTrue(j.update(10_000).isEmpty()); assertTrue(j.resolvedAll)
    }

    @Test fun accuracyAndStars() {
        val j = Judge(listOf(Note(100, 0), Note(200, 0)))
        j.onPress(0, 100); j.onPress(0, 200)
        assertEquals(1.0, j.accuracy); assertEquals(5, j.stars())
        assertEquals(0, Judge(listOf(Note(1, 0))).also { it.update(5000) }.stars())
    }
}

class DataTest {
    @Test fun trackJsonRoundTrip() {
        val t = Track.fromJson("""{"id":"x","title":"T","artist":"A","durationMs":5000,"audio":"audio.m4a","artwork":"",
            "levels":{"1":[[500,2,0],[100,0,900]]}}""")
        assertEquals("T", t.title); assertNull(t.artworkFile)
        assertEquals(listOf(Note(100, 0, 900), Note(500, 2, 0)), t.levels[1])
        assertTrue(t.levels[1]!![0].isHold)
    }

    @Test fun demoChartsAreOrderedValidAndGetDenser() {
        val counts = (1..4).map { DemoTrack.chart(it) }
        counts.forEach { c ->
            assertTrue(c.isNotEmpty()); assertEquals(c, c.sortedBy { it.timeMs })
            assertTrue(c.all { it.lane in 0..2 && it.timeMs in 0..DemoTrack.durationMs })
        }
        assertTrue(counts.map { it.size }.zipWithNext().all { (a, b) -> a < b })
        assertEquals(DemoTrack.chart(3), DemoTrack.chart(3)) // deterministic
    }

    @Test fun demoWavIsWellFormed() {
        val w = DemoTrack.wavBytes()
        assertEquals("RIFF", String(w, 0, 4)); assertEquals("WAVE", String(w, 8, 4))
        assertEquals(44 + (DemoTrack.durationMs / 1000.0 * DemoTrack.SAMPLE_RATE).toInt() * 2, w.size)
        assertTrue(w.drop(44).any { it.toInt() != 0 })
    }
}
