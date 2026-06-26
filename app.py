import datetime as dt
import json
import re
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, url_for
from werkzeug.utils import secure_filename

load_dotenv()

app = Flask(__name__)

DATA_DIR = Path(__file__).parent / "static" / "data"

# ── Uploaded data sources ────────────────────────────────────────────────────
# Phase 1: the LR cooking workbook can be replaced by a file uploaded from the
# Data page. The active source is the uploaded file when present, else the
# bundled default. An upload is only promoted to active once it parses cleanly.
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DEFAULT_LR_FILE = DATA_DIR / "LR_production_march.xlsx"
ACTIVE_LR_FILE = UPLOAD_DIR / "lr_cooking_active.xlsx"
ACTIVE_LR_META = UPLOAD_DIR / "lr_cooking_active.meta.json"
ACTIVE_ASSEMBLY_FILE = UPLOAD_DIR / "assembly_active.xlsx"
ACTIVE_ASSEMBLY_META = UPLOAD_DIR / "assembly_active.meta.json"
ACTIVE_MR_FILE = UPLOAD_DIR / "mr_packing_active.xlsx"
ACTIVE_MR_META = UPLOAD_DIR / "mr_packing_active.meta.json"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB (SATS workbooks embed product images)

app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


def _active_lr_path() -> Path:
    return ACTIVE_LR_FILE if ACTIVE_LR_FILE.exists() else DEFAULT_LR_FILE

# ── LR Excel parser ────────────────────────────────────────────────────────────

MACHINE_COLS = [
    (12, "Bowl Cutter"),
    (13, "Blender (Batching)"),
    (14, "Vegetable Cutting"),
    (15, "Peeling Machine"),
    (16, "Can Opener"),
    (17, "Robocoupe Dice"),
    (18, "Knife"),
    (19, "Meat Ball Machine"),
    (20, "Egg Filling"),
    (21, "Steam Box 1"),
    (22, "Steam Box 2"),
    (23, "Combi Oven 1"),
    (24, "Combi Oven 2"),
    (25, "Combi Oven 3"),
    (26, "Combi Oven 4"),
    (27, "Bratt Pan 1"),
    (28, "Bratt Pan 2"),
    (29, "Bratt Pan 3"),
    (30, "Bratt Pan 4"),
    (31, "Round Bratt Pan"),
    (32, "Pan Fry"),
    (33, "Deep Fryer 1"),
    (34, "Deep Fryer 2"),
    (35, "Deep Fryer 3"),
    (36, "Deep Fryer 4"),
    (37, "Hot Plate"),
    (38, "Flame Grill"),
]

_SKIP_KEYWORDS = ("cleaning line", "break", "เตรียม")


def _strip_step(name: str) -> str:
    """Strip batch / lot / quantity qualifiers from a step name.

    The report tags each batch of a step with markers such as "B.1", "B.1-B.2",
    "B.7-8.5", "5 batch", "(0.5 batch)", "Lot.080", "12/1" and even glued forms
    like "MushroomB.1". Removing these collapses every batch of one step into a
    single name so they can be merged.
    """
    s = name
    s = re.sub(r"\([^)]*\)", " ", s)                       # parentheticals: (0.5 batch), (*1.5)
    s = re.sub(r"lot\.?\s*\d+", " ", s, flags=re.I)        # Lot.080, Lot 086
    s = re.sub(r"\bB\.?\s*\d+(?:\.\d+)?"                   # B.1, B.12, B.7.5
               r"(?:\s*-\s*B?\.?\s*\d+(?:\.\d+)?)?",       #  ...-B.2, -2, -8.5
               " ", s, flags=re.I)
    s = re.sub(r"(?<=[a-z])B\.?\s*\d+(?:\.\d+)?", " ", s, flags=re.I)  # glued: MushroomB.1
    s = re.sub(r"\d+(?:\.\d+)?\s*batch\w*", " ", s, flags=re.I)        # 5 batch, 10.5 batches
    s = re.sub(r"\d+\s*B\.\s*", " ", s, flags=re.I)        # trailing "7 B."
    s = re.sub(r"\d+\s*/\s*\d+", " ", s)                   # 12/1, 1/2 fraction style
    s = re.sub(r"\*+", " ", s)                             # *** emphasis
    s = re.sub(r"\s+", " ", s).strip(" .,-/")
    return s


