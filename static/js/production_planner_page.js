(function () {
    const menuSelect = document.getElementById("plannerMenu");
    const mealsInput = document.getElementById("plannerMeals");
    const runBtn     = document.getElementById("plannerRun");
    const hint       = document.getElementById("plannerHint");
    const unmatched  = document.getElementById("plannerUnmatched");
    const result     = document.getElementById("plannerResult");
    const loadState  = document.getElementById("plannerLoad");

    function esc(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function fmt(n, d) {
        return Number(n || 0).toLocaleString("en", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
    }
    function fmtHours(h) {
        const hrs = Math.floor(h);
        const m = Math.round((h - hrs) * 60);
        if (hrs === 0) return `${m} min`;
        return m === 0 ? `${hrs} h` : `${hrs} h ${m} min`;
    }

    const CAT_CLASS = {
        "Protein": "cat--protein", "Vegetable": "cat--veg", "Starch": "cat--starch",
        "Dairy": "cat--dairy", "Sauce/Seasoning": "cat--sauce", "Other": "cat--other",
    };

    // ── Load menu options ────────────────────────────────────────────────────
    fetch("/api/menu-plan-options")
        .then((r) => r.json())
        .then((data) => {
            if (data.error) { hint.textContent = "Could not load menus: " + data.error; return; }
            const matched = data.options.filter((o) => o.matched);
            menuSelect.innerHTML =
                `<option value="">Select a menu…</option>` +
                matched.map((o) => `<option value="${esc(o.menu)}">${esc(o.menu)}</option>`).join("");
            hint.textContent = `${matched.length} of ${data.options.length} production-report menus are linked to a recipe. ` +
                `Recipes scaled from a ${fmt(1500)}-meal basis.`;
            if (data.unmatched && data.unmatched.length) {
                unmatched.hidden = false;
                unmatched.innerHTML = `<strong>${data.unmatched.length} menus not yet linked to a recipe</strong> ` +
                    `(name too different to auto-match — these can be mapped manually later): ` +
                    data.unmatched.map((m) => esc(m)).join("; ") + ".";
            }
        })
        .catch((err) => { hint.textContent = "Failed to load menus: " + err; });

    // ── Run estimate ─────────────────────────────────────────────────────────
    let requestToken = 0;   // guards against out-of-order responses
    function runEstimate() {
        const menu = menuSelect.value;
        const meals = parseInt(mealsInput.value, 10);
        if (!menu) { result.innerHTML = `<p class="card__helper">Pick a menu first.</p>`; return; }
        if (!meals || meals < 1) { result.innerHTML = `<p class="card__helper">Enter a valid meal count.</p>`; return; }

        const token = ++requestToken;
        result.innerHTML = "";
        loadState.hidden = false;
        const url = `/api/menu-plan?menu=${encodeURIComponent(menu)}&meals=${meals}`;
        fetch(url)
            .then((r) => r.json())
            .then((d) => {
                if (token !== requestToken) return;   // a newer request superseded this one
                loadState.hidden = true;
                if (d.error) { result.innerHTML = `<p class="card__helper" style="color:var(--red)">${esc(d.error)}</p>`; return; }
                if (!d.matched) {
                    result.innerHTML = `<article class="card section-gap"><p class="card__helper">Neither a recipe nor assembly meal data is linked to “${esc(menu)}”, so it can't be estimated yet.</p></article>`;
                    return;
                }
                renderResult(d);
            })
            .catch((err) => {
                if (token !== requestToken) return;
                loadState.hidden = true;
                result.innerHTML = `<p class="card__helper" style="color:var(--red)">Failed: ${esc(err)}</p>`;
            });
    }
    runBtn.addEventListener("click", runEstimate);
    mealsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runEstimate(); });
    menuSelect.addEventListener("change", () => { if (menuSelect.value) runEstimate(); });

    function stageTag(stage) {
        const prep = stage === "prep" || stage === "food_prep";
        return `<span class="stage-badge stage-badge--${prep ? "prep" : "cook"}">${prep ? "Prep" : "Cook"}</span>`;
    }

    // ── Render ───────────────────────────────────────────────────────────────
    function renderResult(d) {
        const s = d.summary || {};
        const machineOK = d.machine_available;
        const bomOK = d.bom_matched;

        // KPI cards — only those we can actually compute.
        const kpis = [];
        if (bomOK) kpis.push(["Total food", `${fmt(d.food_kg, 1)} kg`, "from recipe"]);
        if (machineOK) {
            kpis.push(["Machine time", fmtHours(s.total_machine_hours), "across all units"]);
            kpis.push(["Labour", fmtHours(s.labour_hours), "estimated man-hours"]);
            kpis.push(["Est. duration", `${fmtHours(s.wall_clock_best_hours)} – ${fmtHours(s.wall_clock_worst_hours)}`, "best–worst case"]);
            kpis.push(["Bottleneck", esc(s.bottleneck || "—"), "busiest equipment"]);
        }

        const basisBits = [];
        if (bomOK) {
            basisBits.push(d.match.source === "auto"
                ? `Ingredients from recipe “${esc(d.match.name)}” (auto-match ${Math.round((d.match.score || 0) * 100)}%).`
                : `Ingredients from recipe “${esc(d.match.name)}”.`);
        } else {
            basisBits.push("No recipe linked, so ingredient weights are unavailable for this menu.");
        }
        if (machineOK) {
            basisBits.push(`Machine time, per-step usage and labour come from the LR cooking file, scaled from <strong>${fmt(d.actual_meals)}</strong> meals actually assembled (HR report).`);
        } else {
            basisBits.push("No assembly meal count for this menu, so the machine, time and labour estimate is unavailable.");
        }

        const machineRows = (d.machines || []).map((m) => `
            <tr>
                <td>${esc(m.machine_type)} ${stageTag(m.stage)}</td>
                <td class="col-center">${m.units}</td>
                <td class="col-center">${m.batches != null ? m.batches : "—"}</td>
                <td class="col-center">${fmtHours(m.hours)}</td>
                <td class="col-center">${fmtHours(m.busy_minutes / 60)}</td>
            </tr>`).join("");

        const stepRows = (d.steps || []).map((st) => {
            const mm = st.machines
                .map((x) => `<span class="machine-pill">${esc(x.machine)} <strong>${fmtHours(x.minutes / 60)}</strong></span>`)
                .join(" ");
            return `<tr><td>${esc(st.step)} ${stageTag(st.stage)}</td>` +
                `<td class="col-center">${fmtHours(st.minutes / 60)}</td><td>${mm || "—"}</td></tr>`;
        }).join("");

        const ingRows = d.ingredients.map((r) => `
            <tr>
                <td>${esc(r.name)}</td>
                <td><span class="cat-badge ${CAT_CLASS[r.category] || "cat--other"}">${esc(r.category)}</span></td>
                <td class="col-center">${fmt(r.kg, 1)} kg</td>
            </tr>`).join("");
        const catChips = d.category_totals.map((c) =>
            `<span class="cat-chip ${CAT_CLASS[c.category] || "cat--other"}">${esc(c.category)} <strong>${fmt(c.kg, 1)} kg</strong></span>`).join("");

        const kpiSection = kpis.length ? `
        <section class="card-grid card-grid--kpi section-gap">
            ${kpis.map((k) => `
                <div class="kpi-card">
                    <span class="kpi-card__label">${k[0]}</span>
                    <strong class="kpi-card__value">${k[1]}</strong>
                    <span class="kpi-card__sub">${k[2]}</span>
                </div>`).join("")}
        </section>` : "";

        const machineCard = machineOK ? `
        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Equipment</p>
                <h3>Machines &amp; time <span class="est-badge">estimated</span></h3>
                <p class="card__helper">Every machine that touched this dish in the LR cooking file (prep and cook), scaled to your target. “Busy time” divides total run-time across the available units of that type.</p>
            </div></div>
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead><tr>
                        <th>Equipment</th><th class="col-center">Units</th>
                        <th class="col-center">Batches</th><th class="col-center">Total run-time</th>
                        <th class="col-center">Busy time</th>
                    </tr></thead>
                    <tbody>${machineRows || `<tr><td colspan="5">No machine usage recorded.</td></tr>`}</tbody>
                </table>
            </div>
        </article>

        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Step breakdown</p>
                <h3>Which step uses which machine</h3>
                <p class="card__helper">Each cooking/prep step for this dish and the machine(s) it ran on, scaled to your target meal count.</p>
            </div></div>
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead><tr><th>Step</th><th class="col-center">Time</th><th>Machines</th></tr></thead>
                    <tbody>${stepRows || `<tr><td colspan="3">No steps recorded.</td></tr>`}</tbody>
                </table>
            </div>
        </article>` : "";

        const ingCard = bomOK ? `
        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Ingredients</p>
                <h3>Type &amp; weight <span class="est-badge est-badge--exact">from recipe</span></h3>
                <p class="card__helper">Scaled linearly from the recipe's 1,500-meal basis. Packaging excluded.</p>
            </div></div>
            <div class="cat-chip-row">${catChips}</div>
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead><tr><th>Ingredient</th><th>Type</th><th class="col-center">Weight</th></tr></thead>
                    <tbody>${ingRows}</tbody>
                </table>
            </div>
        </article>` : "";

        result.innerHTML = `
        ${kpiSection}
        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Basis</p>
                <h3>${esc(d.menu)} · ${fmt(d.meals)} meals</h3>
                <p class="card__helper">${basisBits.join(" ")}</p>
            </div></div>
        </article>
        ${machineCard}
        ${machineOK ? simCardHtml(d) : ""}
        ${ingCard}`;
        if (machineOK) wireSimulation(d);
    }

    // ── Simulation (what-if: equipment units, downtime, crew) ─────────────────
    function simCardHtml(d) {
        const staff = d.peak_workers || 10;
        const rows = d.machines.map((m) => `
            <tr data-type="${esc(m.machine_type)}">
                <td>${esc(m.machine_type)} ${stageTag(m.stage)}</td>
                <td class="col-center"><input type="number" class="sim-units" min="0" max="20" value="${m.units}" /></td>
                <td class="col-center"><input type="number" class="sim-avail" min="0" max="100" step="5" value="100" /><span class="sim-pct">%</span></td>
            </tr>`).join("");
        return `
        <article class="card section-gap" id="simCard">
            <div class="card__header"><div>
                <p class="eyebrow">What-if</p>
                <h3>Simulation</h3>
                <p class="card__helper">Adjust equipment units, uptime (for downtime) and crew size to see the effect on completion time, throughput and utilisation. Recalculates instantly.</p>
            </div></div>
            <div class="sim-grid">
                <div class="sim-equip">
                    <label class="sim-staff">Crew size
                        <input type="number" id="simStaff" min="1" max="999" value="${staff}" />
                    </label>
                    <table class="meal-step-table">
                        <thead><tr><th>Equipment</th><th class="col-center">Units</th><th class="col-center">Uptime</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <div class="sim-results" id="simResults"></div>
            </div>
        </article>`;
    }

    function simCompute(types, labourMin, staff, meals) {
        let machineBest = 0, bottleneck = null, blocked = false;
        const perType = types.map((t) => {
            const eff = t.units * (t.avail / 100);
            let busy;
            if (t.runMin <= 0) busy = 0;
            else if (eff <= 0) { busy = Infinity; blocked = true; bottleneck = t.type; }
            else busy = t.runMin / eff;
            if (isFinite(busy) && busy > machineBest) { machineBest = busy; bottleneck = t.type; }
            return { type: t.type, stage: t.stage, eff, busy };
        });
        const lab = staff > 0 ? labourMin / staff : Infinity;
        let completion, constraint;
        if (blocked) { completion = Infinity; constraint = `${bottleneck} (0 units)`; }
        else if (lab > machineBest) { completion = lab; constraint = "Labour"; }
        else { completion = machineBest; constraint = bottleneck; }
        const throughput = (isFinite(completion) && completion > 0) ? meals / (completion / 60) : 0;
        perType.forEach((p) => {
            p.util = (isFinite(completion) && completion > 0 && isFinite(p.busy)) ? (p.busy / completion * 100) : 0;
        });
        return { completion, constraint, throughput, labMin: lab, perType, blocked };
    }

    function renderSimResults(el, r, baseline, staff) {
        const compTxt = r.blocked ? "Not possible" : fmtHours(r.completion / 60);
        let deltaTxt = "";
        if (!r.blocked && isFinite(baseline.completion)) {
            const delta = r.completion - baseline.completion;
            if (Math.abs(delta) < 0.5) deltaTxt = "≈ baseline";
            else deltaTxt = `${delta > 0 ? "+" : "−"}${fmtHours(Math.abs(delta) / 60)} vs baseline`;
        }
        const headline = [
            ["Completion", compTxt, `constraint: ${esc(r.constraint || "—")}`],
            ["Throughput", r.blocked ? "—" : `${fmt(r.throughput)} meals/hr`, deltaTxt],
            ["Crew", `${staff} staff`, `labour ${isFinite(r.labMin) ? fmtHours(r.labMin / 60) : "—"}`],
        ];
        const util = r.perType.slice().sort((a, b) => (b.busy === Infinity ? 1 : b.busy) - (a.busy === Infinity ? 1 : a.busy))
            .map((p) => `
            <tr>
                <td>${esc(p.type)}</td>
                <td class="col-center">${p.eff % 1 ? p.eff.toFixed(1) : p.eff}</td>
                <td class="col-center">${isFinite(p.busy) ? fmtHours(p.busy / 60) : "—"}</td>
                <td class="col-center">${isFinite(p.busy) ? Math.round(p.util) + "%" : "—"}</td>
            </tr>`).join("");
        el.innerHTML = `
            <div class="sim-headline">
                ${headline.map((h) => `<div class="sim-kpi"><span>${h[0]}</span><strong>${h[1]}</strong><small>${h[2]}</small></div>`).join("")}
            </div>
            <table class="meal-step-table">
                <thead><tr><th>Equipment</th><th class="col-center">Eff. units</th><th class="col-center">Busy</th><th class="col-center">Utilisation</th></tr></thead>
                <tbody>${util}</tbody>
            </table>`;
    }

    function wireSimulation(d) {
        const card = document.getElementById("simCard");
        const staffInput = document.getElementById("simStaff");
        const resultsEl = document.getElementById("simResults");
        const base = d.machines.map((m) => ({ type: m.machine_type, runMin: m.minutes, baseUnits: m.units, stage: m.stage }));
        const labourMin = (d.summary.labour_hours || 0) * 60;
        const meals = d.meals;
        const baseStaff = d.peak_workers || 10;
        const baseline = simCompute(
            base.map((b) => ({ type: b.type, runMin: b.runMin, stage: b.stage, units: b.baseUnits, avail: 100 })),
            labourMin, baseStaff, meals);

        function readState() {
            return [...card.querySelectorAll("tbody tr[data-type]")].map((tr) => {
                const b = base.find((x) => x.type === tr.dataset.type);
                const units = parseFloat(tr.querySelector(".sim-units").value) || 0;
                const avail = parseFloat(tr.querySelector(".sim-avail").value);
                return { type: b.type, runMin: b.runMin, stage: b.stage, units, avail: isNaN(avail) ? 100 : avail };
            });
        }
        function recompute() {
            const staff = parseInt(staffInput.value, 10) || 0;
            renderSimResults(resultsEl, simCompute(readState(), labourMin, staff, meals), baseline, staff);
        }
        card.querySelectorAll(".sim-units, .sim-avail").forEach((i) => i.addEventListener("input", recompute));
        staffInput.addEventListener("input", recompute);
        recompute();
    }
})();
