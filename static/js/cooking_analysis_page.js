(function () {
    const sheetSelector  = document.getElementById("sheetSelector");
    const accordion      = document.getElementById("mealAccordion");
    const summaryCard    = document.getElementById("machineSummaryCard");
    const summaryGrid    = document.getElementById("machineSummaryGrid");
    const loadState      = document.getElementById("cookingLoadState");

    let allData = {};

    // ── Helpers ────────────────────────────────────────────────────────────────

    function esc(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function fmtMin(min) {
        if (!min && min !== 0) return "—";
        const h = Math.floor(min / 60);
        const m = Math.round(min % 60);
        if (h === 0) return `${m}m`;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }

    function fmtKg(kg) {
        return kg > 0 ? `${kg.toLocaleString("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg` : "—";
    }

    // ── Machine summary across all meals ───────────────────────────────────────

    function renderMachineSummary(meals) {
        const totals = {};
        Object.values(meals).forEach(function (meal) {
            meal.steps.forEach(function (step) {
                step.machines.forEach(function (m) {
                    totals[m.name] = (totals[m.name] || 0) + m.minutes;
                });
            });
        });

        const sorted = Object.entries(totals)
            .filter(function (e) { return e[1] > 0; })
            .sort(function (a, b) { return b[1] - a[1]; });

        if (sorted.length === 0) {
            summaryGrid.innerHTML = "<p class='card__helper'>No machine usage recorded for this shift.</p>";
            summaryCard.style.display = "";
            return;
        }

        const maxMin = sorted[0][1];

        summaryGrid.innerHTML = sorted.map(function (entry) {
            const name = entry[0];
            const mins = entry[1];
            const pct  = Math.round((mins / maxMin) * 100);
            return `
                <div class="machine-summary-row">
                    <span class="machine-summary-row__name">${esc(name)}</span>
                    <div class="machine-summary-row__bar-wrap">
                        <div class="machine-summary-row__bar" style="width:${pct}%"></div>
                    </div>
                    <span class="machine-summary-row__value">${fmtMin(mins)}</span>
                </div>`;
        }).join("");

        summaryCard.style.display = "";
    }

    // ── Step detail table ──────────────────────────────────────────────────────

    function renderStepTable(steps) {
        if (!steps || steps.length === 0) {
            return "<p class='card__helper' style='padding:12px 0'>No steps recorded.</p>";
        }

        const rows = steps.map(function (step) {
            const machineHtml = step.machines.length > 0
                ? step.machines.map(function (m) {
                    return `<span class="machine-pill">${esc(m.name)} <strong>${fmtMin(m.minutes)}</strong></span>`;
                  }).join(" ")
                : "<span class='card__helper'>—</span>";

            return `
                <tr>
                    <td>${esc(step.name)}</td>
                    <td class="col-center">${esc(step.section)}</td>
                    <td class="col-center">${step.batches}</td>
                    <td class="col-center">${fmtMin(step.total_minutes)}</td>
                    <td class="col-center">${fmtKg(step.total_kg)}</td>
                    <td class="col-machines">${machineHtml}</td>
                </tr>`;
        }).join("");

        return `
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead>
                        <tr>
                            <th>Step</th>
                            <th class="col-center">Section</th>
                            <th class="col-center">Batches</th>
                            <th class="col-center">Time</th>
                            <th class="col-center">Output</th>
                            <th>Machines Used</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    // ── Meal accordion ─────────────────────────────────────────────────────────

    function renderAccordion(meals) {
        accordion.innerHTML = "";

        const sorted = Object.entries(meals).sort(function (a, b) {
            return b[1].total_kg - a[1].total_kg;
        });

        sorted.forEach(function (entry) {
            const mealName = entry[0];
            const meal     = entry[1];

            const card = document.createElement("article");
            card.className = "card section-gap meal-accordion-card";

            card.innerHTML = `
                <div class="meal-accordion-header" role="button" tabindex="0">
                    <div class="meal-accordion-header__title">
                        <p class="eyebrow">${esc(meal.steps[0]?.section || "")}</p>
                        <h3>${esc(mealName)}</h3>
                    </div>
                    <div class="meal-accordion-header__meta">
                        <span class="meal-meta-pill">${meal.step_count} step${meal.step_count !== 1 ? "s" : ""}</span>
                        <span class="meal-meta-pill">${fmtKg(meal.total_kg)}</span>
                        <span class="meal-meta-pill">${fmtMin(meal.total_minutes)}</span>
                        <span class="meal-accordion-chevron">&#8964;</span>
                    </div>
                </div>
                <div class="meal-accordion-body" hidden>
                    ${renderStepTable(meal.steps)}
                </div>`;

            const header = card.querySelector(".meal-accordion-header");
            const body   = card.querySelector(".meal-accordion-body");
            const chev   = card.querySelector(".meal-accordion-chevron");

            function toggle() {
                const open = !body.hidden;
                body.hidden = open;
                chev.style.transform = open ? "" : "rotate(180deg)";
                card.classList.toggle("meal-accordion-card--open", !open);
            }

            header.addEventListener("click", toggle);
            header.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            });

            accordion.appendChild(card);
        });
    }

    // ── Sheet change ───────────────────────────────────────────────────────────

    function applySheet(sheetName) {
        const meals = allData[sheetName];
        if (!meals) return;
        renderMachineSummary(meals);
        renderAccordion(meals);
    }

    sheetSelector.addEventListener("change", function () {
        applySheet(this.value);
    });

    // ── Init ───────────────────────────────────────────────────────────────────

    fetch("/api/lr-machine-data")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            loadState.style.display = "none";

            if (data.error) {
                accordion.innerHTML = `<p class="card__helper" style="color:var(--red)">${esc(data.error)}</p>`;
                return;
            }

            allData = data;
            const sheets = Object.keys(data);

            sheetSelector.innerHTML = sheets.map(function (s) {
                return `<option value="${esc(s)}">${esc(s)}</option>`;
            }).join("");

            if (sheets.length > 0) applySheet(sheets[0]);
        })
        .catch(function (err) {
            loadState.style.display = "none";
            accordion.innerHTML = `<p class="card__helper" style="color:var(--red)">Failed to load data: ${esc(String(err))}</p>`;
        });
})();
