import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.main import get_phrase_suggestions
from backend.vision import LandmarkService


def test_phrase_dictionary_has_447_bilingual_entries():
    phrase_file = Path(__file__).resolve().parents[1] / "datasets" / "isl_phrase_dictionary.json"
    phrases = json.loads(phrase_file.read_text(encoding="utf-8"))

    assert len(phrases) == 447
    assert all(item["english"] and item["hindi"] for item in phrases)


def test_phrase_suggestions_are_letter_filtered_priority_sorted_and_limited():
    suggestions = get_phrase_suggestions("a", limit=5)
    phrase_file = Path(__file__).resolve().parents[1] / "datasets" / "isl_phrase_dictionary.json"
    source_phrases = json.loads(phrase_file.read_text(encoding="utf-8"))
    expected = [item for item in source_phrases if item["letter"] == "A"]
    expected.sort(key=lambda item: item["priority"])

    assert len(suggestions) == 5
    assert suggestions == expected[:5]
    assert all(item["letter"] == "A" for item in suggestions)
    assert [item["priority"] for item in suggestions] == sorted(
        item["priority"] for item in suggestions
    )
    assert suggestions[0]["priority"] == 1
    assert suggestions[0]["english"]
    assert suggestions[0]["hindi"]


@pytest.mark.parametrize("letter", ["", "AA", "1", "?"])
def test_phrase_suggestions_reject_invalid_letters(letter):
    with pytest.raises(HTTPException) as error:
        get_phrase_suggestions(letter)

    assert error.value.status_code == 400


def test_eye_aspect_ratio_distinguishes_open_and_closed_eyes():
    landmarks = [SimpleNamespace(x=0.0, y=0.0) for _ in range(468)]
    for left, right, x in [(33, 133, 0.0), (362, 263, 2.0)]:
        landmarks[left] = SimpleNamespace(x=x, y=0.0)
        landmarks[right] = SimpleNamespace(x=x + 1.0, y=0.0)
    for upper, lower, x in [(159, 145, 0.25), (158, 153, 0.75),
                            (386, 374, 2.25), (385, 380, 2.75)]:
        landmarks[upper] = SimpleNamespace(x=x, y=0.2)
        landmarks[lower] = SimpleNamespace(x=x, y=-0.2)

    service = LandmarkService()
    assert service._eye_aspect_ratio(landmarks) == pytest.approx(0.4)

    for upper, lower, x in [(159, 145, 0.25), (158, 153, 0.75),
                            (386, 374, 2.25), (385, 380, 2.75)]:
        landmarks[upper] = SimpleNamespace(x=x, y=0.04)
        landmarks[lower] = SimpleNamespace(x=x, y=-0.04)
    assert service._eye_aspect_ratio(landmarks) == pytest.approx(0.08)
