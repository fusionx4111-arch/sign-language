from pathlib import Path
import json
import os
from contextlib import contextmanager
from typing import Iterator

from dotenv import load_dotenv
from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.engine import Connection, Engine, URL


load_dotenv()

metadata = MetaData()
gestures = Table(
    "gestures",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("label", String(80), nullable=False),
    Column("meaning", String(200), nullable=False),
    Column("language", String(2), nullable=False, server_default="en"),
    Column("category", String(50), nullable=False, server_default="daily"),
    Column("kind", String(10), nullable=False),
    Column("created_at", DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP")),
    CheckConstraint("kind IN ('static', 'dynamic')", name="ck_gestures_kind"),
)
samples = Table(
    "samples",
    metadata,
    Column("id", Integer, primary_key=True),
    Column(
        "gesture_id",
        Integer,
        ForeignKey("gestures.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("features_json", Text, nullable=False),
    Column("signer_id", String(80), nullable=False),
    Column("handedness", String(5), nullable=False, server_default="any"),
    Column("split", String(10), nullable=False),
    Column("created_at", DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP")),
    CheckConstraint(
        "handedness IN ('Left', 'Right', 'any')", name="ck_samples_handedness"
    ),
    CheckConstraint("split IN ('train', 'validation')", name="ck_samples_split"),
)
history = Table(
    "history",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("mode", String(10), nullable=False),
    Column("text", Text, nullable=False),
    Column("confidence", Float),
    Column("created_at", DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP")),
    CheckConstraint(
        "mode IN ('sign', 'speech', 'emergency')", name="ck_history_mode"
    ),
)
isl_metadata = MetaData()
isl_reference = Table(
    "isl_reference",
    isl_metadata,
    Column("id", String(40), primary_key=True),
    Column("symbol", String(20), nullable=False, server_default="✋"),
    Column("category", String(50), nullable=False, server_default="Common"),
    Column("label", String(80), nullable=False),
    Column("meaning", String(250), nullable=False),
    Column("hindi", String(250), nullable=False, server_default=""),
    Column("kind", String(10), nullable=False, server_default="static"),
    Column("steps_json", Text, nullable=False),
    Column("tip", Text, nullable=True),
    Column("created_at", DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP")),
    Column("updated_at", DateTime, nullable=True),
)
isl_reference_images = Table(
    "isl_reference_images",
    isl_metadata,
    Column("id", Integer, primary_key=True),
    Column(
        "reference_id",
        String(40),
        ForeignKey("isl_reference.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("mime_type", String(20), nullable=False),
    Column("image_data", LargeBinary, nullable=False),
    Column("created_at", DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP")),
)

_engine: Engine | None = None


def _database_url() -> URL | str:
    explicit_url = os.getenv("DATABASE_URL")
    if explicit_url:
        return explicit_url

    password = os.getenv("DB_PASSWORD")
    if not password:
        raise RuntimeError(
            "MySQL is not configured. Set DB_PASSWORD and DB_NAME, DB_USER, "
            "DB_HOST, and DB_PORT in your .env file. See README.md."
        )
    return URL.create(
        "mysql+pymysql",
        username=os.getenv("DB_USER", "signbridge"),
        password=password,
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        database=os.getenv("DB_NAME", "signbridge"),
        query={"charset": "utf8mb4"},
    )


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(
            _database_url(),
            pool_pre_ping=True,
            pool_recycle=1800,
        )
    return _engine


def configure(database_url: str) -> None:
    """Replace the engine, primarily for isolated tests or explicit deployment setup."""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = create_engine(database_url, pool_pre_ping=True, pool_recycle=1800)


class QueryResult:
    def __init__(self, result):
        self._result = result

    @property
    def lastrowid(self):
        return self._result.lastrowid

    @property
    def rowcount(self):
        return self._result.rowcount

    def fetchone(self):
        row = self._result.mappings().fetchone()
        return dict(row) if row is not None else None

    def fetchall(self):
        return [dict(row) for row in self._result.mappings().fetchall()]


class DatabaseConnection:
    def __init__(self, connection: Connection):
        self._connection = connection

    def execute(self, statement: str, parameters: tuple | dict | None = None) -> QueryResult:
        if isinstance(parameters, tuple):
            names = [f"p{index}" for index in range(len(parameters))]
            for name in names:
                statement = statement.replace("?", f":{name}", 1)
            parameters = dict(zip(names, parameters))
        return QueryResult(self._connection.execute(text(statement), parameters or {}))


@contextmanager
def connect(engine: Engine | None = None) -> Iterator[DatabaseConnection]:
    selected_engine = engine or get_engine()
    with selected_engine.begin() as connection:
        yield DatabaseConnection(connection)


def initialize(engine: Engine | None = None) -> None:
    selected_engine = engine or get_engine()
    metadata.create_all(selected_engine)
    isl_metadata.create_all(selected_engine)
    sample_columns = {
        column["name"] for column in inspect(selected_engine).get_columns("samples")
    }
    if "handedness" not in sample_columns:
        with selected_engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE samples ADD COLUMN handedness VARCHAR(5) NOT NULL DEFAULT 'any'")
            )
    with selected_engine.begin() as connection:
        seed_isl_reference_if_empty(DatabaseConnection(connection))


def gesture_rows(db: DatabaseConnection) -> list[dict]:
    rows = db.execute(
        """
        SELECT g.id, g.label, g.meaning, g.language, g.category, g.kind,
               g.created_at, COUNT(s.id) AS sample_count,
               SUM(CASE WHEN s.split = 'train' THEN 1 ELSE 0 END) AS train_count,
               SUM(CASE WHEN s.split = 'validation' THEN 1 ELSE 0 END) AS validation_count,
               COUNT(DISTINCT s.signer_id) AS signer_count
        FROM gestures g LEFT JOIN samples s ON s.gesture_id = g.id
        GROUP BY g.id ORDER BY LOWER(g.label)
        """
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["train_count"] = item["train_count"] or 0
        item["validation_count"] = item["validation_count"] or 0
        item["ready"] = (
            item["train_count"] >= 8
            and item["validation_count"] >= 2
            and item["signer_count"] >= 2
        )
        result.append(item)
    return result


def training_samples(db: DatabaseConnection) -> list[dict]:
    rows = db.execute(
        """
        SELECT g.id, g.label, g.meaning, g.language, g.kind,
               s.features_json, s.handedness
        FROM gestures g JOIN samples s ON s.gesture_id = g.id
        WHERE s.split = 'train'
        """
    ).fetchall()
    return [
        {
            "id": row["id"],
            "label": row["label"],
            "meaning": row["meaning"],
            "language": row["language"],
            "kind": row["kind"],
            "features": json.loads(row["features_json"]),
            "handedness": row["handedness"],
        }
        for row in rows
    ]


def isl_reference_rows(db: DatabaseConnection) -> list[dict]:
    rows = db.execute(
        """
        SELECT id, symbol, category, label, meaning, hindi, kind, steps_json, tip
        FROM isl_reference
        ORDER BY
            CASE category
                WHEN 'Alphabet' THEN 1
                WHEN 'Number' THEN 2
                WHEN 'Greeting' THEN 3
                WHEN 'Common' THEN 4
                ELSE 5
            END,
            LOWER(label)
        """
    ).fetchall()
    result = []
    image_rows = db.execute(
        "SELECT id, reference_id FROM isl_reference_images ORDER BY id"
    ).fetchall()
    images_by_reference: dict[str, list[dict]] = {}
    for image in image_rows:
        images_by_reference.setdefault(image["reference_id"], []).append(
            {
                "id": image["id"],
                "url": f"/api/isl-reference/{image['reference_id']}/images/{image['id']}",
            }
        )
    for row in rows:
        item = dict(row)
        try:
            item["steps"] = json.loads(item["steps_json"])
        except Exception:
            item["steps"] = []
        del item["steps_json"]
        item["photos"] = images_by_reference.get(item["id"], [])
        result.append(item)
    return result


def seed_isl_reference_if_empty(db: DatabaseConnection) -> None:
    count_row = db.execute("SELECT COUNT(*) AS count FROM isl_reference").fetchone()
    count = count_row["count"] if count_row else 0
    if count == 0:
        json_path = Path(__file__).resolve().parent / "default_isl.json"
        if json_path.exists():
            default_data = json.loads(json_path.read_text(encoding="utf-8"))
            for item in default_data:
                db.execute(
                    """
                    INSERT INTO isl_reference (id, symbol, category, label, meaning, hindi, kind, steps_json, tip)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item["id"],
                        item.get("symbol", "✋"),
                        item.get("category", "Common"),
                        item["label"],
                        item["meaning"],
                        item.get("hindi", ""),
                        item.get("kind", "static"),
                        json.dumps(item.get("steps", [])),
                        item.get("tip", ""),
                    ),
                )
