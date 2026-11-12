# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "mlx-whisper",
#   "parakeet-mlx>=0.5",
#   "pyannote.audio>=4.0",
#   "soundfile",
# ]
# ///
"""
Local multi-speaker transcription for Apple Silicon.

  audio file -> ffmpeg (16 kHz mono WAV, loudness evened out)
             -> mlx-whisper or Parakeet (words + timestamps)
             -> pyannote community-1 (who spoke when) -> merged transcript

Nothing is uploaded. Models are downloaded from Hugging Face on first run only.

Usage:
  uv run transcribe.py meeting.wav
  uv run transcribe.py meeting.mp3 --speakers 3 --language en
  uv run transcribe.py meeting.m4a --engine parakeet --min-speakers 4 --max-speakers 8
  uv run transcribe.py folder_of_recordings/        # processes every audio file in it

Outputs, next to each input file:
  <name>.transcript.txt   readable transcript with speaker labels and timestamps
  <name>.transcript.json  the same, structured, for later processing
With --overwrite, a transcript already there is moved into .transcripts/ beside
it first (hidden, so the server's folder scan never takes it for a recording).
"""

import argparse
import faulthandler
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

# PyTorch leaves a semaphore behind at exit, which makes Python's resource tracker print a
# harmless "leaked semaphore objects" warning. The tracker is a separate process that reads
# PYTHONWARNINGS at startup, so set it here, before torch is imported.
os.environ.setdefault("PYTHONWARNINGS", "ignore::UserWarning:multiprocessing.resource_tracker")

# Whisper's word timestamps use numba. With PyTorch's OpenMP libraries installed alongside
# (pulled in by pyannote), numba picks an OpenMP threading layer that segfaults on macOS.
# The plain "workqueue" layer avoids that. Must be set before mlx_whisper (numba) is imported.
os.environ.setdefault("NUMBA_THREADING_LAYER", "workqueue")

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".webm"}
WHISPER_MODELS = {
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large": "mlx-community/whisper-large-v3-mlx",
}
# NVIDIA Parakeet TDT 0.6B in MLX. v3 is multilingual (English, French and 23 other European
# languages, detected on its own); v2 is English only. Neither takes a vocabulary prompt.
PARAKEET_MODELS = {
    "v3": "mlx-community/parakeet-tdt-0.6b-v3",
    "v2": "mlx-community/parakeet-tdt-0.6b-v2",
}
# parakeet-mlx's own defaults for long audio: two-minute windows, overlapping by 15 seconds.
PARAKEET_CHUNK_S = 120.0
PARAKEET_OVERLAP_S = 15.0
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
# Even out the loudness of a far-field recording, and cut rumble below 60 Hz. No denoising:
# on a far-field panel recording, afftdn made Whisper worse (misheard terms, a hallucination loop).
AUDIO_FILTER = "highpass=f=60,loudnorm=I=-18:TP=-2:LRA=11"
# A turn this short (in words) is most often diarization splitting a phrase ("Thank" / "you.").
FRAGMENT_WORDS = 2
# Words further apart than this (seconds) start a new utterance, even from the same speaker.
TURN_GAP = 2.0
ARCHIVE_DIR = ".transcripts"


def to_wav16k(src: Path, dst: Path) -> None:
    """Convert any audio/video file to 16 kHz mono 16-bit WAV, which every model here expects."""
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
           "-af", AUDIO_FILTER, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)]
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit("ffmpeg not found. Install it with:  brew install ffmpeg")


def transcribe_whisper(wav: Path, model: str, language: str | None, prompt: str | None) -> list[dict]:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        str(wav),
        path_or_hf_repo=WHISPER_MODELS[model],
        word_timestamps=True,
        language=language,
        # Names and terms to expect (the server sends speaker names and your glossary).
        initial_prompt=prompt or None,
        # These three stop the loops a long far-field recording falls into ("the same word, the same word, the same word…"):
        # each window starts fresh, a repetitive one is retried, and words over long silence are dropped.
        condition_on_previous_text=False,
        compression_ratio_threshold=2.2,
        hallucination_silence_threshold=2.0,
        verbose=False,
    )
    return whisper_words(result)


