import datetime as dt
import json
import re
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, url_for

load_dotenv()

app = Flask(__name__)

DATA_DIR = Path(__file__).parent / "static" / "data"

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

_BATCH_RE = re.compile(
    r"(\s+B\.[\d][\d\/\-]*\.?\s*$"   # B.1, B.12, B.1-2, B.1/1
    r"|\s+\d+\s+B\.\s*$"             # 3 B., 4 B.
    r"|\s+\d+\s+batch\w*\s*$"        # 5 batch, 5 batches
    r"|\s+\d+\/\d+\s*$)",            # 1/1, 1/2 fraction style
    re.IGNORECASE,
)

_SKIP_KEYWORDS = ("cleaning line", "break", "เตรียม")


def _strip_batch(name: str) -> str:
    return _BATCH_RE.sub("", name).strip()


def _to_min(v) -> float:
    if isinstance(v, dt.time):
        return v.hour * 60 + v.minute + v.second / 60
    return 0.0


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

    # Pass 1 — count raw menu strings so we can cluster them into canonical names.
    raw_counts: dict = {}
    for sn in data_sheets:
        cur_menu = None
        for row in wb[sn].iter_rows(min_row=4, values_only=True):
            if not any(v is not None for v in row):
                continue
            if row[3] is not None and str(row[3]).strip() not in ("", "None"):
                cur_menu = str(row[3]).strip()
            comp = row[4]
            if not comp or str(comp).strip() in ("", "None"):
                continue
            raw_counts[cur_menu or ""] = raw_counts.get(cur_menu or "", 0) + 1
    canon = _build_menu_canon(raw_counts)

    # Pass 2 — aggregate by (date, canonical menu, batch-stripped step).
    agg: dict = {}
    date_labels: dict = {}
    for sn in data_sheets:
        iso = _sheet_date_iso(sn)
        date_labels[iso] = _date_label(iso)
        cur_menu = None
        for row in wb[sn].iter_rows(min_row=4, values_only=True):
            if not any(v is not None for v in row):
                continue
            if row[3] is not None and str(row[3]).strip() not in ("", "None"):
                cur_menu = str(row[3]).strip()
            comp = row[4]
            if not comp or str(comp).strip() in ("", "None"):
                continue
            menu = canon.get(cur_menu or "")
            if not menu:
                continue
            comp_s = str(comp).strip()
            if any(kw in comp_s.lower() for kw in _SKIP_KEYWORDS):
                continue

            step_disp = _strip_batch(comp_s) or comp_s
            key = (iso, menu, step_disp.lower())
            entry = agg.get(key)
            if entry is None:
                entry = {
                    "date": iso,
                    "menu": menu,
                    "step": step_disp,
                    "batches": 0,
                    "duration_min": 0.0,
                    "kg": 0.0,
                    "machines": {},
                }
                agg[key] = entry

            entry["batches"] += 1
            entry["duration_min"] += _to_min(row[8])
            entry["kg"] += _num(row[10])

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
        for mm in entry["machines"].values():
            mm["minutes"] = round(mm["minutes"], 1)
        tasks.append(entry)

    return {
        "dates": sorted(date_labels.keys()),
        "date_labels": date_labels,
        "tasks": tasks,
    }


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


# ── Data API ───────────────────────────────────────────────────────────────────

@app.route("/api/trial-run-data")
def trial_run_data():
    with open(DATA_DIR / "trial_run_data.json", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/lr-production-data")
def lr_production_data():
    path = DATA_DIR / "LR_production_march.xlsx"
    if not path.exists():
        return jsonify({"error": "Production report not found"}), 404
    try:
        return jsonify(_parse_lr_production(str(path)))
    except Exception as e:
        app.logger.error("Excel parse error: %s", e)
        return jsonify({"error": str(e)}), 500


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
