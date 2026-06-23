(function () {
    const REFERENCE = {
        facility: { oee: 81.6, ole: 86.3 },
        assembly: { oee: 88.16, ole: 84.05 },
    };
    const STAFF_ASSUMPTION = {
        batching: 26,
        lowRisk: 99,
        highRisk: 78,
        mediumRisk: 24,
        total: 227,
        attendancePct: 1,
    };

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
        if (Number.isFinite(digits)) return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
        return n.toLocaleString();
    }

    function pct(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "N/A";
    }

    function pctNumber(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "N/A";
    }

    function avg(values) {
        const items = (values || []).filter((value) => Number.isFinite(Number(value))).map(Number);
        if (!items.length) return null;
        return items.reduce((sum, value) => sum + value, 0) / items.length;
    }

    function toneForPct(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "gray";
        if (n >= 80) return "green";
        if (n >= 60) return "amber";
        return "red";
    }

    function sourceBadge(label, tone) {
        return `<span class="oee-source-badge oee-source-badge--${tone}">${esc(label)}</span>`;
    }

    function formatMinutes(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return "N/A";
        const hours = Math.floor(n / 60);
        const mins = Math.round(n % 60);
        return hours ? `${hours}h ${mins}m` : `${mins} min`;
    }

    function shortProduct(name) {
        return String(name || "").split("(")[0].replace(/\s+/g, " ").trim();
    }

    function normalizeProductKey(name) {
        const withoutLot = String(name || "").replace(/lot\.?\s*\d+.*/gi, " ");
        const asciiOnly = withoutLot.replace(/[^\x00-\x7F]/g, " ");
        return asciiOnly
            .replace(/[^a-zA-Z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function parseLines(value) {
        return String(value || "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function sectionTitle(eyebrow, title, helper) {
        return `
            <div class="card__header">
                <div>
                    <p class="eyebrow">${esc(eyebrow)}</p>
                    <h2>${esc(title)}</h2>
                    ${helper ? `<p class="card__helper">${esc(helper)}</p>` : ""}
                </div>
            </div>
        `;
    }

    function buildPackingDisplayModel(report) {
        const headcount = (report.packing.headcount || []).map((row) => ({
            ...row,
            scheduled: STAFF_ASSUMPTION.mediumRisk,
            absent: 0,
            activated: STAFF_ASSUMPTION.mediumRisk,
            activation: STAFF_ASSUMPTION.attendancePct,
            source_note: `Dashboard assumption override: Medium Risk assigned headcount fixed at ${STAFF_ASSUMPTION.mediumRisk}; assumed 100% attendance.`,
        }));

        const partialSummary = (report.packing.partial_summary || []).map((row) => ({
            ...row,
            activation: STAFF_ASSUMPTION.attendancePct,
            partial_ole: row.utilization !== null && row.utilization !== undefined
                ? row.utilization * STAFF_ASSUMPTION.attendancePct
                : null,
            note: `Activation overridden to 100% attendance using assigned Medium Risk headcount of ${STAFF_ASSUMPTION.mediumRisk}.`,
        }));

        return {
            ...report.packing,
            headcount,
            partial_summary: partialSummary,
            assumption_note: `Packing OLE on this page assumes assigned Medium Risk staffing of ${STAFF_ASSUMPTION.mediumRisk} and 100% attendance for every trial date.`,
        };
    }

    async function fetchJson(path) {
        const response = await fetch(path, { cache: "no-store" });
        return response.json();
    }

    function buildLineEstimateModel(report, trialData) {
        const hrDays = (trialData.stages && trialData.stages.hr_days) || [];
        const rows = report.assembly.rows.filter((row) => row.oee !== null);
        const lineMap = {};
        let allocatableAssembled = 0;
        let measurableAssembled = 0;
        const unallocatedProducts = [];

        rows.forEach((row) => {
            measurableAssembled += Number(row.assembled || 0);
            const hrDay = hrDays.find((entry) => entry.date === `2026-03-${String({ "25 Mar": 25, "26 Mar": 26, "27 Mar": 27, "28 Mar": 28 }[row.date] || "").padStart(2, "0")}`);
            const hrBatches = (hrDay && hrDay.batches) || [];
            const key = normalizeProductKey(row.menu);
            const productBatches = hrBatches.filter((batch) => normalizeProductKey(batch.product) === key);
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

            if (!totalTarget) {
                unallocatedProducts.push({
                    day: row.date,
                    product: shortProduct(row.menu),
                    assembled: Number(row.assembled || 0),
                });
                return;
            }

            allocatableAssembled += Number(row.assembled || 0);
            allocations.forEach((allocation) => {
                const share = allocation.target / totalTarget;
                const allocatedAssembled = Number(row.assembled || 0) * share;
                const allocatedOrdered = Number(row.ordered || 0) * share;
                const line = allocation.line;
                if (!lineMap[line]) {
                    lineMap[line] = {
                        line,
                        ordered: 0,
                        assembled: 0,
                        weightedOee: 0,
                        weightedOle: 0,
                        days: new Set(),
                    };
                }
                const bucket = lineMap[line];
                bucket.ordered += allocatedOrdered;
                bucket.assembled += allocatedAssembled;
                bucket.weightedOee += allocatedAssembled * Number(row.oee || 0);
                bucket.weightedOle += allocatedAssembled * Number(row.oee || 0);
                bucket.days.add(row.date);
            });
        });

        const lines = Object.values(lineMap)
            .map((line) => ({
                ...line,
                attainment: line.ordered > 0 ? line.assembled / line.ordered : null,
                oee: line.assembled > 0 ? line.weightedOee / line.assembled : null,
                ole: line.assembled > 0 ? line.weightedOle / line.assembled : null,
                coveragePct: measurableAssembled > 0 ? line.assembled / measurableAssembled : null,
                days: Array.from(line.days),
            }))
            .sort((a, b) => String(a.line).localeCompare(String(b.line)));

        const knownLines = Array.from(
            new Set(hrDays.flatMap((day) => (day.batches || []).flatMap((batch) => parseLines(batch.line))))
        ).sort((a, b) => String(a).localeCompare(String(b)));

        return {
            lines,
            measurableAssembled,
            allocatableAssembled,
            coveragePct: measurableAssembled > 0 ? allocatableAssembled / measurableAssembled : null,
            unavailableLines: knownLines.filter((line) => !lineMap[line]),
            unallocatedProducts,
        };
    }

    function renderSummary(report) {
        const target = document.getElementById("trialOeeSummary");
        if (!target) return;

        const packing = buildPackingDisplayModel(report);
        const oeeRows = report.assembly.rows.filter((row) => row.oee !== null);
        const dailyOeeValues = [
            oeeRows.find((row) => row.date === "26 Mar")?.oee,
            report.assembly.daily_totals.find((row) => row.date === "27 Mar")?.oee,
            report.assembly.daily_totals.find((row) => row.date === "28 Mar")?.oee,
        ].filter((value) => value !== null && value !== undefined);
        const avgAssemblyOee = avg(dailyOeeValues);
        const bestDay = { label: "26 Mar", oee: oeeRows.find((row) => row.date === "26 Mar")?.oee };
        const worstProduct = oeeRows.slice().sort((a, b) => a.oee - b.oee)[0];
        const avgPackingPartial = avg(packing.partial_summary.map((row) => row.partial_ole));
        const chainHit = report.quality.quality_factors.find((row) => row.chain_quality !== null);

        const cards = [
            {
                label: "Average Assembly OEE",
                value: pct(avgAssemblyOee),
                sub: "Workbook-based trial average across 26-28 Mar",
                tone: toneForPct((avgAssemblyOee || 0) * 100),
                badge: sourceBadge("Measured", "live"),
            },
            {
                label: "Packing Partial OLE",
                value: pct(avgPackingPartial),
                sub: "Activation fixed at 100% attendance; no productivity standard",
                tone: toneForPct((avgPackingPartial || 0) * 100),
                badge: sourceBadge("Partial", "derived"),
            },
            {
                label: "Confirmed LR Rejection",
                value: `${num(626.64, 2)} kg`,
                sub: "Two failed scrambled egg batches on 27 Mar",
                tone: "red",
                badge: sourceBadge("Confirmed", "proxy"),
            },
            {
                label: "HR Meals Not Disposed",
                value: "1,502",
                sub: "Assembly meals remained valid despite LR rejection",
                tone: "green",
                badge: sourceBadge("Confirmed", "live"),
            },
            {
                label: "Best Assembly Day",
                value: bestDay.oee !== null && bestDay.oee !== undefined ? `${bestDay.label} · ${pct(bestDay.oee)}` : "N/A",
                sub: "Single-product continuous run",
                tone: "amber",
                badge: sourceBadge("Measured", "live"),
            },
            {
                label: "Worst Product OEE",
                value: worstProduct ? `${shortProduct(worstProduct.menu)} · ${pct(worstProduct.oee)}` : "N/A",
                sub: chainHit ? `Chain quality floor ${pct(chainHit.chain_quality)} on 27 Mar` : "No chain-quality event recorded",
                tone: "red",
                badge: sourceBadge("Root Cause", "benchmark"),
            },
        ];

        target.innerHTML = cards.map((card) => `
            <div class="pfx-kpi-card pfx-kpi-card--${esc(card.tone)}">
                <span class="pfx-kpi-card__label">${esc(card.label)}</span>
                <span class="pfx-kpi-card__value">${esc(card.value)}</span>
                <span class="pfx-kpi-card__sub">${esc(card.sub)}</span>
                <div class="oee-card-badge-row">${card.badge}</div>
            </div>
        `).join("");
    }

    function renderAssembly(report) {
        const target = document.getElementById("trialOeeAssemblyCard");
        if (!target) return;

        const rows = report.assembly.rows || [];
        const dailyTotals = report.assembly.daily_totals || [];
        const selectableRows = rows.map((row, index) => ({
            ...row,
            index,
            key: `${row.date}__${row.lot}__${row.menu}`,
            label: `${row.date} - ${shortProduct(row.menu)}`,
        }));
        const defaultRow = selectableRows.find((row) => row.oee !== null) || selectableRows[0];

        target.innerHTML = `
            <div class="card__header">
                <div>
                    <p class="eyebrow">Assembly OEE</p>
                    <h2>Assembly OEE by Product</h2>
                    <p class="card__helper">Showing one product at a time for a cleaner review. Use the selector to switch across the trial products and dates.</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <label for="trialAssemblyProductSelect" class="pfx-filter-label">Product</label>
                    <select id="trialAssemblyProductSelect" class="view-select view-select--light" style="min-width:280px">
                        ${selectableRows.map((row) => `
                            <option value="${esc(row.key)}"${row.key === defaultRow.key ? " selected" : ""}>${esc(row.label)}</option>
                        `).join("")}
                    </select>
                </div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${esc(report.assembly.warning)}</span>
                <span class="oee-loss-pill">${esc(report.assembly.important_note)}</span>
            </div>
            <div id="trialAssemblyProductDetail"></div>
            <div class="oee-table-wrap" style="margin-top:16px">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Daily Total</th>
                            <th>Ordered</th>
                            <th>Assembled</th>
                            <th>Availability</th>
                            <th>Performance</th>
                            <th>Quality</th>
                            <th>OEE</th>
                            <th>Note</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dailyTotals.map((row) => `
                            <tr>
                                <td><strong>${esc(row.date)}</strong></td>
                                <td>${num(row.ordered)}</td>
                                <td>${num(row.assembled)}</td>
                                <td>${pct(row.availability)}</td>
                                <td>${pct(row.performance)}</td>
                                <td>${pct(row.quality)}</td>
                                <td><strong>${pct(row.oee)}</strong></td>
                                <td>${esc(row.note)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;

        const select = document.getElementById("trialAssemblyProductSelect");
        const detail = document.getElementById("trialAssemblyProductDetail");
        if (!select || !detail) return;

        function renderSelectedProduct(key) {
            const row = selectableRows.find((item) => item.key === key) || defaultRow;
            const tone = toneForPct((Number(row.oee) || 0) * 100);
            const dayTotal = dailyTotals.find((item) => item.date === row.date);
            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Selected Product</span>
                        <strong class="oee-gap-card__value" style="font-size:1.1rem">${esc(shortProduct(row.menu))}</strong>
                        <span class="oee-gap-card__detail">${esc(row.date)} | Lot ${esc(row.lot)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Ordered / Assembled</span>
                        <strong class="oee-gap-card__value">${num(row.assembled)}</strong>
                        <span class="oee-gap-card__detail">${num(row.ordered)} ordered | ${esc(row.impact)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Rates</span>
                        <strong class="oee-gap-card__value">${row.actual_tray_min !== null ? `${num(row.actual_tray_min, 1)} t/m` : "N/R"}</strong>
                        <span class="oee-gap-card__detail">Plan ${row.plan_tray_min !== null ? `${num(row.plan_tray_min, 1)} t/m` : "N/R"}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">OEE</span>
                        <strong class="oee-gap-card__value">${row.oee !== null ? pct(row.oee) : "N/A"}</strong>
                        <span class="oee-gap-card__detail">${row.oee !== null ? sourceBadge("Measured", "live") : sourceBadge("Timing Missing", "na")}</span>
                    </div>
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Plan Window</th>
                                <th>Assembly Time</th>
                                <th>Total Window</th>
                                <th>Availability</th>
                                <th>Performance</th>
                                <th>Quality</th>
                                <th>OEE</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>${row.plan_window_min !== null ? formatMinutes(row.plan_window_min) : "N/R"}</td>
                                <td>${row.assembly_time_min !== null ? formatMinutes(row.assembly_time_min) : "N/R"}</td>
                                <td>${row.total_window_min !== null ? formatMinutes(row.total_window_min) : "N/R"}</td>
                                <td>${pct(row.availability)}</td>
                                <td>${pct(row.performance)}</td>
                                <td>${pct(row.quality)}</td>
                                <td><strong>${row.oee !== null ? pct(row.oee) : "N/A"}</strong></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="oee-loss-summary" style="margin-top:14px">
                    <span class="oee-loss-pill">${esc(row.root_cause)}</span>
                    ${dayTotal ? `<span class="oee-loss-pill">Daily total ${esc(dayTotal.date)} OEE ${pct(dayTotal.oee)} | ${esc(dayTotal.note)}</span>` : ""}
                </div>
            `;
        }

        renderSelectedProduct(defaultRow.key);
        select.addEventListener("change", (event) => {
            renderSelectedProduct(event.target.value);
        });
    }

    function renderPacking(report) {
        const target = document.getElementById("trialOeePackingCard");
        if (!target) return;

        const packing = buildPackingDisplayModel(report);
        const headcountRows = packing.headcount || [];
        const utilizationRows = packing.utilization || [];
        const productivityRows = packing.productivity || [];
        const partialRows = packing.partial_summary || [];
        const selectableDates = partialRows.map((row) => row.date);
        const defaultDate = selectableDates[0];

        target.innerHTML = `
            <div class="card__header">
                <div>
                    <p class="eyebrow">Packing OLE</p>
                    <h2>Packing OLE and Workforce</h2>
                    <p class="card__helper">Showing one date at a time so packing activation, utilization, and output context stay easy to scan. Use the selector to switch between trial dates.</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <label for="trialPackingDateSelect" class="pfx-filter-label">Date</label>
                    <select id="trialPackingDateSelect" class="view-select view-select--light" style="min-width:180px">
                        ${selectableDates.map((date) => `
                            <option value="${esc(date)}"${date === defaultDate ? " selected" : ""}>${esc(date)}</option>
                        `).join("")}
                    </select>
                </div>
            </div>
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${esc(packing.note)}</span>
                <span class="oee-loss-pill">${esc(packing.assumption_note)}</span>
                <span class="oee-loss-pill">${esc(packing.gap_note)}</span>
            </div>
            <div id="trialPackingDateDetail"></div>
        `;

        const select = document.getElementById("trialPackingDateSelect");
        const detail = document.getElementById("trialPackingDateDetail");
        if (!select || !detail || !defaultDate) return;

        function renderSelectedDate(date) {
            const partial = partialRows.find((row) => row.date === date) || null;
            const headcount = headcountRows.find((row) => row.date === date) || null;
            const utilizations = utilizationRows.filter((row) => row.date === date);
            const products = productivityRows.filter((row) => row.date === date);
            const totalMealsPacked = products.reduce((sum, row) => sum + Number(row.meals_packed || 0), 0);
            const totalManHours = products.reduce((sum, row) => sum + Number(row.man_hours || 0), 0);
            const weightedActualRate = totalManHours > 0 ? totalMealsPacked / totalManHours : null;

            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Selected Date</span>
                        <strong class="oee-gap-card__value">${esc(date)}</strong>
                        <span class="oee-gap-card__detail">${headcount ? `${num(headcount.activated)} activated of ${num(headcount.scheduled)} scheduled` : "No headcount row"}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Activation</span>
                        <strong class="oee-gap-card__value">${pct(partial?.activation ?? headcount?.activation ?? null)}</strong>
                        <span class="oee-gap-card__detail">Activated workers / scheduled workers</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Utilization</span>
                        <strong class="oee-gap-card__value">${pct(partial?.utilization)}</strong>
                        <span class="oee-gap-card__detail">Productive task time / shift window</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Partial OLE</span>
                        <strong class="oee-gap-card__value">${pct(partial?.partial_ole)}</strong>
                        <span class="oee-gap-card__detail">${esc(partial?.full_ole_note || "Activation x Utilization only")}</span>
                    </div>
                </div>
                <div class="oee-trial-comparison-grid" style="margin-bottom:16px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Products Packed</span>
                        <strong class="oee-gap-card__value">${num(products.length)}</strong>
                        <span class="oee-gap-card__detail">Rows with packing productivity data</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Meals Packed</span>
                        <strong class="oee-gap-card__value">${num(totalMealsPacked)}</strong>
                        <span class="oee-gap-card__detail">Summed from the selected date</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Man-hours</span>
                        <strong class="oee-gap-card__value">${num(totalManHours, 1)}</strong>
                        <span class="oee-gap-card__detail">Reported packing labour hours</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Actual meals/man/hr</span>
                        <strong class="oee-gap-card__value">${weightedActualRate !== null ? num(weightedActualRate, 1) : "N/A"}</strong>
                        <span class="oee-gap-card__detail">No standard rate yet for productivity ratio</span>
                    </div>
                </div>
                <div class="oee-table-wrap">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Scheduled</th>
                                <th>Absent</th>
                                <th>Activated</th>
                                <th>Activation</th>
                                <th>Source Note</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${headcount ? `
                                <tr>
                                    <td>${num(headcount.scheduled)}</td>
                                    <td>${num(headcount.absent)}</td>
                                    <td>${num(headcount.activated)}</td>
                                    <td>${pct(headcount.activation)}</td>
                                    <td>${esc(headcount.source_note)}</td>
                                </tr>
                            ` : `
                                <tr>
                                    <td colspan="5">No headcount row was matched to this date.</td>
                                </tr>
                            `}
                        </tbody>
                    </table>
                </div>
                <div class="oee-table-wrap" style="margin-top:16px">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Product</th>
                                <th>Start</th>
                                <th>Stop</th>
                                <th>Window</th>
                                <th>Productive</th>
                                <th>Workers</th>
                                <th>Utilization</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${utilizations.length ? utilizations.map((row) => `
                                <tr>
                                    <td>${esc(row.product)}</td>
                                    <td>${esc(row.start)}</td>
                                    <td>${esc(row.stop)}</td>
                                    <td>${formatMinutes(row.window_min)}</td>
                                    <td>${formatMinutes(row.productive_time_min)}</td>
                                    <td>${num(row.workers)}</td>
                                    <td>${pct(row.utilization)}</td>
                                </tr>
                            `).join("") : `
                                <tr>
                                    <td colspan="7">No utilization rows were matched to this date.</td>
                                </tr>
                            `}
                        </tbody>
                    </table>
                </div>
                <div class="oee-table-wrap" style="margin-top:16px">
                    <table class="data-table oee-mini-table">
                        <thead>
                            <tr>
                                <th>Product</th>
                                <th>Meals Packed</th>
                                <th>Man-hours</th>
                                <th>Actual meals/man/hr</th>
                                <th>Ratio</th>
                                <th>Note</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${products.length ? products.map((row) => `
                                <tr>
                                    <td>${esc(row.product)}</td>
                                    <td>${num(row.meals_packed)}</td>
                                    <td>${num(row.man_hours, 1)}</td>
                                    <td>${num(row.actual_meals_per_man_hr, 1)}</td>
                                    <td>${esc(row.ratio_note)}</td>
                                    <td>${esc(row.note)}</td>
                                </tr>
                            `).join("") : `
                                <tr>
                                    <td colspan="6">No packing productivity rows were matched to this date.</td>
                                </tr>
                            `}
                        </tbody>
                    </table>
                </div>
            `;
        }

        renderSelectedDate(defaultDate);
        select.addEventListener("change", (event) => {
            renderSelectedDate(event.target.value);
        });
    }

    function renderQuality(report) {
        const target = document.getElementById("trialOeeQualityCard");
        if (!target) return;

        target.innerHTML = `
            ${sectionTitle("Quality Events", "Confirmed Rejection and Chain Quality", "This section brings in the confirmed quality clarifications from the workbook so the trial page no longer implies that the 27 Mar herb-egg issue hit HR assembly quality directly.")}
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">${esc(report.quality.headline)}</span>
                <span class="oee-loss-pill">${esc(report.quality.chain_note)}</span>
            </div>
            <div class="oee-table-wrap">
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
                        ${report.quality.safety_events.map((row) => `
                            <tr>
                                <td>${esc(row.stage)}</td>
                                <td>${esc(row.detail)}</td>
                                <td>${num(row.qty_kg, 2)}</td>
                                <td>${pct(row.lr_quality)}</td>
                                <td>${row.hr_quality ? esc(row.hr_quality) : "-"}</td>
                                <td>${row.root_cause ? esc(row.root_cause) : "-"}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            <div class="oee-table-wrap" style="margin-top:16px">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Menu</th>
                            <th>Component</th>
                            <th>Leftover (kg)</th>
                            <th>Tray-equivalent excess</th>
                            <th>Leftover %</th>
                            <th>Impact</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${report.quality.leftovers.map((row) => `
                            <tr>
                                <td>${esc(row.date)}</td>
                                <td>${esc(row.menu)}</td>
                                <td>${esc(row.component)}</td>
                                <td>${num(row.leftover_kg, 2)}</td>
                                <td>${num(row.tray_equiv_excess)}</td>
                                <td>${pct(row.leftover_pct)}</td>
                                <td>${esc(row.impact)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            <div class="oee-trial-comparison-grid" style="margin-top:16px">
                ${report.quality.leftover_totals.map((row) => `
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">${esc(row.label)}</span>
                        <strong class="oee-gap-card__value">${num(row.leftover_kg, 2)} kg</strong>
                        <span class="oee-gap-card__detail">LR material yield loss only</span>
                    </div>
                `).join("")}
            </div>
            <div class="oee-table-wrap" style="margin-top:16px">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Product</th>
                            <th>HR Quality</th>
                            <th>LR Quality</th>
                            <th>Chain Quality</th>
                            <th>Basis</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${report.quality.quality_factors.map((row) => `
                            <tr>
                                <td>${esc(row.date)}</td>
                                <td>${esc(row.product)}</td>
                                <td>${pct(row.hr_quality)}</td>
                                <td>${row.lr_quality !== null ? pct(row.lr_quality) : "-"}</td>
                                <td>${row.chain_quality !== null ? pct(row.chain_quality) : "-"}</td>
                                <td>${esc(row.basis)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderRisks(report) {
        const target = document.getElementById("trialOeeRiskCard");
        if (!target) return;

        target.innerHTML = `
            ${sectionTitle("Risk Mapping", "Risk vs Metric Impact", "This keeps the current dashboard UI but adds the workbook's cross-reference between the risk register and the OEE/OLE factors each issue is dragging.")}
            <div class="oee-table-wrap">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Risk</th>
                            <th>Issue</th>
                            <th>Area</th>
                            <th>Description</th>
                            <th>OEE Factor</th>
                            <th>OLE Factor</th>
                            <th>Observed Evidence</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${report.risks.map((row) => `
                            <tr>
                                <td>${esc(row.risk_level)}</td>
                                <td>${esc(row.issue)}</td>
                                <td>${esc(row.area)}</td>
                                <td>${esc(row.description)}</td>
                                <td>${esc(row.oee_factor)}</td>
                                <td>${esc(row.ole_factor)}</td>
                                <td>${esc(row.evidence)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderLineEstimates(report, trialData) {
        const target = document.getElementById("trialOeeLineCard");
        if (!target) return;

        const model = buildLineEstimateModel(report, trialData);
        const unavailable = model.unavailableLines.length
            ? `Line(s) without enough target split to estimate KPI: ${model.unavailableLines.join(", ")}.`
            : "All recorded lines had enough target-bearing batches for an estimate.";
        const missingProducts = model.unallocatedProducts.length
            ? model.unallocatedProducts.map((item) => `${item.day} ${item.product}`).join(" | ")
            : "None";

        target.innerHTML = `
            ${sectionTitle("Line View", "Estimated Assembly OEE / OLE by Line", "Kept in the page because you asked for line visibility, but moved below the stronger workbook-backed sections. These are still estimates, not exact line studies.")}
            <div class="oee-loss-summary">
                <span class="oee-loss-pill">Line allocation coverage: ${pct(model.coveragePct)} of measured assembly output</span>
                <span class="oee-loss-pill">Allocatable output: ${num(model.allocatableAssembled)} of ${num(model.measurableAssembled)} meals</span>
                <span class="oee-loss-pill">${esc(unavailable)}</span>
            </div>
            <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                ${model.lines.map((line) => `
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Line ${esc(line.line)}</span>
                        <strong class="oee-gap-card__value">${pct(line.oee)}</strong>
                        <span class="oee-gap-card__bench">Estimated OLE ${pct(line.ole)} | Attainment ${pct(line.attainment)}</span>
                        <span class="oee-gap-card__detail">${num(line.assembled)} allocated meals across ${line.days.join(", ")} ${sourceBadge("Estimated", "derived")}</span>
                    </div>
                `).join("")}
            </div>
            <div class="oee-table-wrap">
                <table class="data-table oee-mini-table">
                    <thead>
                        <tr>
                            <th>Line</th>
                            <th>Allocated Ordered</th>
                            <th>Allocated Assembled</th>
                            <th>Attainment</th>
                            <th>Estimated OEE</th>
                            <th>Estimated OLE</th>
                            <th>Coverage of Measured Output</th>
                            <th>Contributing Days</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${model.lines.map((line) => `
                            <tr>
                                <td><strong>${esc(line.line)}</strong></td>
                                <td>${num(line.ordered)}</td>
                                <td>${num(line.assembled)}</td>
                                <td>${pct(line.attainment)}</td>
                                <td>${pct(line.oee)}</td>
                                <td>${pct(line.ole)}</td>
                                <td>${pct(line.coveragePct)}</td>
                                <td>${esc(line.days.join(", "))}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            <p class="card__helper" style="margin-top:14px">Unallocated products with no usable line target split: ${esc(missingProducts)}. Exact line OEE/OLE would still require actual output, downtime, and quality capture by line.</p>
        `;
    }

    function renderProductFlow(report) {
        const target = document.getElementById("trialOeeFlowCard");
        if (!target) return;

        const productFlows = report.product_flows || [];
        const selectableProducts = productFlows.map((product, index) => ({
            ...product,
            index,
            key: `${product.product}__${product.lots}__${index}`,
            label: product.product,
        }));
        const defaultProduct = selectableProducts[0];

        target.innerHTML = `
            <div class="card__header">
                <div>
                    <p class="eyebrow">Product Flow</p>
                    <h2>Production Flow by Product</h2>
                    <p class="card__helper">Showing one product at a time so the LR to HR to MR journey is easier to read. Use the selector to switch across the workbook-backed product flows.</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <label for="trialFlowProductSelect" class="pfx-filter-label">Product</label>
                    <select id="trialFlowProductSelect" class="view-select view-select--light" style="min-width:280px">
                        ${selectableProducts.map((product) => `
                            <option value="${esc(product.key)}"${product.key === defaultProduct?.key ? " selected" : ""}>${esc(product.label)}</option>
                        `).join("")}
                    </select>
                </div>
            </div>
            <div id="trialFlowProductDetail"></div>
        `;

        const select = document.getElementById("trialFlowProductSelect");
        const detail = document.getElementById("trialFlowProductDetail");
        if (!select || !detail || !defaultProduct) return;

        function renderSelectedProduct(key) {
            const product = selectableProducts.find((item) => item.key === key) || defaultProduct;
            const lrTasks = product.lr_tasks || [];
            const mrRows = product.mr || [];

            detail.innerHTML = `
                <div class="oee-trial-comparison-grid" style="margin-bottom:14px">
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">Selected Product</span>
                        <strong class="oee-gap-card__value" style="font-size:1.1rem">${esc(product.product)}</strong>
                        <span class="oee-gap-card__detail">Lot(s): ${esc(product.lots)}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">LR Tasks</span>
                        <strong class="oee-gap-card__value">${num(lrTasks.length)}</strong>
                        <span class="oee-gap-card__detail">${lrTasks.length ? `${esc(lrTasks[0].start)} to ${esc(lrTasks[lrTasks.length - 1].stop)}` : "No LR task rows"}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">HR Assembly</span>
                        <strong class="oee-gap-card__value">${num(product.hr?.meals_assembled || 0)}</strong>
                        <span class="oee-gap-card__detail">${product.hr?.oee !== null && product.hr?.oee !== undefined ? `OEE ${pct(product.hr.oee)}` : "No measured OEE"}</span>
                    </div>
                    <div class="oee-gap-card">
                        <span class="oee-gap-card__label">MR Packing Sessions</span>
                        <strong class="oee-gap-card__value">${num(mrRows.length)}</strong>
                        <span class="oee-gap-card__detail">${mrRows.reduce((sum, row) => sum + Number(row.meals_packed || 0), 0) ? `${num(mrRows.reduce((sum, row) => sum + Number(row.meals_packed || 0), 0))} meals packed` : "No MR session rows"}</span>
                    </div>
                </div>
                <div class="oee-flow-stack">
                    <div class="oee-flow-product">
                        <div class="oee-flow-product__head">
                            <div>
                                <strong>${esc(product.product)}</strong>
                                <span class="oee-flow-product__lot">Lot(s): ${esc(product.lots)}</span>
                            </div>
                        </div>
                        <div class="oee-flow-lane">
                            <p class="eyebrow">LR Cooking / Prep</p>
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
                                            <th>Key Component</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${lrTasks.length ? lrTasks.map((task) => `
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
                                        `).join("") : `
                                            <tr>
                                                <td colspan="8">No LR prep/cooking task rows were matched to this product.</td>
                                            </tr>
                                        `}
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
                                            <th>Meals/man/hr</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${mrRows.length ? mrRows.map((row) => `
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
                                        `).join("") : `
                                            <tr>
                                                <td colspan="10">No MR packing session rows were matched to this product.</td>
                                            </tr>
                                        `}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        ${product.note ? `<p class="card__helper" style="margin-top:12px">${esc(product.note)}</p>` : ""}
                    </div>
                </div>
            `;
        }

        renderSelectedProduct(defaultProduct.key);
        select.addEventListener("change", (event) => {
            renderSelectedProduct(event.target.value);
        });
    }

    function renderBenchmark(report) {
        const target = document.getElementById("trialOeeBenchmarkCard");
        if (!target) return;

        const dayOees = [
            report.assembly.rows.find((row) => row.date === "26 Mar")?.oee,
            report.assembly.daily_totals.find((row) => row.date === "27 Mar")?.oee,
            report.assembly.daily_totals.find((row) => row.date === "28 Mar")?.oee,
        ].filter((value) => value !== null && value !== undefined);
        const avgAssemblyOee = avg(dayOees);
        const bestDay = report.assembly.rows.find((row) => row.date === "26 Mar");
        const worstDay = report.assembly.rows.filter((row) => row.oee !== null).sort((a, b) => a.oee - b.oee)[0];
        const cards = [
            {
                label: "Average Assembly OEE",
                current: avgAssemblyOee,
                reference: REFERENCE.assembly.oee / 100,
                detail: "Workbook trial average against dashboard assembly benchmark",
            },
            {
                label: "Best Assembly Day",
                current: bestDay?.oee ?? null,
                reference: REFERENCE.facility.oee / 100,
                detail: bestDay ? `${bestDay.date} compared with facility benchmark` : "No measured day available",
            },
            {
                label: "Worst Product OEE",
                current: worstDay?.oee ?? null,
                reference: REFERENCE.facility.oee / 100,
                detail: worstDay ? `${shortProduct(worstDay.menu)} against facility benchmark` : "No measured row available",
            }
        ];

        target.innerHTML = `
            ${sectionTitle("Benchmark Comparison", "Trial Versus Reference Model", "Kept in the page, but moved below the new workbook-backed trial sections so comparison does not dominate the actual trial story.")}
            <div class="oee-trial-comparison-grid">
                ${cards.map((card) => {
                    const current = Number(card.current);
                    const reference = Number(card.reference);
                    const delta = Number.isFinite(current) && Number.isFinite(reference)
                        ? `${current > reference ? "+" : ""}${((current - reference) * 100).toFixed(1)}pp`
                        : "N/A";
                    return `
                        <div class="oee-gap-card">
                            <span class="oee-gap-card__label">${esc(card.label)}</span>
                            <strong class="oee-gap-card__value">${pct(card.current)}</strong>
                            <span class="oee-gap-card__bench">Benchmark ${pct(card.reference)} | ${delta}</span>
                            <span class="oee-gap-card__detail">${esc(card.detail)}</span>
                        </div>
                    `;
                }).join("")}
            </div>
        `;
    }

    function renderGaps(report) {
        const target = document.getElementById("trialOeeGapsCard");
        if (!target) return;

        const groups = {
            Critical: report.gaps.filter((row) => row.priority === "Critical"),
            High: report.gaps.filter((row) => row.priority === "High"),
            Medium: report.gaps.filter((row) => row.priority === "Medium"),
        };

        target.innerHTML = `
            ${sectionTitle("Data Gaps", "Data Gaps and Recommendations", "The workbook closes with concrete calculation gaps. Keeping them on the page makes it clearer why some trial KPIs are exact and others are only partial.")}
            <div class="oee-gap-groups">
                ${Object.entries(groups).map(([label, rows]) => `
                    <div class="oee-gap-group oee-gap-group--${label.toLowerCase()}">
                        <h3>${esc(label)} Priority</h3>
                        <div class="oee-table-wrap">
                            <table class="data-table oee-mini-table">
                                <thead>
                                    <tr>
                                        <th>Stage</th>
                                        <th>Metric</th>
                                        <th>Gap</th>
                                        <th>Impact</th>
                                        <th>Recommendation</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${rows.map((row) => `
                                        <tr>
                                            <td>${esc(row.stage)}</td>
                                            <td>${esc(row.metric)}</td>
                                            <td>${esc(row.gap)}</td>
                                            <td>${esc(row.impact)}</td>
                                            <td>${esc(row.recommendation)}</td>
                                        </tr>
                                    `).join("")}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `).join("")}
            </div>
        `;
    }

    async function init() {
        try {
            const [report, trialData] = await Promise.all([
                fetchJson("/static/data/oee_ole_trial_report.json"),
                fetchJson("/api/trial-run-data"),
            ]);
            renderSummary(report);
            renderAssembly(report);
            renderPacking(report);
            renderQuality(report);
            renderRisks(report);
            renderLineEstimates(report, trialData);
            renderProductFlow(report);
            renderBenchmark(report);
            renderGaps(report);
        } catch (error) {
            console.warn("Unable to render trial OEE/OLE page", error);
            const banner = document.getElementById("trialOeeBanner");
            if (banner) {
                banner.innerHTML = `
                    <div>
                        <p class="eyebrow">Historical View</p>
                        <h2 class="tr-context-banner__title">Stage 2 trial data unavailable</h2>
                        <p class="card__helper">The page could not load the workbook-derived trial dataset. Retry once the source file is available.</p>
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
