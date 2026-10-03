"""Local Flask API for the Lingua language-learning app."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

import requests
from flask import Flask, Response, jsonify, request, send_from_directory

# Standard HTTPS was more reliable than Hugging Face's optional Xet transfer
# backend during first-run model downloads, and supports resuming partial files.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

ROOT = Path(__file__).parent
DATABASE = Path(os.getenv("LINGUA_DB", ROOT / "lingua.db"))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3.5:0.8b")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
QWEN_TTS_MODEL = os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
QWEN_TTS_DEVICE = os.getenv("QWEN_TTS_DEVICE", "auto")
MAX_HISTORY_MESSAGES = 16
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
_whisper = None
_tts = None
_tts_device = None
_tts_lock = threading.Lock()
_tts_cache: dict[tuple[str, str], bytes] = {}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def init_database() -> None:
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS learning_moments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                context TEXT NOT NULL,
                intended_meaning TEXT NOT NULL,
                learner_attempt TEXT NOT NULL DEFAULT '',
                natural_expression TEXT NOT NULL,
                assistant_reply TEXT NOT NULL,
                translation TEXT NOT NULL,
                short_explanation TEXT NOT NULL,
                language TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                scenario TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                due_at TEXT NOT NULL,
                interval_days REAL NOT NULL DEFAULT 0,
                review_count INTEGER NOT NULL DEFAULT 0,
                last_rating TEXT
            )
        """)


def error_response(message: str, status: int):
    return jsonify(error=message), status


def clean(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def parse_tags(value: Any) -> list[str]:
    raw = value if isinstance(value, list) else str(value or "").split(",")
    tags: list[str] = []
    for item in raw:
        tag = clean(item, 30).lower().lstrip("#")
        if tag and tag not in tags:
            tags.append(tag)
    return tags[:8]


def row_to_card(row: sqlite3.Row) -> dict[str, Any]:
    card = dict(row)
    card["tags"] = json.loads(card["tags"] or "[]")
    card["is_due"] = card["due_at"] <= iso(utc_now())
    return card


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel(
            WHISPER_MODEL,
            device=os.getenv("WHISPER_DEVICE", "auto"),
            compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
        )
    return _whisper


def get_tts():
    """Lazily load the local Qwen3-TTS model on the best available device."""
    global _tts, _tts_device
    if _tts is None:
        import torch
        from huggingface_hub import snapshot_download
        from qwen_tts import Qwen3TTSModel

        if QWEN_TTS_DEVICE != "auto":
            device = QWEN_TTS_DEVICE

        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
        dtype = torch.float32
        model_source = QWEN_TTS_MODEL
        if not Path(model_source).exists():
            try:
                model_source = snapshot_download(model_source, local_files_only=True)
            except Exception:
                model_source = snapshot_download(model_source)
        _tts = Qwen3TTSModel.from_pretrained(
            model_source,
            device_map=device,
            dtype=dtype,
            attn_implementation="eager",
        )
        _tts_device = device
    return _tts


def tts_voice(language: str) -> tuple[str, str]:
    mapping = {
        "Mandarin Chinese": ("Chinese", "Vivian"),
        "Chinese": ("Chinese", "Vivian"),
        "Japanese": ("Japanese", "Ono_Anna"),
        "Korean": ("Korean", "Sohee"),
        "English": ("English", "Ryan"),
        "German": ("German", "Ryan"),
        "French": ("French", "Ryan"),
        "Spanish": ("Spanish", "Ryan"),
        "Italian": ("Italian", "Ryan"),
        "Portuguese": ("Portuguese", "Ryan"),
        "Russian": ("Russian", "Ryan"),
    }
    return mapping.get(language, ("Auto", "Ryan"))


def ollama_chat(messages: list[dict[str, str]], *, json_mode: bool = False) -> str:
    payload: dict[str, Any] = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "messages": messages,
        "options": {"temperature": 0.65, "num_predict": 260},
    }
    if json_mode:
        payload["format"] = "json"
    try:
        response = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=120)
        response.raise_for_status()
        answer = clean(response.json().get("message", {}).get("content"), 8000)
        if not answer:
            raise ValueError("Qwen returned an empty response.")
        return answer
    except requests.ConnectionError as exc:
        raise RuntimeError("Ollama is not running. Start it, then try again.") from exc
    except requests.Timeout as exc:
        raise TimeoutError("Qwen took too long to respond. Please try again.") from exc


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:filename>")
def assets(filename: str):
    if filename not in {"styles.css", "app.js"}:
        return error_response("Not found.", 404)
    return send_from_directory(ROOT, filename)


@app.get("/api/health")
def health():
    try:
        response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=2)
        response.raise_for_status()
        names = [model.get("name", "") for model in response.json().get("models", [])]
        ready = any(
            name == OLLAMA_MODEL or name.startswith(f"{OLLAMA_MODEL}:")
            for name in names
        )
        return jsonify(
            ollama=ready,
            server=True,
            model=OLLAMA_MODEL,
            tts="Qwen3-TTS",
            tts_loaded=_tts is not None,
        )
    except requests.RequestException:
        return jsonify(
            ollama=False,
            server=True,
            model=OLLAMA_MODEL,
            tts="Qwen3-TTS",
            tts_loaded=_tts is not None,
        )


