import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine

import backend.database as database
from backend.main import (
    PhraseSuggestionInput,
    add_phrase_suggestion,
    delete_phrase_suggestion,
    get_phrase_suggestions,
)
from backend.vision import LandmarkService


@pytest.fixture
def phrase_database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'phrases.sqlite3'}")
    database.initialize(engine)
    monkeypatch.setattr(database, "get_engine", lambda: engine)
    yield engine
    engine.dispose()


def test_phrase_dictionary_has_447_bilingual_entries():
    phrase_file = Path(__file__).resolve().parents[1] / "datasets" / "isl_phrase_dictionary.json"
    phrases = json.loads(phrase_file.read_text(encoding="utf-8"))

    assert len(phrases) == 447
    assert all(item["english"] and item["hindi"] for item in phrases)


def test_phrase_suggestions_are_letter_filtered_priority_sorted_and_limited(
    phrase_database,
):
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


def test_custom_phrase_is_saved_and_returned_first_for_its_letter(phrase_database):
    saved = add_phrase_suggestion(
        PhraseSuggestionInput(
            letter="a",
            category="Personal",
            english="Ask for directions",
            hindi="कृपया रास्ता बताइए",
        )
    )

    suggestions = get_phrase_suggestions("A", limit=3)

    assert saved["letter"] == "A"
    assert saved["english"] == "Ask for directions"
    assert suggestions[0] == {
        "id": saved["id"],
        "letter": "A",
        "category": "Personal",
        "english": "Ask for directions",
        "hindi": "कृपया रास्ता बताइए",
        "priority": 0,
        "custom": True,
    }


def test_custom_phrase_can_be_deleted_from_its_suggestions(phrase_database):
    saved = add_phrase_suggestion(
        PhraseSuggestionInput(
            letter="Z",
            category="Personal",
            english="Find my destination",
            hindi="मुझे अपना गंतव्य ढूँढना है",
        )
    )

    assert get_phrase_suggestions("Z")[0]["id"] == saved["id"]
    assert delete_phrase_suggestion(saved["id"]) == {"deleted": True}
    assert all(
        item.get("id") != saved["id"]
        for item in get_phrase_suggestions("Z")
    )


def test_deleting_unknown_custom_phrase_returns_not_found(phrase_database):
    with pytest.raises(HTTPException) as error:
        delete_phrase_suggestion(987654)

    assert error.value.status_code == 404


@pytest.mark.parametrize("letter", ["", "AA", "1", "?"])
def test_phrase_suggestions_reject_invalid_letters(letter):
    with pytest.raises(HTTPException) as error:
        get_phrase_suggestions(letter)

    assert error.value.status_code == 400


def test_custom_phrase_rejects_blank_translations(phrase_database):
    with pytest.raises(HTTPException) as error:
        add_phrase_suggestion(
            PhraseSuggestionInput(
                letter="B",
                category="Personal",
                english=" ",
                hindi="संदेश",
            )
        )

    assert error.value.status_code == 422


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


def test_double_blink_signal_requires_both_eyes_closed():
    landmarks = [SimpleNamespace(x=0.0, y=0.0) for _ in range(478)]
    for left, right, x in [(33, 133, 0.0), (362, 263, 2.0)]:
        landmarks[left] = SimpleNamespace(x=x, y=0.0)
        landmarks[right] = SimpleNamespace(x=x + 1.0, y=0.0)
    for upper, lower, x in [(159, 145, 0.25), (158, 153, 0.75),
                            (386, 374, 2.25), (385, 380, 2.75)]:
        landmarks[upper] = SimpleNamespace(x=x, y=0.2)
        landmarks[lower] = SimpleNamespace(x=x, y=-0.2)

    service = LandmarkService()
    assert service._eye_aspect_ratios(landmarks) == pytest.approx((0.4, 0.4))
    assert not service._both_eyes_closed((0.08, 0.4))

    for upper, lower, x in [(159, 145, 0.25), (158, 153, 0.75)]:
        landmarks[upper] = SimpleNamespace(x=x, y=0.04)
        landmarks[lower] = SimpleNamespace(x=x, y=-0.04)
    ratios = service._eye_aspect_ratios(landmarks)
    assert ratios[0] == pytest.approx(0.08)
    assert ratios[1] == pytest.approx(0.4)
    assert not service._both_eyes_closed(ratios)
    assert service._both_eyes_closed((0.08, 0.08))


def test_eye_gaze_and_landmark_overlay_use_refined_iris_points():
    landmarks = [SimpleNamespace(x=0.5, y=0.5) for _ in range(478)]
    landmarks[33] = SimpleNamespace(x=0.2, y=0.5)
    landmarks[133] = SimpleNamespace(x=0.4, y=0.5)
    landmarks[362] = SimpleNamespace(x=0.6, y=0.5)
    landmarks[263] = SimpleNamespace(x=0.8, y=0.5)
    for index in range(468, 473):
        landmarks[index] = SimpleNamespace(x=0.32, y=0.5)
    for index in range(473, 478):
        landmarks[index] = SimpleNamespace(x=0.72, y=0.5)

    service = LandmarkService()
    assert service._eye_gaze_x(landmarks) == pytest.approx(0.6)
    overlay = service._eye_landmarks(landmarks)
    assert len(overlay["contours"]) == 2
    assert len(overlay["contours"][0]) == len(service.LEFT_EYE_CONTOUR)
    assert len(overlay["irises"]) == 2
    assert overlay["irises"][0]["x"] == pytest.approx(0.32)
