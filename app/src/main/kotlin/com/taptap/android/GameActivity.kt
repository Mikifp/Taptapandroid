package com.taptap.android

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Toast

class GameActivity : Activity() {
    companion object { const val EXTRA_TRACK = "track"; const val EXTRA_LEVEL = "level" }

    private var view: GameView? = null

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        val repo = TrackRepository(this)
        val track = intent.getStringExtra(EXTRA_TRACK)?.let { repo.find(it) }
        val level = intent.getIntExtra(EXTRA_LEVEL, 1)
        if (track == null || track.levels[level] == null) { finish(); return }
        try {
            view = GameView(this, track, level, repo.player(track), repo.background()) { finish() }
                .also { setContentView(it) }
            val best = repo.best(track, level)
            view?.previousBest = best
            view?.onFinished = { score -> repo.submit(track, level, score) }
        } catch (e: Exception) {
            Toast.makeText(this, "Could not load audio: ${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onPause() { super.onPause(); view?.pauseGame() }
    override fun onDestroy() { super.onDestroy(); view?.release() }
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (view?.handleBack() != true) super.onBackPressed() }
}