def whisper_words(result: dict) -> list[dict]:
    """mlx-whisper's segments to the shared word list: {text, start, end}, text with its leading space."""
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({"text": w["word"], "start": float(w["start"]), "end": float(w["end"])})
    return words


def transcribe_parakeet(wav: Path, model: str) -> list[dict]:
    from parakeet_mlx import from_pretrained

    parakeet = from_pretrained(PARAKEET_MODELS[model])
    result = parakeet.transcribe(str(wav), chunk_duration=PARAKEET_CHUNK_S, overlap_duration=PARAKEET_OVERLAP_S)
    return parakeet_words(result.tokens)


def parakeet_words(tokens) -> list[dict]:
    """
    Parakeet's tokens (word pieces, each with start and duration) to the same word list Whisper gives.
    A piece that starts with a space starts a word; the others ("ing", ",") belong to the word before.
    """
    words: list[dict] = []
    for t in tokens:
        text = t.text
        start = float(t.start)
        end = float(getattr(t, "end", 0.0) or start + float(t.duration))
        if not text:
            continue
        if words and not text.startswith(" "):
            words[-1]["text"] += text
            words[-1]["end"] = max(words[-1]["end"], end)
        elif text.strip():
            words.append({"text": text if text.startswith(" ") else f" {text}", "start": start, "end": end})
    return words


def load_pipeline():
    # pyannote 4 sends anonymous usage telemetry by default; switch it off for confidential work.
    os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")
    try:
        from pyannote.audio.telemetry import set_telemetry_metrics
        set_telemetry_metrics(False)
    except Exception:
        pass

    from pyannote.audio import Pipeline

    # Uses HF_TOKEN if set, otherwise the token saved by `hf auth login`.
    pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, token=os.environ.get("HF_TOKEN"))
    if pipeline is None:
        sys.exit(
            "Could not load the diarization model. Check that you accepted the conditions at\n"
            "  https://huggingface.co/pyannote/speaker-diarization-community-1\n"
            "and logged in with:  hf auth login"
        )
    return pipeline


def diarize(pipeline, wav: Path, speakers: int | None, min_speakers: int | None,
            max_speakers: int | None, device: str) -> list[dict]:
    import soundfile as sf
    import torch

    data, sr = sf.read(str(wav), dtype="float32")
    audio = {"waveform": torch.from_numpy(data).unsqueeze(0), "sample_rate": sr}

    kwargs = {}
    if speakers:
        kwargs["num_speakers"] = speakers
    else:
        if min_speakers:
            kwargs["min_speakers"] = min_speakers
        if max_speakers:
            kwargs["max_speakers"] = max_speakers

    def run(dev: str):
        pipeline.to(torch.device(dev))
        return pipeline(audio, **kwargs)

    if device == "mps" and torch.backends.mps.is_available():
        try:
            output = run("mps")
        except Exception as e:  # some ops are still flaky on Apple GPU; CPU always works
            print(f"  GPU diarization failed ({e.__class__.__name__}); retrying on CPU…")
            output = run("cpu")
    else:
        output = run("cpu")

    # "Exclusive" diarization assigns exactly one speaker at any instant, which is
    # what you want when attaching words to speakers.
    annotation = getattr(output, "exclusive_speaker_diarization", None) or output.speaker_diarization
    return [{"start": float(t.start), "end": float(t.end), "speaker": spk} for t, spk in annotation]


def assign_speakers(words: list[dict], turns: list[dict]) -> list[dict]:
    """Give each word the speaker whose turn overlaps it most (nearest turn if none overlap)."""
    for w in words:
        best, best_overlap = None, 0.0
        for t in turns:
            overlap = min(w["end"], t["end"]) - max(w["start"], t["start"])
            if overlap > best_overlap:
                best, best_overlap = t["speaker"], overlap
        if best is None and turns:
            mid = (w["start"] + w["end"]) / 2
            best = min(turns, key=lambda t: min(abs(mid - t["start"]), abs(mid - t["end"])))["speaker"]
        w["speaker"] = best or "UNKNOWN"
    return words


