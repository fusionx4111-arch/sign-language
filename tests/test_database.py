from sqlalchemy import create_engine
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from backend.database import (
    connect,
    gesture_rows,
    initialize,
    metadata,
    training_samples,
)


def test_gesture_needs_training_validation_and_multiple_signers(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.sqlite3'}")
    initialize(engine)
    with connect(engine) as db:
        gesture_id = db.execute(
            "INSERT INTO gestures (label, meaning, kind) VALUES (?, ?, ?)",
            ("hello", "Hello", "static"),
        ).lastrowid
        for index in range(8):
            db.execute(
                "INSERT INTO samples (gesture_id, features_json, signer_id, split) VALUES (?, ?, ?, ?)",
                (gesture_id, "[0]", "person-a", "train"),
            )
        assert gesture_rows(db)[0]["ready"] is False
        db.execute(
            "INSERT INTO samples (gesture_id, features_json, signer_id, split) VALUES (?, ?, ?, ?)",
            (gesture_id, "[0]", "person-b", "validation"),
        )
        db.execute(
            "INSERT INTO samples (gesture_id, features_json, signer_id, split) VALUES (?, ?, ?, ?)",
            (gesture_id, "[0]", "person-b", "validation"),
        )
        assert gesture_rows(db)[0]["ready"] is True
    engine.dispose()


def test_mysql_schema_uses_supported_create_table_ddl():
    statements = [
        str(CreateTable(table).compile(dialect=mysql.dialect()))
        for table in metadata.sorted_tables
    ]
    assert len(statements) == 4
    assert all("AUTO_INCREMENT" in statement for statement in statements)
    assert all("DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP" in statement for statement in statements)


def test_live_training_samples_exclude_validation_rows(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'training-samples.sqlite3'}")
    initialize(engine)
    with connect(engine) as db:
        gesture_id = db.execute(
            "INSERT INTO gestures (label, meaning, kind) VALUES (?, ?, ?)",
            ("A", "Letter A", "static"),
        ).lastrowid
        db.execute(
            "INSERT INTO samples (gesture_id, features_json, signer_id, split) VALUES (?, ?, ?, ?)",
            (gesture_id, "[0]", "person-a", "train"),
        )
        db.execute(
            "INSERT INTO samples (gesture_id, features_json, signer_id, split) VALUES (?, ?, ?, ?)",
            (gesture_id, "[1]", "person-b", "validation"),
        )

        collected = training_samples(db)

    assert len(collected) == 1
    assert collected[0]["id"] == gesture_id
    assert collected[0]["features"] == [0]
    engine.dispose()