def _classify_stage(section: str) -> str:
    """Map the LR 'Section/Job' label to a dashboard stage. Prepare-* sections are
    food prep; everything else (Cooking, Cooking room, Support, blank) is cooking."""
    s = (section or "").lower()
    return "food_prep" if "prepare" in s or s.startswith("prep") else "cooking"


def _to_min(v) -> float:
    if isinstance(v, dt.time):
        return v.hour * 60 + v.minute + v.second / 60
    return 0.0


def _fmt_clock(v) -> str:
    """Format a start/stop cell (datetime.time or 'HH:MM[:SS]') as 'HH:MM'."""
    if isinstance(v, dt.time):
        return f"{v.hour:02d}:{v.minute:02d}"
    m = re.match(r"\s*(\d{1,2}):(\d{2})", str(v or ""))
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ── Menu-name normalisation ──────────────────────────────────────────────────
# The production report types each menu by hand, so the same dish appears with
# case differences, typos, "issue N" tags and varied format suffixes. We merge
# those into one canonical item while keeping genuinely different product formats
# (Bento / MU / CPET Tray) as separate items, and drop non-cooking/admin rows.

DATA_SHEET_RE = re.compile(r"^([DN])\s+(\d{1,2})\s+([A-Za-z]{3})", re.IGNORECASE)
_MONTHS = {m: i for i, m in enumerate(
    ["", "jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"])}
_MONTH_LABELS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_REPORT_YEAR = 2026

_ADMIN_RE = re.compile(
    r"move tools|produce\s*@|cooking room|prepare vegetable support|"
    r"support prepare|^\(?lot\.?|^lot\b|ขอยืม|ยังไม่",
    re.IGNORECASE,
)
_FORMAT_RULES = [
    ("Bento", re.compile(r"bento", re.IGNORECASE)),
    ("CPET Tray", re.compile(r"cpet", re.IGNORECASE)),
    ("MU", re.compile(r"\bmu\b", re.IGNORECASE)),
]


def _menu_format(name: str) -> str:
    for tag, rx in _FORMAT_RULES:
        if rx.search(name):
            return tag
    return ""


def _menu_base_key(name: str) -> str:
    s = name.lower()
    s = re.sub(r"\([^)]*\)", " ", s)        # drop parentheticals (formats/notes)
    s = re.sub(r"issue\s*\d+", " ", s)      # drop "issue 4"
    s = re.sub(r"lot\.?\s*\d+", " ", s)     # drop lot refs
    s = re.sub(r"\*+", " ", s)              # drop ***
    s = re.sub(r"[^a-z0-9]+", " ", s)       # punctuation -> space
    return re.sub(r"\s+", " ", s).strip()


def _menu_is_admin(name: str) -> bool:
    if not name or name.strip() in ("-", "Unknown"):
        return True
    if _ADMIN_RE.search(name):
        return True
    bk = _menu_base_key(name)
    if not bk or not re.search(r"[a-z]", bk):     # no latin letters (Thai-only etc.)
        return True
    if bk.startswith("produce stage") or bk.startswith("move tools"):
        return True
    return False


def _menu_display(name: str, fmt: str) -> str:
    disp = re.sub(r"\([^)]*\)", "", name)
    disp = re.sub(r"\s*issue\s*\d+", "", disp, flags=re.IGNORECASE)
    disp = re.sub(r"\*+", "", disp)
    disp = re.sub(r"\s+", " ", disp).strip(" ,")
    return f"{disp} ({fmt})" if fmt else disp


def _build_menu_canon(raw_counts: dict, threshold: float = 0.90) -> dict:
    """Map each raw menu string to a canonical display name (or None if admin)."""
    import difflib

    items = sorted(
        ((m, c) for m, c in raw_counts.items() if not _menu_is_admin(m)),
        key=lambda x: -x[1],
    )
    clusters = []  # {fmt, key, display}
    canon = {}
    for raw, _cnt in items:
        fmt = _menu_format(raw)
        bk = _menu_base_key(raw)
        best, best_r = None, 0.0
        for cl in clusters:
            if cl["fmt"] != fmt:
                continue
            r = difflib.SequenceMatcher(None, cl["key"], bk).ratio()
            if r > best_r:
                best_r, best = r, cl
        if best and best_r >= threshold:
            canon[raw] = best["display"]
        else:
            disp = _menu_display(raw, fmt)
            clusters.append({"fmt": fmt, "key": bk, "display": disp})
            canon[raw] = disp
    for m in raw_counts:
        if m not in canon:
            canon[m] = None
    return canon


