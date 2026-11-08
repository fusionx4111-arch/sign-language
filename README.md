# Signova — Indian Sign Language Communication Prototype

Signova is a local-first, exhibition-ready prototype for exploring two-way communication between signers and speakers. It provides browser webcam capture, MediaPipe hand/face landmark detection, an explicitly sample-gated gesture matcher, sentence editing, speech playback, browser speech captions, emergency phrases, dataset collection, dictionary, and local conversation history.

> **Scope and safety:** This is not a complete ISL translator and does not ship with a recognition model or training samples. Live predictions use only gesture classes and training examples recorded locally in AI Learning Mode, including letters and numbers you choose to train. Validation samples are kept out of matching and readiness is reported separately. Similarity scores are not calibrated probabilities. Do not rely on this prototype for emergency response or other high-stakes communication.

## Architecture

```text
Browser dashboard
  ├─ getUserMedia camera ─ JPEG frames ─────────┐
  ├─ browser SpeechRecognition / speechSynthesis│
  ├─ accessible UI, sentence builder, settings  │
  └─ local fetch API ───────────────────────────┤
                                                 ▼
FastAPI local service (127.0.0.1:8000)
  ├─ OpenCV decode + MediaPipe Hands / Face Mesh
  ├─ normalized hand landmark extraction
  ├─ static nearest-example / dynamic DTW matching over saved examples
  ├─ gesture sample, history, dictionary endpoints
  └─ MySQL persistence (local MySQL Server)
```

The modules are separated between API and service logic. Facial landmarks are shown as detection/context only; the prototype does not infer emotions as sign meanings. Browser speech APIs may vary by browser and may require network access even though this application does not upload audio.

## How camera recognition works

1. The browser requests camera permission, captures a frame about every 300 ms,
   draws the detected 21-point hand skeleton, and sends the JPEG to the local
   `/api/analyze` endpoint.
2. MediaPipe finds up to two hands. The backend derives wrist-relative features
   and handedness; it does not save the camera frame.
3. Live prediction compares those landmarks only with examples saved for
   gesture classes in AI Learning Mode. Static gestures use nearest-example
   matching; dynamic gestures use sequence matching.
4. Letters and numbers are recognized only after you create their classes and
   save training samples. The bundled dictionary guides
   are visual references, not recognition training data.
5. Saved training examples can be matched live immediately. Validation
   examples are kept out of live matching and the dashboard separately reports
   whether each class has enough training, validation, and contributor
   coverage. This is not a full ISL word or sentence translator.

## Project structure

```text
backend/
  database.py       MySQL schema, connections, and dataset/history access
  main.py           FastAPI endpoints and static frontend hosting
  recognition.py    Confidence-gated static and temporal matching
  vision.py         MediaPipe/OpenCV landmark extraction
frontend/
  index.html        Dashboard and feature pages
  styles.css        Responsive accessible interface and themes
  app.js            Camera, speech, UI, and API modules
datasets/
  README.md         Collection, consent, and evaluation guidance
isl_alphabet_gestures.txt
number_gestures_steps.txt
                    Source instructions shown by Gesture Learning
models/
  README.md         Model artifact and versioning policy
tests/
  test_database.py
  test_recognition.py
requirements.txt
requirements-dev.txt
.env.example
```

## MySQL database setup (Windows)

The application uses a local MySQL Server database. You do not need to create the app tables manually; Signova creates them on its first successful start. Existing database names and credentials remain `signbridge` by default, so renaming the website does not require a database migration.

### 1. Install and start MySQL Server

Install **MySQL Community Server 8.x** using the official Windows MySQL Installer (choose MySQL Server; Workbench is optional). Remember the root password you choose during installation. Start the MySQL service from Windows **Services** (`services.msc`) if the installer did not start it. The default port is `3306`. This computer already has the `MySQL80` service running.

### 2. Create the application database and a restricted user