def group_utterances(words: list[dict]) -> list[dict]:
    """Merge consecutive words from the same speaker into utterances, then fold stray fragments in."""
    utts = []
    for w in words:
        if utts and utts[-1]["speaker"] == w["speaker"] and w["start"] - utts[-1]["end"] < TURN_GAP:
            utts[-1]["text"] += w["text"]
            utts[-1]["end"] = w["end"]
        else:
            utts.append({"speaker": w["speaker"], "start": w["start"], "end": w["end"], "text": w["text"]})
    for u in utts:
        u["text"] = u["text"].strip()
    return fold_fragments(utts)


def fold_fragments(utts: list[dict], max_words: int = FRAGMENT_WORDS) -> list[dict]:
    """
    Diarization splits a word or two off into another speaker's turn ("Thank" / "you.").
    A turn of max_words or fewer goes into the turn before it (the one after, at the start),
    when it follows on within TURN_GAP; then turns of one speaker that now touch are joined.
    """
    def short(u: dict) -> bool:
        return len(u["text"].split()) <= max_words

    folded: list[dict] = []
    for u in utts:
        prev = folded[-1] if folded else None
        if prev and short(u) and u["start"] - prev["end"] < TURN_GAP:
            prev["text"] = f"{prev['text']} {u['text']}".strip()
            prev["end"] = max(prev["end"], u["end"])
        else:
            folded.append(dict(u))
    # A fragment that opens the recording joins the turn after it.
    if len(folded) > 1 and short(folded[0]) and folded[1]["start"] - folded[0]["end"] < TURN_GAP:
        first = folded.pop(0)
        folded[0]["text"] = f"{first['text']} {folded[0]['text']}".strip()
        folded[0]["start"] = first["start"]

    joined: list[dict] = []
    for u in folded:
        if joined and joined[-1]["speaker"] == u["speaker"] and u["start"] - joined[-1]["end"] < TURN_GAP:
            joined[-1]["text"] = f"{joined[-1]['text']} {u['text']}".strip()
            joined[-1]["end"] = max(joined[-1]["end"], u["end"])
        else:
            joined.append(u)
    return joined


def rename_speakers(utts: list[dict]) -> list[dict]:
    """SPEAKER_00 -> Speaker 1, numbered in order of first appearance."""
    mapping = {}
    for u in utts:
        if u["speaker"] not in mapping:
            mapping[u["speaker"]] = f"Speaker {len(mapping) + 1}"
        u["speaker"] = mapping[u["speaker"]]
    return utts


