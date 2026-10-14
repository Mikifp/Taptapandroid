package com.taptap.android

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.taptap.core.Difficulty
import com.taptap.core.Track

class MenuActivity : Activity() {
    private lateinit var repo: TrackRepository
    private lateinit var list: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo = TrackRepository(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.parseColor("#120A24")) }
        root.addView(TextView(this).apply {
            text = "TAP TAP"; textSize = 30f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE)
            gravity = Gravity.CENTER; setPadding(0, dp(28), 0, dp(12))
        })
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(14), dp(24)) }
        root.addView(ScrollView(this).apply { addView(list) })
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        list.removeAllViews()
        for (t in repo.tracks()) list.addView(card(t))
    }

    private fun card(t: Track): View {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(12), dp(12), dp(12))
            background = GradientDrawable().apply { setColor(Color.parseColor("#2A1B4A")); cornerRadius = dp(14).toFloat() }
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        repo.artwork(t)?.let { head.addView(ImageView(this).apply { setImageBitmap(it); layoutParams = LinearLayout.LayoutParams(dp(56), dp(56)).apply { rightMargin = dp(12) } }) }
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        names.addView(TextView(this).apply { text = t.title; textSize = 18f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE) })
        names.addView(TextView(this).apply { text = t.artist; textSize = 13f; setTextColor(Color.parseColor("#B9A8E0")) })
        head.addView(names)
        c.addView(head)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(10), 0, 0) }
        for (level in t.levels.keys.sorted()) {
            val best = repo.best(t, level)
            row.addView(Button(this).apply {
                text = Difficulty.name(level) + if (best > 0) "\n$best" else ""
                textSize = 11f; setAllCaps(false)
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(4) }
                setOnClickListener {
                    startActivity(Intent(this@MenuActivity, GameActivity::class.java)
                        .putExtra(GameActivity.EXTRA_TRACK, t.id).putExtra(GameActivity.EXTRA_LEVEL, level))
                }
            })
        }
        c.addView(row)
        return c
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
