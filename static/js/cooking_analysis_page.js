(function () {
    const dateSelector = document.getElementById("dateSelector");
    const accordion    = document.getElementById("mealAccordion");
    const summaryCard  = document.getElementById("machineSummaryCard");
    const summaryGrid  = document.getElementById("machineSummaryGrid");
    const scopeNote    = document.getElementById("cookingScopeNote");
    const loadState    = document.getElementById("cookingLoadState");

    const ALL_VALUE = "__ALL__";

    let allTasks   = [];   // per (date, menu, step) rows from the API
    let dateLabels = {};

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

    function fmtPerBatch(min) {
        if (!min && min !== 0) return "—";
        const rounded = Math.round(min * 10) / 10;
        return `${rounded.toLocaleString("en", { maximumFractionDigits: 1 })} min`;
    }

    function fmtKg(kg) {
        return kg > 0 ? `${kg.toLocaleString("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg` : "—";
    }

    // ── Aggregation ─────────────────────────────────────────────────────────────

    function tasksForScope(scope) {
        return scope === ALL_VALUE ? allTasks : allTasks.filter((t) => t.date === scope);
    }

    // Merge the per-(date, menu, step) rows into per-menu groups, collapsing the
    // same step across days and summing each machine's run time and batch count.
    function buildMenus(tasks) {
        const menus = {};
        tasks.forEach((t) => {
            const menuKey = t.menu;
            if (!menus[menuKey]) {
                menus[menuKey] = { menu: menuKey, stepMap: {}, stepOrder: [], totalKg: 0, totalMinutes: 0 };
            }
            const meal = menus[menuKey];

            const stepKey = String(t.step || "").toLowerCase();
            if (!meal.stepMap[stepKey]) {
                meal.stepMap[stepKey] = { name: t.step, batches: 0, totalMinutes: 0, totalKg: 0, machines: {} };
                meal.stepOrder.push(stepKey);
            }
            const step = meal.stepMap[stepKey];
            step.batches      += t.batches || 0;
            step.totalMinutes += t.duration_min || 0;
            step.totalKg      += t.kg || 0;
            Object.entries(t.machines || {}).forEach(([name, v]) => {
                if (!step.machines[name]) step.machines[name] = { minutes: 0, batches: 0 };
                step.machines[name].minutes += Number(v.minutes || 0);
                step.machines[name].batches += Number(v.batches || 0);
            });

            meal.totalKg      += t.kg || 0;
            meal.totalMinutes += t.duration_min || 0;
        });

        return Object.values(menus)
            .map((meal) => ({
                menu: meal.menu,
                totalKg: meal.totalKg,
                totalMinutes: meal.totalMinutes,
                steps: meal.stepOrder.map((sk) => {
                    const s = meal.stepMap[sk];
                    return {
                        name: s.name,
                        batches: s.batches,
                        totalMinutes: s.totalMinutes,
                        totalKg: s.totalKg,
                        machines: Object.entries(s.machines)
                            .map(([name, v]) => ({
                                name,
                                minutes: v.minutes,
                                perBatch: v.batches ? v.minutes / v.batches : v.minutes,
                            }))
                            .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
                    };
                }),
            }))
            .sort((a, b) => b.totalKg - a.totalKg || a.menu.localeCompare(b.menu));
    }

    // ── Equipment type grouping ─────────────────────────────────────────────────
    // Individual units (Bratt Pan 1-4, Combi Oven 1-4, …) roll up into one type.

    const MACHINE_TYPE_RULES = [
        [/^Bratt Pan \d/i, "Bratt Pan"],
        [/^Combi Oven \d/i, "Combi Oven"],
        [/^Deep Fryer \d/i, "Deep Fryer"],
        [/^Steam Box \d/i, "Steam Box"],
    ];

    function machineType(name) {
        if (name === "Round Bratt Pan") return "Steam Heated Kettle";
        for (const [rx, type] of MACHINE_TYPE_RULES) {
            if (rx.test(name)) return type;
        }
        return name;
    }

    // ── Machine summary across all menus in scope ──────────────────────────────

    function renderMachineSummary(tasks) {
        // type -> { total, units:{unit:min}, menus:{menu:{total, steps:{step:min}}} }
        const types = {};
        tasks.forEach((t) => {
            Object.entries(t.machines || {}).forEach(([name, v]) => {
                const mins = Number(v.minutes || 0);
                if (mins <= 0) return;
                const type = machineType(name);
                const td = types[type] || (types[type] = { total: 0, units: {}, menus: {} });
                td.total += mins;
                td.units[name] = (td.units[name] || 0) + mins;
                const md = td.menus[t.menu] || (td.menus[t.menu] = { total: 0, steps: {} });
                md.total += mins;
                md.steps[t.step] = (md.steps[t.step] || 0) + mins;
            });
        });

        const sorted = Object.entries(types)
            .filter((e) => e[1].total > 0)
            .sort((a, b) => b[1].total - a[1].total);

        if (sorted.length === 0) {
            summaryGrid.innerHTML = "<p class='card__helper'>No machine usage recorded for this period.</p>";
            summaryCard.style.display = "";
            return;
        }

        const maxMin = sorted[0][1].total;
        summaryGrid.innerHTML = "";
        sorted.forEach(([type, td]) => {
            const pct = Math.round((td.total / maxMin) * 100);
            const unitCount = Object.keys(td.units).length;
            const menuCount = Object.keys(td.menus).length;

            const item = document.createElement("div");
            item.className = "machine-type-item";
            item.innerHTML = `
                <div class="machine-summary-row machine-type-row" role="button" tabindex="0">
                    <span class="machine-summary-row__name">
                        <span class="machine-type-chevron">&#8964;</span>
                        ${esc(type)}${unitCount > 1 ? ` <small>(${unitCount} units)</small>` : ""}
                    </span>
                    <div class="machine-summary-row__bar-wrap">
                        <div class="machine-summary-row__bar" style="width:${pct}%"></div>
                    </div>
                    <span class="machine-summary-row__value">${fmtMin(td.total)}</span>
                </div>
                <div class="machine-type-detail" hidden>
                    <p class="machine-type-detail__hint">Used in ${menuCount} menu item${menuCount !== 1 ? "s" : ""}. Click to collapse.</p>
                </div>`;

            const row    = item.querySelector(".machine-type-row");
            const detail = item.querySelector(".machine-type-detail");
            const chev   = item.querySelector(".machine-type-chevron");
            let built = false;

            function toggle() {
                const open = !detail.hidden;
                detail.hidden = open;
                chev.style.transform = open ? "" : "rotate(180deg)";
                item.classList.toggle("machine-type-item--open", !open);
                if (!built && !open) {
                    detail.insertAdjacentHTML("beforeend", renderTypeDetail(td));
                    built = true;
                }
            }

            row.addEventListener("click", toggle);
            row.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            });

            summaryGrid.appendChild(item);
        });
        summaryCard.style.display = "";
    }

    // Drill-down: per type, the individual units plus each menu item and the
    // specific steps that ran on this equipment, sorted by run time.
    function renderTypeDetail(td) {
        const unitNames = Object.keys(td.units);
        const unitHtml = unitNames.length > 1
            ? `<div class="machine-type-units">${
                Object.entries(td.units).sort((a, b) => b[1] - a[1]).map(([n, m]) =>
                    `<span class="machine-pill">${esc(n)} <strong>${fmtMin(m)}</strong></span>`).join(" ")
              }</div>`
            : "";

        const menuHtml = Object.entries(td.menus)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([menu, md]) => {
                const stepPills = Object.entries(md.steps)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, m]) => `<span class="machine-pill">${esc(s)} <strong>${fmtMin(m)}</strong></span>`)
                    .join(" ");
                return `
                    <div class="machine-type-menu">
                        <div class="machine-type-menu__head">
                            <span class="machine-type-menu__name">${esc(menu)}</span>
                            <span class="machine-type-menu__time">${fmtMin(md.total)}</span>
                        </div>
                        <div class="machine-type-menu__steps">${stepPills}</div>
                    </div>`;
            }).join("");

        return unitHtml + menuHtml;
    }

    // ── Step detail table ──────────────────────────────────────────────────────

    function renderStepTable(steps) {
        if (!steps || steps.length === 0) {
            return "<p class='card__helper' style='padding:12px 0'>No steps recorded.</p>";
        }

        const rows = steps.map((step) => {
            const machineHtml = step.machines.length > 0
                ? step.machines.map((m) =>
                    `<span class="machine-pill">${esc(m.name)} <strong>${fmtMin(m.minutes)}</strong>` +
                    (step.batches > 1 ? ` <small>(${fmtPerBatch(m.perBatch)}/batch)</small>` : "") +
                    `</span>`).join(" ")
                : "<span class='card__helper'>—</span>";

            return `
                <tr>
                    <td>${esc(step.name)}</td>
                    <td class="col-center">${step.batches}</td>
                    <td class="col-center">${fmtMin(step.totalMinutes)}</td>
                    <td class="col-center">${fmtKg(step.totalKg)}</td>
                    <td class="col-machines">${machineHtml}</td>
                </tr>`;
        }).join("");

        return `
            <div class="meal-step-table-wrap">
                <table class="meal-step-table">
                    <thead>
                        <tr>
                            <th>Step</th>
                            <th class="col-center">Batches</th>
                            <th class="col-center">Total Time</th>
                            <th class="col-center">Output</th>
                            <th>Machines Used (total &amp; per batch)</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    // ── Meal accordion ─────────────────────────────────────────────────────────

    // Trial-run dishes are tagged "Trial Run : …" / "Trial run : …" in the report.
    function isTrialRun(menu) {
        return /trial\s*run/i.test(menu);
    }

    function buildMealCard(meal) {
        const card = document.createElement("article");
        card.className = "card section-gap meal-accordion-card";
        card.innerHTML = `
            <div class="meal-accordion-header" role="button" tabindex="0">
                <div class="meal-accordion-header__title">
                    <h3>${esc(meal.menu)}</h3>
                </div>
                <div class="meal-accordion-header__meta">
                    <span class="meal-meta-pill">${meal.steps.length} step${meal.steps.length !== 1 ? "s" : ""}</span>
                    <span class="meal-meta-pill">${fmtKg(meal.totalKg)}</span>
                    <span class="meal-meta-pill">${fmtMin(meal.totalMinutes)}</span>
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

        return card;
    }

    function buildMenuGroup(title, items) {
        const section = document.createElement("section");
        section.className = "menu-group section-gap";
        section.innerHTML = `
            <div class="menu-group__header" role="button" tabindex="0">
                <h3 class="menu-group__title">${esc(title)}</h3>
                <div class="menu-group__meta">
                    <span class="meal-meta-pill">${items.length} item${items.length !== 1 ? "s" : ""}</span>
                    <span class="menu-group__chevron">&#8964;</span>
                </div>
            </div>
            <div class="menu-group__body"></div>`;

        const header = section.querySelector(".menu-group__header");
        const gbody  = section.querySelector(".menu-group__body");
        const gchev  = section.querySelector(".menu-group__chevron");

        items.forEach((meal) => gbody.appendChild(buildMealCard(meal)));

        function toggle() {
            const open = !gbody.hidden;
            gbody.hidden = open;
            gchev.style.transform = open ? "" : "rotate(180deg)";
            section.classList.toggle("menu-group--open", !open);
        }

        header.addEventListener("click", toggle);
        header.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });

        return section;
    }

    function renderAccordion(menus) {
        accordion.innerHTML = "";

        if (menus.length === 0) {
            accordion.innerHTML = "<p class='card__helper'>No menu items were produced on the selected date.</p>";
            return;
        }

        const trial  = menus.filter((m) => isTrialRun(m.menu));
        const actual = menus.filter((m) => !isTrialRun(m.menu));

        if (trial.length > 0) {
            accordion.appendChild(buildMenuGroup("Trial Run Items", trial));
        }
        if (actual.length > 0) {
            accordion.appendChild(buildMenuGroup("Menu Items", actual));
        }
    }

    // ── Scope change ───────────────────────────────────────────────────────────

    function applyScope(scope) {
        const tasks = tasksForScope(scope);
        const menus = buildMenus(tasks);
        const totalKg = menus.reduce((sum, m) => sum + m.totalKg, 0);
        const scopeLabel = scope === ALL_VALUE ? "All of March" : (dateLabels[scope] || scope);
        if (scopeNote) {
            scopeNote.textContent =
                `${scopeLabel} — ${menus.length} menu item${menus.length !== 1 ? "s" : ""}, ${fmtKg(totalKg)} total output.`;
        }
        renderMachineSummary(tasks);
        renderAccordion(menus);
    }

    dateSelector.addEventListener("change", function () {
        applyScope(this.value);
    });

    // ── Init ───────────────────────────────────────────────────────────────────

    fetch("/api/lr-production-data")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            loadState.style.display = "none";

            if (data.error) {
                accordion.innerHTML = `<p class="card__helper" style="color:var(--red)">${esc(data.error)}</p>`;
                return;
            }

            allTasks   = data.tasks || [];
            dateLabels = data.date_labels || {};
            const dates = data.dates || [];

            dateSelector.innerHTML =
                `<option value="${ALL_VALUE}">All of March</option>` +
                dates.map((d) => `<option value="${esc(d)}">${esc(dateLabels[d] || d)}</option>`).join("");

            applyScope(ALL_VALUE);
        })
        .catch(function (err) {
            loadState.style.display = "none";
            accordion.innerHTML = `<p class="card__helper" style="color:var(--red)">Failed to load data: ${esc(String(err))}</p>`;
        });
})();
