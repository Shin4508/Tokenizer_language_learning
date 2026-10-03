# Lingua

Lingua is a language-practice app that turns moments from a local AI conversation into spaced-repetition cards. This build implements the browser MVP and the Phase 2 learning workflow described in `plan.md`. Speech uses the Apache-2.0 [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) model locally.

## What is included

- Setup by target language, native language, level, and situation
- Target-language chat through Qwen running in Ollama
- “How do I say…” suggestions with a natural phrase, likely reply, translation, and explanation
- One-tap saving of a conversation block as a learning moment
- SQLite persistence, search, tags, and card deletion
- Due-card review with **Forgot**, **Hard**, and **Got it** intervals
- Microphone transcription with local Whisper
- Reply and card audio with the local open-source Qwen3-TTS 0.6B model
- Responsive Setup, Practice, Moments, and Review screens

Conversation history remains in the browser session. Only saved learning moments are written to `lingua.db`. Chat, transcription, and speech generation stay on this computer.

## Run locally

Install [Ollama](https://ollama.com/download), pull the model, and create a Python environment:

```sh
ollama pull qwen3.5:0.8b
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the server with `python server.py`.

Open <http://127.0.0.1:8000>. Ollama must also be running. The first Listen action downloads Qwen3-TTS 0.6B from Hugging Face, and the first microphone transcription downloads Whisper, so both take longer than later uses.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL` | `qwen3.5:0.8b` | Local chat model |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server |
| `QWEN_TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | Local speech model or downloaded model directory |
| `QWEN_TTS_DEVICE` | `auto` | Speech device: `auto`, `cpu`, `mps`, or `cuda:0` |
| `WHISPER_MODEL` | `base` | Local transcription model |
| `WHISPER_DEVICE` | `auto` | Whisper compute device |
| `WHISPER_COMPUTE_TYPE` | `int8` | Whisper quantization |
| `LINGUA_DB` | `./lingua.db` | SQLite database path |
| `PORT` | `8000` | Local HTTP port |

The app selects Qwen3-TTS's native `Sohee` voice for Korean, `Ono_Anna` for Japanese, `Vivian` for Chinese, and `Ryan` for the other supported languages. Override `QWEN_TTS_DEVICE=cpu` if your accelerator is unsupported.

## Review scheduling

New cards are due immediately. **Forgot** returns a card in about ten minutes, **Hard** uses a short interval, and **Got it** expands the interval up to 180 days. The schedule and review count are stored with each card.