def _step_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _build_step_canon(step_counts: dict, threshold: float = 0.88) -> dict:
    """Cluster the stripped step names within each menu into one canonical name.

    Steps are hand-typed, so the same step appears with typos and case/word
    differences ("Bechamel" / "Bechemal", "Scrambled Egg" / "Scramble egg").
    Within each menu we fuzzy-cluster the stripped names and pick the most
    frequent spelling as canonical. Returns {(menu, stripped_lower): display}.
    """
    import difflib

    canon = {}
    for menu, steps in step_counts.items():
        clusters = []  # {key, display}
        for disp, _cnt in sorted(steps.items(), key=lambda x: -x[1]):
            key = _step_key(disp)
            best, best_r = None, 0.0
            for cl in clusters:
                r = difflib.SequenceMatcher(None, cl["key"], key).ratio()
                if r > best_r:
                    best_r, best = r, cl
            if best and key and best_r >= threshold:
                canon[(menu, disp.lower())] = best["display"]
            else:
                clusters.append({"key": key, "display": disp})
                canon[(menu, disp.lower())] = disp
    return canon


def _sheet_date_iso(sheet_name: str):
    m = DATA_SHEET_RE.match(sheet_name.strip())
    if not m:
        return None
    mon = _MONTHS.get(m.group(3).lower())
    if not mon:
        return None
    return f"{_REPORT_YEAR}-{mon:02d}-{int(m.group(2)):02d}"


def _date_label(iso: str) -> str:
    _y, mo, d = iso.split("-")
    return f"{int(d)} {_MONTH_LABELS[int(mo)]}"


