import base64
import binascii
from io import BytesIO
import json
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from backend import database
from backend.recognition import FEATURE_SIZE, predict, valid_feature_vector
from backend.vision import LandmarkService


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
PROJECT_DIR = FRONTEND_DIR.parent
landmarks = LandmarkService()
app = FastAPI(title="Signova ISL", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GestureInput(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    meaning: str = Field(min_length=1, max_length=200)
    language: str = Field(default="en", pattern="^(en|hi)$")
    category: str = Field(default="daily", max_length=50)
    kind: str = Field(default="static", pattern="^(static|dynamic)$")
    reference_id: str | None = Field(default=None, max_length=40)


class SampleInput(BaseModel):
    features: list
    signer_id: str = Field(min_length=1, max_length=80)
    handedness: str = Field(default="any", pattern="^(Left|Right|any)$")
    split: str = Field(pattern="^(train|validation)$")


class AnalyzeInput(BaseModel):
    image: str = Field(min_length=1)
    sequence: list[list[float]] = Field(default_factory=list, max_length=30)


class HistoryInput(BaseModel):
    mode: str = Field(pattern="^(sign|speech|emergency)$")
    text: str = Field(min_length=1, max_length=2000)
    confidence: float | None = Field(default=None, ge=0, le=1)

class ISLReferenceInput(BaseModel):
    id: str | None = None
    symbol: str = Field(default="✋", max_length=20)
    category: str = Field(default="Common", max_length=50)
    label: str = Field(min_length=1, max_length=80)
    meaning: str = Field(min_length=1, max_length=250)
    hindi: str = Field(default="", max_length=250)
    kind: str = Field(default="static", pattern="^(static|dynamic)$")
    steps: list[str] = Field(default_factory=list)
    tip: str | None = Field(default="")

class ISLReferenceImageInput(BaseModel):
    image_data: str = Field(min_length=1, max_length=7_000_000)


class ReferencePhotoImportInput(BaseModel):
    reference_id: str = Field(min_length=1, max_length=40)



@app.on_event("startup")
def startup() -> None:
    database.initialize()


@app.get("/api/health")
def health() -> dict:
    try:
        with database.connect() as db:
            db.execute("SELECT 1").fetchone()
        database_status = "connected"
    except (RuntimeError, SQLAlchemyError) as error:
        database_status = f"unavailable: {error}"
    return {
        "status": "ok",
        "database": database_status,
        "vision_available": landmarks.available,
        "vision_error": landmarks.import_error,
        "recognition": "Live recognition uses only AI Learning training samples; dictionary references are not used unless their photos are imported. Validation examples are held out.",
    }


@app.post("/api/analyze")
def analyze(payload: AnalyzeInput) -> dict:
    try:
        result = landmarks.analyze(payload.image)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ImportError, AttributeError, RuntimeError) as error:
        raise HTTPException(
            status_code=503,
            detail=f"MediaPipe vision models are unavailable: {error}",
        ) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Frame analysis failed: {error}") from error

    sequence = payload.sequence[-30:]
    if any(not valid_feature_vector(frame) for frame in sequence):
        raise HTTPException(status_code=400, detail=f"Each sequence frame must contain {FEATURE_SIZE} finite values")
    result["gesture"] = None
    result["gestures"] = []
    if result["hands"]:
        with database.connect() as db:
            samples = database.training_samples(db)
            train_ids = {sample["id"] for sample in samples}
            for hand in result["hands"]:
                hand_gesture = predict(
                    hand["features"],
                    sequence,
                    samples,
                    train_ids,
                    hand["handedness"],
                )
                hand["gesture"] = hand_gesture
                if hand_gesture:
                    result["gestures"].append(hand_gesture)
            if result["gestures"]:
                result["gesture"] = max(
                    result["gestures"], key=lambda item: item["confidence"]
                )
    return result


@app.get("/api/phrase-suggestions")
def get_phrase_suggestions(letter: str, limit: int = 8) -> list[dict]:
    if len(letter) != 1 or letter not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz":
        raise HTTPException(status_code=400, detail="Letter must be a single A-Z character.")
    if not 1 <= limit <= 30:
        raise HTTPException(status_code=400, detail="Limit must be between 1 and 30.")
    phrase_path = Path(__file__).resolve().parent.parent / "datasets" / "isl_phrase_dictionary.json"
    try:
        phrases = json.loads(phrase_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=503, detail=f"Phrase suggestions are unavailable: {error}") from error
    matching = [
        item for item in phrases
        if item.get("letter", "").upper() == letter.upper()
    ]
    matching.sort(key=lambda item: int(item.get("priority", 99)))
    return matching[:limit]


def _read_guide_text(filename: str) -> str:
    path = PROJECT_DIR / filename
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise HTTPException(
            status_code=503,
            detail=f"The gesture guide {filename} could not be loaded: {error}",
        ) from error


def _parse_alphabet_guide(content: str) -> dict:
    general_match = re.search(
        r"(?ms)^GENERAL SETUP\s*\n(.*?)(?=^[A-Z]\s*$)",
        content,
    )
    general = " ".join(general_match.group(1).split()) if general_match else ""
    headings = list(re.finditer(r"(?m)^([A-Z])\s*$", content))
    gestures = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(content)
        section = content[heading.end():end]
        steps = re.findall(r"(?m)^\d+\.\s*(.+?)\s*$", section)
        if steps:
            gestures[heading.group(1)] = steps
    return {"general": general, "gestures": gestures}


def _parse_number_guide(content: str) -> dict:
    general_match = re.search(
        r"(?ms)^General rule:\s*(.*?)(?=^GESTURE\s+\d+)",
        content,
    )
    general_text = " ".join(general_match.group(1).split()) if general_match else ""
    general_parts = re.match(r"(.+?\.)\s*(.*)", general_text)
    general = general_parts.group(1) if general_parts else general_text
    two_hand_rule = general_parts.group(2) if general_parts else ""
    headings = list(
        re.finditer(r"(?m)^GESTURE\s+(\d+)(?:\s+\(two hands\))?\s*$", content)
    )
    gestures = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else content.find("QUICK SUMMARY", heading.end())
        if end < 0:
            end = len(content)
        section = content[heading.end():end]
        group = ""
        steps = []
        for line in section.splitlines():
            stripped = line.strip()
            if stripped in ("First hand:", "Second hand:"):
                group = stripped[:-1]
                continue
            step = re.match(r"Step\s+\d+:\s*(.+)", stripped)
            if step:
                text = step.group(1)
                steps.append(f"{group}: {text}" if group else text)
        if steps:
            gestures[heading.group(1)] = steps
    return {"general": general, "two_hand_rule": two_hand_rule, "gestures": gestures}


@app.get("/api/gesture-guides")
def get_gesture_guides() -> dict:
    alphabet = _parse_alphabet_guide(
        _read_guide_text("isl_alphabet_gestures.txt")
    )
    numbers = _parse_number_guide(
        _read_guide_text("number_gestures_steps.txt")
    )
    if len(alphabet["gestures"]) != 26 or len(numbers["gestures"]) != 9:
        raise HTTPException(
            status_code=503,
            detail="The uploaded alphabet or number guide is incomplete.",
        )
    return {
        "alphabet": alphabet,
        "number": numbers,
    }


@app.get("/api/gestures")
def get_gestures() -> list[dict]:
    with database.connect() as db:
        return database.gesture_rows(db)


@app.post("/api/gestures", status_code=201)
def add_gesture(payload: GestureInput) -> dict:
    try:
        with database.connect() as db:
            if payload.reference_id:
                reference = db.execute(
                    """
                    SELECT label, meaning, category, kind
                    FROM isl_reference WHERE id = ?
                    """,
                    (payload.reference_id,),
                ).fetchone()
                if reference is None:
                    raise HTTPException(
                        status_code=404, detail="ISL reference gesture not found."
                    )
                gesture_id = database.sync_reference_gesture(
                    db,
                    payload.reference_id,
                    reference["label"],
                    reference["meaning"],
                    reference["category"],
                    reference["kind"],
                    previous_label=reference["label"],
                    previous_kind=reference["kind"],
                )
                return {
                    "id": gesture_id,
                    "message": "Linked AI Learning class is ready for training.",
                }
            cursor = db.execute(
                """
                INSERT INTO gestures (label, meaning, language, category, kind)
                VALUES (?, ?, ?, ?, ?)
                """,
                (payload.label.strip(), payload.meaning.strip(), payload.language, payload.category, payload.kind),
            )
            gesture_id = cursor.lastrowid
    except IntegrityError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        "id": gesture_id,
        "message": "Gesture class created. Save training examples for live matching; validation status is tracked separately.",
    }


