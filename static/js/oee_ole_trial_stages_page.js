(function () {
    const STAFF_ASSUMPTION = {
        batching: 26,
        lowRisk: 99,
        highRisk: 78,
        mediumRisk: 24,
        total: 227,
        attendancePct: 1,
    };

    const PROXY_ASSUMPTION = {
        plannedMinutes: 9 * 60,
        actualRunMinutes: 7.5 * 60,
        lunchMinutes: 60,
        downtimeMinutes: 30,
        performancePct: 0.8,
        qualityPct: 1,
        utilizedLabourPct: 0.8,
        productivityPct: 0.75,
    };

    const ALL_DATES_VALUE = "all";
    const MEAL_WEIGHT_KG = 0.3;
    // OEE/OLE analysis is scoped to the Stage 2 trial window 25–28 Mar 2026,
    // regardless of any extra dates present in an uploaded workbook.
    const ALLOWED_TRIAL_DATES = [
        { iso: "2026-03-25", label: "25 Mar" },
        { iso: "2026-03-26", label: "26 Mar" },
        { iso: "2026-03-27", label: "27 Mar" },
        { iso: "2026-03-28", label: "28 Mar" },
    ];
    const ALLOWED_TRIAL_DATE_ISO = new Set(ALLOWED_TRIAL_DATES.map((d) => d.iso));
    const ALLOWED_TRIAL_DATE_LABELS = new Set(ALLOWED_TRIAL_DATES.map((d) => d.label));

    function esc(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function num(value, digits) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "N/A";
        if (Number.isFinite(digits)) {
            return n.toLocaleString(undefined, {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
            });
        }
        return n.toLocaleString();
    }

    function pct(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "N/A";
    }

    function avg(values) {
        const items = (values || []).filter((value) => Number.isFinite(Number(value))).map(Number);
        if (!items.length) return null;
        return items.reduce((sum, value) => sum + value, 0) / items.length;
    }

    function weightedAvg(rows, valueFn, weightFn) {
        const items = (rows || []).map((row) => ({
            value: Number(valueFn(row)),
            weight: Number(weightFn(row)),
        })).filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0);
        if (!items.length) return null;
        const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
        if (!totalWeight) return null;
        return items.reduce((sum, item) => sum + (item.value * item.weight), 0) / totalWeight;
    }

    function proxyAvailability() {
        return PROXY_ASSUMPTION.actualRunMinutes / PROXY_ASSUMPTION.plannedMinutes;
    }

    function proxyOee() {
        return proxyAvailability() * PROXY_ASSUMPTION.performancePct * PROXY_ASSUMPTION.qualityPct;
    }

    function proxyOle() {
        return STAFF_ASSUMPTION.attendancePct * PROXY_ASSUMPTION.utilizedLabourPct * PROXY_ASSUMPTION.productivityPct;
    }

    function proxyAssumptionLabel() {
        return "9h planned | 7.5h run | 80% rate | 0% reject";
    }

    // Throughput: good meals assembled per hour of active assembly time.
    // Null when the meal row has no recorded assembly time (e.g. 25 Mar).
    function mealsPerHour(row) {
        const meals = Number(row.assembled);
        const mins = Number(row.assembly_time_min);
        return Number.isFinite(meals) && Number.isFinite(mins) && mins > 0
            ? meals / (mins / 60)
            : null;
    }

    // Non-assembly time itemised into cleaning / bake-down / set-up. Returns an
    // HTML snippet "Nm (Clean a, Bake b, Set-up c)" or "—" when none recorded.
    function formatDowntime(row) {
        const parts = [];
        if (Number(row.cleaning_min) > 0) parts.push(`Clean ${num(row.cleaning_min)}`);
        if (Number(row.bake_down_min) > 0) parts.push(`Bake ${num(row.bake_down_min)}`);
        if (Number(row.setup_min) > 0) parts.push(`Set-up ${num(row.setup_min)}`);
        if (!parts.length) return "—";
        const total = (Number(row.cleaning_min) || 0) + (Number(row.bake_down_min) || 0) + (Number(row.setup_min) || 0);
        return `${formatMinutes(total)} <small>(${parts.join(", ")})</small>`;
    }

    // Pool the measured-assembly rows into single Availability / Performance /
    // Quality factors (Σ numerator / Σ denominator) for the total-factor method:
    //   Availability = Σ assembly time / Σ window
    //   Performance  = Σ good output  / Σ ideal output (ideal = assembled / perf)
    //   Quality      = Σ assembled    / Σ ordered
    function pooledAssemblyFactors(rows) {
        let runMin = 0, windowMin = 0, ordered = 0, assembled = 0, idealOutput = 0;
        (rows || []).forEach((row) => {
            const at = Number(row.assembly_time_min);
            const tw = Number(row.total_window_min);
            const ord = Number(row.ordered);
            const asm = Number(row.assembled);
            const perf = Number(row.performance);
            if (Number.isFinite(at) && Number.isFinite(tw)) { runMin += at; windowMin += tw; }
            if (Number.isFinite(ord)) ordered += ord;
            if (Number.isFinite(asm)) assembled += asm;
            if (Number.isFinite(perf) && perf > 0 && Number.isFinite(asm)) idealOutput += asm / perf;
        });
        return {
            availability: windowMin > 0 ? runMin / windowMin : null,
            performance: idealOutput > 0 ? assembled / idealOutput : null,
            quality: ordered > 0 ? assembled / ordered : null,
        };
    }

    // Packing labour Utilisation pooled across sessions: Σ productive man-min /
    // Σ available man-min. Optionally scoped to a single trial date.
    function pooledPackingUtilization(report, dateLabel) {
        let rows = ((report.packing && report.packing.utilization) || [])
            .filter((row) => isVisibleTrialDateLabel(row.date));
        if (dateLabel && dateLabel !== ALL_DATES_VALUE) {
            rows = rows.filter((row) => row.date === dateLabel);
        }
        let prod = 0, avail = 0;
        rows.forEach((row) => {
            const p = Number(row.man_min_productive);
            const a = Number(row.man_min_available);
            if (Number.isFinite(p)) prod += p;
            if (Number.isFinite(a)) avail += a;
        });
        return avail > 0 ? prod / avail : null;
    }

    // Packing Availability pooled: Σ productive packing time / Σ total time.
    function pooledPackingAvailability(report, dateLabel) {
        let rows = ((report.packing && report.packing.utilization) || [])
            .filter((row) => isVisibleTrialDateLabel(row.date));
        if (dateLabel && dateLabel !== ALL_DATES_VALUE) {
            rows = rows.filter((row) => row.date === dateLabel);
        }
        let run = 0, total = 0;
        rows.forEach((row) => {
            const r = Number(row.productive_time_min);
            const t = Number(row.window_min);
            if (Number.isFinite(r)) run += r;
            if (Number.isFinite(t)) total += t;
        });
        return total > 0 ? run / total : null;
    }

    // Assembly labour (HR file): pooled Utilisation = Σ productive man-min /
    // Σ available man-min, and total man-hours, over the date scope.
    function assemblyLabourTotals(report, dateLabel) {
        let rows = ((report.assembly && report.assembly.labour) || [])
            .filter((r) => isVisibleTrialDateLabel(r.date));
        if (dateLabel && dateLabel !== ALL_DATES_VALUE) {
            rows = rows.filter((r) => r.date === dateLabel);
        }
        if (!rows.length) return null;
        let prod = 0, avail = 0, manHours = 0;
        rows.forEach((r) => {
            prod += Number(r.productive_min) || 0;
            avail += Number(r.available_min) || 0;
            manHours += Number(r.man_hours) || 0;
        });
        return {
            manHours,
            utilisation: avail > 0 ? prod / avail : null,
        };
    }

    // Packing Activation pooled: Σ activated headcount / Σ scheduled headcount.
    function pooledPackingActivation(report, dateLabel) {
        let rows = ((report.packing && report.packing.headcount) || [])
            .filter((row) => isVisibleTrialDateLabel(row.date));
        if (dateLabel && dateLabel !== ALL_DATES_VALUE) {
            rows = rows.filter((row) => row.date === dateLabel);
        }
        let activated = 0, scheduled = 0;
        rows.forEach((row) => {
            activated += Number(row.activated) || 0;
            scheduled += Number(row.scheduled) || 0;
        });
        return scheduled > 0 ? activated / scheduled : null;
    }

    function formatMinutes(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return "N/A";
        const hours = Math.floor(n / 60);
        const mins = Math.round(n % 60);
        return hours ? `${hours}h ${mins}m` : `${mins} min`;
    }

    function formatTrialDate(dateValue) {
        const value = String(dateValue || "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const [, month, day] = value.split("-");
            const monthNames = {
                "03": "Mar",
            };
            return `${Number(day)} ${monthNames[month] || month}`;
        }
        return value;
    }

    function sortDateLabels(labels) {
        return [...labels].sort((a, b) => {
            const aNum = Number(String(a).split(" ")[0]) || 0;
            const bNum = Number(String(b).split(" ")[0]) || 0;
            return aNum - bNum;
        });
    }

    function isVisibleTrialDateLabel(label) {
        return ALLOWED_TRIAL_DATE_LABELS.has(String(label || "").trim());
    }

    function isVisibleTrialDateIso(dateValue) {
        return ALLOWED_TRIAL_DATE_ISO.has(String(dateValue || "").trim());
    }

    function normalizeProductKey(name) {
        const withoutLot = String(name || "").replace(/lot\.?\s*\d+.*/gi, " ");
        const asciiOnly = withoutLot.replace(/[^\x00-\x7F]/g, " ");
        return asciiOnly
            .replace(/\bwith\b/gi, " ")
            .replace(/\bmu\b/gi, " ")
            .replace(/[^a-zA-Z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function shortProduct(name) {
        return String(name || "")
            .replace(/[^\x00-\x7F]/g, " ")
            .split("(")[0]
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseLines(value) {
        return String(value || "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function sourceBadge(label, tone) {
        return `<span class="oee-source-badge oee-source-badge--${tone}">${esc(label)}</span>`;
    }

    function sectionHeader(eyebrow, title, helper, selectorId, selectorLabel, options, selectedValue) {
        let selectors = [];
        if (Array.isArray(selectorId)) {
            selectors = selectorId;
        } else if (selectorId) {
            selectors = [{
                id: selectorId,
                label: selectorLabel,
                options,
                selectedValue,
                disabled: false,
            }];
        }
        return `
            <div class="card__header">
                <div>
                    <p class="eyebrow">${esc(eyebrow)}</p>
                    <h2>${esc(title)}</h2>
                </div>
                ${selectors.length ? `
                    <div class="trial-stage-toolbar">
                        ${selectors.map((selector) => `
                            <div class="trial-stage-toolbar__group">
                                <label for="${esc(selector.id)}" class="pfx-filter-label">${esc(selector.label)}</label>
                                <select id="${esc(selector.id)}" class="view-select view-select--light trial-stage-select"${selector.disabled ? " disabled" : ""}>
                                    ${(selector.options || []).map((option) => `
                                        <option value="${esc(option.value)}"${option.value === selector.selectedValue ? " selected" : ""}>${esc(option.label)}</option>
                                    `).join("")}
                                </select>
                            </div>
                        `).join("")}
                    </div>
                ` : ""}
            </div>
        `;
    }

    function renderUnavailableKpi(label, detail) {
        return `
            <div class="oee-gap-card">
                <span class="oee-gap-card__label">${esc(label)}</span>
                <strong class="oee-gap-card__value">N/A</strong>
                <span class="oee-gap-card__detail">${esc(detail)}</span>
            </div>
        `;
    }

    async function fetchJson(path) {
        const response = await fetch(path, { cache: "no-store" });
        return response.json();
    }

    function buildPackingDisplayModel(report) {
        const headcount = (report.packing.headcount || []).map((row) => ({
            ...row,
            scheduled: STAFF_ASSUMPTION.mediumRisk,
            absent: 0,
            activated: STAFF_ASSUMPTION.mediumRisk,
            activation: STAFF_ASSUMPTION.attendancePct,
            source_note: `Medium Risk assigned headcount fixed at ${STAFF_ASSUMPTION.mediumRisk}; assumed 100% attendance.`,
        }));

        const partialSummary = (report.packing.partial_summary || []).map((row) => ({
            ...row,
            activation: STAFF_ASSUMPTION.attendancePct,
            partial_ole: Number.isFinite(Number(row.utilization))
                ? Number(row.utilization) * STAFF_ASSUMPTION.attendancePct
                : null,
        }));

        return {
            ...report.packing,
            headcount,
            partial_summary: partialSummary,
            assumption_note: `Packing OLE on this page assumes assigned Medium Risk staffing of ${STAFF_ASSUMPTION.mediumRisk} and 100% attendance for every trial date.`,
        };
    }

    function aggregateMachineMinutes(tasks) {
        const totals = {};
        (tasks || []).forEach((task) => {
            Object.entries(task.machines || {}).forEach(([machine, mins]) => {
                totals[machine] = (totals[machine] || 0) + Number(mins || 0);
            });
        });
        return Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([machine, mins]) => `${machine} ${num(mins)} min`);
    }

    function aggregateMachineUsage(tasks) {
        const totals = {};
        (tasks || []).forEach((task) => {
            const kg = Number(task.kg_output || 0);
            Object.entries(task.machines || {}).forEach(([machine, mins]) => {
                if (!totals[machine]) {
                    totals[machine] = {
                        machine,
                        minutes: 0,
                        kg: 0,
                        tasks: 0,
                    };
                }
                totals[machine].minutes += Number(mins || 0);
                // Full task output is credited to each machine the material passed
                // through, so this column is per-machine and not additive across rows.
                totals[machine].kg += Number.isFinite(kg) ? kg : 0;
                totals[machine].tasks += 1;
            });
        });
        return Object.values(totals)
            .sort((a, b) => b.minutes - a.minutes || a.machine.localeCompare(b.machine));
    }

    // Groups tasks into a menu -> step -> machine tree so the cooking section can
    // show, per meal, which steps ran on which machines and for how long.
    // Strip trailing batch markers so repeated batches of one task collapse to a
    // single step. Handles e.g. "B.1/1", "B.12/2", "B.1-3", "B.1-B.5", "B.7-8.5",
    // "B.10", "(0.5batch)", "5 batch", "8.5 B.", and bare fractions like "10/2".
    function stripBatchSuffix(raw) {
        const original = String(raw == null ? "" : raw).trim();
        let s = original;
        let prev;
        do {
            prev = s;
            s = s
                .replace(/\s*\(\s*[\d.]+\s*batch\w*\s*\)\s*$/i, "")      // "(0.5batch)", "(4 batch)"
                .replace(/\s+B\.\s*\d+\s*\/\s*\d+\s*$/i, "")             // "B.1/1", "B.12/2"
                .replace(/\s+B\.\s*\d+(?:\.\d+)?\s*-\s*(?:B\.)?\s*\d+(?:\.\d+)?\s*$/i, "") // "B.1-3", "B.4-B.5", "B.7-8.5"
                .replace(/\s+B\.\s*\d+(?:\.\d+)?\s*$/i, "")              // "B.1", "B.10"
                .replace(/\s+\d+\s*\/\s*\d+\s*$/i, "")                   // bare "1/1", "10/2"
                .replace(/\s+[\d.]+\s+batch\w*\s*$/i, "")                // "5 batch", "8.5 batch"
                .replace(/\s+[\d.]+\s+B\.\s*$/i, "")                     // "5 B.", "8.5 B."
                .trim();
        } while (s !== prev && s.length > 0);
        return s.length ? s : original;
    }

    function buildMenuMachineBreakdown(tasks) {
        const menus = {};
        (tasks || []).forEach((task) => {
            const menuKey = task.menu || "Unspecified meal";
            if (!menus[menuKey]) {
                menus[menuKey] = { menu: menuKey, stepMap: {}, stepOrder: [], totalKg: 0, totalDuration: 0 };
            }
            const bucket = menus[menuKey];
            const displayName = stripBatchSuffix(task.component) || (task.component || "Unspecified step");
            const stepKey = displayName.toLowerCase();
            if (!bucket.stepMap[stepKey]) {
                bucket.stepMap[stepKey] = {
                    component: displayName,
                    shiftLabels: new Set(),
                    duration: 0,
                    kg: 0,
                    batches: 0,
                    machineMinutes: {},
                };
                bucket.stepOrder.push(stepKey);
            }
            const step = bucket.stepMap[stepKey];
            // trial_run_data has one row per batch (no .batches); the uploaded LR
            // workbook merges batches per step and carries the real count.
            const taskBatches = Number(task.batches || 1);
            step.batches += taskBatches;
            step.duration += Number(task.duration_min || 0);
            step.kg += Number(task.kg_output || 0);
            if (task.shiftLabel) step.shiftLabels.add(task.shiftLabel);
            Object.entries(task.machines || {}).forEach(([machine, mins]) => {
                if (!step.machineMinutes[machine]) {
                    step.machineMinutes[machine] = { minutes: 0, batches: 0 };
                }
                const machineBatches = task.machineBatches && task.machineBatches[machine] != null
                    ? Number(task.machineBatches[machine])
                    : taskBatches;
                step.machineMinutes[machine].minutes += Number(mins || 0);
                step.machineMinutes[machine].batches += machineBatches;
            });
            bucket.totalKg += Number(task.kg_output || 0);
            bucket.totalDuration += Number(task.duration_min || 0);
        });
        return Object.values(menus)
            .map((bucket) => ({
                menu: bucket.menu,
                totalKg: bucket.totalKg,
                totalDuration: bucket.totalDuration,
                steps: bucket.stepOrder.map((stepKey) => {
                    const step = bucket.stepMap[stepKey];
                    return {
                        component: step.component,
                        batches: step.batches,
                        shiftLabel: Array.from(step.shiftLabels).join(", "),
                        duration: step.duration,
                        kg: step.kg,
                        machines: Object.entries(step.machineMinutes)
                            .map(([machine, v]) => ({
                                machine,
                                minutes: v.minutes,
                                perBatch: v.batches ? v.minutes / v.batches : v.minutes,
                            }))
                            .sort((a, b) => b.minutes - a.minutes || a.machine.localeCompare(b.machine)),
                    };
                }),
            }))
            .sort((a, b) => b.totalKg - a.totalKg || a.menu.localeCompare(b.menu));
    }

    // ── Cooking section from the uploaded LR workbook ───────────────────────────
    // Used only when a cooking file has been uploaded. Maps the parsed LR rows
    // (per date/menu/step, batches merged) into the same task/group shape the
    // Cooking section already renders, so the existing render code is unchanged.
    function lrToCookingTask(t) {
        const machines = {};
        const machineBatches = {};
        Object.entries(t.machines || {}).forEach(([name, v]) => {
            machines[name] = Number(v.minutes || 0);
            machineBatches[name] = Number(v.batches || 0);
        });
        return {
            menu: t.menu,
            component: t.step,
            start: t.start || "",
            stop: t.stop || "",
            duration_min: Number(t.duration_min || 0),
            workers: Number(t.workers || 0),
            kg_output: Number(t.kg || 0),
            kg_man_hr: Number(t.kg_man_hr || 0),
            machines,
            machineBatches,
            batches: Number(t.batches || 1),
            shiftLabel: "",
        };
    }

    // dateLabelByIso: Map(iso -> display label) for the dates already on the page;
    // restricts the LR data to those dates and reuses their labels so the global
    // date filter stays aligned with the other stages.
    function buildLrGroupsFromUpload(lrData, dateLabelByIso, stage) {
        const map = {};
        (lrData.tasks || []).forEach((t) => {
            if (t.stage !== stage) return;
            if (!dateLabelByIso.has(t.date)) return;
            if (!map[t.date]) {
                map[t.date] = {
                    key: t.date,
                    label: dateLabelByIso.get(t.date),
                    date: t.date,
                    totalKg: 0,
                    totalDuration: 0,
                    weightedKgManHr: 0,
                    peakWorkers: 0,
                    menus: new Set(),
                    tasks: [],
                };
            }
            const bucket = map[t.date];
            const task = lrToCookingTask(t);
            bucket.totalKg += task.kg_output;
            bucket.totalDuration += task.duration_min;
            bucket.weightedKgManHr += Number.isFinite(task.kg_man_hr)
                ? task.kg_man_hr * Math.max(task.duration_min, 1) : 0;
            bucket.peakWorkers = Math.max(bucket.peakWorkers, task.workers);
            bucket.menus.add(shortProduct(task.menu));
            bucket.tasks.push(task);
        });
        return Object.values(map)
            .map((group) => ({
                ...group,
                avgKgManHr: group.totalDuration > 0 ? group.weightedKgManHr / group.totalDuration : null,
                machineSummary: aggregateMachineMinutes(group.tasks),
                machineUsage: aggregateMachineUsage(group.tasks),
                shiftLabels: ["Uploaded workbook"],
                menus: Array.from(group.menus).filter(Boolean).sort(),
            }))
            .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    function buildLrStageDateGroups(trialData, stageKey) {
        const shifts = (trialData.stages && trialData.stages.lr_shifts) || [];
        const map = {};

        shifts.forEach((shift) => {
            if (!isVisibleTrialDateIso(shift.shift_date)) return;
            const section = shift[stageKey];
            const tasks = (section && section.tasks) || [];
            tasks.forEach((task) => {
                if (!shift.shift_date) return;
                const key = shift.shift_date;
                if (!map[key]) {
                    map[key] = {
                        key,
                        label: formatTrialDate(shift.shift_date),
                        date: shift.shift_date,
                        totalKg: 0,
                        totalDuration: 0,
                        weightedKgManHr: 0,
                        peakWorkers: 0,
                        shiftLabels: new Set(),
                        menus: new Set(),
                        tasks: [],
                    };
                }

                const bucket = map[key];
                const duration = Number(task.duration_min || 0);
                const kg = Number(task.kg_output || 0);
                const kgManHr = Number(task.kg_man_hr || 0);
                const workers = Number(task.workers || 0);

                bucket.totalKg += kg;
                bucket.totalDuration += duration;
                bucket.weightedKgManHr += Number.isFinite(kgManHr) ? kgManHr * Math.max(duration, 1) : 0;
                bucket.peakWorkers = Math.max(bucket.peakWorkers, workers);
                bucket.shiftLabels.add(shift.label);
                bucket.menus.add(shortProduct(task.menu));
                bucket.tasks.push({
                    ...task,
                    shiftLabel: shift.label,
                    shiftType: shift.shift_type,
                    shiftDate: shift.shift_date,
                });
            });
        });

        return Object.values(map)
            .map((group) => ({
                ...group,
                avgKgManHr: group.totalDuration > 0 ? group.weightedKgManHr / group.totalDuration : null,
                machineSummary: aggregateMachineMinutes(group.tasks),
                machineUsage: aggregateMachineUsage(group.tasks),
                shiftLabels: Array.from(group.shiftLabels),
                menus: Array.from(group.menus).filter(Boolean).sort(),
            }))
            .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    function buildAssemblyProducts(report) {
        return (report.assembly.rows || [])
            .filter((row) => isVisibleTrialDateLabel(row.date))
            .map((row, index) => ({
                ...row,
                index,
                key: `${row.date}__${row.lot}__${row.menu}`,
                label: `${row.date} - ${shortProduct(row.menu)}`,
                ole: Number.isFinite(Number(row.availability)) && Number.isFinite(Number(row.performance))
                    ? Number(row.availability) * Number(row.performance)
                    : null,
            }));
    }

    function buildAssemblyDateGroups(report, trialData) {
        const rows = buildAssemblyProducts(report);
        const trialDays = trialData.days || [];
        const dailyTotals = report.assembly.daily_totals || [];
        const byDate = {};

        rows.forEach((row) => {
            if (!byDate[row.date]) {
                const day = trialDays.find((item) => item.short_label === row.date) || null;
                const total = dailyTotals.find((item) => item.date === row.date) || null;
                byDate[row.date] = {
                    key: row.date,
                    label: row.date,
                    rows: [],
                    trialDay: day,
                    dailyTotal: total,
                };
            }
            byDate[row.date].rows.push(row);
        });

        return Object.values(byDate)
            .map((group) => {
                const totalOrdered = group.rows.reduce((sum, row) => sum + Number(row.ordered || 0), 0);
                const totalAssembled = group.rows.reduce((sum, row) => sum + Number(row.assembled || 0), 0);
                const measuredRows = group.rows.filter((row) => row.oee !== null);
                const oee = group.dailyTotal?.oee ?? (measuredRows.length === 1 ? measuredRows[0].oee : null);
                const ole = group.trialDay?.ole?.pct !== undefined && group.trialDay?.ole?.pct !== null
                    ? Number(group.trialDay.ole.pct) / 100
                    : measuredRows.length === 1 ? measuredRows[0].ole : null;
                return {
                    ...group,
                    totalOrdered,
                    totalAssembled,
                    oee,
                    ole,
                };
            })
            .sort((a, b) => {
                const order = { "25 Mar": 25, "26 Mar": 26, "27 Mar": 27, "28 Mar": 28 };
                return (order[a.label] || 0) - (order[b.label] || 0);
            });
    }

    function buildAssemblyLineModel(trialData, assemblyRow) {
        const hrDays = (trialData.stages && trialData.stages.hr_days) || [];
        const dateLookup = { "25 Mar": 25, "26 Mar": 26, "27 Mar": 27, "28 Mar": 28 };
        const hrDay = hrDays.find((entry) => entry.date === `2026-03-${String(dateLookup[assemblyRow.date] || "").padStart(2, "0")}`);
        const hrBatches = (hrDay && hrDay.batches) || [];
        const key = normalizeProductKey(assemblyRow.menu);
        const productBatches = hrBatches.filter((batch) => normalizeProductKey(batch.product) === key);
        const lineMap = {};
        const staffMap = {};

        productBatches.forEach((batch) => {
            parseLines(batch.line).forEach((line) => {
                if (batch.staff !== null && batch.staff !== undefined && !(line in staffMap)) {
                    staffMap[line] = Number(batch.staff);
                }
            });
        });

        const targetRows = productBatches.filter((batch) =>
            batch.target !== null && batch.target !== undefined && batch.line
        );

        let totalTarget = 0;
        const allocations = [];
        targetRows.forEach((batch) => {
            const lines = parseLines(batch.line);
            const target = Number(batch.target);
            if (!lines.length || !Number.isFinite(target) || target <= 0) return;

            if (lines.length === 1) {
                allocations.push({ line: lines[0], target });
                totalTarget += target;
                return;
            }

            const weights = lines.map((line) => {
                const weight = Number(staffMap[line]);
                return Number.isFinite(weight) && weight > 0 ? weight : 1;
            });
            const totalWeight = weights.reduce((sum, value) => sum + value, 0) || lines.length;

            lines.forEach((line, index) => {
                const shareTarget = target * (weights[index] / totalWeight);
                allocations.push({ line, target: shareTarget });
                totalTarget += shareTarget;
            });
        });

        allocations.forEach((allocation) => {
            const share = allocation.target / totalTarget;
            const line = allocation.line;
            if (!lineMap[line]) {
                lineMap[line] = {
                    line,
                    target: 0,
                    assembled: 0,
                    staff: Number(staffMap[line]) || null,
                };
            }
            lineMap[line].target += allocation.target;
            lineMap[line].assembled += Number(assemblyRow.assembled || 0) * share;
        });

        return Object.values(lineMap)
            .map((line) => ({
                ...line,
                attainment: line.target > 0 ? line.assembled / line.target : null,
                oee: assemblyRow.oee,
                ole: assemblyRow.ole,
            }))
            .sort((a, b) => String(a.line).localeCompare(String(b.line)));
    }

    function buildPackingDateGroups(trialData, report) {
        const packing = buildPackingDisplayModel(report);
        const days = (trialData.stages && trialData.stages.mr_days) || [];
        return days.filter((day) => isVisibleTrialDateIso(day.packing_date)).map((day) => {
            const dateLabel = day.packing_date.slice(8, 10) + " Mar";
            const headcountFixed = packing.headcount.find((row) => row.date === dateLabel) || null;
            const utilRows = (packing.utilization || []).filter((row) => row.date === dateLabel);
            const productivityRows = (packing.productivity || []).filter((row) => row.date === dateLabel);
            const sessions = day.sessions || [];
            const partial = utilRows.length ? avg(utilRows.map((row) => row.utilization)) : null;
            const totalMeals = sessions.reduce((sum, row) => sum + Number(row.meals || 0), 0);
            const totalCartons = sessions.reduce((sum, row) => sum + Number(row.cartons || 0), 0);
            const totalManHours = sessions.reduce((sum, row) => {
                const duration = Number(row.duration_min || 0);
                const workers = Number(row.workers || 0);
                return sum + (duration * workers) / 60;
            }, 0);
            const actualMealsPerManHr = totalManHours > 0 ? totalMeals / totalManHours : null;

            return {
                key: day.packing_date,
                date: day.packing_date,
                dateLabel,
                label: dateLabel,
                products: Array.from(new Set(sessions.map((row) => shortProduct(row.menu)).filter(Boolean))).sort(),
                sessions,
                productivityRows,
                headcount: headcountFixed,
                utilizationRows: utilRows,
                activation: headcountFixed ? headcountFixed.activation : STAFF_ASSUMPTION.attendancePct,
                partialOle: Number.isFinite(Number(partial)) ? partial * STAFF_ASSUMPTION.attendancePct : null,
                ole: Number.isFinite(Number(partial)) ? partial * STAFF_ASSUMPTION.attendancePct * PROXY_ASSUMPTION.productivityPct : null,
                totalMeals,
                totalCartons,
                totalManHours,
                actualMealsPerManHr,
            };
        }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    function buildGlobalDateOptions(prepGroups, cookingGroups, assemblyDateGroups, packingDateGroups) {
        const labels = new Set();
        (prepGroups || []).forEach((group) => isVisibleTrialDateLabel(group.label) && labels.add(group.label));
        (cookingGroups || []).forEach((group) => isVisibleTrialDateLabel(group.label) && labels.add(group.label));
        (assemblyDateGroups || []).forEach((group) => isVisibleTrialDateLabel(group.label) && labels.add(group.label));
        (packingDateGroups || []).forEach((group) => {
            const label = group.dateLabel || group.label;
            if (isVisibleTrialDateLabel(label)) labels.add(label);
        });
        return [
            { value: ALL_DATES_VALUE, label: "All Dates" },
            ...sortDateLabels(labels).map((label) => ({ value: label, label })),
        ];
    }

    function buildCombinedLrGroup(groups, selectedDateLabel) {
        const filtered = selectedDateLabel === ALL_DATES_VALUE
            ? groups
            : (groups || []).filter((group) => group.label === selectedDateLabel);
        if (!filtered || !filtered.length) return null;
        const tasks = filtered.flatMap((group) => group.tasks || []);
        const totalKg = filtered.reduce((sum, group) => sum + Number(group.totalKg || 0), 0);
        const totalDuration = filtered.reduce((sum, group) => sum + Number(group.totalDuration || 0), 0);
        const weightedKgManHr = filtered.reduce((sum, group) => sum + (Number(group.avgKgManHr || 0) * Number(group.totalDuration || 0)), 0);
        return {
            key: selectedDateLabel,
            label: selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : selectedDateLabel,
            totalKg,
            totalDuration,
            avgKgManHr: totalDuration > 0 ? weightedKgManHr / totalDuration : null,
            peakWorkers: filtered.reduce((max, group) => Math.max(max, Number(group.peakWorkers || 0)), 0),
            shiftLabels: Array.from(new Set(filtered.flatMap((group) => group.shiftLabels || []))),
            menus: Array.from(new Set(filtered.flatMap((group) => group.menus || []))).sort(),
            tasks,
            machineSummary: aggregateMachineMinutes(tasks),
            machineUsage: aggregateMachineUsage(tasks),
        };
    }

    function buildCombinedAssemblyGroup(report, trialData, selectedDateLabel) {
        const dateGroups = buildAssemblyDateGroups(report, trialData);
        const filtered = selectedDateLabel === ALL_DATES_VALUE
            ? dateGroups
            : dateGroups.filter((group) => group.label === selectedDateLabel);
        if (!filtered.length) return null;
        const rows = filtered.flatMap((group) => group.rows || []);
        return {
            key: selectedDateLabel,
            label: selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : selectedDateLabel,
            rows,
            totalOrdered: rows.reduce((sum, row) => sum + Number(row.ordered || 0), 0),
            totalAssembled: rows.reduce((sum, row) => sum + Number(row.assembled || 0), 0),
            oee: weightedAvg(rows.filter((row) => Number.isFinite(Number(row.oee))), (row) => row.oee, (row) => row.ordered || row.assembled || 0),
            ole: weightedAvg(rows.filter((row) => Number.isFinite(Number(row.ole))), (row) => row.ole, (row) => row.ordered || row.assembled || 0),
            notes: filtered.map((group) => group.trialDay?.note || group.dailyTotal?.note).filter(Boolean),
            impacts: filtered.map((group) => group.dailyTotal?.impact).filter(Boolean),
        };
    }

    function buildCombinedPackingGroup(trialData, report, selectedDateLabel) {
        const groups = buildPackingDateGroups(trialData, report);
        const filtered = selectedDateLabel === ALL_DATES_VALUE
            ? groups
            : groups.filter((group) => (group.dateLabel || group.label) === selectedDateLabel);
        if (!filtered.length) return null;
        const sessions = filtered.flatMap((group) => group.sessions || []);
        const utilizationRows = filtered.flatMap((group) => group.utilizationRows || []);
        const utilization = utilizationRows.length ? avg(utilizationRows.map((row) => row.utilization)) : null;
        const totalMeals = sessions.reduce((sum, row) => sum + Number(row.meals || 0), 0);
        const totalCartons = sessions.reduce((sum, row) => sum + Number(row.cartons || 0), 0);
        const totalManHours = sessions.reduce((sum, row) => sum + ((Number(row.duration_min || 0) * Number(row.workers || 0)) / 60), 0);
        return {
            key: selectedDateLabel,
            dateLabel: selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : selectedDateLabel,
            products: Array.from(new Set(sessions.map((row) => shortProduct(row.menu)).filter(Boolean))).sort(),
            sessions,
            headcount: selectedDateLabel === ALL_DATES_VALUE ? null : (filtered[0].headcount || null),
            utilizationRows,
            activation: STAFF_ASSUMPTION.attendancePct,
            partialOle: Number.isFinite(Number(utilization)) ? utilization * STAFF_ASSUMPTION.attendancePct : null,
            ole: Number.isFinite(Number(utilization)) ? utilization * STAFF_ASSUMPTION.attendancePct * PROXY_ASSUMPTION.productivityPct : null,
            totalMeals,
            totalCartons,
            totalManHours,
            actualMealsPerManHr: totalManHours > 0 ? totalMeals / totalManHours : null,
        };
    }

    function renderProcessFlowTimelineByDate(report, trialData, prepGroups, cookingGroups, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageProcessFlowCard");
        if (!target) return;

        const prep = buildCombinedLrGroup(prepGroups, selectedDateLabel);
        const cooking = buildCombinedLrGroup(cookingGroups, selectedDateLabel);
        const assembly = buildCombinedAssemblyGroup(report, trialData, selectedDateLabel);
        const packing = buildCombinedPackingGroup(trialData, report, selectedDateLabel);
        const label = selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : selectedDateLabel;

        const prepKg = prep ? Number(prep.totalKg || 0) : null;
        const cookingKg = cooking ? Number(cooking.totalKg || 0) : null;
        const assembledMeals = assembly ? Number(assembly.totalAssembled || 0) : null;
        const packedMeals = packing ? Number(packing.totalMeals || 0) : null;
        const assembledWeightKg = Number.isFinite(assembledMeals) ? assembledMeals * MEAL_WEIGHT_KG : null;
        const packedWeightKg = Number.isFinite(packedMeals) ? packedMeals * MEAL_WEIGHT_KG : null;

        const prepToCooking = Number.isFinite(prepKg) && prepKg > 0 && Number.isFinite(cookingKg) ? cookingKg / prepKg : null;
        const cookingToAssembly = Number.isFinite(cookingKg) && cookingKg > 0 && Number.isFinite(assembledWeightKg) ? assembledWeightKg / cookingKg : null;
        const assemblyToPacking = Number.isFinite(assembledWeightKg) && assembledWeightKg > 0 && Number.isFinite(packedWeightKg) ? packedWeightKg / assembledWeightKg : null;

        target.innerHTML = sectionHeader(
            "Process Flow",
            "Ingredient-to-Meal Timeline",
            "",
            [{
                id: "trialProcessFlowLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }]
        ) + `
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${esc(label)}</span>
                <span class="oee-loss-pill">Meal mass assumption: ${num(MEAL_WEIGHT_KG, 1)} kg per meal</span>
                <span class="oee-loss-pill">Prep and cooking values use recorded LR kg output</span>
                <span class="oee-loss-pill">Assembly and packing mass use meal count x ${num(MEAL_WEIGHT_KG, 1)} kg</span>
            </div>
            <div class="trial-flow-timeline">
                <div class="trial-flow-step">
                    <span class="trial-flow-step__label">Food Prep</span>
                    <strong class="trial-flow-step__value">${prep ? `${num(prepKg, 1)} kg` : "N/A"}</strong>
                    <span class="trial-flow-step__sub">Recorded prep output / ingredient mass handled</span>
                    <div class="trial-flow-step__meta">
                        <span class="trial-flow-step__meta-item">${prep ? `${num(prep.tasks.length)} prep tasks` : "No prep rows for this date"}</span>
                        <span class="trial-flow-step__meta-item">${prep ? `${num(prep.menus.length)} meal(s) in prep scope` : ""}</span>
                    </div>
                </div>
                <div class="trial-flow-step">
                    <span class="trial-flow-step__label">Cooking</span>
                    <strong class="trial-flow-step__value">${cooking ? `${num(cookingKg, 1)} kg` : "N/A"}</strong>
                    <span class="trial-flow-step__sub">Recorded cooked output mass</span>
                    <div class="trial-flow-step__meta">
                        <span class="trial-flow-step__meta-item">${cooking ? `${num(cooking.tasks.length)} cooking tasks` : "No cooking rows for this date"}</span>
                        <span class="trial-flow-step__meta-item">${cooking ? `${num(cooking.menus.length)} meal(s) in cooking scope` : ""}</span>
                    </div>
                </div>
                <div class="trial-flow-step">
                    <span class="trial-flow-step__label">Assembly</span>
                    <strong class="trial-flow-step__value">${assembly ? `${num(assembledMeals)} meals` : "N/A"}</strong>
                    <span class="trial-flow-step__sub">${assembly ? `${num(assembledWeightKg, 1)} kg total assembled mass` : "No assembly rows for this date"}</span>
                    <div class="trial-flow-step__meta">
                        <span class="trial-flow-step__meta-item">${assembly ? `${num(assembly.totalOrdered)} ordered | ${num(assembly.rows.length)} meal row(s)` : ""}</span>
                        <span class="trial-flow-step__meta-item">${assembly ? `Assembly OEE ${pct(assembly.oee)} | OLE ${pct(assembly.ole)}` : ""}</span>
                    </div>
                </div>
                <div class="trial-flow-step">
                    <span class="trial-flow-step__label">Packing</span>
                    <strong class="trial-flow-step__value">${packing ? `${num(packedMeals)} meals` : "N/A"}</strong>
                    <span class="trial-flow-step__sub">${packing ? `${num(packedWeightKg, 1)} kg total packed mass` : "No packing rows for this date"}</span>
                    <div class="trial-flow-step__meta">
                        <span class="trial-flow-step__meta-item">${packing ? `${num(packing.sessions.length)} session row(s)` : ""}</span>
                        <span class="trial-flow-step__meta-item">${packing ? `Packing OLE ${pct(packing.ole)}` : ""}</span>
                    </div>
                </div>
            </div>
            <div class="trial-flow-yield-grid">
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Prep to Cooking</span>
                    <strong class="oee-gap-card__value">${pct(prepToCooking)}</strong>
                    <span class="oee-gap-card__detail">Cooking kg divided by food prep kg</span>
                </div>
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Cooking to Assembly</span>
                    <strong class="oee-gap-card__value">${pct(cookingToAssembly)}</strong>
                    <span class="oee-gap-card__detail">Assembled meal mass divided by cooking kg</span>
                </div>
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Assembly to Packing</span>
                    <strong class="oee-gap-card__value">${pct(assemblyToPacking)}</strong>
                    <span class="oee-gap-card__detail">Packed meal mass divided by assembled meal mass</span>
                </div>
            </div>
        `;

        const localSelect = document.getElementById("trialProcessFlowLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
    }

    function extractLotIds(value) {
        return Array.from(new Set(String(value || "").match(/\b\d{3}\b/g) || []));
    }

    function filterVisibleFlowTasks(tasks) {
        return (tasks || []).filter((task) => !String(task.sheet || "").includes("24 Mar"));
    }

    function buildFlowProducts(report) {
        return (report.product_flows || []).map((product, index) => {
            const visibleLrTasks = filterVisibleFlowTasks(product.lr_tasks);
            const mrLots = Array.from(new Set((product.mr || []).map((row) => String(row.lot || "").trim()).filter(Boolean)));
            const flowLots = extractLotIds(product.lots);
            const hasHr = !!product.hr;
            const hasMr = (product.mr || []).length > 0;
            const hasFullMatch =
                visibleLrTasks.length > 0 &&
                hasHr &&
                hasMr &&
                flowLots.length === 1 &&
                mrLots.length === 1 &&
                flowLots[0] === mrLots[0];
            const matchStatus = hasFullMatch
                ? "Fully matched"
                : (visibleLrTasks.length > 0 && hasHr && hasMr ? "Partial traceability" : "Context only");

            return {
                ...product,
                lr_tasks: visibleLrTasks,
                key: `${product.product}__${index}`,
                label: shortProduct(product.product),
                mrLots,
                flowLots,
                hasFullMatch,
                matchStatus,
            };
        });
    }

    // ── End-to-end timing (Production Flow) ─────────────────────────────────────
    // Span = earliest shown prep start → latest packing stop, for single-cycle
    // meals only. 24 Mar pre-trial prep is already excluded from product.lr_tasks.
    const FLOW_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const FLOW_MON_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // "N 24 Mar" / "26 Mar" → { month, day, night }
    function parseFlowDate(label) {
        const s = String(label || "");
        const m = s.match(/(\d{1,2})\s*([A-Za-z]{3})/);
        const mon = m ? FLOW_MONTHS[m[2].toLowerCase()] : null;
        return mon ? { month: mon, day: parseInt(m[1], 10), night: /^\s*N\b/i.test(s) } : null;
    }

    // Clock string ("~01:30(+1)", "19:20") + base date → Date. Night-shift morning
    // times (before noon on an N sheet) and explicit "(+1)" roll to the next day.
    function parseFlowDateTime(baseDate, timeStr, isNight) {
        const s = String(timeStr || "");
        const t = s.match(/(\d{1,2}):(\d{2})/);
        if (!t || !baseDate) return null;
        const hh = parseInt(t[1], 10);
        const mm = parseInt(t[2], 10);
        let dayOffset = 0;
        if (isNight && hh < 12) dayOffset += 1;
        if (s.includes("(+1)")) dayOffset += 1;
        return new Date(2026, baseDate.month - 1, baseDate.day + dayOffset, hh, mm);
    }

    function formatFlowStamp(date) {
        return `${date.getDate()} ${FLOW_MON_LABELS[date.getMonth()]} `
            + `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    function formatFlowSpan(ms) {
        const mins = Math.round(ms / 60000);
        const d = Math.floor(mins / 1440);
        const h = Math.floor((mins % 1440) / 60);
        const m = mins % 60;
        return d > 0
            ? `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`
            : `${h}h ${String(m).padStart(2, "0")}m`;
    }

    function flowDayOrdinal(d) {
        return d.month * 31 + d.day;
    }

    // One packing cycle: prep tasks dated after the previous packing day and up to
    // this one (prevOrd → packDay) feed it; span = earliest such prep → last pack
    // stop on that day. Falls back to pack-only when no prep lands in the window.
    function flowCycleSpan(product, mr, packDay, prevOrd) {
        const packTimes = (key) => {
            const out = [];
            mr.forEach((row) => {
                if (row.date !== packDay.label) return;
                const v = row[key];
                if (v === "-" || v == null || v === "") return;
                const x = parseFlowDateTime(packDay.d, v, false);
                if (x) out.push(x);
            });
            return out;
        };
        const stops = packTimes("stop");
        if (!stops.length) return { date: packDay.label, status: "na" };
        const last = new Date(Math.max.apply(null, stops));

        const ord = flowDayOrdinal(packDay.d);
        const winStarts = [];
        (product.lr_tasks || []).forEach((task) => {
            const d = parseFlowDate(task.sheet);
            if (!d) return;
            const taskOrd = flowDayOrdinal(d);
            if ((prevOrd === null || taskOrd > prevOrd) && taskOrd <= ord) {
                const x = parseFlowDateTime(d, task.start, d.night);
                if (x) winStarts.push(x);
            }
        });

        let first;
        let packOnly = false;
        if (winStarts.length) {
            first = new Date(Math.min.apply(null, winStarts));
        } else {
            const packStarts = packTimes("start");
            if (!packStarts.length) return { date: packDay.label, status: "na" };
            first = new Date(Math.min.apply(null, packStarts));
            packOnly = true;
        }
        return {
            date: packDay.label,
            status: "ok",
            from: first,
            to: last,
            duration: formatFlowSpan(last - first),
            packOnly,
            inconsistent: winStarts.some((s) => s > last),
        };
    }

    function flowEndToEnd(product) {
        const mr = product.mr || [];
        const packDays = Array.from(new Set(mr.map((row) => row.date).filter(Boolean)))
            .map((label) => ({ label, d: parseFlowDate(label) }))
            .filter((p) => p.d)
            .sort((a, b) => flowDayOrdinal(a.d) - flowDayOrdinal(b.d));
        if (!packDays.length) return { status: "na", reason: "No packing times recorded" };

        if (packDays.length === 1) {
            const c = flowCycleSpan(product, mr, packDays[0], null);
            return c.status === "ok"
                ? { status: "ok", from: c.from, to: c.to, duration: c.duration, inconsistent: c.inconsistent }
                : { status: "na", reason: "No packing times recorded" };
        }

        const cycles = [];
        let prevOrd = null;
        packDays.forEach((packDay) => {
            cycles.push(flowCycleSpan(product, mr, packDay, prevOrd));
            prevOrd = flowDayOrdinal(packDay.d);
        });
        return { status: "multi", cycles };
    }

    function flowE2EDisplay(e2e) {
        if (e2e.status === "ok") {
            return {
                value: e2e.duration,
                detail: `First prep ${formatFlowStamp(e2e.from)} → last pack ${formatFlowStamp(e2e.to)}`
                    + (e2e.inconsistent ? " ⚠ source times inconsistent" : ""),
            };
        }
        if (e2e.status === "multi") {
            const parts = e2e.cycles.map((c) => c.status === "ok"
                ? `${c.date}: ${c.duration}${c.packOnly ? " (pack only)" : ""}${c.inconsistent ? " ⚠" : ""}`
                : `${c.date}: N/A`);
            return { value: "By packing day", detail: parts.join("   ·   ") };
        }
        return { value: "N/A", detail: e2e.reason };
    }

    function findQualityFactor(report, assemblyRow) {
        const factors = (report.quality && report.quality.quality_factors) || [];
        const rowKey = normalizeProductKey(assemblyRow.menu);
        return factors.find((factor) => {
            const factorKey = normalizeProductKey(factor.product);
            return factor.date === assemblyRow.date &&
                Number(factor.ordered || 0) === Number(assemblyRow.ordered || 0) &&
                Math.abs(Number(factor.assembled || 0) - Number(assemblyRow.assembled || 0)) <= 3 &&
                (factorKey.includes(rowKey) || rowKey.includes(factorKey));
        }) || null;
    }

    function findFlowContext(report, assemblyRow) {
        const rowKey = normalizeProductKey(assemblyRow.menu);
        const rowLots = extractLotIds(assemblyRow.lot);
        const match = (report.product_flows || []).find((product) => {
            const flowKey = normalizeProductKey(product.product);
            const flowLots = extractLotIds(product.lots);
            const lotMatch = rowLots.some((lot) => flowLots.includes(lot));
            return lotMatch && (flowKey.includes(rowKey) || rowKey.includes(flowKey));
        }) || null;
        return match ? { ...match, lr_tasks: filterVisibleFlowTasks(match.lr_tasks) } : null;
    }

    function renderGlobalDateFilter(options, selectedValue) {
        const target = document.getElementById("trialStageFilterCard");
        if (!target) return;
        target.innerHTML = `
            <div class="card__header trial-stage-filter-card__header">
                <div>
                    <p class="eyebrow">Historical Filter</p>
                    <h2>Trial Date Selector</h2>
                </div>
                <div class="trial-stage-toolbar">
                    <div class="trial-stage-toolbar__group">
                        <label for="trialStageGlobalDateSelect" class="pfx-filter-label">Date</label>
                        <select id="trialStageGlobalDateSelect" class="view-select view-select--light trial-stage-select">
                            ${options.map((option) => `
                                <option value="${esc(option.value)}"${option.value === selectedValue ? " selected" : ""}>${esc(option.label)}</option>
                            `).join("")}
                        </select>
                    </div>
                </div>
            </div>
        `;
    }

    function renderTopSummary(report, assemblyDateGroups, packingDateGroups) {
        const target = document.getElementById("trialStageSummary");
        if (!target) return;

        const assemblyRows = buildAssemblyProducts(report).filter((row) => row.oee !== null);
        // Per-stage values are kept for the factor breakdown and the AI context.
        const assemblyOee = weightedAvg(assemblyRows, (row) => row.oee, (row) => row.ordered || row.assembled || 0);
        const assemblyOle = weightedAvg(assemblyRows, (row) => row.ole, (row) => row.ordered || row.assembled || 0);
        const packingOle = avg((packingDateGroups || []).map((group) => group.ole));
        const foodPrepOee = proxyOee();
        const cookingOee = proxyOee();
        const packingOee = proxyOee();

        // ── Total-factor facility roll-up ───────────────────────────────────────
        // Combine each underlying factor across the 4 stages first, then multiply
        // once — instead of averaging the already-multiplied stage OEE/OLE values.
        // Assembly factors are pooled from the measured rows; Food Prep, Cooking
        // and Packing use the shared proxy assumptions (Packing Utilisation is
        // the one measured packing factor).
        const aFac = pooledAssemblyFactors(assemblyRows);
        const packingUtil = pooledPackingUtilization(report);
        const proxyA = proxyAvailability();

        const totalAvailability = avg([proxyA, proxyA, aFac.availability, proxyA]);
        const totalPerformance  = avg([PROXY_ASSUMPTION.performancePct, PROXY_ASSUMPTION.performancePct, aFac.performance, PROXY_ASSUMPTION.performancePct]);
        const totalQuality      = avg([PROXY_ASSUMPTION.qualityPct, PROXY_ASSUMPTION.qualityPct, aFac.quality, PROXY_ASSUMPTION.qualityPct]);
        const facilityOee = [totalAvailability, totalPerformance, totalQuality].every((v) => Number.isFinite(Number(v)))
            ? totalAvailability * totalPerformance * totalQuality
            : null;

        const totalActivation   = avg([STAFF_ASSUMPTION.attendancePct, STAFF_ASSUMPTION.attendancePct, STAFF_ASSUMPTION.attendancePct, STAFF_ASSUMPTION.attendancePct]);
        const totalUtilisation  = avg([PROXY_ASSUMPTION.utilizedLabourPct, PROXY_ASSUMPTION.utilizedLabourPct, aFac.availability, packingUtil]);
        const totalProductivity = avg([PROXY_ASSUMPTION.productivityPct, PROXY_ASSUMPTION.productivityPct, aFac.performance, PROXY_ASSUMPTION.productivityPct]);
        const facilityOle = [totalActivation, totalUtilisation, totalProductivity].every((v) => Number.isFinite(Number(v)))
            ? totalActivation * totalUtilisation * totalProductivity
            : null;

        window.PAGE_KPI = {
            page: "oee-trial-stages",
            date_filter: "All Dates",
            facility_oee_pct: facilityOee !== null ? Math.round(facilityOee * 1000) / 10 : null,
            facility_ole_pct: facilityOle !== null ? Math.round(facilityOle * 1000) / 10 : null,
            stage_oee_pct: {
                food_prep: Math.round(foodPrepOee * 1000) / 10,
                cooking: Math.round(cookingOee * 1000) / 10,
                assembly: assemblyOee !== null ? Math.round(assemblyOee * 1000) / 10 : null,
                packing: Math.round(packingOee * 1000) / 10,
            },
            stage_ole_pct: {
                food_prep: Math.round(proxyOle() * 1000) / 10,
                cooking: Math.round(proxyOle() * 1000) / 10,
                assembly: assemblyOle !== null ? Math.round(assemblyOle * 1000) / 10 : null,
                packing: packingOle !== null ? Math.round(packingOle * 1000) / 10 : null,
            },
            method: "Total-factor method. Facility OEE = (avg Availability) x (avg Performance) x (avg Quality) across the 4 stages. Facility OLE = (avg Activation) x (avg Utilisation) x (avg Productivity). Assembly factors are pooled from measured rows; the other stages use proxy assumptions.",
        };
        const worstOeeRow = [...assemblyRows].sort((a, b) => Number(a.oee) - Number(b.oee))[0] || null;
        const worstOleRow = [...assemblyRows]
            .filter((row) => Number.isFinite(Number(row.ole)))
            .sort((a, b) => Number(a.ole) - Number(b.ole))[0] || null;
        const quality = report.quality || {};
        const qualityFactors = quality.quality_factors || [];
        const leftovers = quality.leftovers || [];
        const safetyEvents = quality.safety_events || [];
        const worstOverallRow = [...assemblyRows]
            .map((row) => ({
                ...row,
                overallScore: avg([row.oee, row.ole]),
            }))
            .filter((row) => Number.isFinite(Number(row.overallScore)))
            .sort((a, b) => Number(a.overallScore) - Number(b.overallScore))[0] || null;

        let worstDayWastageKg = null;
        let worstDayHasRecordedWaste = false;
        let dayLeftoverKg = 0;
        let dayRejectedKg = 0;
        if (worstOverallRow) {
            const matchingLeftovers = leftovers
                .filter((item) => item.date === worstOverallRow.date);
            dayLeftoverKg = matchingLeftovers
                .reduce((sum, item) => sum + Number(item.leftover_kg || 0), 0);
            // Always include confirmed LR safety-event rejections for 27 Mar —
            // safety_events have no date field but are all tied to that day.
            dayRejectedKg = worstOverallRow.date === "27 Mar"
                ? safetyEvents.reduce((sum, item) => sum + Number(item.qty_kg || 0), 0)
                : 0;
            worstDayHasRecordedWaste = matchingLeftovers.length > 0 || dayRejectedKg > 0;
            worstDayWastageKg = worstDayHasRecordedWaste ? dayLeftoverKg + dayRejectedKg : null;
        }

        const cards = [
            {
                tone: "amber",
                label: "Facility OEE (Total-Factor)",
                value: pct(facilityOee),
                sub: `Total-factor: Avail ${pct(totalAvailability)} × Perf ${pct(totalPerformance)} × Qual ${pct(totalQuality)}`,
                badge: sourceBadge("Proxy", "proxy"),
            },
            {
                tone: "green",
                label: "Facility OLE (Total-Factor)",
                value: pct(facilityOle),
                sub: `Total-factor: Activation ${pct(totalActivation)} × Util ${pct(totalUtilisation)} × Prod ${pct(totalProductivity)}`,
                badge: sourceBadge("Derived", "derived"),
            },
            {
                tone: "red",
                label: "Worst Product OEE",
                value: worstOeeRow ? `${shortProduct(worstOeeRow.menu)} • ${pct(worstOeeRow.oee)}` : "N/A",
                sub: worstOeeRow ? `${worstOeeRow.date} · ${worstOeeRow.impact}` : "No measured assembly OEE rows available.",
                badge: sourceBadge("Measured", "live"),
            },
            {
                tone: "red",
                label: "Worst Product OLE",
                value: worstOleRow ? `${shortProduct(worstOleRow.menu)} • ${pct(worstOleRow.ole)}` : "N/A",
                sub: worstOleRow ? `${worstOleRow.date} · Activation fixed at 100% attendance assumption.` : "No derived assembly OLE rows available.",
                badge: sourceBadge("Derived", "derived"),
            },
        ];

        const summaryCards = [
            {
                tone: "amber",
                label: "Facility OEE (Total-Factor)",
                value: pct(facilityOee),
                sub: `Total-factor: Avail ${pct(totalAvailability)} × Perf ${pct(totalPerformance)} × Qual ${pct(totalQuality)}`,
                badge: sourceBadge("Hybrid", "derived"),
            },
            {
                tone: "green",
                label: "Facility OLE (Total-Factor)",
                value: pct(facilityOle),
                sub: `Total-factor: Activation ${pct(totalActivation)} × Util ${pct(totalUtilisation)} × Prod ${pct(totalProductivity)}`,
                badge: sourceBadge("Hybrid", "derived"),
            },
            {
                tone: "red",
                label: "Overall Worst Product",
                value: worstOverallRow ? `${shortProduct(worstOverallRow.menu)} - ${pct(worstOverallRow.overallScore)}` : "N/A",
                sub: worstOverallRow
                    ? `${worstOverallRow.date} | OEE ${pct(worstOverallRow.oee)} | OLE ${pct(worstOverallRow.ole)}`
                    : "No comparable assembly OEE/OLE rows available.",
                badge: sourceBadge("Measured + Derived", "derived"),
            },
            {
                tone: "amber",
                label: "Total Wastage on That Day",
                value: worstDayWastageKg !== null ? `${num(worstDayWastageKg, 2)} kg` : "N/A",
                sub: worstOverallRow
                    ? `${worstOverallRow.date} | ingredient leftovers (${num(dayLeftoverKg, 2)} kg) + LR batch rejections (${num(dayRejectedKg, 2)} kg thrown)`
                    : "No matching production day available.",
                badge: sourceBadge("Confirmed + Derived", "proxy"),
            },
        ];

        target.innerHTML = summaryCards.map((card) => `
            <div class="pfx-kpi-card pfx-kpi-card--${esc(card.tone)}">
                <span class="pfx-kpi-card__label">${esc(card.label)}</span>
                <span class="pfx-kpi-card__value">${esc(card.value)}</span>
                <span class="pfx-kpi-card__sub">${esc(card.sub)}</span>
                <div class="oee-card-badge-row">${card.badge}</div>
            </div>
        `).join("");
    }

    function renderOverview(prepGroups, cookingGroups, assemblyDateGroups, packingDateGroups) {
        const target = document.getElementById("trialStageOverviewCard");
        if (!target) return;

        const measurableAssembly = assemblyDateGroups.filter((group) => Number.isFinite(Number(group.oee)));
        const assemblyOee = weightedAvg(measurableAssembly, (group) => group.oee, (group) => group.totalOrdered || group.totalAssembled || 0);
        const assemblyOle = weightedAvg(measurableAssembly, (group) => group.ole, (group) => group.totalOrdered || group.totalAssembled || 0);
        const packingOle = avg((packingDateGroups || []).map((group) => group.ole));

        target.innerHTML = `
            ${sectionHeader("Stage Readiness", "What This Stage View Can Show Now", "Each section below is filled with trial data, but the metric status differs by stage based on what the source workbooks actually capture.")}
            <div class="trial-stage-summary-grid">
                <div class="trial-stage-summary-card">
                    <div class="trial-stage-summary-card__head">
                        <strong>Food Prep</strong>
                        ${sourceBadge("Assumed", "proxy")}
                    </div>
                    <div class="trial-stage-status-row">
                        <span class="trial-stage-status-pill">OEE: ${pct(proxyOee())}</span>
                        <span class="trial-stage-status-pill">OLE: ${pct(proxyOle())}</span>
                    </div>
                    <p class="card__helper">Task timing, kg output, workers, and kg/man/hr are available. OEE and OLE shown here use the agreed common trial assumptions because formal planned standards are still missing.</p>
                </div>
                <div class="trial-stage-summary-card">
                    <div class="trial-stage-summary-card__head">
                        <strong>Cooking</strong>
                        ${sourceBadge("Assumed", "proxy")}
                    </div>
                    <div class="trial-stage-status-row">
                        <span class="trial-stage-status-pill">OEE: ${pct(proxyOee())}</span>
                        <span class="trial-stage-status-pill">OLE: ${pct(proxyOle())}</span>
                    </div>
                    <p class="card__helper">Task timing, workers, kg output, kg/man/hr, and machine use are available. OEE and OLE shown here use the agreed common trial assumptions because LR planning standards are still incomplete.</p>
                </div>
                <div class="trial-stage-summary-card">
                    <div class="trial-stage-summary-card__head">
                        <strong>Assembly</strong>
                        ${sourceBadge("Measured", "live")}
                    </div>
                    <div class="trial-stage-status-row">
                        <span class="trial-stage-status-pill">OEE: ${pct(assemblyOee)}</span>
                        <span class="trial-stage-status-pill">OLE: ${pct(assemblyOle)}</span>
                    </div>
                    <p class="card__helper">Assembly has the strongest metric coverage. The line breakdown stays on the page and uses the HR batch data already extracted from the workbook set.</p>
                </div>
                <div class="trial-stage-summary-card">
                    <div class="trial-stage-summary-card__head">
                        <strong>Packing</strong>
                        ${sourceBadge("Hybrid", "derived")}
                    </div>
                    <div class="trial-stage-status-row">
                        <span class="trial-stage-status-pill">OEE: ${pct(proxyOee())}</span>
                        <span class="trial-stage-status-pill">OLE: ${pct(packingOle)}</span>
                    </div>
                    <p class="card__helper">Packing OEE uses the agreed proxy assumptions. Packing OLE keeps workbook utilization by date and applies the agreed 75% productivity assumption.</p>
                </div>
            </div>
        `;
    }

    function renderFoodPrep(prepGroups) {
        const target = document.getElementById("trialStageFoodPrepCard");
        if (!target) return;
        const defaultGroup = prepGroups[0];
        target.innerHTML = sectionHeader(
            "Food Prep",
            "Food Prep Section",
            "This section keeps the workbook task detail by date and overlays the agreed assumed OEE and OLE values where formal prep standards are still missing.",
            "trialFoodPrepSelect",
            "Date",
            prepGroups.map((group) => ({ value: group.key, label: group.label })),
            defaultGroup ? defaultGroup.key : ""
        ) + `<div id="trialFoodPrepDetail"></div>`;

        const select = document.getElementById("trialFoodPrepSelect");
        const detail = document.getElementById("trialFoodPrepDetail");
        if (!select || !detail || !defaultGroup) return;

        function renderGroup(group) {
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Food Prep OEE</span>
                        <strong class="oee-gap-card__value">${pct(proxyOee())}</strong>
                        <span class="oee-gap-card__detail">${proxyAssumptionLabel()}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Food Prep OLE</span>
                        <strong class="oee-gap-card__value">${pct(proxyOle())}</strong>
                        <span class="oee-gap-card__detail">Activation 100% | Utilization 80% | Productivity 75%</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Total Kg Output</span>
                        <strong class="oee-gap-card__value">${num(group.totalKg, 1)} kg</strong>
                        <span class="oee-gap-card__detail">${num(group.tasks.length)} prep tasks across ${num(group.menus.length)} meal(s)</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Avg Kg/Man/Hr</span>
                        <strong class="oee-gap-card__value">${group.avgKgManHr !== null ? num(group.avgKgManHr, 1) : "N/A"}</strong>
                        <span class="oee-gap-card__detail">Peak workers ${num(group.peakWorkers)} | ${formatMinutes(group.totalDuration)}</span>
                    </div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">OEE assumption: ${proxyAssumptionLabel()}</span>
                    <span class="oee-loss-pill">OLE assumption: matched headcount, 80% labour use, 75% productivity</span>
                    <span class="oee-loss-pill">Shifts: ${esc(group.shiftLabels.join(" | "))}</span>
                    <span class="oee-loss-pill">Meals: ${esc(group.menus.join(" | "))}</span>
                    ${group.machineSummary.length ? `<span class="oee-loss-pill">Top equipment: ${esc(group.machineSummary.join(" | "))}</span>` : ""}
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Shift</th>
                                <th>Meal</th>
                                <th>Component</th>
                                <th>Start</th>
                                <th>Stop</th>
                                <th>Duration</th>
                                <th>Workers</th>
                                <th>Kg Output</th>
                                <th>Kg/Man/Hr</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${group.tasks.map((task) => `
                                <tr>
                                    <td>${esc(task.shiftLabel)}</td>
                                    <td>${esc(shortProduct(task.menu))}</td>
                                    <td>${esc(task.component)}</td>
                                    <td>${esc(task.start)}</td>
                                    <td>${esc(task.stop)}</td>
                                    <td>${formatMinutes(task.duration_min)}</td>
                                    <td>${num(task.workers)}</td>
                                    <td>${num(task.kg_output, 2)}</td>
                                    <td>${num(task.kg_man_hr, 2)}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `;
        }

        renderGroup(defaultGroup);
        select.addEventListener("change", (event) => {
            const selected = prepGroups.find((group) => group.key === event.target.value) || defaultGroup;
            renderGroup(selected);
        });
    }

    function renderCooking(cookingGroups) {
        const target = document.getElementById("trialStageCookingCard");
        if (!target) return;
        const defaultGroup = cookingGroups[0];
        target.innerHTML = sectionHeader(
            "Cooking",
            "Cooking Section",
            "This section keeps the LR cooking detail by date and overlays the agreed assumed OEE and OLE values where planned hours, standards, and reject fields are still incomplete.",
            "trialCookingSelect",
            "Date",
            cookingGroups.map((group) => ({ value: group.key, label: group.label })),
            defaultGroup ? defaultGroup.key : ""
        ) + `<div id="trialCookingDetail"></div>`;

        const select = document.getElementById("trialCookingSelect");
        const detail = document.getElementById("trialCookingDetail");
        if (!select || !detail || !defaultGroup) return;

        function renderGroup(group) {
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Cooking OEE</span>
                        <strong class="oee-gap-card__value">${pct(proxyOee())}</strong>
                        <span class="oee-gap-card__detail">${proxyAssumptionLabel()}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Cooking OLE</span>
                        <strong class="oee-gap-card__value">${pct(proxyOle())}</strong>
                        <span class="oee-gap-card__detail">Activation 100% | Utilization 80% | Productivity 75%</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Total Kg Output</span>
                        <strong class="oee-gap-card__value">${num(group.totalKg, 1)} kg</strong>
                        <span class="oee-gap-card__detail">${num(group.tasks.length)} cooking tasks across ${num(group.menus.length)} meal(s)</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Avg Kg/Man/Hr</span>
                        <strong class="oee-gap-card__value">${group.avgKgManHr !== null ? num(group.avgKgManHr, 1) : "N/A"}</strong>
                        <span class="oee-gap-card__detail">Peak workers ${num(group.peakWorkers)} | ${formatMinutes(group.totalDuration)}</span>
                    </div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">OEE assumption: ${proxyAssumptionLabel()}</span>
                    <span class="oee-loss-pill">OLE assumption: matched headcount, 80% labour use, 75% productivity</span>
                    <span class="oee-loss-pill">Shifts: ${esc(group.shiftLabels.join(" | "))}</span>
                    <span class="oee-loss-pill">Meals in date: ${num(group.menus.length)}</span>
                    ${group.machineSummary.length ? `<span class="oee-loss-pill">Top machines: ${esc(group.machineSummary.join(" | "))}</span>` : ""}
                </div>
                <details class="trial-stage-collapse">
                    <summary>
                        <span>Meals in Selected Date</span>
                        <span>${num(group.menus.length)}</span>
                    </summary>
                    <div class="trial-stage-collapse__body">
                        <div class="trial-stage-pill-list">
                            ${group.menus.map((menu) => `<span class="oee-loss-pill">${esc(menu)}</span>`).join("")}
                        </div>
                    </div>
                </details>
                <details class="trial-stage-collapse">
                    <summary>
                        <span>Cooking Task Detail</span>
                        <span>${num(group.tasks.length)} rows</span>
                    </summary>
                    <div class="trial-stage-collapse__body">
                        <div class="oee-table-wrap">
                            <table class="data-table oee-mini-table">
                                <thead>
                                    <tr>
                                        <th>Shift</th>
                                        <th>Meal</th>
                                        <th>Component</th>
                                        <th>Start</th>
                                        <th>Stop</th>
                                        <th>Duration</th>
                                        <th>Workers</th>
                                        <th>Kg Output</th>
                                        <th>Kg/Man/Hr</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${group.tasks.map((task) => `
                                        <tr>
                                            <td>${esc(task.shiftLabel)}</td>
                                            <td>${esc(shortProduct(task.menu))}</td>
                                            <td>${esc(task.component)}</td>
                                            <td>${esc(task.start)}</td>
                                            <td>${esc(task.stop)}</td>
                                            <td>${formatMinutes(task.duration_min)}</td>
                                            <td>${num(task.workers)}</td>
                                            <td>${num(task.kg_output, 2)}</td>
                                            <td>${num(task.kg_man_hr, 2)}</td>
                                        </tr>
                                    `).join("")}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </details>
            `;
        }

        renderGroup(defaultGroup);
        select.addEventListener("change", (event) => {
            const selected = cookingGroups.find((group) => group.key === event.target.value) || defaultGroup;
            renderGroup(selected);
        });
    }

    function renderAssembly(report, trialData) {
        const target = document.getElementById("trialStageAssemblyCard");
        if (!target) return;
        const dateGroups = buildAssemblyDateGroups(report, trialData);
        const defaultGroup = dateGroups[0];

        target.innerHTML = sectionHeader(
            "Assembly",
            "Assembly Section",
            "Assembly now opens by date first. Each selected day shows daily OEE/OLE at the top, then the underlying meal rows and the existing line breakdown underneath.",
            "trialAssemblyStageSelect",
            "Date",
            dateGroups.map((group) => ({ value: group.key, label: group.label })),
            defaultGroup ? defaultGroup.key : ""
        ) + `<div id="trialAssemblyStageDetail"></div>`;

        const select = document.getElementById("trialAssemblyStageSelect");
        const detail = document.getElementById("trialAssemblyStageDetail");
        if (!select || !detail || !defaultGroup) return;

        function renderDate(group) {
            const lineRows = group.rows.flatMap((row) =>
                buildAssemblyLineModel(trialData, row).map((line) => ({
                    ...line,
                    product: shortProduct(row.menu),
                    assemblyDate: row.date,
                }))
            );
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Assembly OEE</span>
                        <strong class="oee-gap-card__value">${pct(group.oee)}</strong>
                        <span class="oee-gap-card__detail">Selected day OEE</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Assembly OLE</span>
                        <strong class="oee-gap-card__value">${pct(group.ole)}</strong>
                        <span class="oee-gap-card__detail">Selected day OLE</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Ordered / Assembled</span>
                        <strong class="oee-gap-card__value">${num(group.totalAssembled)}</strong>
                        <span class="oee-gap-card__detail">${num(group.totalOrdered)} ordered | ${num(group.rows.length)} meal row(s)</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Assembly Lines</span>
                        <strong class="oee-gap-card__value">${num(lineRows.length)}</strong>
                        <span class="oee-gap-card__detail">Estimated line rows from HR batches</span>
                    </div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">${esc(group.trialDay?.note || group.dailyTotal?.note || "No daily note available.")}</span>
                    ${group.dailyTotal?.impact ? `<span class="oee-loss-pill">${esc(group.dailyTotal.impact)}</span>` : ""}
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Meal</th>
                                <th>Lot</th>
                                <th>Plan Rate</th>
                                <th>Actual Rate</th>
                                <th>Plan Window</th>
                                <th>Assembly Time</th>
                                <th>Meals/hr</th>
                                <th>Total Window</th>
                                <th>Availability</th>
                                <th>Performance</th>
                                <th>Quality</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${group.rows.map((row) => `
                                <tr>
                                    <td>${esc(shortProduct(row.menu))}</td>
                                    <td>${esc(row.lot)}</td>
                                    <td>${num(row.plan_tray_min, 1)} t/m</td>
                                    <td>${row.actual_tray_min !== null ? `${num(row.actual_tray_min, 1)} t/m` : "N/R"}</td>
                                    <td>${formatMinutes(row.plan_window_min)}</td>
                                    <td>${row.assembly_time_min !== null ? formatMinutes(row.assembly_time_min) : "N/R"}</td>
                                    <td>${mealsPerHour(row) !== null ? `${num(Math.round(mealsPerHour(row)))} /hr` : "N/R"}</td>
                                    <td>${row.total_window_min !== null ? formatMinutes(row.total_window_min) : "N/R"}</td>
                                    <td>${pct(row.availability)}</td>
                                    <td>${pct(row.performance)}</td>
                                    <td>${pct(row.quality)}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
                <div class="trial-stage-line-wrap">
                    <div class="trial-stage-line-title-row">
                        <p class="eyebrow">Assembly Lines</p>
                        ${sourceBadge("Estimated", "derived")}
                    </div>
                    <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                        ${lineRows.length ? lineRows.map((line) => `
                            <div class="oee-gap-card">
                                <span class="oee-gap-card__label">Line ${esc(line.line)}</span>
                                <strong class="oee-gap-card__value">${pct(line.oee)}</strong>
                                <span class="oee-gap-card__bench">Estimated OLE ${pct(line.ole)} | Attainment ${pct(line.attainment)}</span>
                                <span class="oee-gap-card__detail">${esc(line.assemblyDate)} | ${esc(line.product)} | ${num(line.assembled)} allocated meals | Staff ${line.staff !== null ? num(line.staff) : "N/R"}</span>
                            </div>
                        `).join("") : renderUnavailableKpi("Line Breakdown", "No target-bearing HR batches were available for this product.")}
                    </div>
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead>
                                <tr>
                                    <th>Meal</th>
                                    <th>Line</th>
                                    <th>Allocated Target</th>
                                    <th>Allocated Assembled</th>
                                    <th>Attainment</th>
                                    <th>Estimated OEE</th>
                                    <th>Estimated OLE</th>
                                    <th>Staff</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${lineRows.length ? lineRows.map((line) => `
                                    <tr>
                                        <td>${esc(line.product)}</td>
                                        <td>${esc(line.line)}</td>
                                        <td>${num(line.target)}</td>
                                        <td>${num(line.assembled)}</td>
                                        <td>${pct(line.attainment)}</td>
                                        <td>${pct(line.oee)}</td>
                                        <td>${pct(line.ole)}</td>
                                        <td>${line.staff !== null ? num(line.staff) : "N/R"}</td>
                                    </tr>
                                `).join("") : `
                                    <tr><td colspan="8">No target-bearing HR batches were available for this selected date.</td></tr>
                                `}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        renderDate(defaultGroup);
        select.addEventListener("change", (event) => {
            const selected = dateGroups.find((group) => group.key === event.target.value) || defaultGroup;
            renderDate(selected);
        });
    }

    function renderPacking(trialData, report) {
        const target = document.getElementById("trialStagePackingCard");
        if (!target) return;
        const groups = buildPackingDateGroups(trialData, report);
        const defaultGroup = groups[0];

        target.innerHTML = sectionHeader(
            "Packing",
            "Packing Section",
            "Packing now opens by date first. Each selected day keeps workbook utilization and throughput, then applies the agreed 75% productivity assumption to calculate OLE.",
            "trialPackingStageSelect",
            "Date",
            groups.map((group) => ({ value: group.key, label: group.label })),
            defaultGroup ? defaultGroup.key : ""
        ) + `<div id="trialPackingStageDetail"></div>`;

        const select = document.getElementById("trialPackingStageSelect");
        const detail = document.getElementById("trialPackingStageDetail");
        if (!select || !detail || !defaultGroup) return;

        function renderGroup(group) {
            const utilization = avg(group.utilizationRows.map((row) => row.utilization));
            const ole = Number.isFinite(Number(group.partialOle)) ? Number(group.partialOle) * PROXY_ASSUMPTION.productivityPct : null;
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Packing OEE</span>
                        <strong class="oee-gap-card__value">${pct(proxyOee())}</strong>
                        <span class="oee-gap-card__detail">${proxyAssumptionLabel()}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Packing OLE</span>
                        <strong class="oee-gap-card__value">${pct(ole)}</strong>
                        <span class="oee-gap-card__detail">Activation 100% x utilization x 75% productivity</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Meals Packed</span>
                        <strong class="oee-gap-card__value">${num(group.totalMeals)}</strong>
                        <span class="oee-gap-card__detail">${num(group.sessions.length)} session row(s) | ${num(group.products.length)} meal(s)</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Actual Meals/Man/Hr</span>
                        <strong class="oee-gap-card__value">${group.actualMealsPerManHr !== null ? num(group.actualMealsPerManHr, 1) : "N/A"}</strong>
                        <span class="oee-gap-card__detail">${num(group.totalManHours, 1)} man-hours | ${num(group.totalCartons)} cartons</span>
                    </div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">Assigned Medium Risk staff ${num(STAFF_ASSUMPTION.mediumRisk)} | attendance assumed 100%</span>
                    <span class="oee-loss-pill">Packing OEE assumption: ${proxyAssumptionLabel()}</span>
                    <span class="oee-loss-pill">Packing OLE uses measured utilization and 75% productivity</span>
                    <span class="oee-loss-pill">Meals: ${esc(group.products.join(" | "))}</span>
                    <span class="oee-loss-pill">${group.headcount ? esc(group.headcount.source_note) : "No headcount row matched to this date."}</span>
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>OEE</th>
                                <th>Activation</th>
                                <th>Utilization</th>
                                <th>Productivity</th>
                                <th>OLE</th>
                                <th>Workers</th>
                                <th>Meals/Man/Hr</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>${pct(proxyOee())}</td>
                                <td>${pct(group.activation)}</td>
                                <td>${pct(utilization)}</td>
                                <td>${pct(PROXY_ASSUMPTION.productivityPct)}</td>
                                <td>${pct(ole)}</td>
                                <td>${group.headcount ? num(group.headcount.activated) : "N/R"}</td>
                                <td>${group.actualMealsPerManHr !== null ? num(group.actualMealsPerManHr, 1) : "N/R"}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="oee-table-wrap" style="margin-top:16px">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>Meal</th>
                                <th>Lot</th>
                                <th>Start</th>
                                <th>Stop</th>
                                <th>Duration</th>
                                <th>Workers</th>
                                <th>Meals</th>
                                <th>Meal/Man/Hr</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${group.sessions.map((session) => `
                                <tr>
                                    <td>${esc(group.dateLabel)}</td>
                                    <td>${esc(shortProduct(session.menu))}</td>
                                    <td>${esc(`${session.lot || "-"}-${session.no || "-"}`)}</td>
                                    <td>${esc(session.start)}</td>
                                    <td>${esc(session.stop)}</td>
                                    <td>${formatMinutes(session.duration_min)}</td>
                                    <td>${num(session.workers)}</td>
                                    <td>${num(session.meals)}</td>
                                    <td>${session.meal_man_hr !== null ? num(session.meal_man_hr, 1) : "N/R"}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `;
        }

        renderGroup(defaultGroup);
        select.addEventListener("change", (event) => {
            const selected = groups.find((group) => group.key === event.target.value) || defaultGroup;
            renderGroup(selected);
        });
    }

    function renderMealPerformance(report) {
        const target = document.getElementById("trialStageMealCard");
        if (!target) return;
        const meals = buildAssemblyProducts(report);
        const defaultMeal = meals[0];

        target.innerHTML = sectionHeader(
            "Meal Efficiency (Assembly stage)",
            "Assembly OEE and OLE by Meal Produced",
            "Per-meal effectiveness for the ASSEMBLY stage only (Food Prep, Cooking and Packing not included). OEE and OLE come from the workbook-backed assembly rows.",
            "trialMealStageSelect",
            "Meal",
            meals.map((meal) => ({ value: meal.key, label: meal.label })),
            defaultMeal ? defaultMeal.key : ""
        ) + `<div id="trialMealStageDetail"></div>`;

        const select = document.getElementById("trialMealStageSelect");
        const detail = document.getElementById("trialMealStageDetail");
        if (!select || !detail || !defaultMeal) return;

        function renderMeal(meal) {
            const quality = findQualityFactor(report, meal);
            const flow = findFlowContext(report, meal);
            const lrCount = (flow && flow.lr_tasks ? flow.lr_tasks.length : 0);
            const mrCount = (flow && flow.mr ? flow.mr.length : 0);
            const chainQuality = quality && quality.chain_quality !== null && quality.chain_quality !== undefined
                ? quality.chain_quality
                : null;

            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Assembly Meal OEE</span>
                        <strong class="oee-gap-card__value">${pct(meal.oee)}</strong>
                        <span class="oee-gap-card__detail">${esc(meal.date)} | Lot ${esc(meal.lot)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Assembly Meal OLE</span>
                        <strong class="oee-gap-card__value">${pct(meal.ole)}</strong>
                        <span class="oee-gap-card__detail">Derived from availability x performance</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Ordered / Assembled</span>
                        <strong class="oee-gap-card__value">${num(meal.assembled)}</strong>
                        <span class="oee-gap-card__detail">${num(meal.ordered)} ordered | ${esc(meal.impact || "No impact note")}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Quality Context</span>
                        <strong class="oee-gap-card__value">${chainQuality !== null ? pct(chainQuality) : pct(meal.quality)}</strong>
                        <span class="oee-gap-card__detail">${chainQuality !== null ? "Chain quality" : "HR quality only"}</span>
                    </div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">Root cause: ${esc(meal.root_cause || "No root cause note available.")}</span>
                    <span class="oee-loss-pill">Plan ${num(meal.plan_tray_min, 1)} t/m | Actual ${meal.actual_tray_min !== null ? `${num(meal.actual_tray_min, 1)} t/m` : "N/R"}</span>
                    ${quality?.basis ? `<span class="oee-loss-pill">${esc(quality.basis)}</span>` : ""}
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Lot</th>
                                <th>Availability</th>
                                <th>Performance</th>
                                <th>Quality</th>
                                <th>Plan Window</th>
                                <th>Assembly Time</th>
                                <th>Total Window</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>${esc(meal.date)}</td>
                                <td>${esc(meal.lot)}</td>
                                <td>${pct(meal.availability)}</td>
                                <td>${pct(meal.performance)}</td>
                                <td>${pct(meal.quality)}</td>
                                <td>${formatMinutes(meal.plan_window_min)}</td>
                                <td>${meal.assembly_time_min !== null ? formatMinutes(meal.assembly_time_min) : "N/R"}</td>
                                <td>${meal.total_window_min !== null ? formatMinutes(meal.total_window_min) : "N/R"}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            `;
        }

        renderMeal(defaultMeal);
        select.addEventListener("change", (event) => {
            const selected = meals.find((meal) => meal.key === event.target.value) || defaultMeal;
            renderMeal(selected);
        });
    }

    function renderQuality(report) {
        const target = document.getElementById("trialStageQualityCard");
        if (!target) return;

        const quality = report.quality || {};
        const events = quality.safety_events || [];
        const leftovers = quality.leftovers || [];
        const totals = quality.leftover_totals || [];

        target.innerHTML = `
            ${sectionHeader(
                "Quality Events",
                "Confirmed Rejection and Chain Quality",
                "This section brings in the confirmed quality clarifications from the workbook so the trial page no longer implies that the 27 Mar herb-egg issue hit HR assembly quality directly."
            )}
            <div class="oee-loss-summary" style="margin-bottom:16px">
                ${quality.headline ? `<span class="oee-loss-pill oee-loss-pill--wide">${esc(quality.headline)}</span>` : ""}
                ${quality.chain_note ? `<span class="oee-loss-pill oee-loss-pill--wide">${esc(quality.chain_note)}</span>` : ""}
                ${totals.map((item) => `<span class="oee-loss-pill">${esc(item.label)}: ${num(item.leftover_kg, 2)} kg</span>`).join("")}
            </div>
            <div class="oee-table-wrap" style="margin-bottom:16px">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Stage</th>
                            <th>Detail</th>
                            <th>Qty (kg)</th>
                            <th>LR Quality</th>
                            <th>HR Quality</th>
                            <th>Root Cause</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${events.map((event) => `
                            <tr>
                                <td>${esc(event.stage)}</td>
                                <td>${esc(event.detail)}</td>
                                <td>${num(event.qty_kg, 2)}</td>
                                <td>${pct(event.lr_quality)}</td>
                                <td>${event.hr_quality ? esc(event.hr_quality) : "-"}</td>
                                <td>${event.root_cause ? esc(event.root_cause) : "-"}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            <div class="oee-table-wrap">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Menu</th>
                            <th>Component</th>
                            <th>Leftover (kg)</th>
                            <th>Tray-Equivalent Excess</th>
                            <th>Leftover %</th>
                            <th>Impact</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${leftovers.map((item) => `
                            <tr>
                                <td>${esc(item.date)}</td>
                                <td>${esc(item.menu)}</td>
                                <td>${esc(item.component)}</td>
                                <td>${num(item.leftover_kg, 2)}</td>
                                <td>${num(item.tray_equiv_excess)}</td>
                                <td>${pct(item.leftover_pct)}</td>
                                <td>${esc(item.impact)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderTopSummaryByDate(report, assemblyDateGroups, packingDateGroups, selectedDateLabel) {
        const target = document.getElementById("trialStageSummary");
        if (!target) return;

        const assemblyRows = buildAssemblyProducts(report)
            .filter((row) => row.oee !== null)
            .filter((row) => selectedDateLabel === ALL_DATES_VALUE || row.date === selectedDateLabel);
        const filteredPackingGroups = (packingDateGroups || []).filter((group) =>
            selectedDateLabel === ALL_DATES_VALUE || (group.dateLabel || group.label) === selectedDateLabel
        );
        // Per-stage values are kept for the factor breakdown and the AI context.
        const assemblyOee = weightedAvg(assemblyRows, (row) => row.oee, (row) => row.ordered || row.assembled || 0);
        const assemblyOle = weightedAvg(assemblyRows, (row) => row.ole, (row) => row.ordered || row.assembled || 0);
        const packingOle = avg(filteredPackingGroups.map((group) => group.ole));
        const foodPrepOee = proxyOee();
        const cookingOee = proxyOee();
        const packingOee = proxyOee();

        // ── Total-factor facility roll-up (scoped to the selected date) ─────────
        const aFac = pooledAssemblyFactors(assemblyRows);
        const packingUtil = pooledPackingUtilization(report, selectedDateLabel);
        const proxyA = proxyAvailability();

        // Packing Availability + Activation become measured only when an MR
        // workbook is uploaded; Performance/Productivity/Quality stay proxy.
        const packingMeasured = report.packing && report.packing.source === "uploaded";
        const packingAvail = packingMeasured
            ? pooledPackingAvailability(report, selectedDateLabel) : proxyA;
        const packingActivation = packingMeasured
            ? pooledPackingActivation(report, selectedDateLabel) : STAFF_ASSUMPTION.attendancePct;

        const totalAvailability = avg([proxyA, proxyA, aFac.availability, packingAvail]);
        const totalPerformance  = avg([PROXY_ASSUMPTION.performancePct, PROXY_ASSUMPTION.performancePct, aFac.performance, PROXY_ASSUMPTION.performancePct]);
        const totalQuality      = avg([PROXY_ASSUMPTION.qualityPct, PROXY_ASSUMPTION.qualityPct, aFac.quality, PROXY_ASSUMPTION.qualityPct]);
        const facilityOee = [totalAvailability, totalPerformance, totalQuality].every((v) => Number.isFinite(Number(v)))
            ? totalAvailability * totalPerformance * totalQuality
            : null;

        // Assembly Utilisation uses the measured HR labour log when uploaded,
        // otherwise falls back to assembly availability as a proxy stand-in.
        const asmLabour = (report.assembly && report.assembly.labour_source === "uploaded")
            ? assemblyLabourTotals(report, selectedDateLabel) : null;
        const asmUtil = (asmLabour && asmLabour.utilisation != null) ? asmLabour.utilisation : aFac.availability;

        const totalActivation   = avg([STAFF_ASSUMPTION.attendancePct, STAFF_ASSUMPTION.attendancePct, STAFF_ASSUMPTION.attendancePct, packingActivation]);
        const totalUtilisation  = avg([PROXY_ASSUMPTION.utilizedLabourPct, PROXY_ASSUMPTION.utilizedLabourPct, asmUtil, packingUtil]);
        const totalProductivity = avg([PROXY_ASSUMPTION.productivityPct, PROXY_ASSUMPTION.productivityPct, aFac.performance, PROXY_ASSUMPTION.productivityPct]);
        const facilityOle = [totalActivation, totalUtilisation, totalProductivity].every((v) => Number.isFinite(Number(v)))
            ? totalActivation * totalUtilisation * totalProductivity
            : null;

        // Measured stage values (match the section cards) so the AI assistant and
        // the cards agree. Packing is measured only when its MR file is uploaded.
        const pct1 = (v) => (Number.isFinite(Number(v)) ? Math.round(v * 1000) / 10 : null);
        const packingOeeCard = Number.isFinite(Number(packingAvail))
            ? packingAvail * PROXY_ASSUMPTION.performancePct * PROXY_ASSUMPTION.qualityPct
            : packingOee;
        const packingOleCard = (packingMeasured && Number.isFinite(Number(packingActivation)) && Number.isFinite(Number(packingUtil)))
            ? packingActivation * packingUtil * PROXY_ASSUMPTION.productivityPct
            : packingOle;

        window.PAGE_KPI = {
            page: "oee-trial-stages",
            date_filter: selectedDateLabel === ALL_DATES_VALUE ? "All Dates (25-28 Mar)" : selectedDateLabel,
            facility_oee_pct: pct1(facilityOee),
            facility_ole_pct: pct1(facilityOle),
            facility_factors: {
                availability_pct: pct1(totalAvailability), performance_pct: pct1(totalPerformance), quality_pct: pct1(totalQuality),
                activation_pct: pct1(totalActivation), utilisation_pct: pct1(totalUtilisation), productivity_pct: pct1(totalProductivity),
            },
            stage_oee_pct: {
                food_prep: pct1(foodPrepOee),
                cooking: pct1(cookingOee),
                assembly: pct1(assemblyOee),
                packing: pct1(packingOeeCard),
            },
            stage_ole_pct: {
                food_prep: pct1(proxyOle()),
                cooking: pct1(proxyOle()),
                assembly: pct1(assemblyOle),
                packing: pct1(packingOleCard),
            },
            stage_basis: {
                food_prep: "proxy", cooking: "proxy",
                assembly: "measured (Availability/Performance/Quality from uploaded workbook)",
                packing: packingMeasured
                    ? "measured Availability/Activation/Utilisation; Performance/Quality/Productivity proxy"
                    : "proxy",
            },
            method: "Total-factor method. Facility OEE = (avg Availability) x (avg Performance) x (avg Quality) across the 4 stages; Facility OLE = (avg Activation) x (avg Utilisation) x (avg Productivity). Each stage contributes its own factor values (measured where available, else proxy); this is NOT a simple average of stage OEEs.",
        };

        const quality = report.quality || {};
        const qualityFactors = quality.quality_factors || [];
        const leftovers = quality.leftovers || [];
        const safetyEvents = quality.safety_events || [];
        const worstOverallRow = [...assemblyRows]
            .map((row) => ({ ...row, overallScore: avg([row.oee, row.ole]) }))
            .filter((row) => Number.isFinite(Number(row.overallScore)))
            .sort((a, b) => Number(a.overallScore) - Number(b.overallScore))[0] || null;

        let worstDayWastageKg = null;
        let worstDayHasRecordedWaste = false;
        let dayLeftoverKg = 0;
        let dayRejectedKg = 0;
        if (worstOverallRow) {
            const matchingLeftovers = leftovers
                .filter((item) => item.date === worstOverallRow.date);
            dayLeftoverKg = matchingLeftovers
                .reduce((sum, item) => sum + Number(item.leftover_kg || 0), 0);
            // Always include confirmed LR safety-event rejections for 27 Mar —
            // safety_events have no date field but are all tied to that day.
            dayRejectedKg = worstOverallRow.date === "27 Mar"
                ? safetyEvents.reduce((sum, item) => sum + Number(item.qty_kg || 0), 0)
                : 0;
            worstDayHasRecordedWaste = matchingLeftovers.length > 0 || dayRejectedKg > 0;
            worstDayWastageKg = worstDayHasRecordedWaste ? dayLeftoverKg + dayRejectedKg : null;
        }

        const label = selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : selectedDateLabel;
        const summaryCards = [
            {
                tone: "amber",
                label: "Facility OEE (Total-Factor)",
                value: pct(facilityOee),
                sub: `${label} | Avail ${pct(totalAvailability)} × Perf ${pct(totalPerformance)} × Qual ${pct(totalQuality)}`,
                badge: sourceBadge("Total-Factor", "derived"),
            },
            {
                tone: "green",
                label: "Facility OLE (Total-Factor)",
                value: pct(facilityOle),
                sub: `${label} | Activation ${pct(totalActivation)} × Util ${pct(totalUtilisation)} × Prod ${pct(totalProductivity)}`,
                badge: sourceBadge("Total-Factor", "derived"),
            },
            {
                tone: "red",
                label: "Overall Worst Product",
                value: worstOverallRow ? `${shortProduct(worstOverallRow.menu)} - ${pct(worstOverallRow.overallScore)}` : "N/A",
                sub: worstOverallRow
                    ? `${worstOverallRow.date} | OEE ${pct(worstOverallRow.oee)} | OLE ${pct(worstOverallRow.ole)}`
                    : `${label} | no comparable assembly OEE/OLE rows available.`,
                badge: sourceBadge("Measured + Derived", "derived"),
            },
            {
                tone: "amber",
                label: "Total Wastage on That Day",
                value: worstDayWastageKg !== null ? `${num(worstDayWastageKg, 2)} kg` : "N/A",
                sub: worstOverallRow
                    ? `${worstOverallRow.date} | ingredient leftovers (${num(dayLeftoverKg, 2)} kg) + LR batch rejections (${num(dayRejectedKg, 2)} kg thrown)`
                    : `${label} | no matching wastage day available.`,
                badge: sourceBadge("Confirmed + Derived", "proxy"),
            },
        ];

        target.innerHTML = summaryCards.map((card) => `
            <div class="pfx-kpi-card pfx-kpi-card--${esc(card.tone)}">
                <span class="pfx-kpi-card__label">${esc(card.label)}</span>
                <span class="pfx-kpi-card__value">${esc(card.value)}</span>
                <span class="pfx-kpi-card__sub">${esc(card.sub)}</span>
                <div class="oee-card-badge-row">${card.badge}</div>
            </div>
        `).join("");
    }

    function renderFoodPrepByDate(prepGroups, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageFoodPrepCard");
        if (!target) return;
        const group = buildCombinedLrGroup(prepGroups, selectedDateLabel);
        target.innerHTML = sectionHeader(
            "Food Prep",
            "Food Prep Section",
            "This section keeps the workbook task detail for the selected trial date and overlays the agreed assumed OEE and OLE values where formal prep standards are still missing.",
            [{
                id: "trialFoodPrepLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }]
        ) + `<div id="trialFoodPrepDetail"></div>`;
        const localSelect = document.getElementById("trialFoodPrepLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
        const detail = document.getElementById("trialFoodPrepDetail");
        if (!detail) return;
        if (!group) {
            detail.innerHTML = renderUnavailableKpi("Food Prep", "No Food Prep data exists for the selected date.");
            return;
        }
        detail.innerHTML = `
            <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Food Prep OEE</span>
                    <strong class="oee-gap-card__value">${pct(proxyOee())}</strong>
                    <span class="oee-gap-card__detail">${proxyAssumptionLabel()}</span>
                </div>
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Food Prep OLE</span>
                    <strong class="oee-gap-card__value">${pct(proxyOle())}</strong>
                    <span class="oee-gap-card__detail">Activation 100% | Utilization 80% | Productivity 75%</span>
                </div>
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Total Kg Output</span>
                    <strong class="oee-gap-card__value">${num(group.totalKg, 1)} kg</strong>
                    <span class="oee-gap-card__detail">${num(group.tasks.length)} prep tasks across ${num(group.menus.length)} meal(s)</span>
                </div>
                <div class="oee-gap-card">
                    <span class="oee-gap-card__label">Avg Kg/Man/Hr</span>
                    <strong class="oee-gap-card__value">${group.avgKgManHr !== null ? num(group.avgKgManHr, 1) : "N/A"}</strong>
                    <span class="oee-gap-card__detail">Peak workers ${num(group.peakWorkers)} | ${formatMinutes(group.totalDuration)}</span>
                </div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                <span class="oee-loss-pill">OEE assumption: ${proxyAssumptionLabel()}</span>
                <span class="oee-loss-pill">OLE assumption: matched headcount, 80% labour use, 75% productivity</span>
                <span class="oee-loss-pill">Shifts: ${esc(group.shiftLabels.join(" | "))}</span>
                <span class="oee-loss-pill">Meals: ${esc(group.menus.join(" | "))}</span>
                ${group.machineSummary.length ? `<span class="oee-loss-pill">Top equipment: ${esc(group.machineSummary.join(" | "))}</span>` : ""}
            </div>
            <details class="trial-stage-collapse">
                <summary><span>Meals in Selected Scope</span><span>${num(group.menus.length)}</span></summary>
                <div class="trial-stage-collapse__body"><div class="trial-stage-pill-list">${group.menus.map((menu) => `<span class="oee-loss-pill">${esc(menu)}</span>`).join("")}</div></div>
            </details>
            <details class="trial-stage-collapse">
                <summary><span>Food Prep Task Detail</span><span>${num(group.tasks.length)} rows</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>Shift</th><th>Meal</th><th>Component</th><th>Start</th><th>Stop</th><th>Duration</th><th>Workers</th><th>Kg Output</th><th>Kg/Man/Hr</th></tr></thead>
                            <tbody>
                                ${group.tasks.map((task) => `
                                    <tr>
                                        <td>${esc(task.shiftLabel)}</td>
                                        <td>${esc(shortProduct(task.menu))}</td>
                                        <td>${esc(task.component)}</td>
                                        <td>${esc(task.start)}</td>
                                        <td>${esc(task.stop)}</td>
                                        <td>${formatMinutes(task.duration_min)}</td>
                                        <td>${num(task.workers)}</td>
                                        <td>${num(task.kg_output, 2)}</td>
                                        <td>${num(task.kg_man_hr, 2)}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function renderCookingByDate(cookingGroups, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageCookingCard");
        if (!target) return;
        const group = buildCombinedLrGroup(cookingGroups, selectedDateLabel);
        target.innerHTML = sectionHeader(
            "Cooking",
            "Cooking Section",
            "This section keeps the LR cooking detail for the selected trial date and overlays the agreed assumed OEE and OLE values where planned hours, standards, and reject fields are still incomplete.",
            [{
                id: "trialCookingLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }]
        ) + `<div id="trialCookingDetail"></div>`;
        const localSelect = document.getElementById("trialCookingLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
        const detail = document.getElementById("trialCookingDetail");
        if (!detail) return;
        if (!group) {
            detail.innerHTML = renderUnavailableKpi("Cooking", "No Cooking data exists for the selected date.");
            return;
        }
        const cookingMenuBreakdown = buildMenuMachineBreakdown(group.tasks);
        detail.innerHTML = `
            <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                <div class="oee-gap-card"><span class="oee-gap-card__label">Cooking OEE</span><strong class="oee-gap-card__value">${pct(proxyOee())}</strong><span class="oee-gap-card__detail">${proxyAssumptionLabel()}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Cooking OLE</span><strong class="oee-gap-card__value">${pct(proxyOle())}</strong><span class="oee-gap-card__detail">Activation 100% | Utilization 80% | Productivity 75%</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Total Kg Output</span><strong class="oee-gap-card__value">${num(group.totalKg, 1)} kg</strong><span class="oee-gap-card__detail">${num(group.tasks.length)} cooking tasks across ${num(group.menus.length)} meal(s)</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Avg Kg/Man/Hr</span><strong class="oee-gap-card__value">${group.avgKgManHr !== null ? num(group.avgKgManHr, 1) : "N/A"}</strong><span class="oee-gap-card__detail">Peak workers ${num(group.peakWorkers)} | ${formatMinutes(group.totalDuration)}</span></div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                <span class="oee-loss-pill">OEE assumption: ${proxyAssumptionLabel()}</span>
                <span class="oee-loss-pill">OLE assumption: matched headcount, 80% labour use, 75% productivity</span>
                <span class="oee-loss-pill">Shifts: ${esc(group.shiftLabels.join(" | "))}</span>
                <span class="oee-loss-pill">Meals in scope: ${num(group.menus.length)}</span>
                ${group.machineSummary.length ? `<span class="oee-loss-pill">Top machines: ${esc(group.machineSummary.join(" | "))}</span>` : ""}
            </div>
            <details class="trial-stage-collapse">
                <summary><span>Meals in Selected Scope</span><span>${num(group.menus.length)}</span></summary>
                <div class="trial-stage-collapse__body"><div class="trial-stage-pill-list">${group.menus.map((menu) => `<span class="oee-loss-pill">${esc(menu)}</span>`).join("")}</div></div>
            </details>
            <details class="trial-stage-collapse">
                <summary><span>Equipment Usage Time</span><span>${num(group.machineUsage.length)} equipment row(s)</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>Equipment</th><th>Total Usage Time</th><th>Usage (hr)</th><th>Output Processed (Kg)</th><th>Task References</th></tr></thead>
                            <tbody>
                                ${group.machineUsage.length ? group.machineUsage.map((row) => `
                                    <tr>
                                        <td>${esc(row.machine)}</td>
                                        <td>${num(row.minutes)} min</td>
                                        <td>${num(row.minutes / 60, 2)} hr</td>
                                        <td>${num(row.kg, 1)} kg</td>
                                        <td>${num(row.tasks)}</td>
                                    </tr>
                                `).join("") : `<tr><td colspan="5">No machine usage rows were recorded for the selected date.</td></tr>`}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
            <details class="trial-stage-collapse">
                <summary><span>Menu / Step / Machine Breakdown</span><span>${num(cookingMenuBreakdown.length)} meal(s)</span></summary>
                <div class="trial-stage-collapse__body">
                    <p class="trial-stage-note">Each meal's cooking steps with the machine(s) used and how long each ran. Repeated batches of a step are merged: machine times show the total run time across all batches, with the average time for one batch in brackets. Step duration and Kg are summed across the batches.</p>
                    ${cookingMenuBreakdown.map((menu) => `
                        <details class="trial-stage-collapse trial-stage-collapse--nested">
                            <summary><span>${esc(shortProduct(menu.menu))}</span><span>${num(menu.steps.length)} step(s) | ${num(menu.totalKg, 1)} kg | ${formatMinutes(menu.totalDuration)}</span></summary>
                            <div class="trial-stage-collapse__body">
                                <div class="oee-table-wrap">
                                    <table class="data-table oee-mini-table">
                                        <thead><tr><th>Step</th><th>Machine(s) &amp; Run Time</th><th>Step Duration</th><th>Output (Kg)</th><th>Shift</th></tr></thead>
                                        <tbody>
                                            ${menu.steps.map((step) => `
                                                <tr>
                                                    <td>${esc(step.component)}${step.batches > 1 ? ` <span class="trial-stage-muted">(${num(step.batches)} batches)</span>` : ""}</td>
                                                    <td>${step.machines.length
                                                        ? step.machines.map((m) => `${esc(m.machine)} — ${num(m.minutes)} min${step.batches > 1 ? ` <span class="trial-stage-muted">(${num(m.perBatch, 1)} min/batch)</span>` : ""}`).join("<br>")
                                                        : '<span class="trial-stage-muted">No machine recorded</span>'}</td>
                                                    <td>${formatMinutes(step.duration)}</td>
                                                    <td>${num(step.kg, 2)}</td>
                                                    <td>${esc(step.shiftLabel)}</td>
                                                </tr>
                                            `).join("")}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </details>
                    `).join("")}
                </div>
            </details>
            <details class="trial-stage-collapse">
                <summary><span>Cooking Task Detail</span><span>${num(group.tasks.length)} rows</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>Shift</th><th>Meal</th><th>Component</th><th>Start</th><th>Stop</th><th>Duration</th><th>Workers</th><th>Kg Output</th><th>Kg/Man/Hr</th></tr></thead>
                            <tbody>
                                ${group.tasks.map((task) => `
                                    <tr>
                                        <td>${esc(task.shiftLabel)}</td>
                                        <td>${esc(shortProduct(task.menu))}</td>
                                        <td>${esc(task.component)}</td>
                                        <td>${esc(task.start)}</td>
                                        <td>${esc(task.stop)}</td>
                                        <td>${formatMinutes(task.duration_min)}</td>
                                        <td>${num(task.workers)}</td>
                                        <td>${num(task.kg_output, 2)}</td>
                                        <td>${num(task.kg_man_hr, 2)}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function renderAssemblyByDate(report, trialData, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageAssemblyCard");
        if (!target) return;
        const group = buildCombinedAssemblyGroup(report, trialData, selectedDateLabel);
        target.innerHTML = sectionHeader(
            "Assembly",
            "Assembly Section",
            "Assembly now follows the selected trial date from the global filter. It shows daily or all-date OEE/OLE at the top, then the underlying meal rows and the existing line breakdown underneath.",
            [{
                id: "trialAssemblyLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }]
        ) + `<div id="trialAssemblyStageDetail"></div>`;
        const localSelect = document.getElementById("trialAssemblyLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
        const detail = document.getElementById("trialAssemblyStageDetail");
        if (!detail) return;
        if (!group) {
            detail.innerHTML = renderUnavailableKpi("Assembly", "No Assembly data exists for the selected date.");
            return;
        }
        const lineRows = group.rows.flatMap((row) =>
            buildAssemblyLineModel(trialData, row).map((line) => ({
                ...line,
                product: shortProduct(row.menu),
                assemblyDate: row.date,
            }))
        );
        // Real labour from the HR production log (when uploaded).
        const asmLabour = (report.assembly && report.assembly.labour_source === "uploaded")
            ? assemblyLabourTotals(report, selectedDateLabel) : null;
        const mealsPerManHr = (asmLabour && asmLabour.manHours > 0)
            ? group.totalAssembled / asmLabour.manHours : null;
        detail.innerHTML = `
            <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly OEE</span><strong class="oee-gap-card__value">${pct(group.oee)}</strong><span class="oee-gap-card__detail">${selectedDateLabel === ALL_DATES_VALUE ? "All-date weighted OEE" : "Selected day OEE"}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly OLE</span><strong class="oee-gap-card__value">${pct(group.ole)}</strong><span class="oee-gap-card__detail">${asmLabour ? `Utilisation ${pct(asmLabour.utilisation)} measured (HR)` : (selectedDateLabel === ALL_DATES_VALUE ? "All-date weighted OLE" : "Selected day OLE")}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Ordered / Assembled</span><strong class="oee-gap-card__value">${num(group.totalAssembled)}</strong><span class="oee-gap-card__detail">${num(group.totalOrdered)} ordered | ${num(group.rows.length)} meal row(s)</span></div>
                ${asmLabour ? `
                <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly Man-Hours</span><strong class="oee-gap-card__value">${num(asmLabour.manHours, 1)}</strong><span class="oee-gap-card__detail">From HR log · Utilisation ${pct(asmLabour.utilisation)}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Meals / Man-Hr</span><strong class="oee-gap-card__value">${mealsPerManHr != null ? num(mealsPerManHr, 1) : "N/A"}</strong><span class="oee-gap-card__detail">${num(group.totalAssembled)} meals ÷ man-hours</span></div>
                ` : ""}
                <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly Lines</span><strong class="oee-gap-card__value">${num(lineRows.length)}</strong><span class="oee-gap-card__detail">Estimated line rows from HR batches</span></div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                ${group.notes.map((note) => `<span class="oee-loss-pill">${esc(note)}</span>`).join("")}
                ${group.impacts.map((impact) => `<span class="oee-loss-pill">${esc(impact)}</span>`).join("")}
            </div>
            <details class="trial-stage-collapse">
                <summary><span>Assembly Meal Detail</span><span>${num(group.rows.length)} rows</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>Meal</th><th>Lot</th><th>Plan Rate</th><th>Actual Rate</th><th>Plan Window</th><th>Assembly Time</th><th>Meals/hr</th><th>Total Window</th><th>Downtime</th><th>Availability</th><th>Performance</th><th>Quality</th></tr></thead>
                            <tbody>
                                ${group.rows.map((row) => `
                                    <tr>
                                        <td>${esc(shortProduct(row.menu))}</td>
                                        <td>${esc(row.lot)}</td>
                                        <td>${num(row.plan_tray_min, 1)} t/m</td>
                                        <td>${row.actual_tray_min !== null ? `${num(row.actual_tray_min, 1)} t/m` : "N/R"}</td>
                                        <td>${formatMinutes(row.plan_window_min)}</td>
                                        <td>${row.assembly_time_min !== null ? formatMinutes(row.assembly_time_min) : "N/R"}</td>
                                        <td>${mealsPerHour(row) !== null ? `${num(Math.round(mealsPerHour(row)))} /hr` : "N/R"}</td>
                                        <td>${row.total_window_min !== null ? formatMinutes(row.total_window_min) : "N/R"}</td>
                                        <td>${formatDowntime(row)}</td>
                                        <td>${pct(row.availability)}</td>
                                        <td>${pct(row.performance)}</td>
                                        <td>${pct(row.quality)}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
            <div class="trial-stage-line-wrap">
                <div class="trial-stage-line-title-row"><p class="eyebrow">Assembly Lines</p>${sourceBadge("Estimated", "derived")}</div>
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    ${lineRows.length ? lineRows.map((line) => `
                        <div class="oee-gap-card">
                            <span class="oee-gap-card__label">Line ${esc(line.line)}</span>
                            <strong class="oee-gap-card__value">${pct(line.oee)}</strong>
                            <span class="oee-gap-card__bench">Estimated OLE ${pct(line.ole)} | Attainment ${pct(line.attainment)}</span>
                            <span class="oee-gap-card__detail">${esc(line.assemblyDate)} | ${esc(line.product)} | ${num(line.assembled)} allocated meals | Staff ${line.staff !== null ? num(line.staff) : "N/R"}</span>
                        </div>
                    `).join("") : renderUnavailableKpi("Line Breakdown", "No target-bearing HR batches were available for this selection.")}
                </div>
            </div>
        `;
    }

    function renderPackingByDate(trialData, report, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStagePackingCard");
        if (!target) return;
        const group = buildCombinedPackingGroup(trialData, report, selectedDateLabel);
        target.innerHTML = sectionHeader(
            "Packing",
            "Packing Section",
            "Packing now follows the selected trial date from the global filter. It keeps workbook utilization and throughput, then applies the agreed 75% productivity assumption to calculate OLE.",
            [{
                id: "trialPackingLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }]
        ) + `<div id="trialPackingStageDetail"></div>`;
        const localSelect = document.getElementById("trialPackingLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
        const detail = document.getElementById("trialPackingStageDetail");
        if (!detail) return;
        if (!group) {
            detail.innerHTML = renderUnavailableKpi("Packing", "No Packing data exists for the selected date.");
            return;
        }
        // When an MR workbook is uploaded, Packing Availability + Activation +
        // Utilisation are measured; Performance/Quality/Productivity stay proxy.
        const packingMeasured = report.packing && report.packing.source === "uploaded";
        const packAvail = packingMeasured ? pooledPackingAvailability(report, selectedDateLabel) : proxyAvailability();
        const packAct = packingMeasured ? pooledPackingActivation(report, selectedDateLabel) : STAFF_ASSUMPTION.attendancePct;
        const utilization = packingMeasured
            ? pooledPackingUtilization(report, selectedDateLabel)
            : avg(group.utilizationRows.map((row) => row.utilization));
        const packOee = Number.isFinite(Number(packAvail))
            ? packAvail * PROXY_ASSUMPTION.performancePct * PROXY_ASSUMPTION.qualityPct
            : proxyOee();
        const ole = packingMeasured
            ? (Number.isFinite(Number(packAct)) && Number.isFinite(Number(utilization))
                ? packAct * utilization * PROXY_ASSUMPTION.productivityPct : null)
            : (Number.isFinite(Number(group.partialOle)) ? Number(group.partialOle) * PROXY_ASSUMPTION.productivityPct : null);
        const packOeeDetail = packingMeasured
            ? `Avail ${pct(packAvail)} measured x Perf 80% x Qual 100%`
            : proxyAssumptionLabel();
        const packOleDetail = packingMeasured
            ? `Activation ${pct(packAct)} x Util ${pct(utilization)} x 75% productivity`
            : "Activation 100% x utilization x 75% productivity";
        detail.innerHTML = `
            <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                <div class="oee-gap-card"><span class="oee-gap-card__label">Packing OEE</span><strong class="oee-gap-card__value">${pct(packOee)}</strong><span class="oee-gap-card__detail">${packOeeDetail}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Packing OLE</span><strong class="oee-gap-card__value">${pct(ole)}</strong><span class="oee-gap-card__detail">${packOleDetail}</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Meals Packed</span><strong class="oee-gap-card__value">${num(group.totalMeals)}</strong><span class="oee-gap-card__detail">${num(group.sessions.length)} session row(s) | ${num(group.products.length)} meal(s)</span></div>
                <div class="oee-gap-card"><span class="oee-gap-card__label">Actual Meals/Man/Hr</span><strong class="oee-gap-card__value">${group.actualMealsPerManHr !== null ? num(group.actualMealsPerManHr, 1) : "N/A"}</strong><span class="oee-gap-card__detail">${num(group.totalManHours, 1)} man-hours | ${num(group.totalCartons)} cartons</span></div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                <span class="oee-loss-pill">${packingMeasured ? `Measured headcount | activation ${pct(packAct)}` : `Assigned Medium Risk staff ${num(STAFF_ASSUMPTION.mediumRisk)} | attendance assumed 100%`}</span>
                <span class="oee-loss-pill">${packingMeasured ? `Packing OEE: measured availability x 80% performance x 100% quality` : `Packing OEE assumption: ${proxyAssumptionLabel()}`}</span>
                <span class="oee-loss-pill">Packing OLE uses measured utilization and 75% productivity</span>
                <span class="oee-loss-pill">Meals: ${esc(group.products.join(" | "))}</span>
                <span class="oee-loss-pill">${group.headcount ? esc(group.headcount.source_note) : "All-date aggregate uses the fixed staffing assumption."}</span>
            </div>
            <details class="trial-stage-collapse">
                <summary><span>Packing OEE / OLE Inputs</span><span>1 row</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>OEE</th><th>Activation</th><th>Utilization</th><th>Productivity</th><th>OLE</th><th>Workers</th><th>Meals/Man/Hr</th></tr></thead>
                            <tbody><tr><td>${pct(packOee)}</td><td>${pct(packingMeasured ? packAct : group.activation)}</td><td>${pct(utilization)}</td><td>${pct(PROXY_ASSUMPTION.productivityPct)}</td><td>${pct(ole)}</td><td>${group.headcount ? num(group.headcount.activated) : num(STAFF_ASSUMPTION.mediumRisk)}</td><td>${group.actualMealsPerManHr !== null ? num(group.actualMealsPerManHr, 1) : "N/R"}</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </details>
            <details class="trial-stage-collapse">
                <summary><span>Packing Session Detail</span><span>${num(group.sessions.length)} rows</span></summary>
                <div class="trial-stage-collapse__body">
                    <div class="oee-table-wrap">
                        <table class="data-table oee-mini-table">
                            <thead><tr><th>Session</th><th>Meal</th><th>Lot</th><th>Start</th><th>Stop</th><th>Duration</th><th>Workers</th><th>Meals</th><th>Meal/Man/Hr</th></tr></thead>
                            <tbody>
                                ${group.sessions.map((session) => `
                                    <tr>
                                        <td>${esc(group.dateLabel)}</td>
                                        <td>${esc(shortProduct(session.menu))}</td>
                                        <td>${esc(`${session.lot || "-"}-${session.no || "-"}`)}</td>
                                        <td>${esc(session.start)}</td>
                                        <td>${esc(session.stop)}</td>
                                        <td>${formatMinutes(session.duration_min)}</td>
                                        <td>${num(session.workers)}</td>
                                        <td>${num(session.meals)}</td>
                                        <td>${session.meal_man_hr !== null ? num(session.meal_man_hr, 1) : "N/R"}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function renderMealPerformanceByDate(report, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageMealCard");
        if (!target) return;
        const meals = buildAssemblyProducts(report).filter((meal) =>
            selectedDateLabel === ALL_DATES_VALUE || meal.date === selectedDateLabel
        );
        const defaultMeal = meals[0];
        target.innerHTML = sectionHeader(
            "Meal Efficiency (Assembly stage)",
            "Assembly OEE and OLE by Meal Produced",
            "Per-meal effectiveness for the ASSEMBLY stage only — from the workbook-backed assembly rows. Food Prep, Cooking and Packing are not included (they have no per-meal OEE). Quality and cross-stage traceability are shown underneath.",
            [
                {
                    id: "trialMealLocalDateSelect",
                    label: "Date",
                    options: dateOptions,
                    selectedValue: selectedDateLabel,
                    disabled: globalLocked,
                },
                ...(meals.length > 0 ? [{
                    id: "trialMealStageSelect",
                    label: "Meal",
                    options: meals.map((meal) => ({ value: meal.key, label: meal.label })),
                    selectedValue: defaultMeal ? defaultMeal.key : "",
                    disabled: false,
                }] : []),
            ]
        ) + `<div id="trialMealStageDetail"></div>`;
        const localDateSelect = document.getElementById("trialMealLocalDateSelect");
        if (localDateSelect && !globalLocked) {
            localDateSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
        const detail = document.getElementById("trialMealStageDetail");
        if (!detail) return;
        if (!defaultMeal) {
            detail.innerHTML = renderUnavailableKpi("Meal Efficiency", "No meal-level assembly rows exist for the selected date.");
            return;
        }
        const select = document.getElementById("trialMealStageSelect");
        function renderMeal(meal) {
            const quality = findQualityFactor(report, meal);
            const flow = findFlowContext(report, meal);
            const lrCount = (flow && flow.lr_tasks ? flow.lr_tasks.length : 0);
            const mrCount = (flow && flow.mr ? flow.mr.length : 0);
            const chainQuality = quality && quality.chain_quality !== null && quality.chain_quality !== undefined ? quality.chain_quality : null;
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly Meal OEE</span><strong class="oee-gap-card__value">${pct(meal.oee)}</strong><span class="oee-gap-card__detail">${esc(meal.date)} | Lot ${esc(meal.lot)} | assembly stage only</span></div>
                    <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly Meal OLE</span><strong class="oee-gap-card__value">${pct(meal.ole)}</strong><span class="oee-gap-card__detail">Assembly availability x performance</span></div>
                    <div class="oee-gap-card"><span class="oee-gap-card__label">Ordered / Assembled</span><strong class="oee-gap-card__value">${num(meal.assembled)}</strong><span class="oee-gap-card__detail">${num(meal.ordered)} ordered | ${esc(meal.impact || "No impact note")}</span></div>
                    <div class="oee-gap-card"><span class="oee-gap-card__label">Quality Context</span><strong class="oee-gap-card__value">${chainQuality !== null ? pct(chainQuality) : pct(meal.quality)}</strong><span class="oee-gap-card__detail">${chainQuality !== null ? "Chain quality" : "HR quality only"}</span></div>
                </div>
                <div class="oee-loss-summary">
                    <span class="oee-loss-pill">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                    <span class="oee-loss-pill">Root cause: ${esc(meal.root_cause || "No root cause note available.")}</span>
                    <span class="oee-loss-pill">Plan ${num(meal.plan_tray_min, 1)} t/m | Actual ${meal.actual_tray_min !== null ? `${num(meal.actual_tray_min, 1)} t/m` : "N/R"}</span>
                    ${quality?.basis ? `<span class="oee-loss-pill">${esc(quality.basis)}</span>` : ""}
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead><tr><th>Date</th><th>Lot</th><th>Availability</th><th>Performance</th><th>Quality</th><th>Plan Window</th><th>Assembly Time</th><th>Total Window</th></tr></thead>
                        <tbody><tr><td>${esc(meal.date)}</td><td>${esc(meal.lot)}</td><td>${pct(meal.availability)}</td><td>${pct(meal.performance)}</td><td>${pct(meal.quality)}</td><td>${formatMinutes(meal.plan_window_min)}</td><td>${meal.assembly_time_min !== null ? formatMinutes(meal.assembly_time_min) : "N/R"}</td><td>${meal.total_window_min !== null ? formatMinutes(meal.total_window_min) : "N/R"}</td></tr></tbody>
                    </table>
                </div>
            `;
        }
        renderMeal(defaultMeal);
        if (select) {
            select.addEventListener("change", (event) => {
                const selected = meals.find((meal) => meal.key === event.target.value) || defaultMeal;
                renderMeal(selected);
            });
        }
    }

    function renderQualityByDate(report, selectedDateLabel, dateOptions, globalLocked, onDateChange) {
        const target = document.getElementById("trialStageQualityCard");
        if (!target) return;
        const quality = report.quality || {};
        const events = selectedDateLabel === ALL_DATES_VALUE || selectedDateLabel === "27 Mar"
            ? (quality.safety_events || [])
            : [];
        const leftovers = (quality.leftovers || []).filter((item) =>
            selectedDateLabel === ALL_DATES_VALUE || item.date === selectedDateLabel
        );
        const leftoverTotal = leftovers.reduce((sum, item) => sum + Number(item.leftover_kg || 0), 0);
        const eventTotal = events.reduce((sum, item) => sum + Number(item.qty_kg || 0), 0);
        target.innerHTML = `
            ${sectionHeader("Quality Events", "Confirmed Rejection and Chain Quality", "This section follows the selected global date and keeps the confirmed quality clarifications from the workbook visible.", [{
                id: "trialQualityLocalDateSelect",
                label: "Date",
                options: dateOptions,
                selectedValue: selectedDateLabel,
                disabled: globalLocked,
            }])}
            <div class="oee-loss-summary" style="margin-bottom:16px">
                <span class="oee-loss-pill oee-loss-pill--wide">${selectedDateLabel === ALL_DATES_VALUE ? "All Dates" : esc(selectedDateLabel)}</span>
                ${quality.headline && (selectedDateLabel === ALL_DATES_VALUE || selectedDateLabel === "27 Mar") ? `<span class="oee-loss-pill oee-loss-pill--wide">${esc(quality.headline)}</span>` : ""}
                ${quality.chain_note && (selectedDateLabel === ALL_DATES_VALUE || selectedDateLabel === "27 Mar") ? `<span class="oee-loss-pill oee-loss-pill--wide">${esc(quality.chain_note)}</span>` : ""}
                <span class="oee-loss-pill">Selected leftover total: ${num(leftoverTotal, 2)} kg</span>
                ${events.length ? `<span class="oee-loss-pill">Selected confirmed LR rejection: ${num(eventTotal, 2)} kg</span>` : ""}
            </div>
            <div class="oee-table-wrap" style="margin-bottom:16px">
                <table class="data-table oee-mini-table">
                    <thead><tr><th>Stage</th><th>Detail</th><th>Qty (kg)</th><th>LR Quality</th><th>HR Quality</th><th>Root Cause</th></tr></thead>
                    <tbody>
                        ${events.length ? events.map((event) => `
                            <tr><td>${esc(event.stage)}</td><td>${esc(event.detail)}</td><td>${num(event.qty_kg, 2)}</td><td>${pct(event.lr_quality)}</td><td>${event.hr_quality ? esc(event.hr_quality) : "-"}</td><td>${event.root_cause ? esc(event.root_cause) : "-"}</td></tr>
                        `).join("") : `<tr><td colspan="6">No confirmed rejection event is recorded for the selected date.</td></tr>`}
                    </tbody>
                </table>
            </div>
            <div class="oee-table-wrap">
                <table class="data-table oee-mini-table">
                    <thead><tr><th>Date</th><th>Menu</th><th>Component</th><th>Leftover (kg)</th><th>Tray-Equivalent Excess</th><th>Leftover %</th><th>Impact</th></tr></thead>
                    <tbody>
                        ${leftovers.length ? leftovers.map((item) => `
                            <tr><td>${esc(item.date)}</td><td>${esc(item.menu)}</td><td>${esc(item.component)}</td><td>${num(item.leftover_kg, 2)}</td><td>${num(item.tray_equiv_excess)}</td><td>${pct(item.leftover_pct)}</td><td>${esc(item.impact)}</td></tr>
                        `).join("") : `<tr><td colspan="7">No leftover yield-loss rows are recorded for the selected date.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;
        const localSelect = document.getElementById("trialQualityLocalDateSelect");
        if (localSelect && !globalLocked) {
            localSelect.addEventListener("change", (event) => onDateChange(event.target.value));
        }
    }

    function renderFlow(report) {
        const target = document.getElementById("trialStageFlowCard");
        if (!target) return;
        const products = buildFlowProducts(report);
        const defaultProduct = products[0];

        if (!defaultProduct) {
            target.innerHTML = sectionHeader(
                "Production Flow",
                "Production Flow by Product",
                "No product flow rows are currently available in the workbook-backed dataset."
            );
            return;
        }

        target.innerHTML = sectionHeader(
            "Production Flow",
            "Production Flow by Product",
            "Showing all available products, including partially matched LR to HR to MR chains.",
            "trialFlowStageSelect",
            "Meal",
            products.map((product) => ({ value: product.key, label: product.label })),
            defaultProduct ? defaultProduct.key : ""
        ) + `<div id="trialFlowStageDetail"></div>`;

        const select = document.getElementById("trialFlowStageSelect");
        const detail = document.getElementById("trialFlowStageDetail");
        if (!select || !detail || !defaultProduct) return;

        function renderProduct(product) {
            const e2eDisp = flowE2EDisplay(flowEndToEnd(product));
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Selected Meal</span>
                        <strong class="oee-gap-card__value" style="font-size:1.1rem">${esc(product.label)}</strong>
                        <span class="oee-gap-card__detail">Lot(s): ${esc(product.lots)} | ${esc(product.matchStatus)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">End-to-End Time</span>
                        <strong class="oee-gap-card__value">${esc(e2eDisp.value)}</strong>
                        <span class="oee-gap-card__detail">${esc(e2eDisp.detail)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">LR Tasks</span>
                        <strong class="oee-gap-card__value">${num((product.lr_tasks || []).length)}</strong>
                        <span class="oee-gap-card__detail">Prep and cooking context rows</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">HR Meals</span>
                        <strong class="oee-gap-card__value">${num(product.hr?.meals_assembled || 0)}</strong>
                        <span class="oee-gap-card__detail">Assembly OEE ${pct(product.hr?.oee)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">MR Sessions</span>
                        <strong class="oee-gap-card__value">${num((product.mr || []).length)}</strong>
                        <span class="oee-gap-card__detail">Downstream packing rows</span>
                    </div>
                </div>
                <p class="card__helper" style="margin:-4px 0 12px">End-to-End Time = earliest shown prep start to last packing stop (elapsed time, includes idle waiting between stages). Meals packed across multiple days are split per packing day; "pack only" means that day's prep was bulk-done earlier and counted in the first cycle. 24 Mar pre-trial prep excluded.</p>
                <div class="oee-flow-stack">
                    <div class="oee-flow-product">
                        <div class="oee-flow-product__head">
                            <div>
                                <strong>${esc(product.product)}</strong>
                                <span class="oee-flow-product__lot">Lot(s): ${esc(product.lots)}</span>
                            </div>
                        </div>
                        <div class="oee-flow-lane">
                            <p class="eyebrow">LR Tasks</p>
                            <div class="oee-table-wrap">
                                <table class="data-table oee-mini-table">
                                    <thead>
                                        <tr>
                                            <th>Sheet</th>
                                            <th>Task</th>
                                            <th>Start</th>
                                            <th>Stop</th>
                                            <th>Duration</th>
                                            <th>Workers</th>
                                            <th>Output</th>
                                            <th>Component</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${(product.lr_tasks || []).map((task) => `
                                            <tr>
                                                <td>${esc(task.sheet)}</td>
                                                <td>${esc(task.task)}</td>
                                                <td>${esc(task.start)}</td>
                                                <td>${esc(task.stop)}</td>
                                                <td>${esc(task.duration)}</td>
                                                <td>${esc(task.workers)}</td>
                                                <td>${esc(task.output)}</td>
                                                <td>${esc(task.component)}</td>
                                            </tr>
                                        `).join("")}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div class="oee-flow-lane">
                            <p class="eyebrow">HR Assembly</p>
                            <div class="oee-trial-comparison-grid">
                                <div class="oee-gap-card"><span class="oee-gap-card__label">Window</span><strong class="oee-gap-card__value">${formatMinutes(product.hr?.total_window_min)}</strong><span class="oee-gap-card__detail">${esc(product.hr?.start || "N/R")} to ${esc(product.hr?.stop || "N/R")}</span></div>
                                <div class="oee-gap-card"><span class="oee-gap-card__label">Assembly Time</span><strong class="oee-gap-card__value">${formatMinutes(product.hr?.assembly_min)}</strong><span class="oee-gap-card__detail">${num(product.hr?.meals_assembled || 0)} meals</span></div>
                                <div class="oee-gap-card"><span class="oee-gap-card__label">Quality</span><strong class="oee-gap-card__value">${pct(product.hr?.quality)}</strong><span class="oee-gap-card__detail">Plan ${product.hr?.plan_tray_min !== null && product.hr?.plan_tray_min !== undefined ? num(product.hr.plan_tray_min, 1) : "N/R"} t/m</span></div>
                                <div class="oee-gap-card"><span class="oee-gap-card__label">OEE</span><strong class="oee-gap-card__value">${pct(product.hr?.oee)}</strong><span class="oee-gap-card__detail">Actual ${product.hr?.actual_tray_min !== null && product.hr?.actual_tray_min !== undefined ? num(product.hr.actual_tray_min, 1) : "N/R"} t/m</span></div>
                            </div>
                        </div>
                        <div class="oee-flow-lane">
                            <p class="eyebrow">MR Packing</p>
                            <div class="oee-table-wrap">
                                <table class="data-table oee-mini-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Lot</th>
                                            <th>Sub-lot</th>
                                            <th>Start</th>
                                            <th>Stop</th>
                                            <th>Duration</th>
                                            <th>Workers</th>
                                            <th>Meals Packed</th>
                                            <th>Cartons</th>
                                            <th>Meals/Man/Hr</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${(product.mr || []).map((row) => `
                                            <tr>
                                                <td>${esc(row.date)}</td>
                                                <td>${esc(row.lot)}</td>
                                                <td>${esc(row.sub_lot)}</td>
                                                <td>${esc(row.start)}</td>
                                                <td>${esc(row.stop)}</td>
                                                <td>${esc(row.duration_min)}</td>
                                                <td>${esc(row.workers)}</td>
                                                <td>${num(row.meals_packed)}</td>
                                                <td>${esc(row.cartons)}</td>
                                                <td>${esc(row.meals_per_man_hr)}</td>
                                            </tr>
                                        `).join("")}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        ${product.note ? `<p class="card__helper" style="margin-top:12px">${esc(product.note)}</p>` : ""}
                </div>
            </div>
        `;
    }

        renderProduct(defaultProduct);
        select.addEventListener("change", (event) => {
            const selected = products.find((product) => product.key === event.target.value) || defaultProduct;
            renderProduct(selected);
        });
    }

    function renderNotes() {
        const target = document.getElementById("trialStageNotesCard");
        if (!target) return;
        target.innerHTML = `
            ${sectionHeader("Data Notes", "What Is Filled In Versus What Is Still Missing", "This page is meant to show the UI with the trial data already available, while keeping the metric limits explicit instead of hiding them.")}
            <ul class="oee-note-list">
                <li>Food Prep and Cooking now show assumed OEE and OLE using the agreed common trial assumptions, while still keeping the workbook task detail by date underneath.</li>
                <li>Assembly keeps the workbook-backed product-level OEE and derived OLE with the existing estimated line breakdown retained below the selected date.</li>
                <li>Packing OEE now follows the common proxy assumptions, while Packing OLE keeps workbook utilization by date and applies the agreed 75% productivity assumption.</li>
                <li>Production Flow by Product remains on the page as a separate section so you can still inspect LR to HR to MR context for a chosen meal.</li>
            </ul>
        `;
    }

    async function init() {
        try {
            const [report, trialData] = await Promise.all([
                fetchJson("/api/oee-report"),
                fetchJson("/api/trial-run-data"),
            ]);

            let prepGroups = buildLrStageDateGroups(trialData, "food_prep");
            let cookingGroups = buildLrStageDateGroups(trialData, "cooking");

            // When a cooking workbook has been uploaded on the Data page, drive the
            // Food Prep and Cooking sections from it (restricted to the page's
            // dates), split by the workbook's Section/Job. Falls back on error.
            try {
                const status = await fetchJson("/api/data-status");
                if (status && status.cooking && status.cooking.source === "uploaded") {
                    const lrData = await fetchJson("/api/lr-production-data");
                    const dateLabelByIso = new Map(ALLOWED_TRIAL_DATES.map((d) => [d.iso, d.label]));
                    const lrCooking = buildLrGroupsFromUpload(lrData, dateLabelByIso, "cooking");
                    const lrPrep = buildLrGroupsFromUpload(lrData, dateLabelByIso, "food_prep");
                    if (lrCooking.length) cookingGroups = lrCooking;
                    if (lrPrep.length) prepGroups = lrPrep;
                }
            } catch (e) { /* keep trial_run_data cooking/prep on any failure */ }

            const assemblyDateGroups = buildAssemblyDateGroups(report, trialData);
            const packingDateGroups = buildPackingDateGroups(trialData, report);
            const dateOptions = buildGlobalDateOptions(prepGroups, cookingGroups, assemblyDateGroups, packingDateGroups);
            let globalDateLabel = ALL_DATES_VALUE;
            const localDateState = {
                foodPrep: ALL_DATES_VALUE,
                cooking: ALL_DATES_VALUE,
                assembly: ALL_DATES_VALUE,
                packing: ALL_DATES_VALUE,
                meal: ALL_DATES_VALUE,
                quality: ALL_DATES_VALUE,
                processFlow: ALL_DATES_VALUE,
            };

            function effectiveDate(key) {
                return globalDateLabel !== ALL_DATES_VALUE ? globalDateLabel : localDateState[key];
            }

            function applyFilters() {
                renderGlobalDateFilter(dateOptions, globalDateLabel);
                const globalSelect = document.getElementById("trialStageGlobalDateSelect");
                if (globalSelect) {
                    globalSelect.addEventListener("change", (event) => {
                        globalDateLabel = event.target.value;
                        applyFilters();
                    }, { once: true });
                }
                renderTopSummaryByDate(report, assemblyDateGroups, packingDateGroups, globalDateLabel);
                renderFoodPrepByDate(prepGroups, effectiveDate("foodPrep"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.foodPrep = dateValue;
                    applyFilters();
                });
                renderCookingByDate(cookingGroups, effectiveDate("cooking"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.cooking = dateValue;
                    applyFilters();
                });
                renderAssemblyByDate(report, trialData, effectiveDate("assembly"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.assembly = dateValue;
                    applyFilters();
                });
                renderPackingByDate(trialData, report, effectiveDate("packing"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.packing = dateValue;
                    applyFilters();
                });
                renderMealPerformanceByDate(report, effectiveDate("meal"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.meal = dateValue;
                    applyFilters();
                });
                renderQualityByDate(report, effectiveDate("quality"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.quality = dateValue;
                    applyFilters();
                });
                renderProcessFlowTimelineByDate(report, trialData, prepGroups, cookingGroups, effectiveDate("processFlow"), dateOptions, globalDateLabel !== ALL_DATES_VALUE, (dateValue) => {
                    localDateState.processFlow = dateValue;
                    applyFilters();
                });
            }

            renderOverview(prepGroups, cookingGroups, assemblyDateGroups, packingDateGroups);
            renderFlow(report);
            renderNotes();
            applyFilters();
        } catch (error) {
            console.warn("Unable to render trial stage breakdown page", error);
            const filterCard = document.getElementById("trialStageFilterCard");
            if (filterCard) {
                filterCard.innerHTML = `
                    <div>
                        <p class="eyebrow">Historical View</p>
                        <h2 class="tr-context-banner__title">Stage breakdown data unavailable</h2>
                        <p class="card__helper">The page could not load the workbook-derived trial dataset. Retry once the source files are available.</p>
                    </div>
                `;
            }
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
