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


def _parse_lr_excel(path: str) -> dict:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    result = {}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(min_row=4, values_only=True))

        current_section = None
        current_menu = None
        meals: dict = {}

        for row in rows:
            if not any(v is not None for v in row):
                continue

            # Carry-forward section and menu (merged cells appear as None)
            if row[2] is not None:
                current_section = str(row[2]).strip()
            if row[3] is not None and str(row[3]).strip() not in ("", "None"):
                current_menu = str(row[3]).strip()

            component = row[4]
            if not component:
                continue

            comp = str(component).strip()
            if not comp or comp == "None":
                continue
            if any(kw in comp.lower() for kw in _SKIP_KEYWORDS):
                continue

            time_use_min = _to_min(row[8])
            output_kg = _num(row[10])
            workers = int(_num(row[9]))
            base_step = _strip_batch(comp)
            menu = current_menu or "Unknown"

            meals.setdefault(menu, {})
            meals[menu].setdefault(base_step, {
                "section": current_section or "",
                "batches": 0,
                "total_minutes": 0.0,
                "total_kg": 0.0,
                "workers": 0,
                "machines": {m: 0.0 for _, m in MACHINE_COLS},
            })

            step = meals[menu][base_step]
            step["batches"] += 1
            step["total_minutes"] += time_use_min
            step["total_kg"] += output_kg
            step["workers"] = max(step["workers"], workers)

            row_len = len(row)
            for col_idx, machine_name in MACHINE_COLS:
                if col_idx < row_len:
                    step["machines"][machine_name] += _num(row[col_idx])

        # Serialise to list, drop machines with zero usage
        meals_out = {}
        for meal, steps in meals.items():
            steps_list = []
            for step_name, d in steps.items():
                active_machines = [
                    {"name": k, "minutes": round(v, 1)}
                    for k, v in d["machines"].items()
                    if v > 0
                ]
                steps_list.append({
                    "name": step_name,
                    "section": d["section"],
                    "batches": d["batches"],
                    "total_minutes": round(d["total_minutes"], 1),
                    "total_kg": round(d["total_kg"], 2),
                    "workers": d["workers"],
                    "machines": active_machines,
                })

            meals_out[meal] = {
                "steps": steps_list,
                "step_count": len(steps_list),
                "total_kg": round(sum(s["total_kg"] for s in steps_list), 2),
                "total_minutes": round(sum(s["total_minutes"] for s in steps_list), 1),
            }

        result[sheet_name] = meals_out

    return result


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


@app.route("/api/lr-machine-data")
def lr_machine_data():
    path = DATA_DIR / "LR_stage2_march.xlsx"
    if not path.exists():
        return jsonify({"error": "Excel file not found"}), 404
    try:
        return jsonify(_parse_lr_excel(str(path)))
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
