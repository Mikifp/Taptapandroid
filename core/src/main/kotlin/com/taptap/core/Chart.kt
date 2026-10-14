package com.taptap.core

import org.json.JSONObject

/** One note of a chart. [durMs] > 0 makes it a hold note that must be kept pressed. */
data class Note(val timeMs: Int, val lane: Int, val durMs: Int = 0) {
    val isHold get() = durMs > 0
    val endMs get() = timeMs + durMs
}

class Track(
    val id: String,
    val title: String,
    val artist: String,
    val durationMs: Int,
    val audioFile: String?,
    val artworkFile: String?,
    val levels: Map<Int, List<Note>>,
) {
    companion object {
        /** Parses the track.json written by tools/ipa_to_assets.py. */
        fun fromJson(text: String): Track {
            val o = JSONObject(text)
            val lv = o.getJSONObject("levels")
            val levels = HashMap<Int, List<Note>>()
            for (k in lv.keys()) {
                val arr = lv.getJSONArray(k)
                levels[k.toInt()] = List(arr.length()) {
                    val n = arr.getJSONArray(it)
                    Note(n.getInt(0), n.getInt(1), n.getInt(2))
                }.sortedBy { n -> n.timeMs }
            }
            return Track(
                o.getString("id"), o.getString("title"), o.optString("artist"),
                o.optInt("durationMs"), o.optString("audio").ifEmpty { null },
                o.optString("artwork").ifEmpty { null }, levels,
            )
        }
    }
}

object Difficulty {
    val names = mapOf(1 to "Easy", 2 to "Medium", 3 to "Hard", 4 to "Expert")
    fun name(level: Int) = names[level] ?: "Level $level"
}
