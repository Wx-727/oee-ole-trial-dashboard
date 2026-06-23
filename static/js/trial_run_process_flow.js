(function () {
    const STAGE_TOTAL_STAFF = {
        foodPrep: 26,
        cooking: 99,
        assembly: 78,
        packing: 24,
    };

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function cleanProduct(name) {
        if (!name) return "";
        return String(name)
            .replace(/\s*(ย้อน|Lot\.?\s*\d+.*)/gi, "")
            .replace(/\s*\(MU\)/gi, "")
            .trim();
    }

    function formatNumber(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "N/A";
        return number.toLocaleString();
    }

    function formatMinutes(value) {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0) return "N/A";
        const hours = Math.floor(minutes / 60);
        const remain = Math.round(minutes % 60);
        if (!hours) return `${remain} min`;
        return `${hours}h${remain ? ` ${remain}m` : ""}`;
    }

    function trialDateLabel(dateStr) {
        if (!dateStr) return "N/A";
        const parts = String(dateStr).split("-");
        if (parts.length !== 3) return dateStr;
        const [, month, day] = parts;
        const monthMap = {
            "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
            "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
            "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
        };
        return `${Number(day)} ${monthMap[month] || month}`;
    }

    function pct(value, digits = 1) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "N/A";
        return `${number.toFixed(digits)}%`;
    }

    function splitLots(value) {
        return String(value || "")
            .split(",")
            .map((part) => part.replace(/[^0-9]/g, "").replace(/^0+/, ""))
            .filter(Boolean);
    }

    function normalizeLot(value) {
        return String(value || "").replace(/[^0-9]/g, "").replace(/^0+/, "");
    }

    function matchesLot(value, selectedLot) {
        if (!selectedLot || selectedLot === "all") return true;
        return splitLots(value).includes(selectedLot);
    }

    function parseClockMinutes(value) {
        const text = String(value || "").trim();
        if (!text.includes(":")) return null;
        const [hour, minute] = text.split(":").map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        return hour * 60 + minute;
    }

    function buildKpiCard(label, value, sub = "") {
        return `
            <div class="pfx-kpi-card">
                <span class="pfx-kpi-card__label">${escapeHtml(label)}</span>
                <span class="pfx-kpi-card__value">${value}</span>
                ${sub ? `<span class="pfx-kpi-card__sub">${sub}</span>` : ""}
            </div>
        `;
    }

    function buildPanel(title, meta, content) {
        return `
            <div class="pfx-rout-panel">
                <div class="pfx-rout-panel__header">
                    <p class="eyebrow">${escapeHtml(title)}</p>
                    <span class="pfx-rout-panel__meta">${escapeHtml(meta || "")}</span>
                </div>
                ${content}
            </div>
        `;
    }

    function buildTable(headers, rowsHtml, emptyLabel) {
        return `
            <div class="pfx-rout-table-wrap">
                <table class="pfx-rout-table">
                    <thead>
                        <tr>${headers.map((header) => `<th class="${String(header).includes("text-align:right") ? "numeric-cell" : ""}">${header}</th>`).join("")}</tr>
                    </thead>
                    <tbody>${rowsHtml || `<tr><td colspan="${headers.length}" class="empty-state-cell">${escapeHtml(emptyLabel)}</td></tr>`}</tbody>
                </table>
            </div>
        `;
    }

    function buildProgress(label, percent, detail) {
        const width = Number.isFinite(percent) ? Math.max(0, Math.min(percent, 100)) : 0;
        return `
            <div class="pfx-progress">
                <div class="pfx-progress__meta">
                    <span class="pfx-kpi-card__label">${escapeHtml(label)}</span>
                    <strong>${Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "N/A"}</strong>
                </div>
                <div class="pfx-progress__bar"><span style="width:${width}%"></span></div>
                <span class="pfx-kpi-card__sub">${detail}</span>
            </div>
        `;
    }

    function buildTimeline(entries, statLabel) {
        const normalized = (entries || []).map((entry) => {
            const startMin = parseClockMinutes(entry.start);
            const stopRaw = parseClockMinutes(entry.stop);
            if (startMin === null || stopRaw === null) return null;
            const stopMin = stopRaw >= startMin ? stopRaw : stopRaw + (24 * 60);
            return {
                label: entry.label,
                start: entry.start,
                stop: entry.stop,
                startMin,
                stopMin,
                stat: entry.stat || "—",
                tip: entry.tip || `${entry.start} - ${entry.stop}`,
                color: entry.color || "#c8102e",
            };
        }).filter(Boolean);

        if (!normalized.length) {
            return `<p class="inline-empty-state">No timing data available for the selected trial date.</p>`;
        }

        const minStart = Math.min(...normalized.map((entry) => entry.startMin));
        const maxStop = Math.max(...normalized.map((entry) => entry.stopMin));
        const span = Math.max(maxStop - minStart, 60);

        const minsToHHMM = (mins) => {
            const wrapped = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
            const hours = Math.floor(wrapped / 60);
            const minutes = wrapped % 60;
            return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        };

        const axisHtml = Array.from({ length: 5 }).map((_, index) => {
            const pos = index * 25;
            const tick = minsToHHMM(minStart + Math.round((span * pos) / 100));
            return `
                <span class="pft-axis-tick${index === 4 ? " pft-axis-tick--right" : ""}" style="left:${pos}%">${tick}</span>
                ${index ? `<span class="pft-grid-line" style="left:${pos}%"></span>` : ""}
            `;
        }).join("");

        const rowsHtml = normalized.map((entry) => {
            const left = ((entry.startMin - minStart) / span) * 100;
            const width = Math.max(((entry.stopMin - entry.startMin) / span) * 100, 1.2);
            return `
                <div class="gantt-row">
                    <span class="gantt-label" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span>
                    <div class="gantt-track-wrap">
                        <span class="pft-grid-line" style="left:25%"></span>
                        <span class="pft-grid-line" style="left:50%"></span>
                        <span class="pft-grid-line" style="left:75%"></span>
                        <span class="pft-grid-line" style="left:100%"></span>
                        <div class="gantt-bar" data-tip="${escapeHtml(entry.tip)}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;height:100%;background:${entry.color};border-radius:4px"></div>
                    </div>
                    <span class="gantt-stat gantt-stat--narrow">${escapeHtml(entry.stat)}</span>
                </div>
            `;
        }).join("");

        return `
            <div class="gantt-row">
                <span class="gantt-label"></span>
                <div class="gantt-track-wrap gantt-track-wrap--axis">${axisHtml}</div>
                <span class="gantt-stat" style="font-size:0.7rem">${escapeHtml(statLabel || "")}</span>
            </div>
            ${rowsHtml}
        `;
    }

    /* ── Day / Night shift comparison grid ─────────────────────────────────── */
    function buildShiftCompareGrid(dateShifts, getTasksFn, getSummaryFn, staffCount) {
        const dayEntry   = dateShifts.find(({shift}) => shift.shift_type === "Day");
        const nightEntry = dateShifts.find(({shift}) => shift.shift_type === "Night");
        if (!dayEntry && !nightEntry) return "";

        function shiftCol(entry, label, timeRange) {
            if (!entry) return `
                <div class="pfx-shift-col pfx-shift-col--empty">
                    <div class="pfx-shift-col__header">
                        <span class="pfx-shift-col__label">${label}</span>
                        <span class="pfx-shift-col__time">${timeRange}</span>
                    </div>
                    <p class="pfx-shift-col__na">Not scheduled this date</p>
                </div>`;
            const tasks    = getTasksFn(entry.shift);
            const summary  = getSummaryFn(entry.shift);
            const totalKg  = tasks.reduce((s, t) => s + Number(t.kg_output  || 0), 0);
            const totalMin = summary.total_duration_min || tasks.reduce((s, t) => s + Number(t.duration_min || 0), 0);
            const rates    = tasks.map(t => Number(t.kg_man_hr || 0)).filter(v => v > 0);
            const avgRate  = rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
            return `
                <div class="pfx-shift-col">
                    <div class="pfx-shift-col__header">
                        <span class="pfx-shift-col__label">${label}</span>
                        <span class="pfx-shift-col__time">${timeRange}</span>
                    </div>
                    <div class="pfx-shift-col__metrics">
                        <div class="pfx-shift-metric"><span class="pfx-shift-metric__val">${totalKg > 0 ? totalKg.toFixed(1) + " kg" : "—"}</span><span class="pfx-shift-metric__lbl">Output</span></div>
                        <div class="pfx-shift-metric"><span class="pfx-shift-metric__val">${staffCount || "—"}</span><span class="pfx-shift-metric__lbl">Total Staff</span></div>
                        <div class="pfx-shift-metric"><span class="pfx-shift-metric__val">${totalMin > 0 ? formatMinutes(totalMin) : "—"}</span><span class="pfx-shift-metric__lbl">Total Time</span></div>
                        <div class="pfx-shift-metric"><span class="pfx-shift-metric__val">${avgRate > 0 ? avgRate.toFixed(1) + " kg/mhr" : "—"}</span><span class="pfx-shift-metric__lbl">Avg Rate</span></div>
                    </div>
                </div>`;
        }

        return `
            <div class="pfx-shift-compare">
                ${shiftCol(dayEntry,   "Day Shift",   "07:00 – 19:00")}
                <div class="pfx-shift-divider"></div>
                ${shiftCol(nightEntry, "Night Shift", "19:00 – 07:00")}
            </div>`;
    }

    /* ── Machine usage breakdown by menu ────────────────────────────────────── */
    function buildMachineByMenuPanel(tasks) {
        const menuMap = {};
        tasks.forEach(t => {
            const menu = cleanProduct(t.menu) || "Other";
            if (!menuMap[menu]) menuMap[menu] = {};
            Object.entries(t.machines || {}).forEach(([machine, mins]) => {
                menuMap[menu][machine] = (menuMap[menu][machine] || 0) + Number(mins || 0);
            });
        });
        const entries = Object.entries(menuMap).filter(([, m]) => Object.keys(m).length > 0);
        if (!entries.length) return "";

        const rows = entries.map(([menu, machines]) => {
            const top   = Object.entries(machines).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const total = Object.values(machines).reduce((s, v) => s + v, 0);
            return `
                <tr>
                    <td>${escapeHtml(menu)}</td>
                    <td style="text-align:right">${formatNumber(total)} min</td>
                    <td><div class="pfx-tag-row">${top.map(([m, mins]) => `<span class="pfx-tag">${escapeHtml(m)} <strong>${mins}m</strong></span>`).join("")}</div></td>
                </tr>`;
        }).join("");

        return buildPanel(
            "Machine Usage by Menu",
            `${entries.length} menu${entries.length === 1 ? "" : "s"} with machine data`,
            buildTable(
                ["Menu", "<span style='display:block;text-align:right'>Total Min</span>", "Top Machines Used"],
                rows,
                "No machine data for this selection."
            )
        );
    }

    let cachedTrialData = null;

    async function fetchTrialData() {
        if (cachedTrialData) return cachedTrialData;
        const response = await fetch("/api/trial-run-data", { cache: "no-store" });
        cachedTrialData = await response.json();
        return cachedTrialData;
    }

    function buildState(data) {
        const stages = data.stages || {};
        return {
            data,
            lrByDate: (stages.lr_shifts || []).reduce((acc, shift) => {
                if (!acc[shift.shift_date]) acc[shift.shift_date] = [];
                acc[shift.shift_date].push(shift);
                return acc;
            }, {}),
            dayByDate: Object.fromEntries((data.days || []).map((day) => [day.date, day])),
            hrByDate: Object.fromEntries((stages.hr_days || []).map((day) => [day.date, day])),
            mrByDate: Object.fromEntries((stages.mr_days || []).map((day) => [day.packing_date, day])),
        };
    }

    function updateCardHeader(cardId, eyebrow, title, helper) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const eyebrowEl = card.querySelector(".card__header .eyebrow");
        const titleEl = card.querySelector(".card__header h2");
        const helperEl = card.querySelector(".card__header .card__helper");
        if (eyebrowEl) eyebrowEl.textContent = eyebrow;
        if (titleEl) titleEl.textContent = title;
        if (helperEl) helperEl.textContent = helper;
    }

    function updateProcessTableHeader(eyebrow, title, helper) {
        const card = document.getElementById("pfxProcessDataCard");
        if (!card) return;
        const eyebrowEl = card.querySelector(".card__header .eyebrow");
        const titleEl = card.querySelector(".card__header h2");
        const helperEl = card.querySelector(".card__header .card__helper");
        if (eyebrowEl) eyebrowEl.textContent = eyebrow;
        if (titleEl) titleEl.textContent = title;
        if (helperEl) helperEl.textContent = helper;
    }

    function applyTrialCopy(data) {
        const flowCard = document.querySelector(".pfx-flow-card");
        if (flowCard) {
            const helperEl = flowCard.querySelector(".card__helper");
            if (helperEl) {
                helperEl.textContent = `Historical Stage 2 trial-run view using the 25-28 March 2026 Excel data. ${data.meta?.note || ""}`;
            }
        }

        updateCardHeader("pfxFoodPrepCard", "Stage 1", "Food Prep", "Historical LR task data in the same KPI-and-detail card format as the live process flow.");
        updateCardHeader("pfxCookingCard", "Stage 2", "Cooking", "Historical LR cooking tasks with output, workers, duration, and machine usage.");
        updateCardHeader("pfxAssemblyCard", "Stage 3", "Assembly", "Historical HR production results with attainment plus OEE and OLE where timing was captured.");
        updateCardHeader("pfxPackingCard", "Stage 4", "Packing", "Historical MR sessions summarised into the same structure as the live packing view.");
    }

    function populateFilters(state) {
        const foodPrepDateFilter = document.getElementById("pfxFoodPrepDateFilter");
        const cookingDateFilter = document.getElementById("pfxCookingDateFilter");
        const assemblyDateFilter = document.getElementById("pfxDateFilter");
        const packingDateFilter = document.getElementById("pfxPackingDateFilter");
        const lotFilter = document.getElementById("pfxLotFilter");

        const setOptions = (selectEl, values, label) => {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = `<option value="all">All ${label}</option>`;
            values.forEach((value) => selectEl.appendChild(new Option(value, value)));
            selectEl.value = values.includes(current) ? current : "all";
        };

        const prepDates = Object.keys(state.lrByDate).sort().filter((date) => date >= "2026-03-25");
        const assemblyDates = (state.data.days || []).map((day) => day.date).sort();
        const packingDates = Object.keys(state.mrByDate).sort();
        const lotValues = new Set();

        (state.data.days || []).forEach((day) => {
            (day.products || []).forEach((product) => splitLots(product.lot).forEach((lot) => lotValues.add(lot)));
        });
        Object.values(state.mrByDate).forEach((day) => {
            (day.sessions || []).forEach((session) => {
                const lot = normalizeLot(session.lot);
                if (lot) lotValues.add(lot);
            });
        });

        setOptions(foodPrepDateFilter, prepDates, "Dates");
        setOptions(cookingDateFilter, prepDates, "Dates");
        setOptions(assemblyDateFilter, assemblyDates, "Dates");
        setOptions(packingDateFilter, packingDates, "Dates");

        if (lotFilter) {
            const current = lotFilter.value;
            lotFilter.innerHTML = `<option value="all">All Lots</option>`;
            [...lotValues].sort((a, b) => Number(a) - Number(b)).forEach((lot) => {
                lotFilter.appendChild(new Option(`Lot ${lot}`, lot));
            });
            lotFilter.value = [...lotFilter.options].some((option) => option.value === current) ? current : "all";
        }
    }

    function renderFoodPrep(target, state, selectedDate) {
        const dates = selectedDate !== "all" ? [selectedDate] : Object.keys(state.lrByDate).sort().filter((date) => date >= "2026-03-25");
        const shifts = dates.flatMap((date) => (state.lrByDate[date] || []).map((shift) => ({ date, shift })))
            .filter(({ shift }) => (shift.food_prep?.tasks || []).length);
        const tasks = shifts.flatMap(({ shift }) => shift.food_prep.tasks || []);
        const menus = [...new Set(tasks.map((task) => cleanProduct(task.menu)).filter(Boolean))];
        const components = [...new Set(tasks.map((task) => task.component).filter(Boolean))];
        const sections = [...new Set(tasks.map((task) => task.section).filter(Boolean))];
        const totalKg = tasks.reduce((sum, task) => sum + Number(task.kg_output || 0), 0);
        const avgDuration = tasks.length ? tasks.reduce((sum, task) => sum + Number(task.duration_min || 0), 0) / tasks.length : 0;
        const rates = tasks.map((task) => Number(task.kg_man_hr || 0)).filter((value) => value > 0);
        const avgRate = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : 0;

        const rowsHtml = selectedDate === "all"
            ? dates.map((date) => {
                const dateShifts = (state.lrByDate[date] || []).filter((shift) => (shift.food_prep?.tasks || []).length);
                if (!dateShifts.length) return "";
                const dateTasks = dateShifts.flatMap((shift) => shift.food_prep.tasks || []);
                return `
                    <tr>
                        <td>${trialDateLabel(date)}</td>
                        <td style="text-align:right">${formatNumber(dateShifts.length)}</td>
                        <td style="text-align:right">${formatNumber(dateTasks.length)}</td>
                        <td style="text-align:right">${dateTasks.reduce((sum, task) => sum + Number(task.kg_output || 0), 0).toFixed(1)}</td>
                        <td style="text-align:right">${STAGE_TOTAL_STAFF.foodPrep}</td>
                        <td style="text-align:right">${formatNumber(new Set(dateTasks.map((task) => cleanProduct(task.menu)).filter(Boolean)).size)}</td>
                    </tr>
                `;
            }).join("")
            : shifts.map(({ shift }) => `
                <tr>
                    <td>${escapeHtml(shift.shift_type)} Shift</td>
                    <td style="text-align:right">${formatNumber(shift.food_prep?.tasks?.length || 0)}</td>
                    <td style="text-align:right">${Number(shift.food_prep?.summary?.total_kg_output || 0).toFixed(1)}</td>
                    <td style="text-align:right">${STAGE_TOTAL_STAFF.foodPrep}</td>
                    <td>${escapeHtml((shift.food_prep?.summary?.menus || []).map(cleanProduct).filter(Boolean).slice(0, 3).join(", ") || "—")}</td>
                </tr>
            `).join("");

        const shiftSplitHtml = selectedDate !== "all"
            ? buildShiftCompareGrid(shifts, sh => sh.food_prep?.tasks || [], sh => sh.food_prep?.summary || {}, STAGE_TOTAL_STAFF.foodPrep)
            : "";

        target.innerHTML = shiftSplitHtml + `
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Total Prep Output", tasks.length ? `${totalKg.toFixed(1)} kg` : "N/A", `${formatNumber(tasks.length)} prep tasks in view`)}
                ${buildKpiCard("Total Staff", STAGE_TOTAL_STAFF.foodPrep, "Fixed batching headcount for the Stage 2 trial view")}
                ${buildKpiCard("Menus Prepped", menus.length || "N/A", menus.slice(0, 3).map((menu) => escapeHtml(menu)).join(", ") || "No menu names recorded")}
            </div>
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Avg Task Duration", tasks.length ? formatMinutes(avgDuration) : "N/A", "Calculated from LR task timings")}
                ${buildKpiCard("Avg Productivity", avgRate > 0 ? `${avgRate.toFixed(1)} kg/man/hr` : "N/A", "Average across populated LR rows")}
                ${buildKpiCard("Component Coverage", components.length || "N/A", `${sections.length || 0} prep section${sections.length === 1 ? "" : "s"} represented`)}
            </div>
            ${components.length ? buildPanel("Component Mix", `${components.length} components captured`, `<div class="pfx-tag-row">${components.slice(0, 10).map((component) => `<span class="pfx-tag">${escapeHtml(component)}</span>`).join("")}</div>`) : ""}
            ${buildPanel(selectedDate === "all" ? "Date Summary" : "Shift Summary", selectedDate === "all" ? "Historical LR food-prep trial dates" : `${trialDateLabel(selectedDate)} selected`, buildTable(selectedDate === "all" ? ["Date", "<span style=\"display:block;text-align:right\">Shifts</span>", "<span style=\"display:block;text-align:right\">Tasks</span>", "<span style=\"display:block;text-align:right\">Output Kg</span>", "<span style=\"display:block;text-align:right\">Total Staff</span>", "<span style=\"display:block;text-align:right\">Menus</span>"] : ["Shift", "<span style=\"display:block;text-align:right\">Tasks</span>", "<span style=\"display:block;text-align:right\">Output Kg</span>", "<span style=\"display:block;text-align:right\">Total Staff</span>", "Menus"], rowsHtml, "No food-prep data available for the selected trial date."))}
        `;
    }

    function renderCooking(target, state, selectedDate) {
        const dates = selectedDate !== "all" ? [selectedDate] : Object.keys(state.lrByDate).sort().filter((date) => date >= "2026-03-25");
        const shifts = dates.flatMap((date) => (state.lrByDate[date] || []).map((shift) => ({ date, shift })))
            .filter(({ shift }) => (shift.cooking?.tasks || []).length);
        const tasks = shifts.flatMap(({ shift }) => shift.cooking.tasks || []);
        const menus = [...new Set(tasks.map((task) => cleanProduct(task.menu)).filter(Boolean))];
        const totalKg = tasks.reduce((sum, task) => sum + Number(task.kg_output || 0), 0);
        const avgDuration = tasks.length ? tasks.reduce((sum, task) => sum + Number(task.duration_min || 0), 0) / tasks.length : 0;
        const rates = tasks.map((task) => Number(task.kg_man_hr || 0)).filter((value) => value > 0);
        const avgRate = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : 0;
        const machineTotals = {};
        tasks.forEach((task) => {
            Object.entries(task.machines || {}).forEach(([machine, mins]) => {
                machineTotals[machine] = (machineTotals[machine] || 0) + Number(mins || 0);
            });
        });
        const topMachines = Object.entries(machineTotals).sort((a, b) => b[1] - a[1]).slice(0, 8);

        const rowsHtml = selectedDate === "all"
            ? dates.map((date) => {
                const dateShifts = (state.lrByDate[date] || []).filter((shift) => (shift.cooking?.tasks || []).length);
                if (!dateShifts.length) return "";
                const dateTasks = dateShifts.flatMap((shift) => shift.cooking.tasks || []);
                return `
                    <tr>
                        <td>${trialDateLabel(date)}</td>
                        <td style="text-align:right">${formatNumber(dateShifts.length)}</td>
                        <td style="text-align:right">${formatNumber(dateTasks.length)}</td>
                        <td style="text-align:right">${dateTasks.reduce((sum, task) => sum + Number(task.kg_output || 0), 0).toFixed(1)}</td>
                        <td style="text-align:right">${STAGE_TOTAL_STAFF.cooking}</td>
                        <td style="text-align:right">${formatNumber(new Set(dateTasks.map((task) => cleanProduct(task.menu)).filter(Boolean)).size)}</td>
                    </tr>
                `;
            }).join("")
            : shifts.map(({ shift }) => `
                <tr>
                    <td>${escapeHtml(shift.shift_type)} Shift</td>
                    <td style="text-align:right">${formatNumber(shift.cooking?.tasks?.length || 0)}</td>
                    <td style="text-align:right">${Number(shift.cooking?.summary?.total_kg_output || 0).toFixed(1)}</td>
                    <td style="text-align:right">${STAGE_TOTAL_STAFF.cooking}</td>
                    <td>${escapeHtml((shift.cooking?.summary?.menus || []).map(cleanProduct).filter(Boolean).slice(0, 3).join(", ") || "—")}</td>
                </tr>
            `).join("");

        const cookShiftSplitHtml = selectedDate !== "all"
            ? buildShiftCompareGrid(shifts, sh => sh.cooking?.tasks || [], sh => sh.cooking?.summary || {}, STAGE_TOTAL_STAFF.cooking)
            : "";

        target.innerHTML = cookShiftSplitHtml + `
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Total Cooked Weight", tasks.length ? `${totalKg.toFixed(1)} kg` : "N/A", `${formatNumber(tasks.length)} cooking tasks in view`)}
                ${buildKpiCard("Total Staff", STAGE_TOTAL_STAFF.cooking, "Fixed low-risk cooking/prep headcount for the Stage 2 trial view")}
                ${buildKpiCard("Menus Cooked", menus.length || "N/A", menus.slice(0, 3).map((menu) => escapeHtml(menu)).join(", ") || "No menu names recorded")}
            </div>
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Avg Batch Duration", tasks.length ? formatMinutes(avgDuration) : "N/A", "Calculated from LR cooking timings")}
                ${buildKpiCard("Avg Productivity", avgRate > 0 ? `${avgRate.toFixed(1)} kg/man/hr` : "N/A", "Average across populated LR rows")}
                ${buildKpiCard("Machine Minutes", topMachines.length ? `${formatNumber(topMachines.reduce((sum, [, mins]) => sum + mins, 0))} min` : "N/A", `${topMachines.length} machine type${topMachines.length === 1 ? "" : "s"} captured`)}
            </div>
            ${topMachines.length ? buildPanel("Top Machines Used", `${topMachines.length} machine types populated`, `<div class="pfx-tag-row">${topMachines.map(([machine, mins]) => `<span class="pfx-tag">${escapeHtml(machine)} <span class="pfx-tag__sep">·</span> <strong>${formatNumber(mins)} min</strong></span>`).join("")}</div>`) : ""}
            ${selectedDate !== "all" ? buildMachineByMenuPanel(tasks) : ""}
            ${buildPanel(selectedDate === "all" ? "Date Summary" : "Shift Summary", selectedDate === "all" ? "Historical LR cooking trial dates" : `${trialDateLabel(selectedDate)} selected`, buildTable(selectedDate === "all" ? ["Date", "<span style=\"display:block;text-align:right\">Shifts</span>", "<span style=\"display:block;text-align:right\">Tasks</span>", "<span style=\"display:block;text-align:right\">Output Kg</span>", "<span style=\"display:block;text-align:right\">Total Staff</span>", "<span style=\"display:block;text-align:right\">Menus</span>"] : ["Shift", "<span style=\"display:block;text-align:right\">Tasks</span>", "<span style=\"display:block;text-align:right\">Output Kg</span>", "<span style=\"display:block;text-align:right\">Total Staff</span>", "Menus"], rowsHtml, "No cooking data available for the selected trial date."))}
        `;
    }

    function buildLineComparisonPanel(hrDay) {
        if (!hrDay || !hrDay.batches || !hrDay.batches.length) return "";
        const lineMap = {};
        hrDay.batches.forEach(b => {
            const line = (b.line || "Unknown").trim();
            if (!lineMap[line]) lineMap[line] = { batches: 0, staffSum: 0, staffCount: 0, durSum: 0, durCount: 0 };
            lineMap[line].batches++;
            if (b.staff) { lineMap[line].staffSum += Number(b.staff); lineMap[line].staffCount++; }
            if (b.duration_min) { lineMap[line].durSum += Number(b.duration_min); lineMap[line].durCount++; }
        });
        const lines = Object.keys(lineMap).sort();
        if (lines.length < 2) return "";
        const rows = lines.map(line => {
            const d = lineMap[line];
            const avgStaff = d.staffCount ? (d.staffSum / d.staffCount).toFixed(1) : "—";
            const totalMin = d.durCount ? formatNumber(d.durSum) : "—";
            return `<tr>
                <td>${escapeHtml(line)}</td>
                <td style="text-align:right">${d.batches}</td>
                <td style="text-align:right">${avgStaff}</td>
                <td style="text-align:right">${totalMin}</td>
            </tr>`;
        }).join("");
        return buildPanel("Line Comparison", `${lines.length} assembly lines active`, buildTable(
            ["Line", '<span style="display:block;text-align:right">Batches</span>', '<span style="display:block;text-align:right">Avg Staff</span>', '<span style="display:block;text-align:right">Total Timed Min</span>'],
            rows, "No line data available."
        ));
    }

    function buildWaitEventsPanel(hrDay) {
        if (!hrDay || !hrDay.batches || !hrDay.batches.length) return "";
        const waitPattern = /waiting.*?(\d+)\s*min/i;
        const events = [];
        hrDay.batches.forEach(b => {
            if (!b.remark) return;
            const m = b.remark.match(waitPattern);
            if (m) {
                events.push({
                    batch: b.batch_no || "—",
                    line: (b.line || "—").trim(),
                    product: cleanProduct(b.product || b.menu || ""),
                    remark: b.remark,
                    minutes: Number(m[1])
                });
            }
        });
        if (!events.length) return "";
        const totalMin = events.reduce((s, e) => s + e.minutes, 0);
        const rows = events.map(e => `<tr>
            <td>${escapeHtml(e.line)}</td>
            <td>${escapeHtml(e.product)}</td>
            <td>${escapeHtml(e.remark)}</td>
            <td style="text-align:right;color:var(--amber);font-weight:600">${e.minutes} min</td>
        </tr>`).join("");
        return buildPanel(
            "Wait Events",
            `${events.length} wait event${events.length > 1 ? "s" : ""} · <strong>${totalMin} min total</strong> lost`,
            buildTable(
                ["Line", "Product", "Remark", '<span style="display:block;text-align:right">Wait (min)</span>'],
                rows, "No wait events found."
            )
        );
    }

    function buildAssemblyLossBreakdownPanel(selectedDay, selectedLot) {
        if (!selectedDay || !selectedDay.products || !selectedDay.products.length) return "";
        const products = selectedDay.products.filter((product) => matchesLot(product.lot, selectedLot));
        if (!products.length) return "";

        const totalAssemblyMin = products.reduce((sum, product) => sum + Number(product.assembly_min || 0), 0);
        const totalSetupMin = products.reduce((sum, product) => sum + Number(product.setup_min || 0), 0);
        const totalBakeDownMin = products.reduce((sum, product) => sum + Number(product.bake_down_min || 0), 0);
        const rateRows = products
            .filter((product) => product.actual_rate !== null && product.actual_rate !== undefined && product.planned_rate !== null && product.planned_rate !== undefined)
            .map((product) => ({
                ...product,
                rateGap: Number(product.planned_rate || 0) - Number(product.actual_rate || 0),
            }));
        const largestGap = rateRows.length
            ? rateRows.reduce((worst, product) => (product.rateGap > worst.rateGap ? product : worst), rateRows[0])
            : null;

        const rows = products.map((product) => {
            const gap = product.actual_rate !== null && product.actual_rate !== undefined && product.planned_rate !== null && product.planned_rate !== undefined
                ? Number(product.planned_rate || 0) - Number(product.actual_rate || 0)
                : null;
            return `
                <tr>
                    <td>${escapeHtml(cleanProduct(product.name) || "—")}</td>
                    <td>${escapeHtml(product.lot || "—")}</td>
                    <td style="text-align:right">${product.assembly_min ? formatNumber(product.assembly_min) : "—"}</td>
                    <td style="text-align:right">${product.setup_min ? formatNumber(product.setup_min) : "0"}</td>
                    <td style="text-align:right">${product.bake_down_min ? formatNumber(product.bake_down_min) : "0"}</td>
                    <td style="text-align:right">${product.planned_rate !== null && product.planned_rate !== undefined ? Number(product.planned_rate).toFixed(1) : "—"}</td>
                    <td style="text-align:right">${product.actual_rate !== null && product.actual_rate !== undefined ? Number(product.actual_rate).toFixed(1) : "—"}</td>
                    <td style="text-align:right;color:${gap !== null && gap > 0 ? "var(--amber)" : "var(--text)"};font-weight:${gap !== null && gap > 0 ? "700" : "400"}">${gap !== null ? gap.toFixed(1) : "—"}</td>
                </tr>
            `;
        }).join("");

        return buildPanel(
            "Assembly Loss Breakdown",
            `${trialDateLabel(selectedDay.date)} selected${selectedLot !== "all" ? ` · Lot ${selectedLot} filter applied` : ""}`,
            `
                <div class="pfx-kpi-grid pfx-kpi-grid--four">
                    ${buildKpiCard("Timed Assembly", totalAssemblyMin ? formatMinutes(totalAssemblyMin) : "N/A", "Pure assembly minutes from the trial summary")}
                    ${buildKpiCard("Setup Minutes", totalSetupMin ? formatMinutes(totalSetupMin) : "0 min", "Recorded setup time outside pure assembly")}
                    ${buildKpiCard("Bake-Down / Wait", totalBakeDownMin ? formatMinutes(totalBakeDownMin) : "0 min", "Recorded bake-down or wait loss minutes")}
                    ${buildKpiCard("Largest Rate Gap", largestGap ? `${largestGap.rateGap.toFixed(1)} t/min` : "N/A", largestGap ? cleanProduct(largestGap.name) : "No rate comparison available")}
                </div>
                ${buildTable(
                    ["Product", "Lot", '<span style="display:block;text-align:right">Assembly Min</span>', '<span style="display:block;text-align:right">Setup Min</span>', '<span style="display:block;text-align:right">Bake-Down Min</span>', '<span style="display:block;text-align:right">Plan Rate</span>', '<span style="display:block;text-align:right">Actual Rate</span>', '<span style="display:block;text-align:right">Gap</span>'],
                    rows,
                    "No assembly loss rows available."
                )}
            `
        );
    }

    function renderAssembly(target, state, selectedDate, selectedLot) {
        const days = selectedDate !== "all"
            ? (state.dayByDate[selectedDate] ? [state.dayByDate[selectedDate]] : [])
            : (state.data.days || []);
        const filteredDays = days.map((day) => ({
            ...day,
            products: (day.products || []).filter((product) => matchesLot(product.lot, selectedLot)),
        })).filter((day) => day.products.length || selectedLot === "all");

        const totalOrdered = filteredDays.reduce((sum, day) => sum + day.products.reduce((inner, product) => inner + Number(product.ordered || 0), 0), 0);
        const totalAssembled = filteredDays.reduce((sum, day) => sum + day.products.reduce((inner, product) => inner + Number(product.assembled || 0), 0), 0);
        const validOeeDays = filteredDays.filter((day) => day.oee?.pct != null);
        const avgOee = validOeeDays.length ? validOeeDays.reduce((sum, day) => sum + Number(day.oee.pct || 0), 0) / validOeeDays.length : null;
        const avgOle = validOeeDays.length ? validOeeDays.reduce((sum, day) => sum + Number(day.ole?.pct || 0), 0) / validOeeDays.length : null;
        const totalProducts = filteredDays.reduce((sum, day) => sum + day.products.length, 0);
        const attainment = totalOrdered > 0 ? (totalAssembled / totalOrdered) * 100 : null;
        const selectedDay = selectedDate !== "all" ? state.dayByDate[selectedDate] : null;
        const productRows = selectedDay
            ? (selectedDay.products || []).filter((product) => matchesLot(product.lot, selectedLot)).map((product) => `
                <tr>
                    <td>${escapeHtml(product.name)}</td>
                    <td>${escapeHtml(product.lot || "—")}</td>
                    <td style="text-align:right">${formatNumber(product.ordered || 0)}</td>
                    <td style="text-align:right">${formatNumber(product.assembled || 0)}</td>
                    <td style="text-align:right">${product.attainment_pct != null ? pct(product.attainment_pct) : "N/A"}</td>
                    <td style="text-align:right">${product.oee_pct != null ? pct(product.oee_pct) : "N/A"}</td>
                    <td>${product.start && product.stop ? `${escapeHtml(product.start)} - ${escapeHtml(product.stop)}` : "—"}</td>
                </tr>
            `).join("")
            : "";
        const summaryRows = filteredDays.map((day) => {
            const ordered = day.products.reduce((sum, product) => sum + Number(product.ordered || 0), 0);
            const assembled = day.products.reduce((sum, product) => sum + Number(product.assembled || 0), 0);
            return `
                <tr>
                    <td>${trialDateLabel(day.date)}</td>
                    <td style="text-align:right">${formatNumber(ordered)}</td>
                    <td style="text-align:right">${formatNumber(assembled)}</td>
                    <td style="text-align:right">${ordered > 0 ? pct((assembled / ordered) * 100) : "N/A"}</td>
                    <td style="text-align:right">${day.oee?.pct != null ? pct(day.oee.pct) : "N/A"}</td>
                    <td style="text-align:right">${day.ole?.pct != null ? pct(day.ole.pct) : "N/A"}</td>
                    <td>${escapeHtml([...new Set(day.products.flatMap((product) => splitLots(product.lot)))].join(", ") || "—")}</td>
                </tr>
            `;
        }).join("");

        target.innerHTML = `
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Meals Assembled", totalAssembled ? formatNumber(totalAssembled) : "N/A", `${formatNumber(totalProducts)} product run${totalProducts === 1 ? "" : "s"} in view`)}
                ${buildKpiCard("Target Meals", totalOrdered ? formatNumber(totalOrdered) : "N/A", "Ordered meals from the trial summary")}
                ${buildKpiCard("Attainment", attainment != null ? pct(attainment) : "N/A", selectedLot !== "all" ? `Lot ${escapeHtml(selectedLot)} filter applied` : "Assembled versus ordered meals")}
            </div>
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Average OEE", avgOee != null ? pct(avgOee) : "N/A", "Available for 26-28 Mar where timing exists")}
                ${buildKpiCard("Average OLE", avgOle != null ? pct(avgOle) : "N/A", "Activation x utilisation x productivity model")}
                ${buildKpiCard("Assigned High Risk Staff", STAGE_TOTAL_STAFF.assembly, "Fixed high-risk assembly headcount for the Stage 2 trial view")}
            </div>
            ${buildProgress("Assembled vs Target", attainment, totalOrdered > 0 ? `${formatNumber(totalAssembled)} assembled against ${formatNumber(totalOrdered)} ordered meals.` : "No ordered-meal target available.")}
            ${selectedDate !== "all" ? buildAssemblyLossBreakdownPanel(state.dayByDate[selectedDate], selectedLot) : ""}
            ${selectedDate !== "all" ? buildLineComparisonPanel(state.hrByDate[selectedDate]) : ""}
            ${selectedDate !== "all" ? buildWaitEventsPanel(state.hrByDate[selectedDate]) : ""}
            ${buildPanel(selectedDate === "all" ? "Trial Day Summary" : `Product Summary For ${trialDateLabel(selectedDate)}`, selectedDate === "all" ? "Historical assembly KPI rollup" : `${(selectedDay?.products || []).filter((product) => matchesLot(product.lot, selectedLot)).length} products scheduled`, buildTable(selectedDate === "all" ? ["Date", "<span style=\"display:block;text-align:right\">Ordered</span>", "<span style=\"display:block;text-align:right\">Assembled</span>", "<span style=\"display:block;text-align:right\">Attainment</span>", "<span style=\"display:block;text-align:right\">OEE</span>", "<span style=\"display:block;text-align:right\">OLE</span>", "Lots"] : ["Product", "Lot", "<span style=\"display:block;text-align:right\">Ordered</span>", "<span style=\"display:block;text-align:right\">Assembled</span>", "<span style=\"display:block;text-align:right\">Attainment</span>", "<span style=\"display:block;text-align:right\">OEE</span>", "Run Time"], selectedDate === "all" ? summaryRows : productRows, "No assembly records found for the selected view."))}
            ${selectedDate !== "all" && selectedDay?.note ? `<p class="section-note">${escapeHtml(selectedDay.note)}</p>` : ""}
        `;
    }

    function renderPacking(target, state, selectedDate, selectedLot) {
        const days = selectedDate !== "all"
            ? (state.mrByDate[selectedDate] ? [state.mrByDate[selectedDate]] : [])
            : Object.values(state.mrByDate).sort((a, b) => String(a.packing_date).localeCompare(String(b.packing_date)));
        const filteredDays = days.map((day) => ({
            ...day,
            sessions: (day.sessions || []).filter((session) => matchesLot(session.lot, selectedLot)),
        })).filter((day) => day.sessions.length || selectedLot === "all");
        const sessions = filteredDays.flatMap((day) => day.sessions || []);
        const totalMeals = sessions.reduce((sum, session) => sum + Number(session.meals || 0), 0);
        const totalCartons = sessions.reduce((sum, session) => sum + Number(session.cartons || 0), 0);
        const totalPcs = sessions.reduce((sum, session) => sum + Number(session.pcs || 0), 0);
        const rates = sessions.map((session) => Number(session.meal_man_hr || 0)).filter((value) => value > 0);
        const avgRate = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : 0;
        const selectedDay = selectedDate !== "all" ? state.mrByDate[selectedDate] : null;

        const sessionRows = selectedDay
            ? (selectedDay.sessions || []).filter((session) => matchesLot(session.lot, selectedLot)).map((session) => `
                <tr>
                    <td>${escapeHtml(session.section || "—")}</td>
                    <td>${escapeHtml(cleanProduct(session.menu) || "—")}</td>
                    <td>${escapeHtml(session.lot || "—")}</td>
                    <td style="text-align:right">${session.meals ? formatNumber(session.meals) : "—"}</td>
                    <td style="text-align:right">${session.cartons ? formatNumber(session.cartons) : "—"}</td>
                    <td style="text-align:right">${session.workers || "—"}</td>
                    <td>${session.start && session.stop ? `${escapeHtml(session.start)} - ${escapeHtml(session.stop)}` : "—"}</td>
                    <td style="text-align:right">${session.meal_man_hr ? Number(session.meal_man_hr).toFixed(1) : "—"}</td>
                </tr>
            `).join("")
            : "";

        const summaryRows = filteredDays.map((day) => {
            const dayMeals = day.sessions.reduce((sum, session) => sum + Number(session.meals || 0), 0);
            const dayCartons = day.sessions.reduce((sum, session) => sum + Number(session.cartons || 0), 0);
            const dayRates = day.sessions.map((session) => Number(session.meal_man_hr || 0)).filter((value) => value > 0);
            const dayAvgRate = dayRates.length ? dayRates.reduce((sum, value) => sum + value, 0) / dayRates.length : 0;
            return `
                <tr>
                    <td>${trialDateLabel(day.packing_date)}</td>
                    <td style="text-align:right">${formatNumber(day.sessions.length)}</td>
                    <td style="text-align:right">${formatNumber(dayMeals)}</td>
                    <td style="text-align:right">${formatNumber(dayCartons)}</td>
                    <td style="text-align:right">${dayAvgRate ? dayAvgRate.toFixed(1) : "N/A"}</td>
                    <td>${escapeHtml([...new Set(day.sessions.map((session) => normalizeLot(session.lot)).filter(Boolean))].join(", ") || "—")}</td>
                </tr>
            `;
        }).join("");

        // Productivity spread — fastest / slowest session in view
        const ratedSessions = sessions.filter(s => s.meal_man_hr);
        const fastestS = ratedSessions.length ? ratedSessions.reduce((a,b) => b.meal_man_hr > a.meal_man_hr ? b : a) : null;
        const slowestS = ratedSessions.length ? ratedSessions.reduce((a,b) => b.meal_man_hr < a.meal_man_hr ? b : a) : null;
        const spreadHtml = ratedSessions.length >= 2 ? buildPanel(
            "Productivity Spread",
            `${ratedSessions.length} sessions with rate data · range ${slowestS.meal_man_hr.toFixed(1)}–${fastestS.meal_man_hr.toFixed(1)} meal/man/hr`,
            `<div class="pfx-spread-grid">
                <div class="pfx-spread-card pfx-spread-card--fast">
                    <p class="pfx-spread-card__label">Fastest Session</p>
                    <p class="pfx-spread-card__val">${fastestS.meal_man_hr.toFixed(1)} <span>meal/mhr</span></p>
                    <p class="pfx-spread-card__detail">${escapeHtml(cleanProduct(fastestS.menu) || fastestS.section || "—")} · Lot ${escapeHtml(normalizeLot(fastestS.lot) || "—")} · ${fastestS.workers || "—"} workers</p>
                </div>
                <div class="pfx-spread-card pfx-spread-card--slow">
                    <p class="pfx-spread-card__label">Slowest Session</p>
                    <p class="pfx-spread-card__val">${slowestS.meal_man_hr.toFixed(1)} <span>meal/mhr</span></p>
                    <p class="pfx-spread-card__detail">${escapeHtml(cleanProduct(slowestS.menu) || slowestS.section || "—")} · Lot ${escapeHtml(normalizeLot(slowestS.lot) || "—")} · ${slowestS.workers || "—"} workers</p>
                </div>
            </div>`
        ) : "";

        target.innerHTML = `
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Total Output", totalMeals ? `${formatNumber(totalMeals)} meals` : "N/A", `${formatNumber(sessions.length)} packing session${sessions.length === 1 ? "" : "s"} in view`)}
                ${buildKpiCard("Total Cartons Packed", totalCartons ? formatNumber(totalCartons) : "N/A", "Cartons captured in MR sessions")}
                ${buildKpiCard("Total Pcs Formed", totalPcs ? formatNumber(totalPcs) : "N/A", "Most trial MR rows do not populate pcs")}
            </div>
            <div class="pfx-kpi-grid pfx-kpi-grid--three">
                ${buildKpiCard("Average Productivity", avgRate > 0 ? `${avgRate.toFixed(1)} meal/man/hr` : "N/A", "Average across populated session rows")}
                ${buildKpiCard("Assigned Medium Risk Staff", STAGE_TOTAL_STAFF.packing, "Fixed medium-risk packing headcount for the Stage 2 trial view")}
                ${buildKpiCard("Lots In View", sessions.length ? formatNumber(new Set(sessions.map((session) => normalizeLot(session.lot)).filter(Boolean)).size) : "N/A", selectedDate !== "all" ? `${trialDateLabel(selectedDate)} selected` : "All available packing dates")}
            </div>
            ${spreadHtml}
            ${buildPanel(selectedDate === "all" ? "Packing Day Summary" : `Session Summary For ${trialDateLabel(selectedDate)}`, selectedDate === "all" ? "Historical MR packing rollup · Packing date = spiral freezer run date, typically one day after assembly" : `${(selectedDay?.sessions || []).filter((session) => matchesLot(session.lot, selectedLot)).length} sessions on selected date`, buildTable(selectedDate === "all" ? ["Date", "<span style=\"display:block;text-align:right\">Sessions</span>", "<span style=\"display:block;text-align:right\">Meals</span>", "<span style=\"display:block;text-align:right\">Cartons</span>", "<span style=\"display:block;text-align:right\">Avg Productivity</span>", "Lots"] : ["Section", "Menu", "Lot", "<span style=\"display:block;text-align:right\">Meals</span>", "<span style=\"display:block;text-align:right\">Cartons</span>", "<span style=\"display:block;text-align:right\">Workers</span>", "Time", "<span style=\"display:block;text-align:right\">Meal/Man/Hr</span>"], selectedDate === "all" ? summaryRows : sessionRows, "No packing records found for the selected view."))}
        `;
    }

    function renderDetailTable(currentStage, state, selectedDate, selectedLot) {
        const card = document.getElementById("pfxProcessDataCard");
        const table = document.getElementById("pfxProcessDataTable");
        if (!card || !table) return;

        const shouldShow =
            ((currentStage === "food-prep" || currentStage === "cooking") && selectedDate !== "all") ||
            (currentStage === "assembly" && selectedDate !== "all") ||
            (currentStage === "packing" && selectedDate !== "all");

        card.hidden = !shouldShow;
        if (!shouldShow) return;

        if (currentStage === "food-prep") {
            const rows = ((state.lrByDate[selectedDate] || []).flatMap((shift) => shift.food_prep?.tasks || []));
            updateProcessTableHeader("Production Report Detail", "Food Prep Task Table", `Detailed LR task rows for ${trialDateLabel(selectedDate)}.`);
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Time</th><th>Menu / Component</th><th>Dimension</th><th style="text-align:right">Workers</th><th style="text-align:right">Kg</th><th style="text-align:right">Kg / Man / Hr</th><th>Machines</th>
                    </tr>
                </thead>
                <tbody>${rows.map((task) => `
                    <tr>
                        <td>${escapeHtml(task.start || "—")} - ${escapeHtml(task.stop || "—")}</td>
                        <td><strong>${escapeHtml(cleanProduct(task.menu) || "—")}</strong><span>${escapeHtml(task.component || "—")}</span></td>
                        <td>${escapeHtml(task.dimension || "—")}</td>
                        <td style="text-align:right">${task.workers || "—"}</td>
                        <td style="text-align:right">${task.kg_output ? Number(task.kg_output).toFixed(1) : "—"}</td>
                        <td style="text-align:right">${task.kg_man_hr ? Number(task.kg_man_hr).toFixed(1) : "—"}</td>
                        <td>${escapeHtml(Object.entries(task.machines || {}).map(([name, mins]) => `${name} (${mins}m)`).join(", ") || "—")}</td>
                    </tr>
                `).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--text-soft);padding:24px">No food-prep rows available for the selected date.</td></tr>`}</tbody>
            `;
            return;
        }

        if (currentStage === "cooking") {
            const rows = ((state.lrByDate[selectedDate] || []).flatMap((shift) => shift.cooking?.tasks || []));
            updateProcessTableHeader("Production Report Detail", "Cooking Task Table", `Detailed LR cooking rows for ${trialDateLabel(selectedDate)}.`);
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Time</th><th>Menu / Component</th><th>Dimension</th><th style="text-align:right">Workers</th><th style="text-align:right">Kg</th><th style="text-align:right">Kg / Man / Hr</th><th>Machines</th>
                    </tr>
                </thead>
                <tbody>${rows.map((task) => `
                    <tr>
                        <td>${escapeHtml(task.start || "—")} - ${escapeHtml(task.stop || "—")}</td>
                        <td><strong>${escapeHtml(cleanProduct(task.menu) || "—")}</strong><span>${escapeHtml(task.component || "—")}</span></td>
                        <td>${escapeHtml(task.dimension || "—")}</td>
                        <td style="text-align:right">${task.workers || "—"}</td>
                        <td style="text-align:right">${task.kg_output ? Number(task.kg_output).toFixed(1) : "—"}</td>
                        <td style="text-align:right">${task.kg_man_hr ? Number(task.kg_man_hr).toFixed(1) : "—"}</td>
                        <td>${escapeHtml(Object.entries(task.machines || {}).map(([name, mins]) => `${name} (${mins}m)`).join(", ") || "—")}</td>
                    </tr>
                `).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--text-soft);padding:24px">No cooking rows available for the selected date.</td></tr>`}</tbody>
            `;
            return;
        }

        if (currentStage === "assembly") {
            const hrDay = state.hrByDate[selectedDate];
            const rows = (hrDay?.batches || []).filter((batch) => matchesLot(batch.lot || "", selectedLot));
            updateProcessTableHeader("Production Report Detail", "Assembly Production Table", `Detailed HR batch rows for ${trialDateLabel(selectedDate)}.${selectedLot !== "all" ? ` Lot ${selectedLot} filter applied.` : ""}`);
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Date</th><th>Product</th><th>Batch</th><th style="text-align:right">Target</th><th style="text-align:right">Staff</th><th>Time</th><th>Duration</th><th>Line</th><th>Remark</th>
                    </tr>
                </thead>
                <tbody>${rows.map((batch) => `
                    <tr>
                        <td>${trialDateLabel(selectedDate)}</td>
                        <td>${escapeHtml(cleanProduct(batch.product) || "—")}</td>
                        <td>${escapeHtml(batch.batch_no || "—")}</td>
                        <td style="text-align:right">${batch.target ? formatNumber(batch.target) : "—"}</td>
                        <td style="text-align:right">${batch.staff || "—"}</td>
                        <td>${batch.start && batch.stop ? `${escapeHtml(batch.start)} → ${escapeHtml(batch.stop)}` : "—"}</td>
                        <td>${batch.duration_min ? formatMinutes(batch.duration_min) : "—"}</td>
                        <td>${escapeHtml(batch.line || "—")}</td>
                        <td>${escapeHtml(batch.remark || "—")}</td>
                    </tr>
                `).join("") || `<tr><td colspan="9" style="text-align:center;color:var(--text-soft);padding:24px">No batch-level timing rows are available for ${trialDateLabel(selectedDate)}${selectedDate === "2026-03-25" ? " because timing was not captured in the source file." : "."}</td></tr>`}</tbody>
            `;
            return;
        }

        const mrDay = state.mrByDate[selectedDate];
        const rows = (mrDay?.sessions || []).filter((session) => matchesLot(session.lot, selectedLot));
        updateProcessTableHeader("Production Report Detail", "Packing Session Table", `Detailed MR session rows for ${trialDateLabel(selectedDate)}.${selectedLot !== "all" ? ` Lot ${selectedLot} filter applied.` : ""}`);
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Section</th><th>Menu</th><th>Lot</th><th>No.</th><th style="text-align:right">Meals</th><th style="text-align:right">Cartons</th><th style="text-align:right">Workers</th><th>Time</th><th style="text-align:right">Meal/Man/Hr</th>
                </tr>
            </thead>
            <tbody>${rows.map((session) => `
                <tr>
                    <td>${escapeHtml(session.section || "—")}</td>
                    <td>${escapeHtml(cleanProduct(session.menu) || "—")}</td>
                    <td>${escapeHtml(session.lot || "—")}</td>
                    <td>${escapeHtml(session.no || "—")}</td>
                    <td style="text-align:right">${session.meals ? formatNumber(session.meals) : "—"}</td>
                    <td style="text-align:right">${session.cartons ? formatNumber(session.cartons) : "—"}</td>
                    <td style="text-align:right">${session.workers || "—"}</td>
                    <td>${session.start && session.stop ? `${escapeHtml(session.start)} → ${escapeHtml(session.stop)}` : "—"}</td>
                    <td style="text-align:right">${session.meal_man_hr ? Number(session.meal_man_hr).toFixed(1) : "—"}</td>
                </tr>
            `).join("") || `<tr><td colspan="9" style="text-align:center;color:var(--text-soft);padding:24px">No packing sessions found for the selected date and lot.</td></tr>`}</tbody>
        `;
    }

    function renderGantt(currentStage, state, selectedDate, selectedLot) {
        const staticCard = document.getElementById("pfxStaticGanttCard");
        const assemblyCard = document.getElementById("pfxAssemblyGanttCard");
        const packingCard = document.getElementById("pfxPackingGanttCard");
        const assemblyBody = document.getElementById("pfxGantt");
        const packingBody = document.getElementById("pfxPackingGantt");

        if (staticCard) staticCard.style.display = "none";
        if (assemblyCard) assemblyCard.style.display = "none";
        if (packingCard) packingCard.style.display = "none";

        if (currentStage === "assembly" && selectedDate !== "all") {
            const day = state.dayByDate[selectedDate];
            const products = (day?.products || []).filter((product) => matchesLot(product.lot, selectedLot) && product.start && product.stop);
            if (products.length && assemblyCard && assemblyBody) {
                assemblyBody.innerHTML = buildTimeline(products.map((product) => ({
                    label: cleanProduct(product.name) || "Product",
                    start: product.start,
                    stop: product.stop,
                    stat: `${formatNumber(product.assembled || 0)} meals`,
                    color: "#c8102e",
                    tip: `${product.name} | ${product.start} - ${product.stop} | ${formatNumber(product.assembled || 0)} meals`,
                })), "Output");
                assemblyCard.style.display = "";
            }
            return;
        }

        if (currentStage === "packing" && selectedDate !== "all") {
            const mrDay = state.mrByDate[selectedDate];
            const sessions = (mrDay?.sessions || []).filter((session) => matchesLot(session.lot, selectedLot) && session.start && session.stop);
            if (sessions.length && packingCard && packingBody) {
                packingBody.innerHTML = buildTimeline(sessions.map((session) => ({
                    label: `${normalizeLot(session.lot) ? `Lot ${normalizeLot(session.lot)} ` : ""}${cleanProduct(session.menu) || session.section || "Session"}`.trim(),
                    start: session.start,
                    stop: session.stop,
                    stat: session.meals ? `${formatNumber(session.meals)} meals` : `${session.cartons ? formatNumber(session.cartons) : "—"} ctn`,
                    color: session.section && session.section.toLowerCase().includes("stage 2") ? "#c8102e" : "#f59e0b",
                    tip: `${session.section || "Packing"} | ${session.start} - ${session.stop} | ${session.workers || "—"} workers`,
                })), "Output");
                packingCard.style.display = "";
            }
        }
    }

    function applyStageVisibility(currentStage, detailDate, packingDate) {
        const cards = {
            "food-prep": document.getElementById("pfxFoodPrepCard"),
            "cooking": document.getElementById("pfxCookingCard"),
            "assembly": document.getElementById("pfxAssemblyCard"),
            "packing": document.getElementById("pfxPackingCard"),
        };
        Object.entries(cards).forEach(([stageId, card]) => {
            if (card) card.hidden = stageId !== currentStage;
        });

        const buttons = [...(document.getElementById("processFlowHeader")?.querySelectorAll(".pfx-flow-step") || [])];
        buttons.forEach((button) => button.classList.toggle("is-active", button.dataset.stage === currentStage));

        const detailCard = document.getElementById("pfxProcessDataCard");
        if (detailCard) {
            detailCard.hidden = !(
                ((currentStage === "food-prep" || currentStage === "cooking" || currentStage === "assembly") && detailDate !== "all") ||
                (currentStage === "packing" && packingDate !== "all")
            );
        }
    }

    /* ── Cross-stage handoff panel ──────────────────────────────────────────── */
    function buildHandoffPanel(state) {
        const KG_PER_MEAL = 0.3;
        const dates = ["2026-03-25", "2026-03-26", "2026-03-27", "2026-03-28"];

        const rows = dates.map(date => {
            const lrShifts = state.lrByDate[date] || [];
            const prepKg   = lrShifts.reduce((s, sh) => s + sh.food_prep.summary.total_kg_output, 0);
            const cookKg   = lrShifts.reduce((s, sh) => s + sh.cooking.summary.total_kg_output, 0);

            const asmDay      = state.dayByDate[date];
            const totalAsm    = asmDay ? asmDay.products.reduce((s, p) => s + Number(p.assembled || 0), 0) : null;

            const mrDay       = state.mrByDate[date];
            const totalPack   = mrDay ? mrDay.sessions.reduce((s, sess) => s + Number(sess.meals || 0), 0) : null;

            const lots = [...new Set([
                ...(asmDay?.products || []).flatMap(p => splitLots(p.lot)),
                ...(mrDay?.sessions  || []).map(s => normalizeLot(s.lot)).filter(Boolean),
            ])].sort((a, b) => Number(a) - Number(b)).map(l => "Lot " + l).join(", ");

            const na = `<span style="color:var(--text-muted)">N/A</span>`;
            const prepCell = lrShifts.length ? `${prepKg.toFixed(0)} kg*`  : na;
            const cookCell = lrShifts.length ? `${cookKg.toFixed(0)} kg*`  : na;
            const asmCell  = totalAsm  !== null
                ? `${formatNumber(totalAsm)} meals<br><small style="color:var(--text-muted)">≈ ${formatNumber(Math.round(totalAsm  * KG_PER_MEAL))} kg est.</small>`
                : na;
            const packCell = totalPack !== null && totalPack > 0
                ? `${formatNumber(totalPack)} meals<br><small style="color:var(--text-muted)">≈ ${formatNumber(Math.round(totalPack * KG_PER_MEAL))} kg est.</small>`
                : na;

            return `
                <tr>
                    <td><strong>${trialDateLabel(date)}</strong></td>
                    <td>${prepCell}</td>
                    <td>${cookCell}</td>
                    <td>${asmCell}</td>
                    <td>${packCell}</td>
                    <td style="font-size:0.75rem;color:var(--text-soft)">${lots || "—"}</td>
                </tr>`;
        }).join("");

        return `
            <article class="card stack-gap" id="pfxHandoffCard">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Cross-Stage Flow</p>
                        <h2>Stage Handoff by Date</h2>
                        <p class="card__helper">Daily output across all stages. * Food Prep = ingredient weight only; Cooking = dish weight incl. sauces &amp; liquids. Assembly and Packing kg are estimated at 0.3 kg/meal.</p>
                    </div>
                </div>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Food Prep</th>
                                <th>Cooking</th>
                                <th>Assembly</th>
                                <th>Packing</th>
                                <th>Lots</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </article>`;
    }

    async function renderProcessFlow() {
        const data = await fetchTrialData();
        const state = buildState(data);
        const stageShell = document.querySelector(".pfx-stage-shell");
        const foodPrepBody = document.getElementById("pfxFoodPrepBody");
        const cookingBody = document.getElementById("pfxCookingBody");
        const assemblyBody = document.getElementById("pfxAssemblyBody");
        const packingBody = document.getElementById("pfxPackingBody");
        const flowHeader = document.getElementById("processFlowHeader");
        if (!stageShell || !foodPrepBody || !cookingBody || !assemblyBody || !packingBody || !flowHeader) return;

        const legacyTrialSection = document.getElementById("trialRunSection");
        if (legacyTrialSection) legacyTrialSection.remove();

        stageShell.style.display = "";
        applyTrialCopy(data);
        populateFilters(state);

        // Inject cross-stage handoff panel (remove any previous instance first)
        const prevHandoff = document.getElementById("pfxHandoffCard");
        if (prevHandoff) prevHandoff.remove();
        const processDataCard = document.getElementById("pfxProcessDataCard");
        if (processDataCard) processDataCard.insertAdjacentHTML("afterend", buildHandoffPanel(state));

        const foodPrepDateFilter = document.getElementById("pfxFoodPrepDateFilter");
        const cookingDateFilter = document.getElementById("pfxCookingDateFilter");
        const assemblyDateFilter = document.getElementById("pfxDateFilter");
        const packingDateFilter = document.getElementById("pfxPackingDateFilter");
        const lotFilter = document.getElementById("pfxLotFilter");

        let currentStage = "food-prep";

        const rebuild = () => {
            let prepDate = foodPrepDateFilter?.value || "all";
            let cookingDate = cookingDateFilter?.value || "all";
            let assemblyDate = assemblyDateFilter?.value || "all";
            let packingDate = packingDateFilter?.value || "all";
            const selectedLot = lotFilter?.value || "all";

            if (selectedLot !== "all") {
                const assemblyMatch = (state.data.days || []).find((day) => (day.products || []).some((product) => matchesLot(product.lot, selectedLot)));
                if (assemblyMatch && assemblyDateFilter && assemblyDateFilter.value !== assemblyMatch.date) {
                    assemblyDateFilter.value = assemblyMatch.date;
                    assemblyDate = assemblyMatch.date;
                }
                if (assemblyMatch && foodPrepDateFilter && [...foodPrepDateFilter.options].some((option) => option.value === assemblyMatch.date) && foodPrepDateFilter.value !== assemblyMatch.date) {
                    foodPrepDateFilter.value = assemblyMatch.date;
                    prepDate = assemblyMatch.date;
                }
                const packingMatch = Object.values(state.mrByDate).find((day) => (day.sessions || []).some((session) => matchesLot(session.lot, selectedLot)));
                if (packingMatch && packingDateFilter && packingDateFilter.value !== packingMatch.packing_date) {
                    packingDateFilter.value = packingMatch.packing_date;
                    packingDate = packingMatch.packing_date;
                }
            }

            renderFoodPrep(foodPrepBody, state, prepDate);
            renderCooking(cookingBody, state, cookingDate);
            renderAssembly(assemblyBody, state, assemblyDate, selectedLot);
            renderPacking(packingBody, state, packingDate, selectedLot);

            const detailDate = currentStage === "assembly" ? assemblyDate : currentStage === "packing" ? packingDate : prepDate;
            renderDetailTable(currentStage, state, detailDate, selectedLot);
            renderGantt(currentStage, state, currentStage === "packing" ? packingDate : assemblyDate, selectedLot);
            applyStageVisibility(currentStage, detailDate, packingDate);
        };

        [...flowHeader.querySelectorAll(".pfx-flow-step")].forEach((button) => {
            button.onclick = () => {
                currentStage = button.dataset.stage;
                rebuild();
            };
        });

        if (foodPrepDateFilter) foodPrepDateFilter.onchange = rebuild;
        if (cookingDateFilter) cookingDateFilter.onchange = rebuild;
        if (assemblyDateFilter) assemblyDateFilter.onchange = rebuild;
        if (packingDateFilter) packingDateFilter.onchange = rebuild;
        if (lotFilter) lotFilter.onchange = rebuild;

        rebuild();
    }

    function restoreLiveProcessFlow() {
        const handoffCard = document.getElementById("pfxHandoffCard");
        if (handoffCard) handoffCard.remove();

        const stageShell = document.querySelector(".pfx-stage-shell");
        const processDataCard = document.getElementById("pfxProcessDataCard");
        const staticGantt = document.getElementById("pfxStaticGanttCard");
        const assemblyGantt = document.getElementById("pfxAssemblyGanttCard");
        const packingGantt = document.getElementById("pfxPackingGanttCard");
        const flowCard = document.querySelector(".pfx-flow-card");

        if (stageShell) stageShell.style.display = "";
        if (processDataCard) processDataCard.style.display = "";
        if (staticGantt) staticGantt.style.display = "";
        if (assemblyGantt) assemblyGantt.style.display = "none";
        if (packingGantt) packingGantt.style.display = "none";

        if (flowCard) {
            const helperEl = flowCard.querySelector(".card__helper");
            if (helperEl) {
                helperEl.textContent = "Compact flow header showing the production sequence at a glance.";
            }
        }

        updateCardHeader("pfxFoodPrepCard", "Stage 1", "Food Prep", "Date-based production items and the raw materials required for that day's food prep.");
        updateCardHeader("pfxCookingCard", "Stage 2", "Cooking", "Cooking pace, cooked output, and cooked food mix.");
        updateCardHeader("pfxAssemblyCard", "Stage 3", "Assembly", "Primary production control stage with output, target, status, and productivity indicators.");
        updateCardHeader("pfxPackingCard", "Stage 4", "Packing", "Packing throughput, batch references, and dispatch readiness support metrics.");
        updateProcessTableHeader("Production Report Detail", "Assembly Production Table", "Batch-level records from the production report workbook.");
    }

    const existing = window.TrialRunView || {};
    window.TrialRunView = {
        ...existing,
        renderProcessFlow,
        restoreLiveProcessFlow,
    };
})();
