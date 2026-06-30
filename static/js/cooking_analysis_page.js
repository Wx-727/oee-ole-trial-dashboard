(function () {
    const dateSelector = document.getElementById("dateSelector");
    const accordion    = document.getElementById("mealAccordion");
    const summaryCard  = document.getElementById("machineSummaryCard");
    const summaryGrid  = document.getElementById("machineSummaryGrid");
    const scopeNote    = document.getElementById("cookingScopeNote");
    const loadState    = document.getElementById("cookingLoadState");
    const kpiStrip     = document.getElementById("cookingKpiStrip");
    const sortBar      = document.getElementById("cookingSortBar");
    const sortSelect   = document.getElementById("cookingSortSelect");
    const searchInput  = document.getElementById("cookingSearch");
    const searchClear  = document.getElementById("cookingSearchClear");
    const searchCount  = document.getElementById("cookingSearchCount");
    const dqCard       = document.getElementById("dataQualityCard");
    const dqSummary    = document.getElementById("dqSummary");
    const dqList       = document.getElementById("dqList");
    const dqStatusFilter   = document.getElementById("dqStatusFilter");
    const dqCategoryFilter = document.getElementById("dqCategoryFilter");
    const dqHeader     = document.getElementById("dqHeader");
    const dqBody       = document.getElementById("dqBody");
    const dqHeaderPill = document.getElementById("dqHeaderPill");

    let currentMenus = [];

    const ALL_VALUE = "__ALL__";

    let allTasks   = [];   // per (date, menu, step) rows from the API
    let dateLabels = {};

    // ── Data-quality state ───────────────────────────────────────────────────
    let allFlags     = [];     // flag objects from /api/lr-data-quality
    let flagSummary  = null;
    let flagIndex    = {};     // "menu|||step" (lower) -> { status, categories:Set }
    let dqStatus     = "pending";
    let dqCategory   = "__ALL__";

    // ── Meals assembled (from the HR month report) ───────────────────────────
    let mealsByMenu = {};   // lr menu -> { meals, meals_per_man_hr, by_day:[{date,meals}] }

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
    function kgPerManHr(kg, manMinutes) {
        return manMinutes > 0 ? kg / (manMinutes / 60) : null;
    }

    function buildMenus(tasks) {
        const menus = {};
        tasks.forEach((t) => {
            const menuKey = t.menu;
            if (!menus[menuKey]) {
                menus[menuKey] = { menu: menuKey, stepMap: {}, stepOrder: [], totalKg: 0, totalMinutes: 0, manMinutes: 0, peakWorkers: 0, dateSet: {} };
            }
            const meal = menus[menuKey];
            if (t.date) meal.dateSet[t.date] = true;
            const workers = Number(t.workers) || 0;
            const dur = Number(t.duration_min) || 0;

            const stepKey = String(t.step || "").toLowerCase();
            if (!meal.stepMap[stepKey]) {
                meal.stepMap[stepKey] = { name: t.step, stageMin: {}, batches: 0, totalMinutes: 0, totalKg: 0, manMinutes: 0, workers: 0, machines: {} };
                meal.stepOrder.push(stepKey);
            }
            const step = meal.stepMap[stepKey];
            step.batches      += t.batches || 0;
            step.totalMinutes += dur;
            step.totalKg      += t.kg || 0;
            step.manMinutes   += workers * dur;
            step.workers       = Math.max(step.workers, workers);
            // Track time per stage so the badge reflects the dominant one (some
            // steps are logged under both Prep and Cooking sections across days).
            const st = t.stage || "cooking";
            step.stageMin[st] = (step.stageMin[st] || 0) + (dur || 1);
            Object.entries(t.machines || {}).forEach(([name, v]) => {
                if (!step.machines[name]) step.machines[name] = { minutes: 0, batches: 0 };
                step.machines[name].minutes += Number(v.minutes || 0);
                step.machines[name].batches += Number(v.batches || 0);
            });

            meal.totalKg      += t.kg || 0;
            meal.totalMinutes += dur;
            meal.manMinutes   += workers * dur;
            meal.peakWorkers   = Math.max(meal.peakWorkers, workers);
        });

        return Object.values(menus)
            .map((meal) => ({
                menu: meal.menu,
                totalKg: meal.totalKg,
                totalMinutes: meal.totalMinutes,
                peakWorkers: meal.peakWorkers,
                dates: Object.keys(meal.dateSet).sort(),
                kgPerManHr: kgPerManHr(meal.totalKg, meal.manMinutes),
                steps: meal.stepOrder.map((sk) => {
                    const s = meal.stepMap[sk];
                    const dominantStage = Object.entries(s.stageMin)
                        .sort((a, b) => b[1] - a[1])[0];
                    return {
                        name: s.name,
                        stage: dominantStage ? dominantStage[0] : "cooking",
                        batches: s.batches,
                        totalMinutes: s.totalMinutes,
                        totalKg: s.totalKg,
                        minPerBatch: s.batches ? s.totalMinutes / s.batches : s.totalMinutes,
                        kgPerBatch: s.batches ? s.totalKg / s.batches : s.totalKg,
                        workers: s.workers,
                        kgPerManHr: kgPerManHr(s.totalKg, s.manMinutes),
                        machines: Object.entries(s.machines)
                            .map(([name, v]) => ({
                                name,
                                minutes: v.minutes,
                                perBatch: v.batches ? v.minutes / v.batches : v.minutes,
                            }))
                            .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
                    };
                }),
            }));
    }

    function fmtEff(v) {
        return v && v > 0 ? v.toLocaleString("en", { maximumFractionDigits: 1 }) : "—";
    }

    function stageBadge(stage) {
        const prep = stage === "food_prep";
        return `<span class="stage-badge stage-badge--${prep ? "prep" : "cook"}">${prep ? "Prep" : "Cook"}</span>`;
    }

    function sortMenus(menus, mode) {
        const cmp = {
            kg: (a, b) => b.totalKg - a.totalKg,
            time: (a, b) => b.totalMinutes - a.totalMinutes,
            efficiency: (a, b) => (b.kgPerManHr || 0) - (a.kgPerManHr || 0),
            name: (a, b) => a.menu.localeCompare(b.menu),
        }[mode] || ((a, b) => b.totalKg - a.totalKg);
        return [...menus].sort((a, b) => cmp(a, b) || a.menu.localeCompare(b.menu));
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

    function flagBadge(menu, stepName) {
        const hit = flagIndex[`${String(menu).toLowerCase()}|||${String(stepName).toLowerCase()}`];
        if (!hit) return "";
        const cats = [...hit.categories].join(", ");
        const cls = hit.status === "confirmed" ? "flag-badge--confirmed" : "flag-badge--pending";
        const label = hit.status === "confirmed" ? "confirmed issue" : "needs review";
        return ` <span class="flag-badge ${cls}" title="Data quality: ${esc(cats)} (${label})">&#9888;</span>`;
    }

    function renderStepTable(steps, menu) {
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

            const perBatchTime = step.batches > 1 ? ` <small>(${fmtMin(step.minPerBatch)}/batch)</small>` : "";
            const perBatchKg = (step.batches > 1 && step.totalKg > 0) ? ` <small>(${fmtEff(step.kgPerBatch)} kg/batch)</small>` : "";
            return `
                <tr>
                    <td>${esc(step.name)} ${stageBadge(step.stage)}${flagBadge(menu, step.name)}</td>
                    <td class="col-center">${step.batches}</td>
                    <td class="col-center">${fmtMin(step.totalMinutes)}${perBatchTime}</td>
                    <td class="col-center">${fmtKg(step.totalKg)}${perBatchKg}</td>
                    <td class="col-center">${step.workers || "—"}</td>
                    <td class="col-center">${fmtEff(step.kgPerManHr)}</td>
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
                            <th class="col-center">Time (total &amp; /batch)</th>
                            <th class="col-center">Output (total &amp; /batch)</th>
                            <th class="col-center">Workers</th>
                            <th class="col-center">Kg/Man-Hr</th>
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

    function dayPills(isos) {
        if (!isos || !isos.length) return "";
        const pills = isos
            .map((iso) => `<span class="meal-day-pill" data-iso="${esc(iso)}" role="button" tabindex="0" title="View ${esc(dateLabels[iso] || iso)}">${esc(dateLabels[iso] || iso)}</span>`)
            .join("");
        return `<div class="meal-days"><span class="meal-days__label">Produced on</span>${pills}</div>`;
    }

    function goToDate(iso) {
        if (!dateSelector) return;
        dateSelector.value = iso;
        applyScope(iso);
        if (kpiStrip) kpiStrip.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function fmtIsoShort(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
        return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]}` : iso;
    }
    function fmtMeals(n) {
        return Number(n || 0).toLocaleString("en");
    }

    // Header pills for meals + meals/man-hr (assembly stage, from HR report).
    function mealsPills(menu) {
        const info = mealsByMenu[menu];
        if (!info) return "";
        let html = `<span class="meal-meta-pill meal-meta-pill--meals" title="Meals assembled (High Risk), whole month">${fmtMeals(info.meals)} meals</span>`;
        if (info.meals_per_man_hr) {
            html += `<span class="meal-meta-pill" title="Assembly labour efficiency">${fmtMeals(info.meals_per_man_hr)} meals/man-hr</span>`;
        }
        return html;
    }

    // Per-day meals assembled (HR assembly dates — may differ from cooking dates).
    function assembledRow(menu) {
        const info = mealsByMenu[menu];
        if (!info || !info.by_day || !info.by_day.length) return "";
        const pills = info.by_day
            .map((d) => `<span class="meal-assembled-pill">${esc(fmtIsoShort(d.date))} <strong>${fmtMeals(d.meals)}</strong></span>`)
            .join("");
        return `<div class="meal-assembled"><span class="meal-days__label">Assembled</span>${pills}</div>`;
    }

    function buildMealCard(meal) {
        const card = document.createElement("article");
        card.className = "card section-gap meal-accordion-card";
        card.innerHTML = `
            <div class="meal-accordion-header" role="button" tabindex="0">
                <div class="meal-accordion-header__title">
                    <h3>${esc(meal.menu)}</h3>
                    ${dayPills(meal.dates)}
                    ${assembledRow(meal.menu)}
                </div>
                <div class="meal-accordion-header__meta">
                    <span class="meal-meta-pill">${meal.steps.length} step${meal.steps.length !== 1 ? "s" : ""}</span>
                    <span class="meal-meta-pill">${fmtKg(meal.totalKg)}</span>
                    <span class="meal-meta-pill">${fmtMin(meal.totalMinutes)}</span>
                    ${meal.kgPerManHr ? `<span class="meal-meta-pill meal-meta-pill--accent">${fmtEff(meal.kgPerManHr)} kg/man-hr</span>` : ""}
                    ${mealsPills(meal.menu)}
                    <span class="meal-accordion-chevron">&#8964;</span>
                </div>
            </div>
            <div class="meal-accordion-body" hidden>
                ${renderStepTable(meal.steps, meal.menu)}
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

        // Day pills jump to that date's scope instead of toggling the card.
        card.querySelectorAll(".meal-day-pill").forEach(function (pill) {
            const iso = pill.dataset.iso;
            pill.addEventListener("click", function (e) { e.stopPropagation(); goToDate(iso); });
            pill.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); goToDate(iso); }
            });
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

        // Only wrap in groups when both sets exist; otherwise list meals directly
        // so a single-group file (e.g. a real trial workbook) isn't double-headed.
        if (trial.length > 0 && actual.length > 0) {
            accordion.appendChild(buildMenuGroup("Trial Run Items", trial));
            accordion.appendChild(buildMenuGroup("Menu Items", actual));
        } else {
            menus.forEach((meal) => accordion.appendChild(buildMealCard(meal)));
        }
    }

    // ── KPI strip ───────────────────────────────────────────────────────────────

    function renderKpiStrip(tasks) {
        if (!kpiStrip) return;
        let totalKg = 0, totalBatches = 0, manMinutes = 0;
        const machineMin = {};
        tasks.forEach((t) => {
            totalKg += t.kg || 0;
            totalBatches += t.batches || 0;
            manMinutes += (Number(t.workers) || 0) * (Number(t.duration_min) || 0);
            Object.entries(t.machines || {}).forEach(([n, v]) => {
                machineMin[n] = (machineMin[n] || 0) + Number(v.minutes || 0);
            });
        });
        const manHours = manMinutes / 60;
        const busiest = Object.entries(machineMin).sort((a, b) => b[1] - a[1])[0];
        const avgEff = kgPerManHr(totalKg, manMinutes);

        const cards = [
            ["Total Output", fmtKg(totalKg), ""],
            ["Total Batches", totalBatches.toLocaleString("en"), ""],
            ["Labour", `${manHours.toLocaleString("en", { maximumFractionDigits: 0 })} man-hr`, ""],
            ["Avg Efficiency", avgEff ? `${fmtEff(avgEff)} kg/man-hr` : "—", ""],
            ["Equipment Used", `${Object.keys(machineMin).length} machines`, ""],
            ["Busiest Machine", busiest ? esc(busiest[0]) : "—", busiest ? fmtMin(busiest[1]) : ""],
        ];
        kpiStrip.innerHTML = cards.map((c) => `
            <div class="kpi-card">
                <span class="kpi-card__label">${c[0]}</span>
                <strong class="kpi-card__value">${c[1]}</strong>
                ${c[2] ? `<span class="kpi-card__sub">${c[2]}</span>` : ""}
            </div>`).join("");
        kpiStrip.style.display = "";
    }

    // ── Scope change ───────────────────────────────────────────────────────────

    function filterMenus(menus, query) {
        const q = query.trim().toLowerCase();
        if (!q) return menus;
        return menus.filter((m) =>
            m.menu.toLowerCase().includes(q) ||
            (m.steps || []).some((s) => String(s.name).toLowerCase().includes(q)));
    }

    function renderMenuList() {
        const mode = sortSelect ? sortSelect.value : "kg";
        const query = searchInput ? searchInput.value : "";
        const filtered = filterMenus(currentMenus, query);
        renderAccordion(sortMenus(filtered, mode));

        if (searchClear) searchClear.hidden = !query.trim();
        if (searchCount) {
            if (query.trim()) {
                searchCount.hidden = false;
                searchCount.textContent =
                    `${filtered.length} of ${currentMenus.length} menu item${currentMenus.length !== 1 ? "s" : ""} match “${query.trim()}”.`;
            } else {
                searchCount.hidden = true;
            }
        }
    }

    function applyScope(scope) {
        const tasks = tasksForScope(scope);
        currentMenus = buildMenus(tasks);
        const totalKg = currentMenus.reduce((sum, m) => sum + m.totalKg, 0);
        const scopeLabel = scope === ALL_VALUE ? "All of March" : (dateLabels[scope] || scope);
        if (scopeNote) {
            scopeNote.textContent =
                `${scopeLabel} — ${currentMenus.length} menu item${currentMenus.length !== 1 ? "s" : ""}, ${fmtKg(totalKg)} total output.`;
        }
        renderKpiStrip(tasks);
        renderMachineSummary(tasks);
        if (sortBar) sortBar.style.display = currentMenus.length ? "" : "none";
        renderMenuList();
    }

    dateSelector.addEventListener("change", function () {
        applyScope(this.value);
    });

    if (sortSelect) {
        sortSelect.addEventListener("change", renderMenuList);
    }

    if (searchInput) {
        searchInput.addEventListener("input", renderMenuList);
    }
    if (searchClear) {
        searchClear.addEventListener("click", function () {
            searchInput.value = "";
            searchInput.focus();
            renderMenuList();
        });
    }

    // ── Data Quality review ─────────────────────────────────────────────────────

    const SEVERITY_DOT = { error: "dq-dot--error", warn: "dq-dot--warn", info: "dq-dot--info" };
    const STATUS_LABEL = { pending: "Needs review", confirmed: "Confirmed issue", dismissed: "Not an issue" };

    function buildFlagIndex() {
        flagIndex = {};
        allFlags.forEach((f) => {
            if (f.status === "dismissed" || !f.menu || !f.step) return;
            const key = `${String(f.menu).toLowerCase()}|||${String(f.step).toLowerCase()}`;
            const cur = flagIndex[key] || (flagIndex[key] = { status: "pending", categories: new Set() });
            cur.categories.add(f.category);
            if (f.status === "confirmed") cur.status = "confirmed";
        });
    }

    function renderDqSummary() {
        if (!flagSummary) return;
        const s = flagSummary.by_status || {};
        const chips = [
            ["Total flags", flagSummary.total || 0, ""],
            ["Needs review", s.pending || 0, "dq-chip--pending"],
            ["Confirmed", s.confirmed || 0, "dq-chip--confirmed"],
            ["Dismissed", s.dismissed || 0, "dq-chip--dismissed"],
        ];
        dqSummary.innerHTML = chips.map((c) =>
            `<div class="dq-chip ${c[2]}"><span class="dq-chip__value">${c[1]}</span>` +
            `<span class="dq-chip__label">${c[0]}</span></div>`).join("");
    }

    function renderDqFilters() {
        const counts = (flagSummary && flagSummary.by_status) || {};
        const statuses = [
            ["pending", `Needs review (${counts.pending || 0})`],
            ["confirmed", `Confirmed (${counts.confirmed || 0})`],
            ["dismissed", `Dismissed (${counts.dismissed || 0})`],
            ["__ALL__", `All (${flagSummary ? flagSummary.total : 0})`],
        ];
        dqStatusFilter.innerHTML = statuses.map(([v, label]) =>
            `<button type="button" class="dq-filter__btn${dqStatus === v ? " is-active" : ""}" data-status="${v}">${label}</button>`).join("");
        dqStatusFilter.querySelectorAll(".dq-filter__btn").forEach((b) => {
            b.addEventListener("click", () => { dqStatus = b.dataset.status; renderDqFilters(); renderDqList(); });
        });

        const cats = Object.keys((flagSummary && flagSummary.by_category) || {}).sort();
        dqCategoryFilter.innerHTML =
            `<option value="__ALL__">All categories</option>` +
            cats.map((c) => `<option value="${esc(c)}"${dqCategory === c ? " selected" : ""}>${esc(c)}</option>`).join("");
        dqCategoryFilter.onchange = function () { dqCategory = this.value; renderDqList(); };
    }

    function flagContext(f) {
        const bits = [];
        if (f.date_label) bits.push(esc(f.date_label));
        if (f.menu) bits.push(esc(f.menu));
        if (f.step) bits.push(esc(f.step));
        if (f.machine) bits.push(`<strong>${esc(f.machine)}</strong>`);
        return bits.join(" · ");
    }

    function renderDqList() {
        let list = allFlags.slice();
        if (dqStatus !== "__ALL__") list = list.filter((f) => (f.status || "pending") === dqStatus);
        if (dqCategory !== "__ALL__") list = list.filter((f) => f.category === dqCategory);

        if (list.length === 0) {
            dqList.innerHTML = `<p class="card__helper" style="padding:12px 0">No flags in this view. ${
                (flagSummary && flagSummary.total) ? "" : "The data passed every check."}</p>`;
            return;
        }

        dqList.innerHTML = list.map((f) => {
            const st = f.status || "pending";
            return `
            <div class="dq-flag dq-flag--${st}" data-id="${esc(f.id)}">
                <div class="dq-flag__main">
                    <span class="dq-dot ${SEVERITY_DOT[f.severity] || "dq-dot--warn"}"></span>
                    <div class="dq-flag__body">
                        <div class="dq-flag__head">
                            <span class="dq-flag__category">${esc(f.category)}</span>
                            <span class="dq-status-badge dq-status-badge--${st}">${STATUS_LABEL[st]}</span>
                        </div>
                        <p class="dq-flag__msg">${esc(f.message)}</p>
                        <p class="dq-flag__context">${flagContext(f)}</p>
                        ${f.note ? `<p class="dq-flag__note">Note: ${esc(f.note)}</p>` : ""}
                    </div>
                </div>
                <div class="dq-flag__actions">
                    <button type="button" class="dq-btn dq-btn--confirm" data-act="confirmed">Confirm issue</button>
                    <button type="button" class="dq-btn dq-btn--dismiss" data-act="dismissed">Not an issue</button>
                    ${st !== "pending" ? `<button type="button" class="dq-btn dq-btn--reset" data-act="pending">Reset</button>` : ""}
                    <input type="text" class="dq-note-input" placeholder="Add a note (optional)" value="${esc(f.note || "")}" maxlength="500" />
                </div>
            </div>`;
        }).join("");

        dqList.querySelectorAll(".dq-flag").forEach((el) => {
            const id = el.dataset.id;
            const noteInput = el.querySelector(".dq-note-input");
            el.querySelectorAll(".dq-btn").forEach((btn) => {
                btn.addEventListener("click", () => submitReview(id, btn.dataset.act, noteInput.value));
            });
        });
    }

    function submitReview(id, status, note) {
        dqList.querySelectorAll(`.dq-flag[data-id="${CSS.escape(id)}"] .dq-btn`).forEach((b) => (b.disabled = true));
        fetch("/api/lr-flag-review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status, note }),
        })
            .then((r) => r.json())
            .then((data) => {
                if (data.error) { alert("Could not save: " + data.error); return; }
                allFlags = data.flags || [];
                flagSummary = data.summary || null;
                buildFlagIndex();
                renderDataQuality();
                renderMenuList();   // refresh step badges
            })
            .catch((err) => alert("Could not save review: " + err));
    }

    function renderDataQuality() {
        if (!dqCard) return;
        if (!allFlags.length && (!flagSummary || !flagSummary.total)) {
            dqCard.style.display = "none";
            return;
        }
        dqCard.style.display = "";
        if (dqHeaderPill && flagSummary) {
            const pending = (flagSummary.by_status || {}).pending || 0;
            dqHeaderPill.textContent = pending > 0
                ? `${pending} need${pending !== 1 ? "" : "s"} review`
                : `${flagSummary.total} flag${flagSummary.total !== 1 ? "s" : ""} · all reviewed`;
            dqHeaderPill.classList.toggle("meal-meta-pill--accent", pending > 0);
        }
        renderDqSummary();
        renderDqFilters();
        renderDqList();
    }

    function toggleDq() {
        if (!dqBody) return;
        const open = !dqBody.hidden;
        dqBody.hidden = open;
        dqCard.classList.toggle("data-quality-card--open", !open);
    }

    if (dqHeader) {
        dqHeader.addEventListener("click", toggleDq);
        dqHeader.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDq(); }
        });
    }

    function loadMenuMeals() {
        fetch("/api/lr-menu-meals")
            .then((r) => r.json())
            .then((data) => {
                if (data.error || !data.menus) return;
                mealsByMenu = data.menus;
                renderMenuList();   // re-render cards with meals once known
            })
            .catch(function () { /* meals are supplementary; ignore */ });
    }

    function loadDataQuality() {
        fetch("/api/lr-data-quality")
            .then((r) => r.json())
            .then((data) => {
                if (data.error) return;
                allFlags = data.flags || [];
                flagSummary = data.summary || null;
                buildFlagIndex();
                renderDataQuality();
                renderMenuList();   // badge steps once flags are known
            })
            .catch(function () { /* verification is non-critical; ignore */ });
    }

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
            loadDataQuality();
            loadMenuMeals();
        })
        .catch(function (err) {
            loadState.style.display = "none";
            accordion.innerHTML = `<p class="card__helper" style="color:var(--red)">Failed to load data: ${esc(String(err))}</p>`;
        });
})();