def fmt(t: float) -> str:
    h, rem = divmod(int(t), 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def engine_model(args) -> tuple[str, str]:
    """What makes the words: the engine and the model's Hugging Face id, written into the transcript."""
    if args.engine == "parakeet":
        return "parakeet", PARAKEET_MODELS[args.parakeet_model]
    return "whisper", WHISPER_MODELS[args.whisper_model]


def archive_old(stem: Path) -> list[Path]:
    """
    Before a transcript is replaced, move the one there into .transcripts/ beside it, named by when
    it was made. A hidden folder: the server's folder scan skips it, so it never looks like a new
    recording (<stem>.old.transcript.json in the folder itself would).
    """
    moved = []
    for suffix in (".transcript.json", ".transcript.txt"):
        old = Path(f"{stem}{suffix}")
        if not old.exists():
            continue
        made = datetime.fromtimestamp(old.stat().st_mtime).strftime("%Y%m%dT%H%M%S")
        dest_dir = stem.parent / ARCHIVE_DIR
        dest_dir.mkdir(exist_ok=True)
        dest = dest_dir / f"{stem.name}.{made}{suffix}"
        n = 2
        while dest.exists():
            dest = dest_dir / f"{stem.name}.{made}-{n}{suffix}"
            n += 1
        old.rename(dest)
        moved.append(dest)
    return moved


def process(path: Path, pipeline, args) -> None:
    print(f"\n▶ {path.name}")
    t0 = time.time()
    engine, model_id = engine_model(args)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        to_wav16k(path, wav)

        print(f"  transcribing with {model_id}…")
        if engine == "parakeet":
            words = transcribe_parakeet(wav, args.parakeet_model)
        else:
            words = transcribe_whisper(wav, args.whisper_model, args.language, args.prompt)
        print(f"  {len(words)} words ({time.time() - t0:.0f}s)")

        print("  identifying speakers…")
        turns = diarize(pipeline, wav, args.speakers, args.min_speakers, args.max_speakers, args.device)

    utts = rename_speakers(group_utterances(assign_speakers(words, turns)))
    n_speakers = len({u["speaker"] for u in utts})

    write_outputs(path, engine, model_id, utts)
    print(f"  ✓ {n_speakers} speakers, done in {time.time() - t0:.0f}s → {path.with_suffix('').name}.transcript.txt")


def write_outputs(path: Path, engine: str, model_id: str, utts: list[dict]) -> None:
    """The two files beside the recording; any transcript already there is kept in .transcripts/ first."""
    n_speakers = len({u["speaker"] for u in utts})
    stem = path.with_suffix("")
    archive_old(stem)
    txt = Path(f"{stem}.transcript.txt")
    with txt.open("w") as f:
        f.write(f"{path.name} — {n_speakers} speakers ({model_id})\n\n")
        for u in utts:
            f.write(f"[{fmt(u['start'])}] {u['speaker']}: {u['text']}\n\n")
    Path(f"{stem}.transcript.json").write_text(
        json.dumps({"file": path.name, "engine": engine, "model": model_id, "speakers": n_speakers, "utterances": utts}, indent=2, ensure_ascii=False)
    )


def main():
    faulthandler.enable()  # if something crashes natively, print where instead of dying silently
    p = argparse.ArgumentParser(description="Local multi-speaker transcription (Whisper or Parakeet, + pyannote).")
    p.add_argument("inputs", nargs="+", type=Path, help="audio files or folders")
    p.add_argument("--engine", choices=["whisper", "parakeet"], default="whisper",
                   help="whisper (default) or parakeet: usually more accurate on meetings, much faster, never loops")
    p.add_argument("--whisper-model", choices=WHISPER_MODELS, default="turbo",
                   help="turbo = fast (default); large = slightly more accurate, ~2x slower")
    p.add_argument("--parakeet-model", choices=PARAKEET_MODELS, default="v3",
                   help="v3 = multilingual (default); v2 = English only")
    p.add_argument("--language", default=None, help="e.g. en, fr — skips auto-detection (Whisper only)")
    p.add_argument("--prompt", default=None,
                   help="names and terms to expect, as Whisper's initial prompt (Whisper only)")
    p.add_argument("--speakers", type=int, help="exact number of speakers, if known (improves accuracy)")
    p.add_argument("--min-speakers", type=int)
    p.add_argument("--max-speakers", type=int)
    p.add_argument("--device", choices=["mps", "cpu"], default="mps", help="for diarization")
    p.add_argument("--overwrite", action="store_true", help="redo files that already have a transcript")
    args = p.parse_args()

    files = []
    for i in args.inputs:
        if i.is_dir():
            files += sorted(f for f in i.iterdir() if f.suffix.lower() in AUDIO_EXTS)
        elif i.exists():
            files.append(i)
        else:
            print(f"Not found: {i}")
    if not args.overwrite:
        files = [f for f in files if not Path(f"{f.with_suffix('')}.transcript.txt").exists()]
    if not files:
        sys.exit("Nothing to process.")
    if args.engine == "parakeet" and (args.language or args.prompt):
        print("Parakeet detects the language itself and takes no prompt; --language and --prompt are ignored.")

    pipeline = load_pipeline()
    for f in files:
        process(f, pipeline, args)


if __name__ == "__main__":
    main()
