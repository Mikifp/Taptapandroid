package com.taptap.core

import kotlin.math.abs

enum class Grade(val label: String, val points: Int) { PERFECT("PERFECT", 100), GREAT("GREAT", 75), GOOD("GOOD", 50), MISS("MISS", 0) }

/** Per-note state, used for drawing. Hold state belongs to the note, not to its lane. */
enum class NoteState { PENDING, HOLDING, HIT, MISSED, BROKEN }

/** What happened to a note, reported to the UI for feedback effects. */
data class JudgeEvent(val note: Note, val grade: Grade)

/**
 * Scoring engine for one play-through, independent of rendering and audio.
 * Feed it taps and releases with the song time in ms, and call [update] every frame.
 *
 * Streak multiplier: x1, then +1 for every 10 consecutive hits, capped at x4.
 */
class Judge(notes: List<Note>) {
    companion object {
        const val PERFECT_MS = 55
        const val GREAT_MS = 110
        const val GOOD_MS = 170
        const val STREAK_PER_MULT = 10
        const val MAX_MULT = 4
        const val HOLD_TICK_MS = 100
        const val HOLD_TICK_POINTS = 10
        const val RELEASE_SLACK_MS = 120
    }

    private class State(val note: Note) { var resolved = false; var holding = false; var missed = false; var broken = false; var lastTick = 0 }

    private val states = notes.sortedBy { it.timeMs }.map { State(it) }
    private val byNote = java.util.IdentityHashMap<Note, State>().also { m -> states.forEach { m[it.note] = it } }
    val totalNotes = states.size

    var score = 0L; private set
    var streak = 0; private set
    var bestStreak = 0; private set
    val counts = IntArray(Grade.entries.size)
    val multiplier get() = minOf(MAX_MULT, 1 + streak / STREAK_PER_MULT)
    private val pressedAt = BooleanArray(8)

    /** Share of notes hit, weighted by grade, 0..1. */
    val accuracy: Double
        get() {
            val done = counts.sum()
            if (done == 0) return 1.0
            val pts = Grade.entries.sumOf { counts[it.ordinal] * it.points }
            return pts / (done * 100.0)
        }

    val resolvedAll get() = states.all { it.resolved }

    fun onPress(lane: Int, tMs: Int): JudgeEvent? {
        pressedAt[lane] = true
        val s = states.filter { !it.resolved && !it.holding && it.note.lane == lane && abs(it.note.timeMs - tMs) <= GOOD_MS }
            .minByOrNull { abs(it.note.timeMs - tMs) } ?: return null
        val d = abs(s.note.timeMs - tMs)
        val grade = when { d <= PERFECT_MS -> Grade.PERFECT; d <= GREAT_MS -> Grade.GREAT; else -> Grade.GOOD }
        award(grade)
        if (s.note.isHold) { s.holding = true; s.lastTick = maxOf(tMs, s.note.timeMs) } else s.resolved = true
        return JudgeEvent(s.note, grade)
    }

    fun onRelease(lane: Int, tMs: Int): JudgeEvent? {
        pressedAt[lane] = false
        val s = states.firstOrNull { it.holding && it.note.lane == lane } ?: return null
        s.holding = false; s.resolved = true
        return if (tMs < s.note.endMs - RELEASE_SLACK_MS) { s.broken = true; breakStreak(); counts[Grade.MISS.ordinal]++; JudgeEvent(s.note, Grade.MISS) } else null
    }

    /** Resolves missed notes and pays out held notes. Returns events produced. */
    fun update(tMs: Int): List<JudgeEvent> {
        var out: MutableList<JudgeEvent>? = null
        for (s in states) {
            if (s.resolved) continue
            if (s.holding) {
                while (s.lastTick + HOLD_TICK_MS <= minOf(tMs, s.note.endMs)) {
                    s.lastTick += HOLD_TICK_MS; score += HOLD_TICK_POINTS.toLong() * multiplier
                }
                if (tMs >= s.note.endMs) { s.holding = false; s.resolved = true }
            } else if (tMs - s.note.timeMs > GOOD_MS) {
                s.resolved = true; s.missed = true; breakStreak(); counts[Grade.MISS.ordinal]++
                (out ?: mutableListOf<JudgeEvent>().also { out = it }).add(JudgeEvent(s.note, Grade.MISS))
            }
        }
        return out ?: emptyList()
    }

    fun isHolding(lane: Int) = states.any { it.holding && it.note.lane == lane }
    fun isResolved(note: Note) = byNote[note]?.resolved ?: true

    fun noteState(note: Note): NoteState {
        val s = byNote[note] ?: return NoteState.HIT
        return when {
            s.holding -> NoteState.HOLDING
            !s.resolved -> NoteState.PENDING
            s.missed -> NoteState.MISSED
            s.broken -> NoteState.BROKEN
            else -> NoteState.HIT
        }
    }

    private fun award(g: Grade) {
        score += g.points.toLong() * multiplier
        streak++; bestStreak = maxOf(bestStreak, streak)
        counts[g.ordinal]++
    }

    private fun breakStreak() { streak = 0 }

    /** 0..5 stars from accuracy and completion. */
    fun stars(): Int {
        val a = accuracy
        return when { a >= 0.95 -> 5; a >= 0.88 -> 4; a >= 0.78 -> 3; a >= 0.62 -> 2; a >= 0.40 -> 1; else -> 0 }
    }
}
