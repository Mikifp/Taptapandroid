package com.taptap.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.media.MediaPlayer
import android.util.SparseIntArray
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.taptap.core.Difficulty
import com.taptap.core.Grade
import com.taptap.core.Judge
import com.taptap.core.JudgeEvent
import com.taptap.core.Note
import com.taptap.core.Track
import kotlin.math.max
import kotlin.math.min

/**
 * The playfield. Everything is laid out in the original game's 320x480 point space and scaled to fit.
 * Lane x positions and the hit line mirror the original DJ theme (theme.cfg feedback sprites).
 */
class GameView(
    context: Context,
    private val track: Track,
    private val level: Int,
    private val player: MediaPlayer,
    private val backdrop: Bitmap?,
    private val onExit: () -> Unit,
) : SurfaceView(context), SurfaceHolder.Callback, Runnable {

    private enum class State { COUNTDOWN, PLAYING, PAUSED, RESULTS }

    companion object {
        const val W = 320f
        const val H = 480f
        const val HIT_Y = 427f
        const val APPROACH_MS = 1500
        const val LEAD_IN_MS = 3000
        val LANE_X = floatArrayOf(55.5f, 160f, 263f)
        val LANE_COLOR = intArrayOf(Color.rgb(255, 77, 109), Color.rgb(255, 210, 63), Color.rgb(63, 167, 255))
    }

    var previousBest = 0L
    var onFinished: (Long) -> Boolean = { false }

    private val notes: List<Note> = track.levels[level].orEmpty()
    private val judge = Judge(notes)
    private val lock = Any()
    private val chartEnd = (notes.maxOfOrNull { it.endMs } ?: 0) + 1200

    private var state = State.COUNTDOWN
    private var thread: Thread? = null
    @Volatile private var running = false
    private var audioDone = false
    private var newRecord = false

    // clock
    private var countdownStart = 0L
    private var lastPos = 0
    private var lastPosNanos = 0L
    private var songMs = -LEAD_IN_MS.toDouble()
    @Volatile private var frameMs = -LEAD_IN_MS.toDouble()
    @Volatile private var frameNanos = 0L

    // feedback
    private var feedback: Grade? = null
    private var feedbackAt = 0L
    private val flashUntil = LongArray(3)
    private val pointerLane = SparseIntArray()
    private val laneDown = IntArray(3)

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()
    private var bgGradient: Paint? = null

    init {
        holder.addCallback(this)
        player.setOnCompletionListener { audioDone = true }
    }

    // ---- lifecycle -------------------------------------------------------------------------------------------

    override fun surfaceCreated(h: SurfaceHolder) {
        running = true
        countdownStart = System.nanoTime()
        thread = Thread(this, "game-loop").also { it.start() }
    }

    override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) {}

    override fun surfaceDestroyed(h: SurfaceHolder) {
        running = false
        thread?.join(500)
        thread = null
    }

    fun release() {
        running = false
        try { player.release() } catch (_: Exception) {}
    }

    fun pauseGame() {
        synchronized(lock) {
            if (state == State.PLAYING) { state = State.PAUSED; try { player.pause() } catch (_: Exception) {} }
            else if (state == State.COUNTDOWN) { state = State.PAUSED }
        }
    }

    /** Returns true when the back press was consumed. */
    fun handleBack(): Boolean {
        synchronized(lock) {
            when (state) {
                State.PAUSED -> resume()
                State.RESULTS -> return false
                else -> pauseGame()
            }
        }
        return true
    }

    private fun resume() {
        if (songMs < 0) {
            countdownStart = System.nanoTime() - ((songMs + LEAD_IN_MS) * 1e6).toLong()
            state = State.COUNTDOWN
        } else {
            try { player.start() } catch (_: Exception) {}
            lastPosNanos = System.nanoTime(); lastPos = player.currentPosition
            state = State.PLAYING
        }
    }

    // ---- game loop -------------------------------------------------------------------------------------------

    override fun run() {
        while (running) {
            val start = System.nanoTime()
            val canvas = try { holder.lockCanvas() } catch (_: Exception) { null }
            if (canvas != null) {
                try {
                    synchronized(lock) { tick(start) }
                    draw(canvas)
                } finally {
                    try { holder.unlockCanvasAndPost(canvas) } catch (_: Exception) {}
                }
            }
            val spent = (System.nanoTime() - start) / 1_000_000
            if (spent < 16) try { Thread.sleep(16 - spent) } catch (_: InterruptedException) {}
        }
    }

    private fun tick(now: Long) {
        when (state) {
            State.COUNTDOWN -> {
                songMs = (now - countdownStart) / 1e6 - LEAD_IN_MS
                if (songMs >= 0) {
                    try { player.start() } catch (_: Exception) {}
                    lastPos = 0; lastPosNanos = now
                    state = State.PLAYING
                }
            }
            State.PLAYING -> {
                val p = try { player.currentPosition } catch (_: Exception) { lastPos }
                if (p != lastPos) { lastPos = p; lastPosNanos = now }
                songMs = max(songMs, lastPos + (now - lastPosNanos) / 1e6)
                for (e in judge.update(songMs.toInt())) onEvent(e, now)
                if (audioDone || (songMs > chartEnd && judge.resolvedAll)) finishSong()
            }
            else -> {}
        }
        frameMs = songMs; frameNanos = now
    }

    private fun finishSong() {
        for (e in judge.update(Int.MAX_VALUE / 2)) onEvent(e, System.nanoTime())
        try { player.pause() } catch (_: Exception) {}
        newRecord = onFinished(judge.score)
        state = State.RESULTS
    }

    private fun onEvent(e: JudgeEvent, now: Long) {
        feedback = e.grade; feedbackAt = now
        flashUntil[e.note.lane] = now + 150_000_000L
    }

    // ---- input -----------------------------------------------------------------------------------------------

    private fun laneAt(x: Float): Int {
        val vx = (x - offX) / scale
        return if (vx < W / 3) 0 else if (vx < 2 * W / 3) 1 else 2
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        val idx = ev.actionIndex
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> press(ev.getPointerId(idx), ev.getX(idx), ev.getY(idx))
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> release(ev.getPointerId(idx))
            MotionEvent.ACTION_CANCEL -> for (i in 0 until ev.pointerCount) release(ev.getPointerId(i))
        }
        return true
    }

    private fun press(id: Int, x: Float, y: Float) {
        synchronized(lock) {
            when (state) {
                State.PLAYING -> {
                    val lane = laneAt(x)
                    pointerLane.put(id, lane + 1); laneDown[lane]++
                    val t = (frameMs + (System.nanoTime() - frameNanos) / 1e6).toInt()
                    judge.onPress(lane, t)?.let { onEvent(it, System.nanoTime()) }
                }
                State.PAUSED -> {
                    val vy = (y - offY) / scale
                    if (vy in 190f..250f) resume() else if (vy in 270f..330f) onExit()
                }
                State.RESULTS -> onExit()
                else -> {}
            }
        }
    }

    private fun release(id: Int) {
        synchronized(lock) {
            val lane = pointerLane.get(id) - 1
            if (lane < 0) return
            pointerLane.delete(id); laneDown[lane] = max(0, laneDown[lane] - 1)
            if (state == State.PLAYING && laneDown[lane] == 0) {
                val t = (frameMs + (System.nanoTime() - frameNanos) / 1e6).toInt()
                judge.onRelease(lane, t)?.let { onEvent(it, System.nanoTime()) }
            }
        }
    }

    // ---- rendering -------------------------------------------------------------------------------------------

    private var scale = 1f
    private var offX = 0f
    private var offY = 0f

    private fun draw(c: Canvas) {
        val sw = c.width.toFloat(); val sh = c.height.toFloat()
        scale = min(sw / W, sh / H); offX = (sw - W * scale) / 2; offY = (sh - H * scale) / 2
        drawBackground(c, sw, sh)
        c.save(); c.translate(offX, offY); c.scale(scale, scale)
        synchronized(lock) {
            drawLanes(c)
            drawNotes(c)
            drawHud(c)
            when (state) {
                State.COUNTDOWN -> drawCountdown(c)
                State.PAUSED -> drawPause(c)
                State.RESULTS -> drawResults(c)
                else -> {}
            }
        }
        c.restore()
    }

    private fun drawBackground(c: Canvas, sw: Float, sh: Float) {
        if (backdrop != null) {
            val s = max(sw / backdrop.width, sh / backdrop.height)
            val w = backdrop.width * s; val h = backdrop.height * s
            rect.set((sw - w) / 2, (sh - h) / 2, (sw + w) / 2, (sh + h) / 2)
            c.drawBitmap(backdrop, null, rect, null)
            paint.shader = null; paint.color = Color.argb(120, 0, 0, 0); c.drawRect(0f, 0f, sw, sh, paint)
        } else {
            val g = bgGradient ?: Paint().also {
                it.shader = LinearGradient(0f, 0f, 0f, sh, Color.rgb(34, 14, 70), Color.rgb(6, 4, 16), Shader.TileMode.CLAMP)
                bgGradient = it
            }
            c.drawRect(0f, 0f, sw, sh, g)
        }
    }

    private fun drawLanes(c: Canvas) {
        val now = System.nanoTime()
        for (i in 0 until 3) {
            val lit = laneDown[i] > 0 || now < flashUntil[i]
            paint.shader = null
            paint.color = Color.argb(if (lit) 90 else 36, Color.red(LANE_COLOR[i]), Color.green(LANE_COLOR[i]), Color.blue(LANE_COLOR[i]))
            c.drawRect(i * W / 3 + 3, 0f, (i + 1) * W / 3 - 3, H, paint)
            paint.color = LANE_COLOR[i]; paint.style = Paint.Style.STROKE; paint.strokeWidth = if (lit) 5f else 3f
            c.drawCircle(LANE_X[i], HIT_Y, 27f, paint)
            paint.style = Paint.Style.FILL
        }
    }

    private fun drawNotes(c: Canvas) {
        val t = songMs
        for (n in notes) {
            if (n.timeMs > t + APPROACH_MS) break
            if (n.endMs < t - 250) continue
            val held = n.isHold && judge.isHolding(n.lane)
            if (judge.isResolved(n) && !held) continue
            val headY = if (held) HIT_Y else yFor(n.timeMs, t)
            if (n.isHold) {
                val tailY = yFor(n.endMs, t)
                paint.color = Color.argb(if (held) 200 else 130, Color.red(LANE_COLOR[n.lane]), Color.green(LANE_COLOR[n.lane]), Color.blue(LANE_COLOR[n.lane]))
                rect.set(LANE_X[n.lane] - 10, tailY, LANE_X[n.lane] + 10, headY); c.drawRoundRect(rect, 10f, 10f, paint)
            }
            val r = 12f + 14f * ((headY + 20f) / (HIT_Y + 20f)).coerceIn(0f, 1f)
            paint.color = LANE_COLOR[n.lane]; c.drawCircle(LANE_X[n.lane], headY, r, paint)
            paint.color = Color.argb(160, 255, 255, 255); c.drawCircle(LANE_X[n.lane], headY, r * 0.45f, paint)
        }
    }

    private fun yFor(noteMs: Int, t: Double): Float {
        val p = 1f - ((noteMs - t) / APPROACH_MS).toFloat()
        return -20f + p * (HIT_Y + 20f)
    }

    private fun text(c: Canvas, s: String, x: Float, y: Float, size: Float, color: Int, align: Paint.Align = Paint.Align.CENTER, bold: Boolean = true) {
        paint.textSize = size; paint.color = color; paint.textAlign = align
        paint.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        c.drawText(s, x, y, paint)
    }

    private fun drawHud(c: Canvas) {
        text(c, judge.score.toString(), 10f, 30f, 24f, Color.WHITE, Paint.Align.LEFT)
        text(c, "x${judge.multiplier}", W - 10f, 30f, 26f, if (judge.multiplier > 1) LANE_COLOR[1] else Color.LTGRAY, Paint.Align.RIGHT)
        if (judge.streak >= 5) text(c, "${judge.streak} streak", W / 2, 58f, 16f, Color.argb(200, 255, 255, 255))
        val prog = if (track.durationMs > 0) (songMs / track.durationMs).toFloat().coerceIn(0f, 1f) else 0f
        paint.color = Color.argb(160, 255, 255, 255); c.drawRect(0f, 0f, W * prog, 3f, paint)
        feedback?.let { g ->
            val age = (System.nanoTime() - feedbackAt) / 1e6f
            if (age < 450) {
                val a = (255 * (1 - age / 450f)).toInt()
                val col = when (g) { Grade.PERFECT -> Color.rgb(90, 255, 120); Grade.GREAT -> Color.rgb(255, 230, 90); Grade.GOOD -> Color.rgb(120, 200, 255); Grade.MISS -> Color.rgb(255, 80, 80) }
                text(c, g.label, W / 2, 330f - age / 30f, 26f, Color.argb(a, Color.red(col), Color.green(col), Color.blue(col)))
            }
        }
    }

    private fun drawCountdown(c: Canvas) {
        text(c, track.title, W / 2, 190f, 22f, Color.WHITE)
        text(c, Difficulty.name(level), W / 2, 216f, 15f, Color.LTGRAY, bold = false)
        val remain = -songMs
        if (remain > 0) text(c, (remain / 1000 + 1).toInt().toString(), W / 2, 290f, 64f, Color.WHITE)
    }

    private fun drawPause(c: Canvas) {
        paint.color = Color.argb(190, 0, 0, 0); c.drawRect(0f, 0f, W, H, paint)
        text(c, "PAUSED", W / 2, 160f, 28f, Color.WHITE)
        for ((i, label) in listOf("RESUME", "QUIT").withIndex()) {
            val y = 190f + i * 80f
            paint.color = Color.argb(255, 60, 40, 110); rect.set(70f, y, 250f, y + 60f); c.drawRoundRect(rect, 14f, 14f, paint)
            text(c, label, W / 2, y + 38f, 22f, Color.WHITE)
        }
    }

    private fun drawResults(c: Canvas) {
        paint.color = Color.argb(215, 8, 4, 20); c.drawRect(0f, 0f, W, H, paint)
        text(c, track.title, W / 2, 70f, 22f, Color.WHITE)
        text(c, Difficulty.name(level), W / 2, 94f, 14f, Color.LTGRAY, bold = false)
        val stars = judge.stars()
        text(c, "★".repeat(stars) + "☆".repeat(5 - stars), W / 2, 150f, 34f, LANE_COLOR[1])
        text(c, judge.score.toString(), W / 2, 205f, 40f, Color.WHITE)
        if (newRecord) text(c, "NEW BEST!", W / 2, 232f, 18f, Color.rgb(90, 255, 120))
        else if (previousBest > 0) text(c, "Best $previousBest", W / 2, 232f, 14f, Color.LTGRAY, bold = false)
        var y = 280f
        for (g in listOf(Grade.PERFECT, Grade.GREAT, Grade.GOOD, Grade.MISS)) {
            text(c, g.label, 80f, y, 17f, Color.LTGRAY, Paint.Align.LEFT, false)
            text(c, judge.counts[g.ordinal].toString(), 240f, y, 17f, Color.WHITE, Paint.Align.RIGHT)
            y += 26f
        }
        text(c, "Best streak ${judge.bestStreak}   Accuracy ${(judge.accuracy * 100).toInt()}%", W / 2, y + 12f, 14f, Color.LTGRAY, bold = false)
        text(c, "Tap to continue", W / 2, 450f, 15f, Color.argb(200, 255, 255, 255), bold = false)
    }
}