@app.post("/api/gestures/{gesture_id}/samples", status_code=201)
def add_sample(gesture_id: int, payload: SampleInput) -> dict:
    features = payload.features
    valid = valid_feature_vector(features)
    if isinstance(features, list) and features and isinstance(features[0], list):
        valid = len(features) >= 3 and len(features) <= 120 and all(
            valid_feature_vector(frame) for frame in features
        )
    if not valid:
        raise HTTPException(
            status_code=400,
            detail=f"Features must be a {FEATURE_SIZE}-value vector or a sequence of 3-120 such vectors.",
        )
    with database.connect() as db:
        gesture = db.execute("SELECT id FROM gestures WHERE id = ?", (gesture_id,)).fetchone()
        if gesture is None:
            raise HTTPException(status_code=404, detail="Gesture class not found")
        cursor = db.execute(
            """
            INSERT INTO samples
                (gesture_id, features_json, signer_id, handedness, split)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                gesture_id,
                json.dumps(features),
                payload.signer_id.strip(),
                payload.handedness,
                payload.split,
            ),
        )
        count = db.execute(
            "SELECT COUNT(*) AS count FROM samples WHERE gesture_id = ?", (gesture_id,)
        ).fetchone()["count"]
    return {"id": cursor.lastrowid, "sample_count": count}


@app.delete("/api/gestures/{gesture_id}")
def delete_gesture(gesture_id: int) -> dict:
    with database.connect() as db:
        cursor = db.execute("DELETE FROM gestures WHERE id = ?", (gesture_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Gesture class not found")
    return {"deleted": True}


@app.get("/api/history")
def get_history(query: str = "") -> list[dict]:
    with database.connect() as db:
        rows = db.execute(
            """
            SELECT id, mode, text, confidence, created_at FROM history
            WHERE text LIKE ? ORDER BY id DESC LIMIT 200
            """,
            (f"%{query[:100]}%",),
        ).fetchall()
        return [dict(row) for row in rows]


@app.post("/api/history", status_code=201)
def add_history(payload: HistoryInput) -> dict:
    with database.connect() as db:
        cursor = db.execute(
            "INSERT INTO history (mode, text, confidence) VALUES (?, ?, ?)",
            (payload.mode, payload.text.strip(), payload.confidence),
        )
        return {"id": cursor.lastrowid}


@app.delete("/api/history")
def clear_history() -> dict:
    with database.connect() as db:
        db.execute("DELETE FROM history")
    return {"cleared": True}


@app.delete("/api/history/{history_id}")
def delete_history(history_id: int) -> dict:
    with database.connect() as db:
        cursor = db.execute("DELETE FROM history WHERE id = ?", (history_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="History entry not found")
    return {"deleted": True}


@app.get("/api/isl-reference")
def get_isl_reference() -> list[dict]:
    with database.connect() as db:
        return database.isl_reference_rows(db)


@app.post("/api/isl-reference", status_code=201)
def add_isl_reference(payload: ISLReferenceInput) -> dict:
    import uuid
    import re
    gesture_id = payload.id.strip() if payload.id and payload.id.strip() else None
    if not gesture_id:
        clean_label = re.sub(r'[^a-zA-Z0-9]', '_', payload.label.strip())
        gesture_id = f"G_{clean_label}_{uuid.uuid4().hex[:6]}"

    with database.connect() as db:
        existing = db.execute("SELECT id FROM isl_reference WHERE id = ?", (gesture_id,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail=f"A gesture with ID '{gesture_id}' already exists.")

        db.execute(
            """
            INSERT INTO isl_reference (id, symbol, category, label, meaning, hindi, kind, steps_json, tip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                gesture_id,
                payload.symbol.strip() or "✋",
                payload.category.strip() or "Common",
                payload.label.strip(),
                payload.meaning.strip(),
                payload.hindi.strip(),
                payload.kind,
                json.dumps([s.strip() for s in payload.steps if s.strip()]),
                payload.tip.strip() if payload.tip else "",
            ),
        )
        training_gesture_id = database.sync_reference_gesture(
            db,
            gesture_id,
            payload.label.strip(),
            payload.meaning.strip(),
            payload.category.strip() or "Common",
            payload.kind,
            previous_label=payload.label.strip(),
            previous_kind=payload.kind,
        )
    return {
        "id": gesture_id,
        "training_gesture_id": training_gesture_id,
        "message": "ISL reference gesture added successfully.",
    }