@app.post("/api/speak")
def speak():
    payload = request.get_json(silent=True) or {}
    text = clean(payload.get("text"), 2000)
    language = clean(payload.get("language", "Auto"), 40)
    if not text:
        return error_response("Text is required.", 400)
    try:
        import soundfile as sf

        model_language, speaker = tts_voice(language)
        cache_key = (text, model_language)
        with _tts_lock:
            audio = _tts_cache.get(cache_key)
            if audio is None:
                wavs, sample_rate = get_tts().generate_custom_voice(
                    text=text,
                    language=model_language,
                    speaker=speaker,
                    do_sample=False,
                )
                output = BytesIO()
                sf.write(output, wavs[0], sample_rate, format="WAV")
                audio = output.getvalue()
                if len(_tts_cache) >= 32:
                    _tts_cache.pop(next(iter(_tts_cache)))
                _tts_cache[cache_key] = audio
        return Response(audio, content_type="audio/wav")
    except ImportError:
        return error_response(
            "Local speech is not installed. Run: pip install -r requirements.txt", 503
        )
    except Exception as exc:
        app.logger.exception("Qwen3-TTS generation failed")
        return error_response(f"Local speech generation failed: {exc}", 500)


@app.post("/api/chat")
def chat():
    payload = request.get_json(silent=True) or {}
    target = clean(payload.get("targetLanguage", "English"), 40)
    native = clean(payload.get("nativeLanguage", "English"), 40)
    level = clean(payload.get("difficulty", "Beginner"), 30)
    scenario = clean(payload.get("scenario", "Everyday conversation"), 120)
    raw = payload.get("messages", [])
    if not isinstance(raw, list) or not raw:
        return error_response("Send at least one message.", 400)
    messages = []
    for item in raw[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
            continue
        content = clean(item.get("content"))
        if content:
            messages.append({"role": item["role"], "content": content})
    if not messages:
        return error_response("No valid messages were provided.", 400)
    system = (
        f"You are a warm, patient {target} conversation partner. The learner speaks {native}, "
        f"is at {level} level, and is practicing this situation: {scenario}. Reply only in {target}. "
        "Use natural language appropriate to the level, keep replies to 1-3 short sentences, and end "
        "with one conversational opening when appropriate. Gently model corrections without explaining "
        "them in the learner's native language. Do not use markdown or stage directions. /no_think"
    )
    try:
        return jsonify(
            message=ollama_chat([{"role": "system", "content": system}, *messages])
        )
    except RuntimeError as exc:
        return error_response(str(exc), 503)
    except TimeoutError as exc:
        return error_response(str(exc), 504)
    except (requests.RequestException, ValueError) as exc:
        return error_response(f"Ollama request failed: {exc}", 502)


@app.post("/api/help-me-say")
def help_me_say():
    payload = request.get_json(silent=True) or {}
    target = clean(payload.get("targetLanguage", "English"), 40)
    native = clean(payload.get("nativeLanguage", "English"), 40)
    level = clean(payload.get("difficulty", "Beginner"), 30)
    scenario = clean(payload.get("scenario", "Everyday conversation"), 120)
    intended = clean(payload.get("intendedMeaning"))
    attempt = clean(payload.get("learnerAttempt"))
    context = clean(payload.get("context"))
    if not intended:
        return error_response("Describe what you want to say.", 400)
    system = (
        f"You help a {level} learner say one thing naturally in {target}. Their known language is {native}. "
        "Return valid JSON only with these string keys: naturalExpression, assistantReply, translation, "
        "shortExplanation. naturalExpression is what the learner should say. assistantReply is a short "
        f"natural reply in {target}. translation gives the meaning in {native}. shortExplanation is a "
        f"concise explanation in {native}. Situation: {scenario}. /no_think"
    )
    user = f"Recent conversation:\n{context or '(none)'}\n\nI mean:\n{intended}\n\nMy attempt:\n{attempt or '(none)'}"
    try:
        result = json.loads(
            ollama_chat(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                json_mode=True,
            )
        )
        required = (
            "naturalExpression",
            "assistantReply",
            "translation",
            "shortExplanation",
        )
        output = {key: clean(result.get(key)) for key in required}
        if not all(output.values()):
            raise ValueError("The learning suggestion was incomplete.")
        return jsonify(output)
    except RuntimeError as exc:
        return error_response(str(exc), 503)
    except TimeoutError as exc:
        return error_response(str(exc), 504)
    except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
        return error_response(f"Could not create a learning moment: {exc}", 502)


@app.get("/api/cards")
def list_cards():
    query = clean(request.args.get("q"), 100).lower()
    tag = clean(request.args.get("tag"), 30).lower().lstrip("#")
    due_only = request.args.get("due") == "1"
    clauses, values = [], []
    if query:
        clauses.append(
            "lower(context || ' ' || intended_meaning || ' ' || natural_expression || ' ' || translation || ' ' || short_explanation) LIKE ?"
        )
        values.append(f"%{query}%")
    if tag:
        clauses.append("tags LIKE ?")
        values.append(f'%"{tag}"%')
    if due_only:
        clauses.append("due_at <= ?")
        values.append(iso(utc_now()))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    order = "due_at ASC" if due_only else "created_at DESC"
    with connect() as db:
        rows = db.execute(
            f"SELECT * FROM learning_moments {where} ORDER BY {order}", values
        ).fetchall()
    return jsonify(cards=[row_to_card(row) for row in rows])


@app.post("/api/cards")
def create_card():
    payload = request.get_json(silent=True) or {}
    fields = {
        "context": clean(payload.get("context")),
        "intended_meaning": clean(payload.get("intendedMeaning")),
        "learner_attempt": clean(payload.get("learnerAttempt")),
        "natural_expression": clean(payload.get("naturalExpression")),
        "assistant_reply": clean(payload.get("assistantReply")),
        "translation": clean(payload.get("translation")),
        "short_explanation": clean(payload.get("shortExplanation")),
        "language": clean(payload.get("language"), 40),
        "difficulty": clean(payload.get("difficulty"), 30),
        "scenario": clean(payload.get("scenario"), 120),
    }
    required = (
        "intended_meaning",
        "natural_expression",
        "assistant_reply",
        "translation",
        "language",
    )
    if not all(fields[name] for name in required):
        return error_response("The learning moment is missing required fields.", 400)
    now = iso(utc_now())
    tags = json.dumps(parse_tags(payload.get("tags")), ensure_ascii=False)
    columns = ", ".join([*fields, "tags", "created_at", "due_at"])
    placeholders = ", ".join("?" for _ in range(len(fields) + 3))
    with connect() as db:
        cursor = db.execute(
            f"INSERT INTO learning_moments ({columns}) VALUES ({placeholders})",
            [*fields.values(), tags, now, now],
        )
        row = db.execute(
            "SELECT * FROM learning_moments WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return jsonify(card=row_to_card(row)), 201


@app.patch("/api/cards/<int:card_id>")
def update_card(card_id: int):
    payload = request.get_json(silent=True) or {}
    if "tags" not in payload:
        return error_response("Only tags can be updated here.", 400)
    tags = json.dumps(parse_tags(payload["tags"]), ensure_ascii=False)
    with connect() as db:
        cursor = db.execute(
            "UPDATE learning_moments SET tags = ? WHERE id = ?", (tags, card_id)
        )
        if not cursor.rowcount:
            return error_response("Card not found.", 404)
        row = db.execute(
            "SELECT * FROM learning_moments WHERE id = ?", (card_id,)
        ).fetchone()
    return jsonify(card=row_to_card(row))


@app.delete("/api/cards/<int:card_id>")
def delete_card(card_id: int):
    with connect() as db:
        cursor = db.execute("DELETE FROM learning_moments WHERE id = ?", (card_id,))
    return ("", 204) if cursor.rowcount else error_response("Card not found.", 404)


@app.post("/api/cards/<int:card_id>/review")
def review_card(card_id: int):
    rating = clean((request.get_json(silent=True) or {}).get("rating"), 20).lower()
    if rating not in {"forgot", "hard", "correct"}:
        return error_response("Rating must be forgot, hard, or correct.", 400)
    with connect() as db:
        row = db.execute(
            "SELECT * FROM learning_moments WHERE id = ?", (card_id,)
        ).fetchone()
        if row is None:
            return error_response("Card not found.", 404)
        old_interval = float(row["interval_days"])
        if rating == "forgot":
            interval = 0.007
        elif rating == "hard":
            interval = max(1, round(old_interval * 1.5, 2))
        else:
            interval = 1 if old_interval < 1 else min(180, round(old_interval * 2.5, 2))
        due_at = iso(utc_now() + timedelta(days=interval))
        db.execute(
            "UPDATE learning_moments SET interval_days=?, due_at=?, review_count=review_count+1, last_rating=? WHERE id=?",
            (interval, due_at, rating, card_id),
        )
        updated = db.execute(
            "SELECT * FROM learning_moments WHERE id = ?", (card_id,)
        ).fetchone()
    return jsonify(card=row_to_card(updated))


@app.post("/api/transcribe")
def transcribe():
    upload = request.files.get("audio")
    if upload is None or not upload.filename:
        return error_response("No audio recording was received.", 400)
    language = clean(request.form.get("language", "en"), 8)
    suffix = Path(upload.filename).suffix or ".webm"
    temp_path = None
    try:
        with NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            upload.save(temp)
            temp_path = temp.name
        segments, _ = get_whisper().transcribe(
            temp_path,
            language=language,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return (
            jsonify(text=text)
            if text
            else error_response("No speech was detected. Please try again.", 422)
        )
    except Exception as exc:
        app.logger.exception("Whisper transcription failed")
        return error_response(f"Whisper transcription failed: {exc}", 500)
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


init_database()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "8000")), debug=False)