def _parse_lr_production(path: str) -> dict:
    """Parse the month-wide LR production report into per-(date, menu, step) rows.

    Batches of the same step are merged; each machine carries total run minutes
    and the number of batches it ran (so the client can show a per-batch time).
    """
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    data_sheets = [sn for sn in wb.sheetnames if _sheet_date_iso(sn)]

    # Pass 1 — read every component row once, carrying the menu and section/job
    # headers down. Each record is (iso, raw_menu, stripped_step, row, stage);
    # raw_counts feeds the menu clusterer and step_counts feeds the step one.
    records: list = []
    raw_counts: dict = {}
    date_labels: dict = {}
    for sn in data_sheets:
        iso = _sheet_date_iso(sn)
        date_labels[iso] = _date_label(iso)
        cur_menu = None
        cur_section = None
        for row in wb[sn].iter_rows(min_row=4, values_only=True):
            if not any(v is not None for v in row):
                continue
            if row[2] is not None and str(row[2]).strip() not in ("", "None"):
                cur_section = str(row[2]).strip()
            if row[3] is not None and str(row[3]).strip() not in ("", "None"):
                cur_menu = str(row[3]).strip()
            comp = row[4]
            if not comp or str(comp).strip() in ("", "None"):
                continue
            comp_s = str(comp).strip()
            if any(kw in comp_s.lower() for kw in _SKIP_KEYWORDS):
                continue
            raw_counts[cur_menu or ""] = raw_counts.get(cur_menu or "", 0) + 1
            records.append((iso, cur_menu or "", _strip_step(comp_s) or comp_s,
                            row, _classify_stage(cur_section)))

    wb.close()  # release the file handle (read_only keeps it open on Windows)

    canon = _build_menu_canon(raw_counts)

    # Count stripped steps per canonical menu, then cluster spelling variants.
    step_counts: dict = {}
    for _iso, raw_menu, step_disp, _row, _stage in records:
        menu = canon.get(raw_menu)
        if menu:
            step_counts.setdefault(menu, {})
            step_counts[menu][step_disp] = step_counts[menu].get(step_disp, 0) + 1
    step_canon = _build_step_canon(step_counts)

    # Pass 2 — aggregate by (date, canonical menu, canonical step, stage).
    agg: dict = {}
    for iso, raw_menu, step_stripped, row, stage in records:
        menu = canon.get(raw_menu)
        if not menu:
            continue
        step_disp = step_canon.get((menu, step_stripped.lower()), step_stripped)
        key = (iso, menu, step_disp.lower(), stage)
        entry = agg.get(key)
        if entry is None:
            entry = {
                "date": iso,
                "menu": menu,
                "step": step_disp,
                "stage": stage,
                "batches": 0,
                "duration_min": 0.0,
                "kg": 0.0,
                "workers": 0,
                "start": None,
                "stop": None,
                "kg_man_hr": 0.0,
                "_man_min": 0.0,
                "machines": {},
            }
            agg[key] = entry

        dur = _to_min(row[8])
        entry["batches"] += 1
        entry["duration_min"] += dur
        entry["kg"] += _num(row[10])

        # Workers (col 9), start/stop (cols 6/7) and labour-minutes for kg/man-hr.
        workers = _num(row[9])
        entry["workers"] = max(entry["workers"], int(workers))
        entry["_man_min"] += workers * dur
        start, stop = _fmt_clock(row[6]), _fmt_clock(row[7])
        if start and (entry["start"] is None or start < entry["start"]):
            entry["start"] = start
        if stop and (entry["stop"] is None or stop > entry["stop"]):
            entry["stop"] = stop

        row_len = len(row)
        for col_idx, machine_name in MACHINE_COLS:
            if col_idx < row_len:
                mins = _num(row[col_idx])
                if mins > 0:
                    mm = entry["machines"].setdefault(
                        machine_name, {"minutes": 0.0, "batches": 0})
                    mm["minutes"] += mins
                    mm["batches"] += 1

    tasks = []
    for entry in agg.values():
        entry["duration_min"] = round(entry["duration_min"], 1)
        entry["kg"] = round(entry["kg"], 2)
        man_min = entry.pop("_man_min", 0.0)
        entry["kg_man_hr"] = round(entry["kg"] / (man_min / 60), 2) if man_min > 0 else 0.0
        for mm in entry["machines"].values():
            mm["minutes"] = round(mm["minutes"], 1)
        tasks.append(entry)

    return {
        "dates": sorted(date_labels.keys()),
        "date_labels": date_labels,
        "tasks": tasks,
    }


# ── Assembly (HR) parser ─────────────────────────────────────────────────────
# The Assembly workbook has one block per production day on a single sheet:
# a date header row, per-menu rows, then a "Total" row. Columns map to the same
# OEE factors the dashboard already uses. Performance/Quality are capped at 100%.

def _assembly_date_label(value) -> str:
    m = re.search(r"(\d{1,2})-([A-Za-z]{3})", str(value or ""))
    return f"{int(m.group(1))} {m.group(2).capitalize()}" if m else ""


def _assembly_factors(asm_min, total_min, ordered, assembled, plan_rate, actual_rate):
    availability = asm_min / total_min if total_min > 0 else None
    performance = min(actual_rate / plan_rate, 1.0) if plan_rate > 0 and actual_rate > 0 else None
    quality = min(assembled / ordered, 1.0) if ordered > 0 else None
    oee = (availability * performance * quality
           if None not in (availability, performance, quality) else None)
    rnd = lambda v: round(v, 4) if v is not None else None
    return rnd(availability), rnd(performance), rnd(quality), rnd(oee)


