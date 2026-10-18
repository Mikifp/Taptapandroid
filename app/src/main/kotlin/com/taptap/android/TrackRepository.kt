package com.taptap.android

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import com.taptap.core.DemoTrack
import com.taptap.core.Track
import org.json.JSONArray
import java.io.File
import java.io.IOException

/** Finds playable tracks: converted game tracks in assets/tracks plus the built-in demo song. */
class TrackRepository(private val ctx: Context) {
    private val prefs: SharedPreferences = ctx.getSharedPreferences("scores", Context.MODE_PRIVATE)

    fun tracks(): List<Track> {
        val out = ArrayList<Track>()
        try {
            val ids = JSONArray(ctx.assets.open("tracks/index.json").bufferedReader().use { it.readText() })
            for (i in 0 until ids.length()) {
                val id = ids.getString(i)
                try {
                    out.add(Track.fromJson(ctx.assets.open("tracks/$id/track.json").bufferedReader().use { it.readText() }))
                } catch (_: Exception) { /* skip a broken track */ }
            }
        } catch (_: IOException) { /* no converted content installed */ }
        out.add(DemoTrack.track())
        return out
    }

    fun find(id: String): Track? = tracks().firstOrNull { it.id == id }

    fun player(t: Track): MediaPlayer {
        val mp = MediaPlayer()
        if (t.audioFile == null) {
            val f = File(ctx.cacheDir, "demo-${DemoTrack.durationMs}.wav")
            if (!f.exists()) f.writeBytes(DemoTrack.wavBytes())
            mp.setDataSource(f.absolutePath)
        } else {
            ctx.assets.openFd("tracks/${t.id}/${t.audioFile}").use { mp.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
        }
        mp.prepare()
        return mp
    }

    fun artwork(t: Track): Bitmap? = t.artworkFile?.let {
        try { ctx.assets.open("tracks/${t.id}/$it").use { s -> BitmapFactory.decodeStream(s) } } catch (_: IOException) { null }
    }

    /** The track's own theme backdrop, else the shared one, else null. */
    fun background(t: Track): Bitmap? {
        val paths = listOfNotNull(t.backgroundFile?.let { "tracks/${t.id}/$it" }, "theme/background.jpg")
        for (p in paths) {
            try { return ctx.assets.open(p).use { BitmapFactory.decodeStream(it) } } catch (_: IOException) { /* try next */ }
        }
        return null
    }

    fun best(t: Track, level: Int): Long = prefs.getLong("${t.id}:$level", 0L)

    /** Stores the score if it beats the old one; returns true for a new record. */
    fun submit(t: Track, level: Int, score: Long): Boolean {
        if (score <= best(t, level)) return false
        prefs.edit().putLong("${t.id}:$level", score).apply()
        return true
    }
}