Open MySQL Workbench and connect as `root`, or open PowerShell and run `mysql -u root -p`. In the SQL editor/CLI, execute the following. Replace the example password with your own strong password; do not put the root account in the app configuration.

```sql
CREATE DATABASE IF NOT EXISTS signbridge
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'signbridge_app'@'127.0.0.1'
  IDENTIFIED BY 'replace_this_with_a_strong_password';

GRANT ALL PRIVILEGES ON signbridge.*
  TO 'signbridge_app'@'127.0.0.1';
```

### 3. Configure the application connection

From the project directory, create your private environment file and edit it:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `DB_PASSWORD` to the exact password used in the `CREATE USER` statement. The other `.env.example` values match the database/user above. `.env` is ignored by Git; do not share or commit it.

The backend reads `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` when it starts. Alternatively, configure a SQLAlchemy `DATABASE_URL` instead of these fields. If the password contains URL-reserved characters, prefer the separate `DB_*` fields.

### 4. Install Python packages and run

Use Python 3.11 for the pinned MediaPipe version.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Run the command from the project root. To start the app directly instead, run `.\.venv\Scripts\python.exe backend\main.py`. Use the `.venv` interpreter for both commands; the system Python 3.14 does not support this project's pinned MediaPipe version.

On startup, the app connects to MySQL and automatically creates the `gestures`, `samples`, and `history` tables. Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Camera and microphone access require localhost (or HTTPS) and user permission. If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that terminal, then activate the environment.

To start the website manually on a later day, open PowerShell in this project
folder and run:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Keep that PowerShell window open while using the site, then visit
`http://127.0.0.1:8000` in your browser. Press **Ctrl+C** in the PowerShell
window when you are finished. Start MySQL first if it is not already running.
The website needs the local server running because the browser uses it for the
database, camera analysis, and saved gesture data; closing the server stops
those features until you run the command again.

The interface adapts to phone, tablet, and laptop screen widths. Search-engine
listing and social previews require publishing the app at a public HTTPS domain;
`127.0.0.1` is local to your computer and cannot be indexed. Set the canonical,
Open Graph, and social-card URLs and publish a sitemap after choosing that
domain.

If startup reports a database connection error, check that the MySQL service is running, `.env` is in the project root, the database/user/password match, and port `3306` is available. If PowerShell says `mysql` is not recognized, use Workbench's SQL editor or add the MySQL `bin` folder to PATH.

The previous SQLite file, if any, is not automatically imported. New MySQL tables start empty; back up any existing data before migrating it.

