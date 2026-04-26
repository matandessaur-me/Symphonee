# Video Use plugin

Conversation-driven video editor. The LLM never *watches* video - it
*reads* a packed transcript (`takes_packed.md`) and asks for visual drilldown
PNGs (`timeline_view`) at decision points. Cuts come from speech boundaries
and silence gaps, baked into an EDL JSON, executed via ffmpeg.

Pattern ported from https://github.com/browser-use/video-use (MIT). Native
Node implementation - no Python dependency at runtime.

## Routes (all under `/api/plugins/video-use/`)

- `GET  /health` - liveness check + ffmpeg detection.
- `POST /inventory` - body `{ folder }`. Returns the list of source video
  files (mp4/mov/mkv/webm/avi) with duration + dimensions.
- `POST /transcribe` - body `{ video, editDir?, language?, provider? }`.
  Provider is `auto` (default), `whisper`, or `elevenlabs`. Writes
  `<editDir>/transcripts/<stem>.json`. Cached.
- `POST /transcribe-batch` - body `{ folder, editDir?, provider? }`.
  Transcribes every video in the folder (cached).
- `POST /pack` - body `{ editDir, silenceThreshold? }`. Writes
  `<editDir>/takes_packed.md` from all transcripts.
- `POST /timeline-view` - body `{ video, start, end, nFrames?, transcript?, out? }`.
  Filmstrip + waveform PNG composite. The on-demand visual drilldown.
- `POST /render` - body `{ edl, output? }` or `{ edlPath, output? }`.
  Executes the EDL with 30ms audio fades and optional subtitle burn-in.
- `POST /grade` - body `{ video, preset?, filter?, out? }`. Apply a color
  grade preset or a raw ffmpeg filter chain.

## EDL schema

```json
{
  "version": 1,
  "sources": {
    "C0103": "/abs/path/to/clip01.mp4",
    "C0104": "/abs/path/to/clip02.mp4"
  },
  "segments": [
    { "source": "C0103", "in": 2.52, "out": 8.40, "grade": "warm" },
    { "source": "C0104", "in": 0.10, "out": 14.20, "grade": "auto" }
  ],
  "subtitles": {
    "enabled": true,
    "style": "uppercase-2word"
  },
  "audioFadeMs": 30
}
```

- `sources`: stable IDs to source paths so segment lists stay readable.
- `segments`: ordered list of cuts. `in`/`out` are seconds in the source.
- `grade`: preset name, raw ffmpeg filter, "auto", or omitted.
- `subtitles.enabled`: when true, the renderer builds a master SRT from the
  per-source transcripts (must be transcribed first) and burns it.

## Daily flow

1. User drops raw footage in a folder.
2. Agent calls `/inventory` to list takes.
3. Agent calls `/transcribe-batch` to transcribe every source.
4. Agent calls `/pack` to build `takes_packed.md`.
5. Agent reads `takes_packed.md`, drafts an EDL, posts to `/render`.
6. After render, agent (optionally) calls `/timeline-view` on the output to
   self-evaluate cut boundaries before showing the user.

## Transcription providers

- `auto` (default): try `whisper-cli` (whisper.cpp), then `whisper`
  (OpenAI Python), then ElevenLabs if configured. Errors out if all fail.
- `whisper`: force local. Requires `whisper-cli` or `whisper` on PATH.
- `elevenlabs`: force ElevenLabs Scribe. Requires `ElevenLabsApiKey` in
  plugin settings.

Local Whisper output is normalised to the same shape as Scribe so packing
works either way: `{ words: [{ start, end, text, type, speaker_id? }] }`.

## ffmpeg requirement

`ffmpeg` and `ffprobe` must be installed and either on PATH or pointed to
via the `FfmpegPath`/`FfprobePath` plugin settings. The plugin does not
bundle ffmpeg.

## Source

- Concept: github.com/browser-use/video-use (MIT).
- Renderer + pack/transcribe logic: native Node port at `lib/`.
- Cloned reference at `.ai-workspace/research/browser-video/video-use/`.
