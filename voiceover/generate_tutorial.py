"""Озвучка нулевого раунда — интерактивного обучения — через Gemini TTS.

Два голоса. Ведущий (тот же, что в обучающем ролике) читает подсказки, каждую отдельным вызовом.
Голос раунда диктует пять номеров и пять слов одним вызовом; запись режется по паузам, как в раундах.
Тексты — в tutorial/script.json (их же показывает игра), клипы — tutorial/lines/<id>.mp3,
tutorial/numbers/NN.mp3 и tutorial/words/NN.mp3, длины и голоса — в tutorial/manifest.json.

    set GEMINI_API_KEY=...
    python -X utf8 generate_tutorial.py generate
    python -X utf8 generate_tutorial.py verify

Ответы API кэшируются в .state/raw (файлы round_00_*): повторный запуск не тратит вызовы.
Переозвучить одну подсказку: generate --retake welcome,final.
"""
import argparse
import base64
import json
import time

import numpy as np

import generate_voiceover as gv

OUT = gv.BASE / "tutorial"
MANIFEST = OUT / "manifest.json"
VERIFICATION = OUT / "verification.json"
MODEL = gv.MODELS[0]  # gemini-3.8-flash-tts

NARRATOR_VOICE = "Laomedeia"
NARRATOR_DIRECTION = (
    "# AUDIO PROFILE: Narrator of a funny animated tutorial\n"
    "## THE SCENE: A cozy art studio; you explain a drawing-and-memory game to a new player\n"
    "### DIRECTOR'S NOTES\n"
    "Performance: warm, playful and lively, like a storyteller in a family cartoon; smiling voice, crisp diction, "
    "a brisk but unhurried pace. Words in «» are names of on-screen buttons: say them clearly with a light emphasis.\n"
    "Language: Russian. Read the transcript exactly as written and add nothing.\n"
    "#### TRANSCRIPT\n"
)

# Голос раунда: в обучении диктует добродушный подмастерье, медленно и разборчиво.
DICTATOR = ("Achird", "Friendly apprentice", "A bright art studio during a first lesson for a beginner",
            "Speak clearly, kindly and calmly, at an even unhurried pace, as if dictating to someone who is just learning")

# Слова и подсказки — в tutorial/script.json: оттуда же их берёт игра. Слов там пять, их нет среди 400 слов
# раундов, и их легко и нарисовать, и написать без ошибок. speech — как читать слово (ударение, «ё»).
SCRIPT = json.loads((OUT / "script.json").read_text(encoding="utf-8"))
WORDS = SCRIPT["words"]
SPEECH = SCRIPT["speech"]
LINES = SCRIPT["lines"]

# Русская речь — около 0,07 с на букву. Сильно короче или длиннее — модель что-то пропустила или добавила.
SECONDS_PER_CHAR = (0.035, 0.16)


def checked_trim(text):
    def process(x, rate):
        clip = gv.trim(x, rate)
        per_char = len(clip) / rate / len(text)
        if not SECONDS_PER_CHAR[0] <= per_char <= SECONDS_PER_CHAR[1]:
            raise gv.QCError(f"длина {len(clip) / rate:.1f} с не похожа на текст из {len(text)} букв")
        return clip
    return process


def write_clip(rel, clip, rate):
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    gv.write_mp3(path, gv.to_pcm(clip), rate)
    return f"tutorial/{rel}"


