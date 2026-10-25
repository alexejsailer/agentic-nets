#!/usr/bin/env python3
"""The local speech service behind the gateway's /speech-api: dictation and reading, on this machine.

Two endpoints, both plain HTTP, no auth (the gateway in front has the JWT; bind to loopback):

  POST /transcribe   multipart form: file=<audio clip, any ffmpeg-readable format>, language=en|de|...
                     -> {"text": "...", "language": "de", "seconds": 1.9}
  POST /speak        JSON {"text": "...", "voice": "<piper voice id>", "lang": "en-US", "rate": 1.0}
                     -> audio/wav
  GET  /health       -> {"ok": true, "stt": "...", "tts": "..."}

Backends (open source, on device):
  STT  whisper.cpp:  `whisper-cli` (brew install whisper-cpp) with a ggml model (WHISPER_MODEL),
       Metal on Apple silicon. Audio is converted to 16 kHz mono WAV with ffmpeg first.
  TTS  Piper:        `piper` (pip install piper-tts) with a voice .onnx + .json (PIPER_VOICE, or a
       voices directory PIPER_VOICES and the request's voice id). Falls back to macOS `say` when
       Piper is absent, so reading works before any model is downloaded (not open source, but local).

Environment:
  SPEECH_PORT (8092)  SPEECH_HOST (127.0.0.1)
  WHISPER_CLI (whisper-cli)  WHISPER_MODEL (~/.agenticos/speech/ggml-small.bin)  WHISPER_THREADS (4)
  PIPER_BIN (piper)  PIPER_VOICES (~/.agenticos/speech/voices)  PIPER_VOICE (default voice id, e.g. en_US-lessac-medium)
  FFMPEG (ffmpeg)  SAY_FALLBACK (true)

Start:  python3 speech_service.py
Gateway: SPEECH_URL=http://127.0.0.1:8092 (gateway.speech-url); Studio: Focus view, voice "local speech service".
Standard library only; the work is done by the binaries.
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SPEECH_PORT", "8092"))
HOST = os.environ.get("SPEECH_HOST", "127.0.0.1")
WHISPER_CLI = os.environ.get("WHISPER_CLI", "whisper-cli")
WHISPER_MODEL = os.path.expanduser(os.environ.get("WHISPER_MODEL", "~/.agenticos/speech/ggml-small.bin"))
WHISPER_THREADS = os.environ.get("WHISPER_THREADS", "4")
def _piper_default():
    # The README installs Piper into a venv next to the models; use it before anything on PATH.
    venv = os.path.expanduser("~/.agenticos/speech/venv/bin/piper")
    return venv if os.path.isfile(venv) else "piper"


PIPER_BIN = os.environ.get("PIPER_BIN", _piper_default())
PIPER_VOICES = os.path.expanduser(os.environ.get("PIPER_VOICES", "~/.agenticos/speech/voices"))
PIPER_VOICE = os.environ.get("PIPER_VOICE", "")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
SAY_FALLBACK = os.environ.get("SAY_FALLBACK", "true").lower() == "true"


def have(binary):
    return os.path.isfile(binary) and os.access(binary, os.X_OK) or shutil.which(binary) is not None


def status():
    stt = f"whisper.cpp ({WHISPER_CLI}, model {os.path.basename(WHISPER_MODEL)})" if have(WHISPER_CLI) and os.path.isfile(WHISPER_MODEL) else None
    if not stt:
        stt_missing = [] if have(WHISPER_CLI) else [f"{WHISPER_CLI} not on PATH (brew install whisper-cpp)"]
        if not os.path.isfile(WHISPER_MODEL):
            stt_missing.append(f"model {WHISPER_MODEL} missing (see README: download a ggml model)")
    else:
        stt_missing = []
    tts = f"piper ({PIPER_BIN})" if have(PIPER_BIN) else ("macOS say (fallback, not open source)" if SAY_FALLBACK and have("say") else None)
    return {"ok": bool(stt or tts), "stt": stt, "sttMissing": stt_missing, "tts": tts, "ffmpeg": have(FFMPEG),
            "voices": piper_voices()}


def piper_voices():
    out = []
    if os.path.isdir(PIPER_VOICES):
        for name in sorted(os.listdir(PIPER_VOICES)):
            if name.endswith(".onnx") and os.path.isfile(os.path.join(PIPER_VOICES, name + ".json")):
                out.append(name[:-5])
    return out


# ------------------------------------------------------------------------------------------ STT

def transcribe(clip, language):
    """Audio bytes in, text out: ffmpeg to 16 kHz mono WAV, then whisper-cli."""
    if not have(WHISPER_CLI):
        raise RuntimeError(f"{WHISPER_CLI} is not installed (brew install whisper-cpp)")
    if not os.path.isfile(WHISPER_MODEL):
        raise RuntimeError(f"whisper model {WHISPER_MODEL} is missing; see deployment/speech/README.md")
    if not have(FFMPEG):
        raise RuntimeError("ffmpeg is not installed (brew install ffmpeg); it converts the browser's clip to 16 kHz WAV")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "clip")
        wav = os.path.join(tmp, "clip.wav")
        with open(src, "wb") as f:
            f.write(clip)
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
                       check=True, capture_output=True, timeout=120)
        cmd = [WHISPER_CLI, "-m", WHISPER_MODEL, "-f", wav, "-t", WHISPER_THREADS, "-nt", "-np", "-oj", "-of", os.path.join(tmp, "out")]
        if language and language != "auto":
            cmd += ["-l", language]
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        with open(os.path.join(tmp, "out.json"), encoding="utf-8") as f:
            res = json.load(f)
        text = " ".join(seg.get("text", "").strip() for seg in res.get("transcription", [])).strip()
        text = re.sub(r"\s+", " ", text)
        detected = (res.get("result") or {}).get("language") or language
        return text, detected


# ------------------------------------------------------------------------------------------ TTS

def speak(text, voice, lang, rate):
    """Text in, WAV bytes out: Piper when present, else macOS say."""
    if have(PIPER_BIN):
        model = None
        candidates = [voice, PIPER_VOICE] + [v for v in piper_voices() if v.startswith((lang or "en").split("-")[0].lower())] + piper_voices()
        for c in candidates:
            if c and os.path.isfile(os.path.join(PIPER_VOICES, c + ".onnx")):
                model = os.path.join(PIPER_VOICES, c + ".onnx")
                break
        if not model:
            raise RuntimeError(f"no Piper voice in {PIPER_VOICES}; download one (README) or set PIPER_VOICE")
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "out.wav")
            length = str(1.0 / max(0.5, min(2.0, float(rate or 1.0))))
            subprocess.run([PIPER_BIN, "--model", model, "--output_file", wav, "--length_scale", length],
                           input=text.encode("utf-8"), check=True, capture_output=True, timeout=300)
            with open(wav, "rb") as f:
                return f.read()
    if SAY_FALLBACK and have("say"):
        with tempfile.TemporaryDirectory() as tmp:
            aiff = os.path.join(tmp, "out.aiff")
            wav = os.path.join(tmp, "out.wav")
            cmd = ["say", "-o", aiff, "-r", str(int(175 * float(rate or 1.0)))]
            if voice:
                cmd += ["-v", voice]
            subprocess.run(cmd, input=text.encode("utf-8"), check=True, capture_output=True, timeout=300)
            if have(FFMPEG):
                subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", aiff, wav], check=True, capture_output=True, timeout=120)
                with open(wav, "rb") as f:
                    return f.read()
            with open(aiff, "rb") as f:
                return f.read()
    raise RuntimeError(f"no voice: install Piper ({PIPER_BIN}) and a voice, see deployment/speech/README.md")


# ------------------------------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "agenticnets-speech/0.1"

    def log_message(self, fmt, *args):  # one line per request, no client address noise
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/"):
            self._json(200, status())
        else:
            self._json(404, {"error": "unknown path"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        try:
            if path == "/transcribe":
                clip, fields = parse_multipart(self.headers.get("Content-Type", ""), body)
                if not clip:
                    return self._json(400, {"error": "multipart field 'file' with the audio clip is required"})
                t0 = time.time()
                text, detected = transcribe(clip, fields.get("language", "auto"))
                return self._json(200, {"text": text, "language": detected, "seconds": round(time.time() - t0, 2)})
            if path == "/speak":
                req = json.loads(body.decode("utf-8") or "{}")
                text = str(req.get("text", "")).strip()
                if not text:
                    return self._json(400, {"error": "text is required"})
                wav = speak(text[:5000], req.get("voice"), req.get("lang"), req.get("rate"))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
                return None
            return self._json(404, {"error": "unknown path"})
        except subprocess.CalledProcessError as e:
            return self._json(502, {"error": f"{e.cmd[0]} failed: {(e.stderr or b'').decode('utf-8', 'replace')[-400:]}"})
        except Exception as e:  # noqa: BLE001
            return self._json(503, {"error": str(e)})


def parse_multipart(content_type, body):
    """The one multipart shape the browser sends: a file field and a few text fields."""
    m = re.search(r"boundary=([^;]+)", content_type or "")
    if not m:
        return body, {}  # a raw audio body is accepted too
    boundary = m.group(1).strip().strip('"').encode()
    clip = None
    fields = {}
    for part in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        data = data.rstrip(b"\r\n").removesuffix(b"--")
        name = re.search(rb'name="([^"]+)"', head)
        if not name:
            continue
        if b"filename=" in head:
            clip = data
        else:
            fields[name.group(1).decode()] = data.decode("utf-8", "replace").strip()
    return clip, fields


if __name__ == "__main__":
    st = status()
    print(f"speech service on http://{HOST}:{PORT}  stt={st['stt']}  tts={st['tts']}  voices={st['voices']}", flush=True)
    for miss in st.get("sttMissing", []):
        print("  note:", miss, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