def _parse_assembly(path: str) -> dict:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = next((wb[sn] for sn in wb.sheetnames if "chart" not in sn.lower()), wb[wb.sheetnames[0]])

    rows: list = []
    daily_totals: list = []
    cur_date = None
    for row in ws.iter_rows(values_only=True):
        c0 = row[0]
        if isinstance(c0, str) and re.search(r"\d{1,2}-[A-Za-z]{3}", c0):
            cur_date = _assembly_date_label(c0)
            continue
        if not cur_date or len(row) < 19:
            continue

        ordered, assembled = _num(row[5]), _num(row[17])
        asm_min, total_min = _num(row[12]), _num(row[16])
        plan_rate, actual_rate = _num(row[8]), _num(row[18])
        avail, perf, qual, oee = _assembly_factors(
            asm_min, total_min, ordered, assembled, plan_rate, actual_rate)

        if isinstance(c0, (int, float)) and row[2] and str(row[2]).strip() not in ("", "None"):
            rows.append({
                "date": cur_date,
                "menu": str(row[2]).strip(),
                "lot": "",
                "plan_tray_min": round(plan_rate, 2) or None,
                "ordered": int(ordered),
                "plan_window_min": _num(row[6]) or None,
                "actual_tray_min": round(actual_rate, 2) or None,
                "assembled": int(assembled),
                "assembly_time_min": asm_min or None,
                "total_window_min": total_min or None,
                "cleaning_min": _num(row[13]) or None,
                "bake_down_min": _num(row[14]) or None,
                "setup_min": _num(row[15]) or None,
                "availability": avail,
                "performance": perf,
                "quality": qual,
                "oee": oee,
                "root_cause": "",
                "impact": "",
            })
        elif isinstance(c0, str) and c0.strip().lower() == "total":
            daily_totals.append({
                "date": cur_date,
                "ordered": int(ordered),
                "assembled": int(assembled),
                "assembly_time_min": asm_min or None,
                "total_window_min": total_min or None,
                "availability": avail,
                "performance": perf,
                "quality": qual,
                "oee": oee,
            })
    wb.close()
    return {"rows": rows, "daily_totals": daily_totals}


# ── Packing (MR) parser ──────────────────────────────────────────────────────
# One sheet per day. Tasks are classified value-add vs downtime (Cleaning,
# Break, Clear Damage, etc.). Yields per-day Availability (run/total time),
# Utilisation (productive man-min / total man-min) and Activation (present vs
# scheduled headcount from the manpower footer). Quality is NOT taken from here.

MR_DOWN_KEYWORDS = ("cleaning", "break", "clear damage", "morning talk", "set up", "damage box")


def _mr_date_label(sheet_name) -> str:
    m = re.match(r"\s*(\d{1,2})-(\d{1,2})", str(sheet_name or ""))
    return f"{int(m.group(1))} {_MONTH_LABELS[int(m.group(2))]}" if m else ""


def _mr_is_downtime(c2, c3) -> bool:
    s = (str(c2 or "") + " " + str(c3 or "")).lower()
    return any(k in s for k in MR_DOWN_KEYWORDS)


def _mr_columns(ws) -> dict:
    """Locate the Time-Use / Worker / Output(Meal) columns from the header row,
    since the column layout differs between MR sheets."""
    cols = {}
    for row in ws.iter_rows(min_row=1, max_row=3, values_only=True):
        for j, v in enumerate(row):
            s = str(v or "").lower().replace("\n", " ")
            if "time use" in s and "dur" not in cols:
                cols["dur"] = j
            elif "worker" in s and "workers" not in cols:
                cols["workers"] = j
            elif "output" in s and "meal" in s and "meals" not in cols:
                cols["meals"] = j
        if "dur" in cols and "workers" in cols:
            break
    return cols


def _parse_mr(path: str) -> dict:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    utilization, headcount = [], []
    for sn in wb.sheetnames:
        date = _mr_date_label(sn)
        if not date:
            continue
        ws = wb[sn]
        cols = _mr_columns(ws)
        dur_c = cols.get("dur", 16)
        wk_c = cols.get("workers", 17)
        meal_c = cols.get("meals", 6)
        prod_t = down_t = mm_prod = mm_total = meals = 0.0
        activated, absent = None, 0
        for row in ws.iter_rows(values_only=True):
            cells = [str(v or "").strip() for v in row]
            for c in cells:
                m = re.search(r"absent\s*(\d+)", c, re.I)
                if m:
                    absent = int(m.group(1))
            # Manpower footer: a "Total <n> People" row gives the present headcount.
            if "Total" in cells and any("People" in c for c in cells):
                ti = cells.index("Total")
                for k in range(ti + 1, len(row)):
                    try:
                        activated = int(float(row[k]))
                        break
                    except (TypeError, ValueError):
                        continue
                continue

            c2 = row[2] if len(row) > 2 else None
            c3 = row[3] if len(row) > 3 else None
            if isinstance(c2, str) and c2.strip().lower() in ("total", "supervisor", "leader"):
                continue
            dur = _to_min(row[dur_c]) if len(row) > dur_c else 0.0
            if dur <= 0:
                continue
            workers = _num(row[wk_c]) if len(row) > wk_c else 0.0
            if _mr_is_downtime(c2, c3):
                down_t += dur
            else:
                prod_t += dur
                mm_prod += workers * dur
                meals += _num(row[meal_c]) if len(row) > meal_c else 0.0
            mm_total += workers * dur

        window = prod_t + down_t
        scheduled = (activated or 0) + absent
        utilization.append({
            "date": date,
            "productive_time_min": round(prod_t, 1),
            "window_min": round(window, 1),
            "man_min_productive": round(mm_prod, 1),
            "man_min_available": round(mm_total, 1),
            "utilization": round(mm_prod / mm_total, 4) if mm_total > 0 else None,
            "availability": round(prod_t / window, 4) if window > 0 else None,
            "meals_packed": int(meals),
        })
        headcount.append({
            "date": date,
            "scheduled": scheduled,
            "absent": absent,
            "activated": activated or 0,
            "activation": round(activated / scheduled, 4) if scheduled else None,
        })
    wb.close()
    return {"utilization": utilization, "headcount": headcount}