def generate(retake):
    for name in retake:
        # Восемь знаков — хэш промпта; так «draw» не задевает «draw_more».
        for old in gv.RAW_DIR.glob(f"round_00_line_{name}_{'?' * 8}.wav"):
            old.rename(old.with_suffix(f".rejected{int(time.time())}.wav"))

    numbers = gv.NUMBERS[: len(WORDS)]
    lines = [t for n, w in zip(numbers, WORDS) for t in (f"{n}.", f"{SPEECH.get(w, w)}.")]
    print(f"Диктовка: {MODEL} / {DICTATOR[0]}", flush=True)
    (dictation, gaps), rate = gv.obtain(0, "dictation", MODEL, DICTATOR[0], gv.build_prompt(DICTATOR, lines),
                                        lambda x, r: gv.split_lines(x, r, len(lines)))
    gain = gv.round_gain(dictation, rate)
    dictation = [c * gain for c in dictation]

    print(f"Подсказки: {MODEL} / {NARRATOR_VOICE}", flush=True)
    said = {}
    for key, text in LINES.items():
        said[key], line_rate = gv.obtain(0, f"line_{key}", MODEL, NARRATOR_VOICE, NARRATOR_DIRECTION + text,
                                         checked_trim(text))
        if line_rate != rate:
            raise gv.QCError("у голосов разная частота дискретизации")
    narrator_gain = gv.round_gain(list(said.values()), rate)

    cells = []
    for i, word in enumerate(WORDS):
        number, spoken = dictation[2 * i], dictation[2 * i + 1]
        cells.append({"cell": i + 1, "word": word,
                      "number_clip": write_clip(f"numbers/{i + 1:02d}.mp3", number, rate), "number_ms": gv.ms(len(number), rate),
                      "word_clip": write_clip(f"words/{i + 1:02d}.mp3", spoken, rate), "word_ms": gv.ms(len(spoken), rate)})
    service = {}
    for key, clip in said.items():
        clip = clip * narrator_gain
        service[key] = {"text": LINES[key], "clip": write_clip(f"lines/{key}.mp3", clip, rate), "ms": gv.ms(len(clip), rate)}

    gv.save_json(MANIFEST, {
        "round": 0, "model": MODEL, "sample_rate": rate,
        "narrator": {"voice": NARRATOR_VOICE, "gain_db": round(20 * float(np.log10(narrator_gain)), 1)},
        "dictator": {"voice": DICTATOR[0], "persona": DICTATOR[1], "gain_db": round(20 * float(np.log10(gain)), 1),
                     "segmentation": gaps},
        "number_pause_ms": round(gv.PAUSE_S * 1000),
        "cells": cells, "lines": service,
    })
    print(f"Готово: {len(cells)} слов, {len(service)} подсказок -> {MANIFEST.relative_to(gv.BASE.parent)}", flush=True)


def verify():
    """Распознаёт каждый клип и сравнивает с текстом: не пропущено ли что-то, не прочитано ли иначе."""
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    clips = {f"number {c['cell']}": (c["number_clip"], gv.NUMBERS[c["cell"] - 1]) for c in manifest["cells"]}
    clips |= {f"word {c['cell']}": (c["word_clip"], c["word"]) for c in manifest["cells"]}
    clips |= {f"line {k}": (v["clip"], v["text"]) for k, v in manifest["lines"].items()}
    prompt = ('Transcribe this Russian audio exactly, word for word. Return JSON: {"text": "the transcript", '
              '"delivery": "under 10 English words on the speaker\'s manner"}.')
    results = {}
    for name, (clip, expected) in clips.items():
        data = (gv.BASE / clip).read_bytes()
        body = {"contents": [{"role": "user", "parts": [
                    {"inlineData": {"mimeType": "audio/mp3", "data": base64.b64encode(data).decode()}}, {"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "thinkingConfig": {"thinkingLevel": "low"}}}
        reply = gv.post(gv.VERIFY_MODEL, body)
        gv.log_usage(gv.VERIFY_MODEL, f"verify tutorial {name}", reply.get("usageMetadata"))
        parsed = json.loads(reply["candidates"][0]["content"]["parts"][-1]["text"])
        ok = gv.normalize(parsed["text"]) == gv.normalize(expected)
        results[name] = {"expected": expected, "heard": parsed["text"], "ok": ok, "delivery": parsed.get("delivery")}
        print(f"{'ок ' if ok else 'НЕ '} {name}: {parsed['text']}" + ("" if ok else f"  (ожидалось: {expected})"), flush=True)
    gv.save_json(VERIFICATION, results)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["generate", "verify"])
    parser.add_argument("--retake", default="", help="переозвучить подсказки, через запятую")
    args = parser.parse_args()
    if args.command == "generate":
        generate([k for k in args.retake.split(",") if k])
    else:
        verify()


if __name__ == "__main__":
    main()
