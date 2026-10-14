package com.taptap.core

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

/**
 * Original, copyright-free built-in song so the app is playable without any converted
 * game content: a synthesized 124 BPM loop plus charts generated from its melody.
 */
object DemoTrack {
    const val BPM = 124.0
    const val BARS = 32
    const val SAMPLE_RATE = 22050
    const val LEAD_IN_BEATS = 4
    private val beatMs get() = 60000.0 / BPM
    private val bassRoots = intArrayOf(45, 45, 41, 43) // A2 A2 F2 G2 per bar, in MIDI notes
    private val melody = intArrayOf(0, 3, 5, 3, 7, 5, 3, 0) // scale steps per eighth note

    val durationMs: Int get() = ((LEAD_IN_BEATS + BARS * 4) * beatMs).toInt() + 2000

    fun track(): Track = Track("demo", "Neon Pulse", "Built-in demo", durationMs, null, null,
        (1..4).associateWith { chart(it) })

    /** One note per melody eighth, thinned out for easier levels; holds on long bars. */
    fun chart(level: Int): List<Note> {
        val rnd = Random(1000 + level)
        val keepEvery = mapOf(1 to 2, 2 to 1, 3 to 1, 4 to 1)[level] ?: 1
        val density = mapOf(1 to 0.55, 2 to 0.75, 3 to 0.9, 4 to 1.0)[level] ?: 1.0
        val notes = ArrayList<Note>()
        var lastLane = 1
        for (bar in 1 until BARS) {
            for (e in 0 until 8) {
                if (e % keepEvery != 0) continue
                if (level == 1 && e % 2 != 0) continue
                if (rnd.nextDouble() > density) continue
                val t = ((LEAD_IN_BEATS + bar * 4 + e * 0.5) * beatMs).toInt()
                val lane = laneFor(melody[e], bar, lastLane, rnd)
                lastLane = lane
                val hold = level >= 3 && e == 0 && bar % 4 == 3
                notes.add(Note(t, lane, if (hold) (beatMs * 1.5).toInt() else 0))
                if (level == 4 && e % 4 == 2 && rnd.nextDouble() < 0.35) {
                    notes.add(Note(t, (lane + 1 + rnd.nextInt(2)) % 3))
                }
            }
        }
        return notes.sortedBy { it.timeMs }
    }

    private fun laneFor(step: Int, bar: Int, last: Int, rnd: Random): Int {
        val base = (step + bar) % 3
        return if (base == last && rnd.nextDouble() < 0.5) (base + 1) % 3 else base
    }

    /** Renders the loop to a 16-bit mono PCM WAV file. */
    fun wavBytes(): ByteArray {
        val total = (durationMs / 1000.0 * SAMPLE_RATE).toInt()
        val mix = FloatArray(total)
        val beat = beatMs / 1000.0
        val scale = intArrayOf(0, 2, 3, 5, 7, 8, 10, 12) // natural minor
        fun hz(m: Int) = 440.0 * Math.pow(2.0, (m - 69) / 12.0)
        fun add(startSec: Double, lenSec: Double, gain: Float, f: (Double) -> Double) {
            val s0 = (startSec * SAMPLE_RATE).toInt()
            val n = (lenSec * SAMPLE_RATE).toInt()
            for (i in 0 until n) { val idx = s0 + i; if (idx >= 0 && idx < total) mix[idx] += (f(i.toDouble() / SAMPLE_RATE) * gain).toFloat() }
        }
        val rnd = Random(7)
        val totalBeats = LEAD_IN_BEATS + BARS * 4
        for (b in 0 until totalBeats) {
            val t = b * beat
            if (b >= 0) add(t, 0.18, 0.5f) { x -> sin(2 * PI * (110.0 * exp(-x * 30) + 45) * x) * exp(-x * 14) } // kick
            add(t + beat / 2, 0.05, 0.12f) { _ -> rnd.nextDouble() * 2 - 1 }                                   // hat
            if (b >= LEAD_IN_BEATS && (b - LEAD_IN_BEATS) % 2 == 1) add(t, 0.12, 0.2f) { x -> (rnd.nextDouble() * 2 - 1) * exp(-x * 25) } // snare
        }
        for (bar in 0 until BARS) {
            val barStart = (LEAD_IN_BEATS + bar * 4) * beat
            val root = bassRoots[bar % 4]
            for (e in 0 until 8) {
                val ts = barStart + e * beat / 2
                add(ts, beat / 2, 0.18f) { x -> val p = (hz(root) * x) % 1.0; (2 * p - 1) * exp(-x * 4) }       // bass saw
                if (bar >= 1) {
                    val f = hz(57 + scale[melody[e] % scale.size] + (if (bar % 4 == 3) 2 else 0))
                    add(ts, beat / 2, 0.14f) { x -> (if (sin(2 * PI * f * x) > 0) 1.0 else -1.0) * exp(-x * 6) }  // square lead
                }
            }
        }
        val out = ByteArrayOutputStream()
        val data = ByteBuffer.allocate(total * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (v in mix) data.putShort((v.coerceIn(-1f, 1f) * 30000).toInt().toShort())
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + total * 2).put("WAVEfmt ".toByteArray())
            .putInt(16).putShort(1).putShort(1).putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
            .put("data".toByteArray()).putInt(total * 2)
        out.write(header.array()); out.write(data.array())
        return out.toByteArray()
    }
}
