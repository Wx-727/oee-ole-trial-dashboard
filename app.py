import json
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

app = Flask(__name__)

DATA_DIR = Path(__file__).parent / "static" / "data"


# ── Pages ──────────────────────────────────────────────────────────────────────

@app.route("/")
def trial_run():
    return render_template("trial_run.html")


@app.route("/trial-stage-breakdown")
def trial_stages():
    return render_template("trial_stages.html")


# ── Data API ───────────────────────────────────────────────────────────────────

@app.route("/api/trial-run-data")
def trial_run_data():
    with open(DATA_DIR / "trial_run_data.json", encoding="utf-8") as f:
        return jsonify(json.load(f))


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
