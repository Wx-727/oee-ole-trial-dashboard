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
    function runEstimate() {
        const menu = menuSelect.value;
        const meals = parseInt(mealsInput.value, 10);
        if (!menu) { result.innerHTML = `<p class="card__helper">Pick a menu first.</p>`; return; }
        if (!meals || meals < 1) { result.innerHTML = `<p class="card__helper">Enter a valid meal count.</p>`; return; }

        result.innerHTML = "";
        loadState.hidden = false;
        const url = `/api/menu-plan?menu=${encodeURIComponent(menu)}&meals=${meals}`;
        fetch(url)
            .then((r) => r.json())
            .then((d) => {
                loadState.hidden = true;
                if (d.error) { result.innerHTML = `<p class="card__helper" style="color:var(--red)">${esc(d.error)}</p>`; return; }
                if (!d.matched) {
                    result.innerHTML = `<article class="card section-gap"><p class="card__helper">No recipe is linked to “${esc(menu)}” yet, so it can't be estimated.</p></article>`;
                    return;
                }
                renderResult(d);
            })
            .catch((err) => { loadState.hidden = true; result.innerHTML = `<p class="card__helper" style="color:var(--red)">Failed: ${esc(err)}</p>`; });
    }
    runBtn.addEventListener("click", runEstimate);
    mealsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runEstimate(); });
    menuSelect.addEventListener("change", () => { if (menuSelect.value) runEstimate(); });

    // ── Render ───────────────────────────────────────────────────────────────
    function renderResult(d) {
        const s = d.summary;
        const cov = Math.round((s.coverage || 0) * 100);
        const covClass = cov >= 80 ? "ok" : (cov >= 50 ? "mid" : "low");

        const kpis = [
            ["Total food", `${fmt(d.food_kg, 1)} kg`, "from recipe"],
            ["Machine time", fmtHours(s.total_machine_hours), "across all units"],
            ["Labour", fmtHours(s.labour_hours), "estimated man-hours"],
            ["Est. duration", `${fmtHours(s.wall_clock_best_hours)} – ${fmtHours(s.wall_clock_worst_hours)}`, "best–worst case"],
            ["Bottleneck", esc(s.bottleneck || "—"), "busiest equipment"],
        ];

        const matchNote = d.match.source === "auto"
            ? `Auto-linked to recipe “${esc(d.match.name)}” (confidence ${Math.round((d.match.score || 0) * 100)}%).`
            : `Linked to recipe “${esc(d.match.name)}”.`;

        const ingRows = d.ingredients.map((r) => `
            <tr>
                <td>${esc(r.name)}</td>
                <td><span class="cat-badge ${CAT_CLASS[r.category] || "cat--other"}">${esc(r.category)}</span></td>
                <td class="col-center">${fmt(r.kg, 1)} kg</td>
            </tr>`).join("");

        const catChips = d.category_totals.map((c) =>
            `<span class="cat-chip ${CAT_CLASS[c.category] || "cat--other"}">${esc(c.category)} <strong>${fmt(c.kg, 1)} kg</strong></span>`).join("");

        const machineRows = d.machines.map((m) => `
            <tr>
                <td>${esc(m.machine_type)} ${m.measured ? "" : '<span class="est-badge" title="No measured rate for this machine — used the overall average">approx</span>'}</td>
                <td class="col-center">${m.units}</td>
                <td class="col-center">${m.batches != null ? m.batches : "—"}</td>
                <td class="col-center">${fmtHours(m.hours)}</td>
                <td class="col-center">${fmtHours(m.busy_minutes / 60)}</td>
            </tr>`).join("");

        const unmapped = d.processes.filter((p) => !p.machine);
        const unmappedNote = unmapped.length
            ? `<p class="card__helper" style="margin-top:8px">${unmapped.length} recipe step(s) couldn't be tied to a machine operation and are excluded from the time estimate: ${unmapped.map((p) => esc(p.name)).join(", ")}.</p>`
            : "";

        result.innerHTML = `
        <section class="card-grid card-grid--kpi section-gap">
            ${kpis.map((k) => `
                <div class="kpi-card">
                    <span class="kpi-card__label">${k[0]}</span>
                    <strong class="kpi-card__value">${k[1]}</strong>
                    <span class="kpi-card__sub">${k[2]}</span>
                </div>`).join("")}
        </section>

        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Recipe link</p>
                <h3>${esc(d.menu)} · ${fmt(d.meals)} meals</h3>
                <p class="card__helper">${matchNote} Estimate covers <span class="coverage-pill coverage-pill--${covClass}">${cov}% of recipe steps with measured rates</span>.</p>
            </div></div>
        </article>

        <article class="card section-gap">
            <div class="card__header"><div>
                <p class="eyebrow">Equipment</p>
                <h3>Machines &amp; time <span class="est-badge">estimated</span></h3>
                <p class="card__helper">Run-time = recipe quantity × measured machine-min/kg from the production report. “Busy time” divides total run-time across the available units of that type.</p>
            </div></div>
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead><tr>
                        <th>Equipment type</th><th class="col-center">Units</th>
                        <th class="col-center">Batches</th><th class="col-center">Total run-time</th>
                        <th class="col-center">Busy time</th>
                    </tr></thead>
                    <tbody>${machineRows || `<tr><td colspan="5">No machine operations estimated.</td></tr>`}</tbody>
                </table>
            </div>
            ${unmappedNote}
        </article>

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
        </article>`;
    }
})();
