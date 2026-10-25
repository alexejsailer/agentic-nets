# Local speech service (dictation and reading for Studio)

Open source, on this machine, nothing leaves it. Studio's Focus view reads cards aloud and takes
dictation through the gateway route `/speech-api`, which proxies to this service.

```
Studio ──/speech-api──▶ gateway ──SPEECH_URL──▶ speech_service.py ──▶ whisper-cli (STT), piper (TTS)
```

## Install (macOS, Apple silicon)

```bash
brew install whisper-cpp ffmpeg              # whisper-cli with Metal; ffmpeg converts the browser's clip
mkdir -p ~/.agenticos/speech/voices
# a Whisper model: small (fast, ~470 MB) or large-v3-turbo (best, ~1.6 GB)
curl -L -o ~/.agenticos/speech/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# Piper and one voice per language you dictate in (each ~60 MB: the .onnx and its .json side by side)
python3.12 -m venv ~/.agenticos/speech/venv && ~/.agenticos/speech/venv/bin/pip install piper-tts   # the service finds this venv by itself
for f in en_US-lessac-medium.onnx en_US-lessac-medium.onnx.json; do
  curl -L -o ~/.agenticos/speech/voices/$f https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/$f; done
for f in de_DE-thorsten-medium.onnx de_DE-thorsten-medium.onnx.json; do
  curl -L -o ~/.agenticos/speech/voices/$f https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/$f; done
```

Without Piper the service reads with macOS `say` (local, not open source) so reading works at once.

## Run

```bash
python3 deployment/speech/speech_service.py          # http://127.0.0.1:8092, GET /health shows what it found
SPEECH_URL=http://127.0.0.1:8092 ...                  # on the gateway (gateway.speech-url); Desktop: desktop.properties
```

In Studio's Focus view pick "local speech service" in the voice box. `R` reads the card, `Esc` stops,
the microphone next to every text box dictates (press, speak, press again; the clip is transcribed
when you stop). The "browser voice" setting uses the OS voices and the browser's own recognition
instead (the browser sends that audio to its vendor).

## API

| Call | In | Out |
|---|---|---|
| `POST /transcribe` | multipart `file` (webm/ogg/wav/m4a), `language` (`en`, `de`, `auto`) | `{text, language, seconds}` |
| `POST /speak` | JSON `{text, voice?, lang?, rate?}` | `audio/wav` |
| `GET /health` | | `{ok, stt, tts, voices}` |

Environment: `SPEECH_PORT` (8092), `WHISPER_MODEL`, `WHISPER_THREADS`, `PIPER_VOICES`, `PIPER_VOICE`,
`SAY_FALLBACK` (true). Quality: `ggml-small` is near instant and fine for short answers;
`ggml-large-v3-turbo` for long dictation in mixed languages.

## As a lane

The same binary serves nets: a command transition on the executor runs
`whisper-cli -m <model> -f <clip.wav> -nt -np` and emits the transcript as a token, so a voice memo
dropped into a place becomes a brief note on a subject. The service above is only the live path.