# ── Pages ──────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return redirect(url_for("trial_stages"))


@app.route("/trial-stage-breakdown")
def trial_stages():
    return render_template("trial_stages.html")


@app.route("/cooking-analysis")
def cooking_analysis():
    return render_template("cooking_analysis.html")


@app.route("/data")
def data_page():
    return render_template("data.html")


# ── Data API ───────────────────────────────────────────────────────────────────

@app.route("/api/trial-run-data")
def trial_run_data():
    with open(DATA_DIR / "trial_run_data.json", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/lr-production-data")
def lr_production_data():
    path = _active_lr_path()
    if not path.exists():
        return jsonify({"error": "Production report not found"}), 404
    try:
        return jsonify(_parse_lr_production(str(path)))
    except Exception as e:
        app.logger.error("Excel parse error: %s", e)
        return jsonify({"error": str(e)}), 500


# ── Data upload (LR cooking + Assembly workbooks) ─────────────────────────────

def _read_meta(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


@app.route("/api/data-status")
def data_status():
    return jsonify({
        "cooking": {
            "source": "uploaded" if ACTIVE_LR_FILE.exists() else "default",
            "default_filename": DEFAULT_LR_FILE.name,
            "meta": _read_meta(ACTIVE_LR_META) if ACTIVE_LR_FILE.exists() else {},
        },
        "assembly": {
            "source": "uploaded" if ACTIVE_ASSEMBLY_FILE.exists() else "default",
            "default_filename": "oee_ole_trial_report.json (curated)",
            "meta": _read_meta(ACTIVE_ASSEMBLY_META) if ACTIVE_ASSEMBLY_FILE.exists() else {},
        },
        "packing": {
            "source": "uploaded" if ACTIVE_MR_FILE.exists() else "default",
            "default_filename": "oee_ole_trial_report.json (curated)",
            "meta": _read_meta(ACTIVE_MR_META) if ACTIVE_MR_FILE.exists() else {},
        },
    })


@app.route("/api/upload/cooking", methods=["POST"])
def upload_cooking():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file was provided."}), 400
    name = secure_filename(file.filename)
    if not name.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"error": "Please upload an Excel .xlsx file."}), 400

    tmp = UPLOAD_DIR / "lr_cooking_upload.tmp.xlsx"
    file.save(str(tmp))

    def _discard():
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    # Validate by parsing: only a workbook that parses into real production rows
    # is promoted to the active source, so a bad upload never breaks the page.
    try:
        parsed = _parse_lr_production(str(tmp))
    except Exception as e:
        _discard()
        return jsonify({"error": f"Could not read this workbook: {e}"}), 400

    dates = parsed.get("dates", [])
    tasks = parsed.get("tasks", [])
    if not dates or not tasks:
        _discard()
        return jsonify({"error": "Parsed the file but found no date sheets or "
                                 "production rows. Check it matches the LR cooking layout."}), 400

    tmp.replace(ACTIVE_LR_FILE)
    meta = {
        "filename": name,
        "uploaded_at": dt.datetime.now().isoformat(timespec="seconds"),
        "dates": len(dates),
        "menus": len({t["menu"] for t in tasks}),
        "rows": len(tasks),
    }
    ACTIVE_LR_META.write_text(json.dumps(meta), encoding="utf-8")
    return jsonify({"ok": True, "summary": meta})


