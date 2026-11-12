"""
Tests for transcribe.py's own logic, with fake model results: no model, no audio, no MLX.

  python3 transcribe/test_transcribe.py

npm test runs this too.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("transcribe", HERE / "transcribe.py")
transcribe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transcribe)


def token(text, start, duration):
    # parakeet_mlx.AlignedToken: start and duration, end worked out from them.
    return SimpleNamespace(id=0, text=text, start=start, duration=duration, confidence=1.0, end=start + duration)


def word(text, start, end, speaker):
    return {"text": text, "start": start, "end": end, "speaker": speaker}


class ParakeetWords(unittest.TestCase):
    def test_pieces_join_into_words_with_their_times(self):
        tokens = [token(" P", 0.0, 0.1), token("OP", 0.1, 0.1), token("IA", 0.2, 0.2), token(",", 0.4, 0.05),
                  token(" section", 0.6, 0.3), token(" 7", 1.0, 0.1), token("2", 1.1, 0.1), token(".", 1.2, 0.05)]
        words = transcribe.parakeet_words(tokens)
        self.assertEqual([w["text"] for w in words], [" POPIA,", " section", " 72."])
        self.assertEqual((words[0]["start"], round(words[0]["end"], 2)), (0.0, 0.45))
        self.assertEqual((words[2]["start"], round(words[2]["end"], 2)), (1.0, 1.25))

    def test_the_first_piece_starts_a_word_even_without_a_space(self):
        words = transcribe.parakeet_words([token("Hello", 0.0, 0.3), token(" there", 0.4, 0.3)])
        self.assertEqual([w["text"] for w in words], [" Hello", " there"])

    def test_gives_the_same_shape_as_whisper(self):
        whisper = transcribe.whisper_words({"segments": [{"words": [{"word": " Hello", "start": 0, "end": 0.3, "probability": 0.9}]}]})
        parakeet = transcribe.parakeet_words([token(" Hello", 0.0, 0.3)])
        self.assertEqual(set(whisper[0]), {"text", "start", "end"})
        self.assertEqual(set(parakeet[0]), {"text", "start", "end"})


class Fragments(unittest.TestCase):
    def test_a_word_or_two_split_off_goes_back_into_the_turn(self):
        words = [word(" We", 0.0, 0.2, "A"), word(" close", 0.3, 0.6, "A"), word(" here.", 0.7, 1.0, "A"),
                 word(" Thank", 1.1, 1.3, "B"),
                 word(" you.", 1.4, 1.6, "C"),
                 word(" Next", 4.0, 4.3, "B"), word(" is", 4.4, 4.5, "B"), word(" the", 4.6, 4.7, "B"), word(" panel.", 4.8, 5.2, "B")]
        utts = transcribe.group_utterances(words)
        self.assertEqual([(u["speaker"], u["text"]) for u in utts], [("A", "We close here. Thank you."), ("B", "Next is the panel.")])
        self.assertEqual(utts[0]["end"], 1.6)

    def test_a_fragment_between_two_turns_of_one_speaker_joins_them(self):
        utts = transcribe.fold_fragments([
            {"speaker": "A", "start": 0.0, "end": 3.0, "text": "On the data protection act"},
            {"speaker": "B", "start": 3.1, "end": 3.4, "text": "section"},
            {"speaker": "A", "start": 3.5, "end": 6.0, "text": "seventy-two applies here"},
        ])
        self.assertEqual(utts, [{"speaker": "A", "start": 0.0, "end": 6.0, "text": "On the data protection act section seventy-two applies here"}])

    def test_a_short_answer_after_a_pause_stays_its_own(self):
        utts = transcribe.fold_fragments([
            {"speaker": "A", "start": 0.0, "end": 3.0, "text": "Shall we start?"},
            {"speaker": "B", "start": 6.0, "end": 6.3, "text": "Yes."},
        ])
        self.assertEqual([u["speaker"] for u in utts], ["A", "B"])

    def test_a_fragment_that_opens_the_recording_joins_the_next_turn(self):
        utts = transcribe.fold_fragments([
            {"speaker": "B", "start": 0.0, "end": 0.3, "text": "So,"},
            {"speaker": "A", "start": 0.5, "end": 3.0, "text": "welcome to the panel everyone"},
        ])
        self.assertEqual(utts, [{"speaker": "A", "start": 0.0, "end": 3.0, "text": "So, welcome to the panel everyone"}])

    def test_speakers_left_only_with_fragments_disappear(self):
        utts = transcribe.rename_speakers(transcribe.group_utterances([
            word(" Good", 0.0, 0.2, "S0"), word(" morning", 0.3, 0.6, "S0"), word(" all.", 0.7, 0.9, "S0"),
            word(" Hi.", 1.0, 1.2, "S1"),
            word(" Let", 1.5, 1.7, "S2"), word(" us", 1.8, 1.9, "S2"), word(" begin.", 2.0, 2.4, "S2"),
        ]))
        self.assertEqual([(u["speaker"], u["text"]) for u in utts], [("Speaker 1", "Good morning all. Hi."), ("Speaker 2", "Let us begin.")])


class Outputs(unittest.TestCase):
    def test_writes_engine_and_model_and_keeps_the_old_transcript_out_of_the_folder_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "Panel [of_1].ogg"
            audio.write_bytes(b"audio")
            old = Path(tmp) / "Panel [of_1].transcript.json"
            old.write_text(json.dumps({"utterances": [{"speaker": "Speaker 1", "start": 0, "end": 1, "text": "copy-up"}]}))
            Path(tmp, "Panel [of_1].transcript.txt").write_text("old")
            os.utime(old, (1_700_000_000, 1_700_000_000))

            utts = [{"speaker": "Speaker 1", "start": 0.0, "end": 1.0, "text": "POPIA"}]
            transcribe.write_outputs(audio, "parakeet", transcribe.PARAKEET_MODELS["v3"], utts)

            new = json.loads(old.read_text())
            self.assertEqual((new["engine"], new["model"], new["speakers"]), ("parakeet", "mlx-community/parakeet-tdt-0.6b-v3", 1))
            self.assertEqual(new["utterances"][0]["text"], "POPIA")
            kept = sorted(p.name for p in (Path(tmp) / ".transcripts").iterdir())
            self.assertEqual(len(kept), 2)
            self.assertTrue(all(n.startswith("Panel [of_1].") for n in kept))
            self.assertTrue(any(n.endswith(".transcript.json") for n in kept))
            # Only the recording and its new transcript are left where the server looks.
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir() if not p.name.startswith(".")),
                             ["Panel [of_1].ogg", "Panel [of_1].transcript.json", "Panel [of_1].transcript.txt"])

            # A second run the same second keeps both earlier ones.
            transcribe.write_outputs(audio, "whisper", transcribe.WHISPER_MODELS["large"], utts)
            self.assertEqual(len(list((Path(tmp) / ".transcripts").iterdir())), 4)

    def test_engine_and_model_from_the_options(self):
        ns = SimpleNamespace(engine="whisper", whisper_model="large", parakeet_model="v3")
        self.assertEqual(transcribe.engine_model(ns), ("whisper", "mlx-community/whisper-large-v3-mlx"))
        ns.engine = "parakeet"
        self.assertEqual(transcribe.engine_model(ns), ("parakeet", "mlx-community/parakeet-tdt-0.6b-v3"))

    def test_the_audio_is_evened_out_but_never_denoised(self):
        self.assertIn("loudnorm", transcribe.AUDIO_FILTER)
        self.assertNotIn("afftdn", transcribe.AUDIO_FILTER)


if __name__ == "__main__":
    unittest.main()
