import base64

import backend.database as database
import cv2
import numpy as np
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine

from backend.main import (
    ISLReferenceImageInput,
    ISLReferenceInput,
    add_isl_reference,
    add_isl_reference_image,
    delete_isl_reference,
    delete_isl_reference_image,
    get_isl_reference,
    get_isl_reference_image,
    update_isl_reference,
)


@pytest.fixture
def reference_database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'reference.sqlite3'}")
    database.initialize(engine)
    monkeypatch.setattr(database, "get_engine", lambda: engine)
    yield engine
    engine.dispose()


def test_isl_reference_crud(reference_database):
    # 1. Get initial references
    initial = get_isl_reference()
    assert isinstance(initial, list)
    assert len(initial) >= 60

    # 2. Add new gesture
    payload = ISLReferenceInput(
        id="G_test_123",
        symbol="🙏",
        category="Greeting",
        label="Test Namaste",
        meaning="Test greeting meaning",
        hindi="नमस्ते टेस्ट",
        kind="static",
        steps=["Step 1: Put palms together", "Step 2: Bow gently"],
        tip="Keep fingers together"
    )
    res = add_isl_reference(payload)
    assert res["id"] == "G_test_123"

    # 3. Verify in list
    items = get_isl_reference()
    found = next((g for g in items if g["id"] == "G_test_123"), None)
    assert found is not None
    assert found["label"] == "Test Namaste"
    assert found["meaning"] == "Test greeting meaning"
    assert len(found["steps"]) == 2

    # 4. Update gesture with new meaning
    update_payload = ISLReferenceInput(
        id="G_test_123",
        symbol="🙏",
        category="Greeting",
        label="Test Namaste Updated",
        meaning="Brand new updated meaning",
        hindi="नया अर्थ",
        kind="static",
        steps=["Step 1: Updated step"],
        tip="Updated tip"
    )
    update_res = update_isl_reference("G_test_123", update_payload)
    assert update_res["id"] == "G_test_123"

    # Verify update
    items = get_isl_reference()
    updated_found = next((g for g in items if g["id"] == "G_test_123"), None)
    assert updated_found is not None
    assert updated_found["label"] == "Test Namaste Updated"
    assert updated_found["meaning"] == "Brand new updated meaning"

    # 5. Delete gesture
    del_res = delete_isl_reference("G_test_123")
    assert del_res["deleted"] is True

    # Verify deleted
    items = get_isl_reference()
    assert not any(g["id"] == "G_test_123" for g in items)


def test_reference_photos_are_saved_listed_served_and_deleted(reference_database):
    add_isl_reference(
        ISLReferenceInput(
            id="G_photo_test",
            label="Photo test",
            meaning="A test gesture",
            steps=["Hold the pose"],
        )
    )
    success, encoded = cv2.imencode(
        ".jpg", np.full((24, 32, 3), 127, dtype=np.uint8)
    )
    assert success
    data_url = "data:image/jpeg;base64," + base64.b64encode(
        encoded.tobytes()
    ).decode("ascii")

    saved = add_isl_reference_image(
        "G_photo_test", ISLReferenceImageInput(image_data=data_url)
    )
    gesture = next(
        item for item in get_isl_reference() if item["id"] == "G_photo_test"
    )
    served = get_isl_reference_image("G_photo_test", saved["id"])

    assert gesture["photos"] == [{"id": saved["id"], "url": saved["url"]}]
    assert served.media_type == "image/jpeg"
    assert bytes(served.body) == encoded.tobytes()

    assert delete_isl_reference_image("G_photo_test", saved["id"])["deleted"]
    assert next(
        item for item in get_isl_reference() if item["id"] == "G_photo_test"
    )["photos"] == []
    with pytest.raises(HTTPException) as error:
        get_isl_reference_image("G_photo_test", saved["id"])
    assert error.value.status_code == 404
    delete_isl_reference("G_photo_test")


def test_reference_photo_requires_valid_image_bytes(reference_database):
    add_isl_reference(
        ISLReferenceInput(
            id="G_bad_photo_test",
            label="Bad photo test",
            meaning="A test gesture",
            steps=["Hold the pose"],
        )
    )
    invalid_data = "data:image/png;base64," + base64.b64encode(b"not an image").decode()
    with pytest.raises(HTTPException) as error:
        add_isl_reference_image(
            "G_bad_photo_test", ISLReferenceImageInput(image_data=invalid_data)
        )
    assert error.value.status_code == 400
    assert "invalid" in error.value.detail


def test_deleting_reference_removes_its_photos(reference_database):
    add_isl_reference(
        ISLReferenceInput(
            id="G_delete_photo_test",
            label="Delete photo test",
            meaning="A test gesture",
            steps=["Hold the pose"],
        )
    )
    success, encoded = cv2.imencode(
        ".png", np.full((16, 16, 3), 255, dtype=np.uint8)
    )
    assert success
    data_url = "data:image/png;base64," + base64.b64encode(
        encoded.tobytes()
    ).decode("ascii")
    saved = add_isl_reference_image(
        "G_delete_photo_test", ISLReferenceImageInput(image_data=data_url)
    )

    delete_isl_reference("G_delete_photo_test")

    with pytest.raises(HTTPException) as error:
        get_isl_reference_image("G_delete_photo_test", saved["id"])
    assert error.value.status_code == 404
