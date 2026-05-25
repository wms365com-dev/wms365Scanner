package com.wms365.nativeapp.scanner

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.KeyEvent

class ScannerManager(
    private val context: Context,
    private val onScan: (String) -> Unit
) {
    private val buffer = StringBuilder()
    private val handler = Handler(Looper.getMainLooper())
    private val flushRunnable = Runnable { flush() }
    private val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)

    fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return false
        if (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_TAB) {
            flush()
            return buffer.isNotEmpty()
        }
        val unicode = event.unicodeChar
        if (unicode > 0) {
            val ch = unicode.toChar()
            if (!ch.isISOControl()) {
                buffer.append(ch)
                handler.removeCallbacks(flushRunnable)
                handler.postDelayed(flushRunnable, 180)
                return false
            }
        }
        return false
    }

    fun acceptCameraResult(value: String) {
        if (value.isBlank()) return
        success()
        onScan(value.trim())
    }

    fun success() {
        tone.startTone(ToneGenerator.TONE_PROP_BEEP, 90)
        vibrate(40)
    }

    fun error() {
        tone.startTone(ToneGenerator.TONE_PROP_NACK, 140)
        vibrate(140)
    }

    private fun flush() {
        val value = buffer.toString().trim()
        buffer.clear()
        handler.removeCallbacks(flushRunnable)
        if (value.length >= 2) {
            success()
            onScan(value)
        }
    }

    private fun vibrate(ms: Long) {
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(ms)
        }
    }
}