@app.route("/api/reset/cooking", methods=["POST"])
def reset_cooking():
    ACTIVE_LR_FILE.unlink(missing_ok=True)
    ACTIVE_LR_META.unlink(missing_ok=True)
    return jsonify({"ok": True})


@app.route("/api/upload/assembly", methods=["POST"])
def upload_assembly():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file was provided."}), 400
    name = secure_filename(file.filename)
    if not name.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"error": "Please upload an Excel .xlsx file."}), 400

    tmp = UPLOAD_DIR / "assembly_upload.tmp.xlsx"
    file.save(str(tmp))

    def _discard():
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    try:
        parsed = _parse_assembly(str(tmp))
    except Exception as e:
        _discard()
        return jsonify({"error": f"Could not read this workbook: {e}"}), 400

    rows = parsed.get("rows", [])
    if not rows:
        _discard()
        return jsonify({"error": "Parsed the file but found no assembly rows. "
                                 "Check it matches the Assembly workbook layout."}), 400

    tmp.replace(ACTIVE_ASSEMBLY_FILE)
    meta = {
        "filename": name,
        "uploaded_at": dt.datetime.now().isoformat(timespec="seconds"),
        "dates": len({r["date"] for r in rows}),
        "menus": len({r["menu"] for r in rows}),
        "rows": len(rows),
    }
    ACTIVE_ASSEMBLY_META.write_text(json.dumps(meta), encoding="utf-8")
    return jsonify({"ok": True, "summary": meta})


@app.route("/api/reset/assembly", methods=["POST"])
def reset_assembly():
    ACTIVE_ASSEMBLY_FILE.unlink(missing_ok=True)
    ACTIVE_ASSEMBLY_META.unlink(missing_ok=True)
    return jsonify({"ok": True})


@app.route("/api/upload/packing", methods=["POST"])
def upload_packing():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file was provided."}), 400
    name = secure_filename(file.filename)
    if not name.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"error": "Please upload an Excel .xlsx file."}), 400

    tmp = UPLOAD_DIR / "mr_packing_upload.tmp.xlsx"
    file.save(str(tmp))

    def _discard():
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    try:
        parsed = _parse_mr(str(tmp))
    except Exception as e:
        _discard()
        return jsonify({"error": f"Could not read this workbook: {e}"}), 400

    util = parsed.get("utilization", [])
    if not util:
        _discard()
        return jsonify({"error": "Parsed the file but found no packing days. "
                                 "Check it matches the MR packing layout."}), 400

    tmp.replace(ACTIVE_MR_FILE)
    meta = {
        "filename": name,
        "uploaded_at": dt.datetime.now().isoformat(timespec="seconds"),
        "dates": len(util),
        "menus": sum(1 for u in util if u.get("meals_packed")),
        "rows": len(util),
    }
    ACTIVE_MR_META.write_text(json.dumps(meta), encoding="utf-8")
    return jsonify({"ok": True, "summary": meta})


@app.route("/api/reset/packing", methods=["POST"])
def reset_packing():
    ACTIVE_MR_FILE.unlink(missing_ok=True)
    ACTIVE_MR_META.unlink(missing_ok=True)
    return jsonify({"ok": True})


@app.route("/api/oee-report")
def oee_report():
    """Curated OEE report, with the assembly and/or packing sections replaced by
    uploaded workbooks when present (quality / flow stay curated)."""
    with open(DATA_DIR / "oee_ole_trial_report.json", encoding="utf-8") as f:
        report = json.load(f)
    if ACTIVE_ASSEMBLY_FILE.exists():
        try:
            parsed = _parse_assembly(str(ACTIVE_ASSEMBLY_FILE))
            report.setdefault("assembly", {})
            report["assembly"]["rows"] = parsed["rows"]
            report["assembly"]["daily_totals"] = parsed["daily_totals"]
        except Exception as e:
            app.logger.error("Assembly parse error: %s", e)
    if ACTIVE_MR_FILE.exists():
        try:
            parsed = _parse_mr(str(ACTIVE_MR_FILE))
            report.setdefault("packing", {})
            report["packing"]["utilization"] = parsed["utilization"]
            report["packing"]["headcount"] = parsed["headcount"]
            report["packing"]["source"] = "uploaded"
        except Exception as e:
            app.logger.error("MR parse error: %s", e)
    return jsonify(report)