@app.put("/api/isl-reference/{gesture_id}")
def update_isl_reference(gesture_id: str, payload: ISLReferenceInput) -> dict:
    with database.connect() as db:
        existing = db.execute(
            "SELECT id, label, kind FROM isl_reference WHERE id = ?",
            (gesture_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Gesture not found in ISL reference.")

        db.execute(
            """
            UPDATE isl_reference
            SET symbol = ?, category = ?, label = ?, meaning = ?, hindi = ?, kind = ?, steps_json = ?, tip = ?
            WHERE id = ?
            """,
            (
                payload.symbol.strip() or "✋",
                payload.category.strip() or "Common",
                payload.label.strip(),
                payload.meaning.strip(),
                payload.hindi.strip(),
                payload.kind,
                json.dumps([s.strip() for s in payload.steps if s.strip()]),
                payload.tip.strip() if payload.tip else "",
                gesture_id,
            ),
        )
        training_gesture_id = database.sync_reference_gesture(
            db,
            gesture_id,
            payload.label.strip(),
            payload.meaning.strip(),
            payload.category.strip() or "Common",
            payload.kind,
            previous_label=existing["label"],
            previous_kind=existing["kind"],
        )
    return {
        "id": gesture_id,
        "training_gesture_id": training_gesture_id,
        "message": "ISL reference gesture updated successfully.",
    }


@app.delete("/api/isl-reference/{gesture_id}")
def delete_isl_reference(gesture_id: str) -> dict:
    with database.connect() as db:
        db.execute(
            "DELETE FROM isl_reference_images WHERE reference_id = ?", (gesture_id,)
        )
        cursor = db.execute("DELETE FROM isl_reference WHERE id = ?", (gesture_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Gesture not found in ISL reference.")
        database.unlink_reference_gesture(db, gesture_id)
    return {"deleted": True, "id": gesture_id}


@app.post("/api/isl-reference/{gesture_id}/images", status_code=201)
def add_isl_reference_image(
    gesture_id: str, payload: ISLReferenceImageInput
) -> dict:
    encoded = payload.image_data.split(",", 1)[-1]
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=400, detail="Photo must be valid base64 image data.") from error

    max_image_bytes = 4 * 1024 * 1024
    if not image_bytes or len(image_bytes) > max_image_bytes:
        raise HTTPException(
            status_code=413,
            detail="Each gesture photo must be smaller than 4 MB.",
        )

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            mime_type = {
                "JPEG": "image/jpeg",
                "PNG": "image/png",
                "WEBP": "image/webp",
            }.get(image.format)
            if mime_type is None:
                raise HTTPException(
                    status_code=400,
                    detail="Upload a valid JPEG, PNG, or WebP photo.",
                )
            if image.width * image.height > 16_000_000:
                raise HTTPException(
                    status_code=400,
                    detail="The uploaded photo has too many pixels.",
                )
            image.load()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise HTTPException(
            status_code=400,
            detail="The uploaded photo is invalid or has too many pixels.",
        ) from error

    with database.connect() as db:
        if not db.execute(
            "SELECT id FROM isl_reference WHERE id = ?", (gesture_id,)
        ).fetchone():
            raise HTTPException(status_code=404, detail="Gesture not found in ISL reference.")
        image_count = db.execute(
            "SELECT COUNT(*) AS count FROM isl_reference_images WHERE reference_id = ?",
            (gesture_id,),
        ).fetchone()["count"]
        if image_count >= 12:
            raise HTTPException(
                status_code=400,
                detail="A gesture can have at most 12 reference photos.",
            )
        image_id = db.execute(
            """
            INSERT INTO isl_reference_images (reference_id, mime_type, image_data)
            VALUES (?, ?, ?)
            """,
            (gesture_id, mime_type, image_bytes),
        ).lastrowid
    return {
        "id": image_id,
        "url": f"/api/isl-reference/{gesture_id}/images/{image_id}",
    }


@app.post("/api/gestures/{gesture_id}/import-reference-photos")
def import_reference_photos(
    gesture_id: int, payload: ReferencePhotoImportInput
) -> dict:
    with database.connect() as db:
        gesture = db.execute(
            "SELECT id, kind FROM gestures WHERE id = ?", (gesture_id,)
        ).fetchone()
        if gesture is None:
            raise HTTPException(status_code=404, detail="Gesture class not found.")
        if gesture["kind"] != "static":
            raise HTTPException(
                status_code=400,
                detail="Reference photos can only be imported into static gestures.",
            )
        reference = db.execute(
            "SELECT id FROM isl_reference WHERE id = ?",
            (payload.reference_id,),
        ).fetchone()
        if reference is None:
            raise HTTPException(
                status_code=404, detail="ISL reference gesture not found."
            )
        photos = db.execute(
            """
            SELECT id, mime_type, image_data
            FROM isl_reference_images WHERE reference_id = ? ORDER BY id
            """,
            (payload.reference_id,),
        ).fetchall()

    imported_count = 0
    skipped_count = 0
    failed = []
    for photo in photos:
        image_data = (
            f"data:{photo['mime_type']};base64,"
            f"{base64.b64encode(photo['image_data']).decode('ascii')}"
        )
        try:
            analysis = landmarks.analyze(image_data)
        except (ValueError, ImportError, AttributeError, RuntimeError) as error:
            failed.append({"photo_id": photo["id"], "reason": str(error)})
            continue

        hands = analysis.get("hands", [])
        if not hands:
            failed.append(
                {"photo_id": photo["id"], "reason": "No hand was detected."}
            )
            continue
        for index, hand in enumerate(hands):
            features = hand.get("features")
            if not valid_feature_vector(features):
                failed.append(
                    {
                        "photo_id": photo["id"],
                        "reason": f"Detected hand must have {FEATURE_SIZE} valid landmark values.",
                    }
                )
                continue
            signer_id = f"reference-photo-{photo['id']}-{index + 1}"
            with database.connect() as db:
                exists = db.execute(
                    """
                    SELECT id FROM samples
                    WHERE gesture_id = ? AND signer_id = ? AND split = 'train'
                    """,
                    (gesture_id, signer_id),
                ).fetchone()
                if exists:
                    skipped_count += 1
                    continue
                db.execute(
                    """
                    INSERT INTO samples
                        (gesture_id, features_json, signer_id, handedness, split)
                    VALUES (?, ?, ?, ?, 'train')
                    """,
                    (
                        gesture_id,
                        json.dumps(features),
                        signer_id,
                        hand.get("handedness")
                        if hand.get("handedness") in ("Left", "Right")
                        else "any",
                    ),
                )
            imported_count += 1

    return {
        "imported_count": imported_count,
        "skipped_count": skipped_count,
        "failed": failed,
    }


@app.get("/api/isl-reference/{gesture_id}/images/{image_id}")
def get_isl_reference_image(gesture_id: str, image_id: int) -> Response:
    with database.connect() as db:
        image = db.execute(
            """
            SELECT mime_type, image_data FROM isl_reference_images
            WHERE id = ? AND reference_id = ?
            """,
            (image_id, gesture_id),
        ).fetchone()
    if image is None:
        raise HTTPException(status_code=404, detail="Gesture photo not found.")
    return Response(
        content=image["image_data"],
        media_type=image["mime_type"],
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.delete("/api/isl-reference/{gesture_id}/images/{image_id}")
def delete_isl_reference_image(gesture_id: str, image_id: int) -> dict:
    with database.connect() as db:
        cursor = db.execute(
            "DELETE FROM isl_reference_images WHERE id = ? AND reference_id = ?",
            (image_id, gesture_id),
        )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Gesture photo not found.")
    return {"deleted": True, "id": image_id}


@app.post("/api/isl-reference/reset")
def reset_isl_reference() -> dict:
    with database.connect() as db:
        db.execute("DELETE FROM isl_reference_images")
        db.execute("DELETE FROM isl_reference")
        database.seed_isl_reference_if_empty(db)
        count = db.execute("SELECT COUNT(*) AS count FROM isl_reference").fetchone()["count"]
    return {"message": f"Reset completed. {count} reference gestures restored."}

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