Run tests with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest
```

## Collecting gesture examples

1. Open **AI learning mode**, create a class, and select static or dynamic.
2. Start the camera in **Live recognition** and keep the hand(s) clearly visible.
3. Use a consistent anonymous contributor ID. Record at least 8 training samples.
4. Change the split to validation and record at least 2 samples. Include a second contributor; for stronger evaluation, keep validation contributors out of training.
5. Check the dataset status. A complete dataset has 8 training samples, 2 validation samples, and 2 contributors; only training samples are used for live matching.
6. Test the class under varied positions, lighting, and users; record any errors and do not treat prototype matches as verified translation.

Samples store normalized hand landmarks, signer ID, and split in MySQL. They do not store camera images. Collect only with informed consent. See [datasets/README.md](datasets/README.md).

Gesture Learning displays the saved reference photos for all alphabet and
number entries. Its alphabet and number instructions come directly from
`isl_alphabet_gestures.txt` and `number_gestures_steps.txt`; the separate
dictionary instructions remain unchanged.

### Dictionary reference photos and training

Edit a gesture in the ISL dictionary to upload up to 12 JPEG, PNG, or WebP
reference photos (maximum 4 MB each). These photos are stored in the local
database and displayed with that dictionary entry; they are visual references,
not training samples. Use **Train this gesture** on its guide to create or
select the corresponding recognition class and open AI Learning Mode. Record
webcam landmark samples there. Saved training samples are used for live
matching; validation samples are held out. The app reports when a class reaches
8 training samples, 2 validation samples, and at least 2 contributors.

### Letter-based phrase suggestions and hands-free controls

The app loads the 447 bilingual entries from
[datasets/isl_phrase_dictionary.json](datasets/isl_phrase_dictionary.json),
exported from the approved `ISL_phrase_dictionary.xlsx` `Phrases` sheet.
Suggestions are filtered by a letter recognized from your saved gesture
samples and ordered by workbook
priority; they are phrase ideas, not a sentence translation. Review/select an
idea, then use the visible controls to add it to the sentence and speak it.
English or Hindi speech follows the selected speech language.

Pointing, eye-gaze navigation, and double-blink controls are separately opt-in
and off by default. Capture open eyes while looking at the camera to calibrate
the gaze center; look left/right to browse ideas, then double-blink with both
eyes to select and speak one. The live preview
draws eye contours and iris markers alongside the hand landmark skeleton.
Blink selection requires both eyes to close together. In AI Learning Mode, its separate
double-blink option saves the current sample only when a gesture class,
contributor, split, and hand are ready. Manual buttons and arrow-key
navigation remain available. Eye measurements are computed locally and are
not stored. Training stores hand landmarks only—never camera photos or video.
Blink detection depends on camera angle, lighting, and the user's eyes, so use
the manual controls if it does not respond reliably.

AI Learning Mode also includes hands-free practice: capture open-eye and
closed-eye readings to calibrate blink detection for the current session, then
practice index-finger left/right swipes with live feedback. Calibration and
practice readings are temporary; they do not create gesture training samples.

## API

The interactive API reference is available at `/docs`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | MySQL connection and vision dependency status |
| `POST` | `/api/analyze` | Analyze a base64 JPEG frame and optional recent landmark sequence |
| `GET` | `/api/phrase-suggestions?letter=A&limit=8` | Get priority-ranked bilingual ideas for a recognized letter |
| `GET` | `/api/gesture-guides` | Read the uploaded alphabet and number instructions used by Gesture Learning |
| `GET` | `/api/gestures` | List classes and sample readiness |
| `POST` | `/api/gestures` | Create a static or dynamic gesture class |
| `POST` | `/api/gestures/{id}/samples` | Add a landmark vector or temporal sequence with signer and split |
| `DELETE` | `/api/gestures/{id}` | Delete a class and its samples |
| `GET` | `/api/history?query=` | Search recent local history |
| `POST` | `/api/history` | Save sign, speech, or emergency text |
| `DELETE` | `/api/history` | Clear history |
| `DELETE` | `/api/history/{id}` | Delete one history entry |
| `POST` | `/api/isl-reference/{id}/images` | Save a dictionary reference photo |
| `GET` | `/api/isl-reference/{id}/images/{image_id}` | Display a saved dictionary photo |
| `DELETE` | `/api/isl-reference/{id}/images/{image_id}` | Remove a dictionary photo |

`/api/analyze` uses the browser-provided frame and keeps no image. It returns hand landmarks, face-detection status, a transient eye-closure signal for the opt-in blink controls, and gesture results only from saved classes that meet the sample/contributor gates and match above the heuristic distance/margin threshold. Eye measurements and face landmarks are not saved. Invalid input and unavailable vision dependencies return explicit HTTP errors.

## Implemented phases

1. **Prototype foundation:** local API, MySQL, webcam permission/error handling, MediaPipe landmarks, and basic static gesture matching.
2. **Recognition workflow:** dynamic landmark sequence matching, duplicate suppression, confidence rejection, face landmark status, and controlled sample collection.
3. **Communication:** editable sentence builder, browser Hindi/English text-to-speech and speech captions.
4. **Smart features:** emergency phrases, local history/search/delete, gesture dictionary, language and theme settings.
5. **Validation:** focused unit tests for readiness gates and recognition rejection; dataset guide documents further signer/lighting/latency evaluation still required.