@app.errorhandler(413)
def upload_too_large(_e):
    return jsonify({"error": "File too large (max 50 MB)."}), 413


# ── AI Help ────────────────────────────────────────────────────────────────────

@app.route("/api/ai-help", methods=["POST"])
def ai_help():
    import groq as groq_sdk

    body = request.get_json(force=True)
    user_message = (body.get("message") or "").strip()
    history = body.get("history") or []
    page_kpi = body.get("page_kpi") or {}

    if not user_message:
        return jsonify({"error": "No message provided"}), 400

    system_prompt = """You are a data assistant embedded in the SATS Stage 2 trial run OEE/OLE dashboard.
You help supervisors understand the March 2026 trial run production data, metrics, and KPIs.

CRITICAL RULES:
1. Only state facts present in the DATA section below. Never guess or make up numbers.
2. Keep answers under 120 words unless the user asks for detail.
3. Write in plain prose. No markdown, no asterisks, no bullet symbols (*, **, +, -, #).
4. Reply in the same language the user writes in.

Key domain terms:
- OEE = Availability x Performance x Quality (equipment effectiveness, world-class >85%)
- OLE = labour equivalent of OEE (workforce effectiveness)
- Trial run = 25-28 March 2026 Stage 2 production trial at SATS
- Assembly is the best-measured stage; Food Prep/Cooking/Packing use proxy or derived values
- Facility OEE = simple average of 4 stages; Facility OLE = headcount-weighted blend"""

    context = "\n\n--- TRIAL RUN CONTEXT ---"
    context += "\nDataset: SATS Stage 2 trial run, 25-28 March 2026"
    context += "\nStages covered: Food Prep (proxy), Cooking (proxy), Assembly (measured), Packing (derived)"

    if page_kpi:
        fac_oee = page_kpi.get("facility_oee_pct")
        fac_ole = page_kpi.get("facility_ole_pct")
        st_oee  = page_kpi.get("stage_oee_pct") or {}
        st_ole  = page_kpi.get("stage_ole_pct") or {}
        date_filter = page_kpi.get("date_filter", "All Dates")
        method  = page_kpi.get("method", "")
        context += (
            f"\n\n--- DISPLAYED KPI VALUES (filter: {date_filter}) ---"
            f"\nFacility OEE: {fac_oee}%  |  Facility OLE: {fac_ole}%"
            f"\nStage OEE — Food Prep: {st_oee.get('food_prep')}% | Cooking: {st_oee.get('cooking')}%"
            f" | Assembly: {st_oee.get('assembly')}% | Packing: {st_oee.get('packing')}%"
            f"\nStage OLE — Food Prep: {st_ole.get('food_prep')}% | Cooking: {st_ole.get('cooking')}%"
            f" | Assembly: {st_ole.get('assembly')}% | Packing: {st_ole.get('packing')}%"
            f"\nMethod: {method}"
            f"\nUSE THESE VALUES when answering OEE/OLE questions."
        )

    full_system = system_prompt + context

    try:
        client = groq_sdk.Groq()
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=512,
            temperature=0.3,
            messages=[
                {"role": "system", "content": full_system},
                *[{"role": m["role"], "content": m["content"]} for m in history[:-1]],
                {"role": "user", "content": user_message},
            ],
        )
        return jsonify({"answer": response.choices[0].message.content.strip()})
    except groq_sdk.RateLimitError:
        return jsonify({"error": "Groq daily token limit reached (100k/day). Resets at 8am Singapore time."}), 429
    except groq_sdk.AuthenticationError:
        return jsonify({"error": "AI authentication failed. Check GROQ_API_KEY in .env file."}), 503
    except Exception as e:
        app.logger.error("Groq error: %s", e)
        return jsonify({"error": f"Unexpected error: {e}"}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5001)
