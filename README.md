# Tap Tap for Android

An Android rhythm game modelled on *Tap Tap Revenge 3* (iOS): three lanes, notes falling to a hit line,
hold notes, a streak multiplier up to x4, and PERFECT / GREAT / GOOD / MISS judging.

This is a clean re-implementation. It contains **no** code or assets from the original game.

## What is in the repo

| Path | Purpose |
|---|---|
| `core/` | Pure Kotlin game logic: chart model, scoring (`Judge`), built-in demo song. Unit-tested. |
| `app/` | Android UI: menu, `GameView` (SurfaceView renderer + touch), audio via `MediaPlayer`. |
| `tools/ipa_to_assets.py` | Converts the tracks of a TTR3 `.ipa` into charts + audio the app can play. |

A built-in original demo song ("Neon Pulse", 4 difficulties) is generated at runtime, so the app is playable
as is.

## Using the songs from your own TTR3 IPA

The reverse-engineered facts behind the converter (found with [rea](https://github.com/morluto/rea) and
plain parsing of the bundle):

* Each `Tracks/<uuid>.track/` holds `audio.m4a`, `artwork.png`, `info.plist` and `taptrack.ttr2_track`.
* `taptrack.ttr2_track` is an `NSKeyedArchiver` binary plist: one entry per difficulty (1-4) with an embedded
  Standard MIDI File (`rawData`, division 9600, tempo map in meta events).
* Notes are MIDI pitches 60/61, 62/63, 64/65 = left / centre / right lane. Long notes become hold notes.
* The screen is 320x480 points; lanes are at x = 55.5 / 160 / 263 and the hit line is near y = 427.

```sh
python3 tools/ipa_to_assets.py path/to/game.ipa      # writes into app/src/main/assets (git-ignored)
./gradlew :app:assembleDebug
```

The converted songs and artwork are copyrighted by their owners, so they are git-ignored. Build the APK
locally for personal use and do not redistribute it.

## Build

Requires JDK 17 and the Android SDK (`ANDROID_HOME`). `./gradlew :core:test` runs the logic tests,
`./gradlew :app:assembleDebug` produces `app/build/outputs/apk/debug/app-debug.apk`. The GitHub Actions
workflow does the same on every push and uploads the APK.

## Controls

Tap a lane when a note reaches the ring. Keep your finger down for hold notes. Back pauses.
