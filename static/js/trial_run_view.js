/* trial_run_view.js — Stage 2 Trial Run (25–28 Mar 2026) */
(function () {

    /* ── shared helpers ─────────────────────────────────────────────────────── */
    function pct(value, decimals) {
        if (value === null || value === undefined) return "N/A";
        return `${Number(value).toFixed(decimals ?? 1)}%`;
    }
    function num(value) {
        if (value === null || value === undefined) return "—";
        return Number(value).toLocaleString();
    }
    function oeeColor(value) {
        if (value === null || value === undefined) return "gray";
        if (value >= 80) return "green";
        if (value >= 60) return "amber";
        return "red";
    }
    function attainColor(value) {
        if (value === null || value === undefined) return "gray";
        if (value >= 98) return "green";
        if (value >= 90) return "amber";
        return "red";
    }
    function pill(label, color) {
        const safe = String(label ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        return `<span class="status-pill status-pill--${color}">${safe}</span>`;
    }
    function oeeBar(value, label) {
        const width = value !== null ? Math.min(100, Math.max(0, value)) : 0;
        const color = oeeColor(value);
        const colorMap = { green: "#16a34a", amber: "#f59e0b", red: "#dc2626", gray: "#aaa" };
        return `
            <div class="tr-bar-row">
                <span class="tr-bar-label">${label}</span>
                <div class="tr-bar-track">
                    <div class="tr-bar-fill" style="width:${width}%;background:${colorMap[color]}"></div>
                    <span class="tr-bar-value">${pct(value)}</span>
                </div>
            </div>`;
    }
    function confBadge(type) {
        const map = {
            measured:  { label: "Measured",  cls: "conf-badge--measured"  },
            derived:   { label: "Derived",   cls: "conf-badge--derived"   },
            na:        { label: "N/A",       cls: "conf-badge--na"        },
            benchmark: { label: "Benchmark", cls: "conf-badge--benchmark" },
        };
        const t = map[type] || map.na;
        return `<span class="conf-badge ${t.cls}">${t.label}</span>`;
    }
    function cleanProduct(name) {
        if (!name) return name;
        return name.replace(/\s*(ย้อน|Lot\.?\s*\d+.*)/gi, "").replace(/\s*\(MU\)/gi, "").trim();
    }
    function fmtKg(val) {
        if (val === null || val === undefined) return "—";
        return `${Number(val).toLocaleString()} kg`;
    }
    function fmtMin(val) {
        if (!val) return "—";
        const h = Math.floor(val / 60), m = val % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    function shortName(name) {
        if (!name) return "—";
        return name.split(",")[0].split("/")[0].split("(")[0].trim();
    }

    /* ── fetch ──────────────────────────────────────────────────────────────── */
    let _cachedData = null;
    async function fetchTrialData() {
        if (_cachedData) return _cachedData;
        const r = await fetch("/api/trial-run-data", { cache: "no-store" });
        _cachedData = await r.json();
        return _cachedData;
    }

    /* ══════════════════════════════════════════════════════════════════════════
       SHARED SECTION BUILDERS — used by both overview and process flow
    ══════════════════════════════════════════════════════════════════════════ */

    /* ── Executive Summary strip ────────────────────────────────────────────── */
    function buildExecSummary(data, stages) {
        const validDays = data.days.filter(d => d.oee?.pct !== null);
        const avgOEE = validDays.length ? validDays.reduce((s,d) => s + d.oee.pct, 0) / validDays.length : null;
        const avgOLE = validDays.length ? validDays.reduce((s,d) => s + d.ole.pct, 0) / validDays.length : null;
        const totalPacked = (stages.mr_days || []).reduce((s,d) =>
            s + d.sessions.reduce((ss,x) => ss + (x.meals || 0), 0), 0);
        const yieldPct = data.meta.total_assembled > 0
            ? (totalPacked / data.meta.total_assembled * 100).toFixed(1) : null;

        function statBox(label, value, badge, sub, color) {
            const valStyle = color ? `style="color:${color}"` : "";
            return `
                <div class="tr-exec-stat">
                    <span class="tr-exec-stat__label">${label}</span>
                    <span class="tr-exec-stat__value" ${valStyle}>${value}</span>
                    <div class="tr-exec-stat__footer">
                        ${confBadge(badge)}
                        ${sub ? `<span class="tr-exec-stat__sub">${sub}</span>` : ""}
                    </div>
                </div>`;
        }

        const oeeStyle = oeeColor(avgOEE) === "green" ? "var(--green)" : oeeColor(avgOEE) === "amber" ? "var(--amber)" : "var(--red)";
        const oleStyle = oeeColor(avgOLE) === "green" ? "var(--green)" : oeeColor(avgOLE) === "amber" ? "var(--amber)" : "var(--red)";

        return `
            <div class="tr-exec-strip">
                ${statBox("Total Assembled", num(data.meta.total_assembled), "measured", `of ${num(data.meta.total_ordered)} ordered`)}
                ${statBox("Overall Attainment", pct(data.meta.total_attainment_pct), "measured", "all 4 days", attainColor(data.meta.total_attainment_pct) === "green" ? "var(--green)" : "var(--amber)")}
                ${statBox("Trial Yield", yieldPct !== null ? yieldPct + "%" : "N/A", "derived", "packed ÷ assembled", Number(yieldPct) >= 98 ? "var(--green)" : "var(--amber)")}
                ${statBox("Avg OEE", pct(avgOEE), "derived", "26–28 Mar only", oeeStyle)}
                ${statBox("Avg OLE", pct(avgOLE), "derived", "26–28 Mar only", oleStyle)}
                ${statBox("Total Packed", num(totalPacked), "measured", "spiral freezer output")}
            </div>`;
    }

    /* ── Stage handoff arrow strip ──────────────────────────────────────────── */
    function buildHandoffStrip(data, stages) {
        const KG_PER_MEAL = 0.3;
        const prepKg    = Math.round((stages.lr_shifts || []).reduce((s,sh) => s + sh.food_prep.summary.total_kg_output, 0));
        const cookKg    = Math.round((stages.lr_shifts || []).reduce((s,sh) => s + sh.cooking.summary.total_kg_output, 0));
        const asmMeals  = data.meta.total_assembled;
        const packMeals = (stages.mr_days || []).reduce((s,d) => s + d.sessions.reduce((ss,x) => ss + (x.meals || 0), 0), 0);
        const asmKgEst  = Math.round(asmMeals * KG_PER_MEAL);
        const packKgEst = Math.round(packMeals * KG_PER_MEAL);
        const yieldPct  = asmMeals > 0 ? (packMeals / asmMeals * 100).toFixed(1) : null;

        function stageNode(label, primaryVal, primaryUnit, kgNote, badge, sub) {
            return `
                <div class="tr-handoff-stage">
                    <p class="tr-handoff-stage__label">${label}</p>
                    <p class="tr-handoff-stage__value">${primaryVal}</p>
                    <p class="tr-handoff-stage__unit">${primaryUnit}</p>
                    ${kgNote ? `<p class="tr-handoff-stage__kg-note">${kgNote}</p>` : ""}
                    <div class="tr-handoff-stage__footer">
                        ${confBadge(badge)}
                        ${sub ? `<span class="tr-handoff-stage__sub">${sub}</span>` : ""}
                    </div>
                </div>`;
        }

        return `
            <div class="tr-handoff-strip">
                ${stageNode("Food Prep",
                    Number(prepKg).toLocaleString() + "*", "kg ingredient weight",
                    "prepared components only",
                    "measured", "24–27 Mar")}
                <div class="tr-handoff-arrow">→</div>
                ${stageNode("Cooking",
                    Number(cookKg).toLocaleString() + "*", "kg dish weight",
                    "incl. added sauces &amp; liquids",
                    "measured", "24–27 Mar")}
                <div class="tr-handoff-arrow">→</div>
                ${stageNode("Assembly",
                    Number(asmMeals).toLocaleString(), "meals assembled",
                    "≈ " + Number(asmKgEst).toLocaleString() + " kg est. @ 0.3 kg/meal",
                    "measured", "25–28 Mar")}
                <div class="tr-handoff-arrow">→</div>
                ${stageNode("Packing",
                    Number(packMeals).toLocaleString(), "meals packed",
                    "≈ " + Number(packKgEst).toLocaleString() + " kg est. · " + (yieldPct !== null ? yieldPct + "% yield" : ""),
                    "measured", "spiral freezer output")}
            </div>`;
    }

    /* ── Compact workforce summary ──────────────────────────────────────────── */
    function buildWorkforceStrip() {
        const fixedHeadcount = {
            "Food Prep": 26,
            "Cooking": 99,
            "Assembly": 78,
            "Packing": 24,
        };

        function zone(label, headcount, dates, note) {
            const range = peak && min && peak !== min ? `${min}–${peak}` : (peak ? `${peak}` : "—");
            return `
                <div class="tr-wf-zone">
                    <p class="tr-wf-zone__label">${label}</p>
                    <p class="tr-wf-zone__peak">${peak || "—"}</p>
                    <p class="tr-wf-zone__sub">peak workers</p>
                    <p class="tr-wf-zone__range">Range: ${range}</p>
                    <p class="tr-wf-zone__dates">${dates}</p>
                    ${note ? `<p class="tr-wf-zone__note">${note}</p>` : ""}
                </div>`;
        }

        return `
            <div class="tr-wf-strip">
                <div class="tr-wf-header">
                    <p class="eyebrow">Trial Workforce</p>
                    <h3 class="tr-wf-title">Headcount by Zone</h3>
                </div>
                <div class="tr-wf-zones">
                    ${zone("Food Prep",  prepPeaks,      "24–27 Mar", "7 shifts · Day &amp; Night")}
                    ${zone("Cooking",    cookPeaks,      "24–27 Mar", "7 shifts · Day &amp; Night")}
                    ${zone("Assembly",   asmAllStaff,    "26–28 Mar", "3 production days")}
                    ${zone("Packing",    packAllWorkers, "26–28 Mar", "3 packing days")}
                </div>
                <p class="tr-wf-caveat">Peak = highest single batch or session headcount. Values from Excel records; some may reflect assigned rather than active workers.</p>
            </div>`;
    }

    /* ── Best / Worst / Loss Driver band ────────────────────────────────────── */
    function buildWorkforceStripFixed() {
        const fixedHeadcount = {
            "Food Prep": 26,
            "Cooking": 99,
            "Assembly": 78,
            "Packing": 24,
        };

        function zone(label, headcount, dates, note) {
            return `
                <div class="tr-wf-zone">
                    <p class="tr-wf-zone__label">${label}</p>
                    <p class="tr-wf-zone__peak">${headcount}</p>
                    <p class="tr-wf-zone__sub">assigned headcount</p>
                    <p class="tr-wf-zone__dates">${dates}</p>
                    ${note ? `<p class="tr-wf-zone__note">${note}</p>` : ""}
                </div>`;
        }

        return `
            <div class="tr-wf-strip">
                <div class="tr-wf-header">
                    <p class="eyebrow">Trial Workforce</p>
                    <h3 class="tr-wf-title">Headcount by Zone</h3>
                </div>
                <div class="tr-wf-zones">
                    ${zone("Food Prep", fixedHeadcount["Food Prep"], "24–27 Mar", "7 shifts · Day &amp; Night")}
                    ${zone("Cooking", fixedHeadcount["Cooking"], "24–27 Mar", "7 shifts · Day &amp; Night")}
                    ${zone("Assembly", fixedHeadcount["Assembly"], "26–28 Mar", "3 production days")}
                    ${zone("Packing", fixedHeadcount["Packing"], "26–28 Mar", "3 packing days")}
                </div>
            </div>`;
    }

    function buildDayChangeBand(data) {
        const transitions = [];
        for (let i = 1; i < data.days.length; i++) {
            const prev = data.days[i - 1];
            const curr = data.days[i];
            const hasOee = prev.oee?.pct !== null && prev.oee?.pct !== undefined && curr.oee?.pct !== null && curr.oee?.pct !== undefined;
            transitions.push({
                from: prev.short_label,
                to: curr.short_label,
                outputDelta: Number(curr.total_assembled || 0) - Number(prev.total_assembled || 0),
                staffDelta: Number(curr.headcount?.total || 0) - Number(prev.headcount?.total || 0),
                oeeDelta: hasOee ? Number(curr.oee.pct || 0) - Number(prev.oee.pct || 0) : null,
            });
        }

        const bestRecovery = transitions
            .filter((step) => step.oeeDelta !== null && step.oeeDelta > 0)
            .reduce((best, step) => (!best || step.oeeDelta > best.oeeDelta ? step : best), null);
        const biggestDrop = transitions
            .filter((step) => step.oeeDelta !== null && step.oeeDelta < 0)
            .reduce((worst, step) => (!worst || step.oeeDelta < worst.oeeDelta ? step : worst), null);

        const staffingDays = data.days.map((day) => ({
            label: day.short_label,
            meals: Number(day.total_assembled || 0),
            staff: Number(day.headcount?.total || 0),
            mealsPerStaff: Number(day.headcount?.total || 0) > 0 ? Number(day.total_assembled || 0) / Number(day.headcount.total) : null,
        })).filter((day) => day.mealsPerStaff !== null);
        const bestStaffing = staffingDays.reduce((best, day) => (!best || day.mealsPerStaff > best.mealsPerStaff ? day : best), null);

        function wholeDelta(value) {
            const sign = Number(value) > 0 ? "+" : "";
            return `${sign}${num(value)}`;
        }

        function pointDelta(value) {
            const sign = Number(value) > 0 ? "+" : "";
            return `${sign}${Number(value).toFixed(1)} pts`;
        }

        function insightCard(tone, title, value, detail, badge) {
            return `
                <div class="tr-daychange-card tr-daychange-card--${tone}">
                    <p class="eyebrow">${title}</p>
                    <div class="tr-daychange-card__value">${value}</div>
                    <div class="tr-daychange-card__detail">${detail}</div>
                    <div class="tr-daychange-card__footer">${confBadge(badge)}</div>
                </div>`;
        }

        return `
            <div class="tr-daychange-wrap">
                <div class="tr-daychange-band">
                    ${bestRecovery
                        ? insightCard(
                            "improve",
                            "Largest OEE Recovery",
                            pointDelta(bestRecovery.oeeDelta),
                            `${bestRecovery.from} -> ${bestRecovery.to} · ${wholeDelta(bestRecovery.outputDelta)} meals · ${wholeDelta(bestRecovery.staffDelta)} staff`,
                            "derived"
                        )
                        : insightCard("neutral", "Largest OEE Recovery", "N/A", "No positive day-over-day OEE change recorded.", "na")}
                    ${biggestDrop
                        ? insightCard(
                            "drop",
                            "Largest OEE Drop",
                            pointDelta(biggestDrop.oeeDelta),
                            `${biggestDrop.from} -> ${biggestDrop.to} · ${wholeDelta(biggestDrop.outputDelta)} meals · ${wholeDelta(biggestDrop.staffDelta)} staff`,
                            "derived"
                        )
                        : insightCard("neutral", "Largest OEE Drop", "N/A", "No negative day-over-day OEE change recorded.", "na")}
                    ${bestStaffing
                        ? insightCard(
                            "efficiency",
                            "Best Staffing Efficiency",
                            `${bestStaffing.mealsPerStaff.toFixed(1)} meals/staff`,
                            `${bestStaffing.label} · ${num(bestStaffing.meals)} meals with ${num(bestStaffing.staff)} assigned staff`,
                            "derived"
                        )
                        : insightCard("neutral", "Best Staffing Efficiency", "N/A", "No staffing data recorded.", "na")}
                </div>
            </div>`;
    }

    function buildBestWorstBand(data, stages) {
        const oeeDays = data.days.filter(d => d.oee?.pct !== null);
        if (!oeeDays.length) return "";
        const bestDay  = oeeDays.reduce((a,b) => a.oee.pct >= b.oee.pct ? a : b);
        const worstDay = oeeDays.reduce((a,b) => a.oee.pct <= b.oee.pct ? a : b);

        let worstProduct = null;
        data.days.forEach(d => d.products.forEach(p => {
            if (p.oee_pct !== null && (!worstProduct || p.oee_pct < worstProduct.oee_pct))
                worstProduct = { ...p, dayLabel: d.short_label };
        }));

        // Worst packing session by meal/man/hr
        let worstSession = null;
        (stages?.mr_days || []).forEach(day => {
            (day.sessions || []).forEach(s => {
                if (s.meal_man_hr && (!worstSession || s.meal_man_hr < worstSession.meal_man_hr))
                    worstSession = { ...s, packDate: day.packing_date };
            });
        });
        const wsd = worstSession;
        const wsdDate = wsd ? wsd.packDate.replace("2026-03-","") + " Mar" : null;

        return `
            <div class="tr-bwl-band">
                <div class="tr-bwl-card tr-bwl-card--best">
                    <p class="eyebrow">Best Day</p>
                    <div class="tr-bwl-card__date">${bestDay.short_label}</div>
                    <div class="tr-bwl-card__metrics">
                        ${oeeBar(bestDay.oee.pct, "OEE")}
                        ${oeeBar(bestDay.ole?.pct, "OLE")}
                    </div>
                    <div class="tr-bwl-card__detail">Attainment: ${pct(bestDay.attainment_pct)}</div>
                    ${confBadge("derived")}
                </div>
                <div class="tr-bwl-card tr-bwl-card--worst">
                    <p class="eyebrow">Worst Day</p>
                    <div class="tr-bwl-card__date">${worstDay.short_label}</div>
                    <div class="tr-bwl-card__metrics">
                        ${oeeBar(worstDay.oee.pct, "OEE")}
                        ${oeeBar(worstDay.ole?.pct, "OLE")}
                    </div>
                    <div class="tr-bwl-card__detail">Attainment: ${pct(worstDay.attainment_pct)}</div>
                    ${confBadge("derived")}
                </div>
                <div class="tr-bwl-card tr-bwl-card--loss">
                    <p class="eyebrow">Worst Assembly Product</p>
                    <div class="tr-bwl-card__date" style="font-size:0.95rem">${worstProduct ? shortName(worstProduct.name) : "—"}</div>
                    <div class="tr-bwl-card__metrics">${worstProduct ? oeeBar(worstProduct.oee_pct, "OEE") : ""}</div>
                    <div class="tr-bwl-card__detail">${worstProduct ? `${worstProduct.dayLabel} · Avail ${pct(worstProduct.avail_pct)} · Perf ${pct(worstProduct.perf_pct)}` : "—"}</div>
                    ${confBadge("derived")}
                </div>
                <div class="tr-bwl-card tr-bwl-card--pack">
                    <p class="eyebrow">Slowest Packing Session</p>
                    <div class="tr-bwl-card__date" style="font-size:0.9rem">${wsd ? shortName(wsd.menu || wsd.section || "—") : "—"}</div>
                    <div class="tr-bwl-card__metrics" style="margin-top:6px">
                        ${wsd ? `<div class="tr-oee-bar-wrap"><span class="tr-oee-bar-label">Rate</span><div class="tr-oee-bar-track"><div class="tr-oee-bar-fill" style="width:${Math.min(wsd.meal_man_hr/2,100)}%;background:var(--amber)"></div></div><span class="tr-oee-bar-val" style="color:var(--amber)">${wsd.meal_man_hr.toFixed(1)} meal/mhr</span></div>` : ""}
                    </div>
                    <div class="tr-bwl-card__detail">${wsd ? `${wsdDate} · Lot ${wsd.lot || "—"} · ${wsd.workers || "—"} workers` : "—"}</div>
                    ${confBadge("measured")}
                </div>
            </div>`;
    }

    /* ── Stage productivity summary cards ───────────────────────────────────── */
    function buildStageProdCards(data, stages) {
        const totalPrepKg = (stages.lr_shifts || []).reduce((s,sh) => s + sh.food_prep.summary.total_kg_output, 0);
        const totalCookKg = (stages.lr_shifts || []).reduce((s,sh) => s + sh.cooking.summary.total_kg_output, 0);
        const cookTasks   = (stages.lr_shifts || []).reduce((s,sh) => s + sh.cooking.tasks.filter(t => t.duration_min).length, 0);

        const validDays = data.days.filter(d => d.oee?.pct !== null);
        const avgOEE = validDays.length ? validDays.reduce((s,d) => s + d.oee.pct, 0) / validDays.length : null;
        const avgOLE = validDays.length ? validDays.reduce((s,d) => s + d.ole.pct, 0) / validDays.length : null;

        const totalPacked   = (stages.mr_days || []).reduce((s,d) => s + d.sessions.reduce((ss,x) => ss + (x.meals || 0), 0), 0);
        const totalCartons  = (stages.mr_days || []).reduce((s,d) => s + d.sessions.reduce((ss,x) => ss + (x.cartons || 0), 0), 0);
        const allRates      = (stages.mr_days || []).flatMap(d => d.sessions.filter(s => s.meal_man_hr).map(s => s.meal_man_hr));
        const avgPackRate   = allRates.length ? allRates.reduce((a,b) => a+b, 0) / allRates.length : null;
        const minRate       = allRates.length ? Math.min(...allRates) : null;
        const maxRate       = allRates.length ? Math.max(...allRates) : null;

        const oeeCol = v => v === null ? "var(--text-muted)" : oeeColor(v) === "green" ? "var(--green)" : oeeColor(v) === "amber" ? "var(--amber)" : "var(--red)";

        function metric(val, label, badge) {
            return `<div class="tr-spc-metric"><span class="tr-spc-metric__val">${val}</span><span class="tr-spc-metric__lbl">${label}</span>${confBadge(badge)}</div>`;
        }

        return `
            <div class="tr-stage-cards">
                <div class="tr-stage-prod-card">
                    <div class="tr-stage-prod-card__header">
                        <p class="eyebrow">Stage 1 · Low Risk</p>
                        <h3>Food Preparation</h3>
                    </div>
                    <div class="tr-stage-prod-card__metrics">
                        ${metric(fmtKg(Math.round(totalPrepKg)), "Total Prepared", "measured")}
                        ${metric("7 shifts", "24–27 Mar", "measured")}
                        ${metric("Day &amp; Night", "Shift Coverage", "measured")}
                    </div>
                    <p class="tr-stage-prod-card__note">28 Mar not applicable — Stage 1 run</p>
                </div>

                <div class="tr-stage-prod-card">
                    <div class="tr-stage-prod-card__header">
                        <p class="eyebrow">Stage 2 · Low Risk</p>
                        <h3>Cooking</h3>
                    </div>
                    <div class="tr-stage-prod-card__metrics">
                        ${metric(fmtKg(Math.round(totalCookKg)), "Total Cooked", "measured")}
                        ${metric(cookTasks + " tasks", "Timed Components", "measured")}
                        ${metric("10 menus", "Across Trial", "measured")}
                    </div>
                </div>

                <div class="tr-stage-prod-card tr-stage-prod-card--featured">
                    <div class="tr-stage-prod-card__header">
                        <p class="eyebrow">Stage 3 · High Risk</p>
                        <h3>Assembly</h3>
                    </div>
                    <div class="tr-stage-prod-card__metrics">
                        ${metric(num(data.meta.total_assembled), "Meals Assembled", "measured")}
                        ${metric(`<span style="color:${oeeCol(data.meta.total_attainment_pct)}">${pct(data.meta.total_attainment_pct)}</span>`, "Attainment", "measured")}
                        ${metric(`<span style="color:${oeeCol(avgOEE)}">${pct(avgOEE)}</span>`, "Avg OEE (26–28)", "derived")}
                        ${metric(`<span style="color:${oeeCol(avgOLE)}">${pct(avgOLE)}</span>`, "Avg OLE (26–28)", "derived")}
                        ${metric('<span style="color:var(--text-muted)">N/A</span>', "OEE 25 Mar", "na")}
                    </div>
                </div>

                <div class="tr-stage-prod-card">
                    <div class="tr-stage-prod-card__header">
                        <p class="eyebrow">Stage 4 · Medium Risk</p>
                        <h3>Packing</h3>
                    </div>
                    <div class="tr-stage-prod-card__metrics">
                        ${metric(num(totalPacked), "Meals Packed", "measured")}
                        ${metric(num(totalCartons), "Cartons", "measured")}
                        ${metric(avgPackRate ? avgPackRate.toFixed(0) : "—", "Avg Meal/Man/Hr", "derived")}
                        ${minRate && maxRate ? metric(`${minRate.toFixed(0)}–${maxRate.toFixed(0)}`, "Rate Range", "measured") : ""}
                    </div>
                    <p class="tr-stage-prod-card__note">Date = spiral freezer run date, not assembly date</p>
                </div>
            </div>`;
    }

    /* ── Exceptions / Loss Drivers panel ────────────────────────────────────── */
    function buildExceptionsPanel(data, stages) {
        // Wait events from HR remarks
        const waitEvents = [];
        (stages.hr_days || []).forEach(day => {
            day.batches.forEach(b => {
                if (!b.remark) return;
                const r = b.remark.toLowerCase();
                if (r.includes("wait") || r.includes("hr -") || r.includes("hr-")) {
                    waitEvents.push({ date: day.date.replace("2026-03-","") + " Mar", product: cleanProduct(b.product) || "—", remark: b.remark, batch: b.batch_no });
                }
            });
        });

        // Rework batches per day
        const reworkByDay = (stages.hr_days || []).map(day => {
            const rework = day.batches.filter(b => b.product && b.product.includes("ย้อน")).length;
            return { date: day.date.replace("2026-03-","") + " Mar", rework, total: day.batches.length, ratePct: day.batches.length > 0 ? (rework / day.batches.length * 100).toFixed(0) : 0 };
        });

        // Per-product loss table (assembly only, OEE available)
        const lossRows = [];
        data.days.forEach(d => {
            d.products.forEach(p => {
                if (p.oee_pct === null) return;
                lossRows.push({
                    dayLabel: d.short_label,
                    name: shortName(p.name),
                    lot: p.lot,
                    ordered: p.ordered,
                    assembled: p.assembled,
                    attainment: p.attainment_pct,
                    oee: p.oee_pct,
                    avail: p.avail_pct,
                    perf: p.perf_pct,
                    assembly_min: p.assembly_min,
                    bake_down_min: p.bake_down_min,
                    setup_min: p.setup_min,
                    actual_rate: p.actual_rate,
                    planned_rate: p.planned_rate,
                    notes: p.notes,
                });
            });
        });
        lossRows.sort((a,b) => a.oee - b.oee);

        const waitHtml = waitEvents.length ? waitEvents.map(e => `
            <div class="tr-exc-event">
                <div class="tr-exc-event__icon">⚠</div>
                <div class="tr-exc-event__body">
                    <strong>${e.date} — Batch ${e.batch}</strong>
                    <span class="tr-exc-event__product">${e.product}</span>
                    <span class="tr-exc-event__remark">${e.remark}</span>
                </div>
                ${confBadge("measured")}
            </div>`).join("") : `<p class="tr-no-data">No wait events recorded.</p>`;

        const reworkHtml = reworkByDay.map(r => {
            const color = Number(r.ratePct) > 50 ? "var(--red)" : Number(r.ratePct) > 0 ? "var(--amber)" : "var(--green)";
            return `
                <div class="tr-exc-rework-row">
                    <span class="tr-exc-rework-date">${r.date}</span>
                    <div class="tr-exc-rework-bar-wrap">
                        <div class="tr-exc-rework-bar" style="width:${r.ratePct}%;background:${color}"></div>
                    </div>
                    <span class="tr-exc-rework-pct" style="color:${color}">${r.ratePct}%</span>
                    <span class="tr-exc-rework-count">${r.rework} / ${r.total} batches</span>
                    ${confBadge("measured")}
                </div>`;
        }).join("");

        const lossTableRows = lossRows.map(r => `
            <tr>
                <td>${r.dayLabel}</td>
                <td style="max-width:180px;word-break:break-word">${r.name}</td>
                <td>${r.lot}</td>
                <td>${r.ordered ? num(r.ordered) : "—"}</td>
                <td>${r.assembled ? num(r.assembled) : "—"}</td>
                <td>${pill(pct(r.attainment), attainColor(r.attainment))}</td>
                <td>${pill(pct(r.oee), oeeColor(r.oee))}</td>
                <td>${pct(r.avail)} ${confBadge("derived")}</td>
                <td>${pct(r.perf)} ${confBadge("derived")}</td>
                <td>${r.assembly_min ? r.assembly_min + " min" : `<span class="tr-na-cell">— ${confBadge("na")}</span>`}</td>
                <td>${r.bake_down_min > 0 ? r.bake_down_min + " min" : "0"}</td>
                <td>${r.actual_rate !== null ? r.actual_rate + " t/m" : `<span class="tr-na-cell">— ${confBadge("na")}</span>`}</td>
                <td>${r.planned_rate} t/m</td>
                <td style="font-size:0.75rem;color:var(--text-soft);max-width:160px">${r.notes || ""}</td>
            </tr>`).join("");

        return `
            <article class="card tr-exceptions-card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Exceptions &amp; Loss Analysis</p>
                        <h2>What Went Wrong</h2>
                        <p class="card__helper">Assembly wait events, rework batch rates, and per-product OEE breakdown sorted by worst performer first.</p>
                    </div>
                </div>

                <div class="tr-exc-section">
                    <div class="tr-exc-section__title">Production Wait Events</div>
                    <div class="tr-exc-events">${waitHtml}</div>
                </div>

                <div class="tr-exc-section" style="margin-top:16px">
                    <div class="tr-exc-section__title">Top Loss Drivers — Assembly (sorted by OEE, worst first)</div>
                    <div class="tr-lr-table-wrap">
                        <table class="data-table tr-stage-table tr-loss-table">
                            <thead>
                                <tr>
                                    <th>Date</th><th>Product</th><th>Lot</th>
                                    <th>Ordered</th><th>Assembled</th><th>Attainment</th>
                                    <th>OEE</th><th>Availability</th><th>Performance</th>
                                    <th>Assembly Time</th><th>Bake-Down</th>
                                    <th>Actual Rate</th><th>Planned Rate</th><th>Notes / Remarks</th>
                                </tr>
                            </thead>
                            <tbody>${lossTableRows}</tbody>
                        </table>
                    </div>
                    <p style="font-size:0.75rem;color:var(--text-muted);margin-top:6px">OEE = Availability × Performance · Quality assumed 100% · ${confBadge("derived")} = calculated from timing data &nbsp; ${confBadge("na")} = timing not recorded in source file</p>
                </div>
            </article>`;
    }

    /* ── Headcount table ────────────────────────────────────────────────────── */
    function buildHeadcountTable() {
        const fixed = {
            batching: 26,
            high_risk: 78,
            low_risk: 99,
            medium_risk: 24,
            total: 227,
        };
        return `
            <div class="tr-headcount-wrap">
                <table class="data-table tr-headcount-table">
                    <thead>
                        <tr>
                            <th>Basis</th><th>Batching</th><th>High Risk (Assembly)</th>
                            <th>Low Risk (Cooking / Prep)</th><th>Medium Risk (Packing)</th><th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Fixed stage headcount ${confBadge("derived")}</td>
                            <td>${fixed.batching}</td>
                            <td>${fixed.high_risk}</td>
                            <td>${fixed.low_risk}</td>
                            <td>${fixed.medium_risk}</td>
                            <td><strong>${fixed.total}</strong></td>
                        </tr>
                    </tbody>
                </table>
            </div>`;
    }

    /* ══════════════════════════════════════════════════════════════════════════
       OVERVIEW PAGE
    ══════════════════════════════════════════════════════════════════════════ */

    function renderTrialAlertBanner(data) {
        const el = document.getElementById("criticalAlertBanner");
        if (!el) return;
        el.classList.remove("is-visible", "red", "amber", "green");
        el.classList.add("is-visible", "amber");
        el.innerHTML = `
            <div class="alert-banner__header">
                <div class="alert-banner__title">Viewing Stage 2 Trial Run — Historical Data (25–28 Mar 2026)</div>
                ${pill("Historical", "amber")}
            </div>
            <div class="status-note">${data.meta.note}</div>`;
    }

    function renderTrialHourlyChart(data, canvasId = "hourlyOutputChart") {
        const el = document.getElementById(canvasId);
        if (!el || typeof Chart === "undefined" || !el.getContext) return;
        const existing = Chart.getChart(el);
        if (existing) existing.destroy();

        // Stacked bar: assembled by product per day
        const labels = data.days.map(d => d.short_label);
        const assembled = data.days.map(d => d.total_assembled);
        const ordered   = data.days.map(d => d.total_ordered);

        new Chart(el.getContext("2d"), {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "Target (Ordered)", data: ordered, backgroundColor: "rgba(200,16,46,0.12)", borderColor: "#c8102e", borderWidth: 1.5, borderRadius: 4 },
                    { label: "Assembled",         data: assembled, backgroundColor: "rgba(200,16,46,0.7)", borderColor: "#c8102e", borderWidth: 0, borderRadius: 4 },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: true,
                plugins: {
                    legend: { display: true, position: "top" },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} meals` } },
                },
                scales: { y: { beginAtZero: true, ticks: { callback: v => v.toLocaleString() } } },
            },
        });
    }

    function renderTrialDayGrid(data) {
        const el = document.getElementById("targetProgressWidget");
        if (!el) return;
        const benchOEE = data.benchmarks?.oee_pct ?? 81.6;
        const benchOLE = data.benchmarks?.ole_pct ?? 86.3;

        const rows = data.days.map((day) => {
            const oee     = day.oee?.pct;
            const ole     = day.ole?.pct;
            const hasOee  = oee !== null && oee !== undefined;
            return `
                <div class="tr-day-row">
                    <div class="tr-day-date">${day.short_label}</div>
                    <div class="tr-day-stats">
                        <div class="tr-day-attain">
                            ${pill(pct(day.attainment_pct), attainColor(day.attainment_pct))}
                            <span class="tr-day-meals">${num(day.total_assembled)} / ${num(day.total_ordered)}</span>
                            ${!hasOee ? confBadge("na") : confBadge("derived")}
                        </div>
                        <div class="tr-day-oee">
                            ${hasOee
                                ? `${oeeBar(oee, "OEE")} ${oeeBar(ole, "OLE")}`
                                : `<span style="font-size:0.75rem;color:var(--text-muted)">OEE / OLE not available — timing not recorded</span>`}
                        </div>
                    </div>
                </div>`;
        }).join("");

        el.innerHTML = `
            <div class="tr-day-grid">
                <div class="tr-day-bench">
                    <span>Benchmark: OEE ${pct(benchOEE)} &nbsp;|&nbsp; OLE ${pct(benchOLE)} ${confBadge("benchmark")}</span>
                </div>
                ${rows}
            </div>`;
    }

    async function renderTrialRunOverview() {
        const data = await fetchTrialData();
        const stages = data.stages || {};

        // Remove any previously injected trial sections so re-renders don't stack
        document.querySelectorAll(".tr-ov-stage-section, .tr-ov-output-section, .tr-ov-exceptions-section, .tr-ov-context-note-wrap, .tr-handoff-wrap, .tr-wf-wrap, .tr-daychange-wrap").forEach(el => el.remove());

        renderTrialAlertBanner(data);

        // Section 1 — Executive Summary (replaces hero + KPI cards)
        const heroEl = document.getElementById("executiveHero");
        if (heroEl) heroEl.innerHTML = `
            <div class="hero-card__inner">
                <div>
                    <p class="eyebrow" style="color:var(--amber)">Historical · Stage 2 Trial Run</p>
                    <h1 class="hero-card__title">${data.meta.label}</h1>
                    <p class="hero-card__sub">${data.meta.facility} &nbsp;|&nbsp; ${data.meta.date_range}</p>
                </div>
            </div>`;

        const kpiEl = document.getElementById("overviewKpis");
        if (kpiEl) {
            kpiEl.innerHTML = buildExecSummary(data, stages);
            kpiEl.insertAdjacentHTML("afterend",
                `<div class="tr-handoff-wrap">${buildHandoffStrip(data, stages)}</div>` +
                `<div class="tr-wf-wrap">${buildWorkforceStripFixed()}</div>`);
        }

        // Section 2 — Stage productivity cards (injected after criticalAlertBanner)
        const workforceWrap = document.querySelector(".tr-wf-wrap");
        if (workforceWrap) {
            workforceWrap.insertAdjacentHTML("afterend",
                `<section class="tr-ov-output-section">
                    <article class="card">
                        <div class="card__header">
                            <div>
                                <p class="eyebrow">Trial Run Production</p>
                                <h2>Daily Output (25–28 Mar)</h2>
                                <p class="card__helper">Meals ordered vs assembled per day across the Stage 2 trial period.</p>
                            </div>
                        </div>
                        <canvas id="trialDailyOutputChart"></canvas>
                    </article>
                </section>`);
            const zones = workforceWrap.querySelectorAll(".tr-wf-zone");
            [
                { headcount: "26", dates: "24-27 Mar", note: "7 shifts · Day & Night" },
                { headcount: "99", dates: "24-27 Mar", note: "7 shifts · Day & Night" },
                { headcount: "78", dates: "26-28 Mar", note: "3 production days" },
                { headcount: "24", dates: "26-28 Mar", note: "3 packing days" },
            ].forEach((row, index) => {
                const zone = zones[index];
                if (!zone) return;
                const value = zone.querySelector(".tr-wf-zone__peak");
                const sub = zone.querySelector(".tr-wf-zone__sub");
                const dates = zone.querySelector(".tr-wf-zone__dates");
                const note = zone.querySelector(".tr-wf-zone__note");
                if (value) value.textContent = row.headcount;
                if (sub) sub.textContent = "assigned headcount";
                if (dates) dates.textContent = row.dates;
                if (note) note.textContent = String(row.note || "").replace(/\u00c2\u00b7/g, "-").replace(/·/g, "-");
            });
            const outputTitle = document.querySelector(".tr-ov-output-section h2");
            if (outputTitle) outputTitle.textContent = "Daily Output (25-28 Mar)";
            try { renderTrialHourlyChart(data, "trialDailyOutputChart"); } catch(e) { console.warn("Trial chart:", e); }
        }

        const stageProdEl = document.getElementById("criticalAlertBanner");
        if (stageProdEl) stageProdEl.insertAdjacentHTML("afterend",
            `<section class="tr-ov-stage-section">${buildStageProdCards(data, stages)}</section>`);

        // Section 3 — Context note + Exceptions panel + Data limitations (injected after the dashboard grid)
        const dashGrid = document.querySelector(".dashboard-grid--overview");
        if (dashGrid) {
            dashGrid.hidden = true;
            dashGrid.style.display = "none";
            dashGrid.insertAdjacentHTML("afterend",
                `<div class="tr-ov-context-note-wrap">
                    <div class="tr-overview-context-note">
                        <span class="tr-overview-context-note__item">
                            <strong>25 Mar:</strong> attainment only — assembly timing was not recorded, so OEE / OLE cannot be calculated.
                        </span>
                        <span class="tr-overview-context-note__sep">·</span>
                        <span class="tr-overview-context-note__item">
                            <strong>Packing date ≠ assembly date</strong> — packing figures reflect the spiral freezer run date, which is typically one day after assembly.
                        </span>
                    </div>
                    <section class="tr-ov-exceptions-section">${buildExceptionsPanel(data, stages)}</section>
                    <div class="tr-data-limits">
                        <p class="tr-data-limits__title">Data Limitations</p>
                        <ul class="tr-data-limits__list">
                            <li><strong>25 Mar assembly timing:</strong> start/stop times were not recorded — OEE and OLE cannot be calculated for this day.</li>
                            <li><strong>Quality assumed 100%:</strong> no reject or defect counts exist in the source data, so OEE Quality factor is set to 1.0.</li>
                            <li><strong>Packing date ≠ assembly date:</strong> MR spiral freezer sessions run the day after assembly. Cross-stage comparisons on the same calendar date will not match.</li>
                            <li><strong>Cross-stage kg comparisons are directional:</strong> Food Prep kg = ingredient weight only; Cooking kg = dish weight including added sauces and liquids. These are not directly comparable to each other or to the assembly/packing meal counts.</li>
                        </ul>
                    </div>
                </div>`);
        }
    }

    /* ══════════════════════════════════════════════════════════════════════════
       PROCESS FLOW PAGE — stage detail builders
    ══════════════════════════════════════════════════════════════════════════ */

    function buildLrShiftSummary(shift) {
        const fp = shift.food_prep.summary;
        const ck = shift.cooking.summary;

        const fpRows = shift.food_prep.tasks.reduce((acc, t) => {
            if (!acc[t.section]) acc[t.section] = { tasks: 0, kg: 0, workers: 0 };
            acc[t.section].tasks++;
            acc[t.section].kg += t.kg_output || 0;
            acc[t.section].workers = Math.max(acc[t.section].workers, t.workers || 0);
            return acc;
        }, {});

        const fpTableRows = Object.entries(fpRows).map(([sec, v]) => `
            <tr><td>${sec}</td><td>${v.tasks}</td><td>${fmtKg(Math.round(v.kg*10)/10)}</td><td>${v.workers||"—"}</td></tr>`).join("");

        const cookGroups = {};
        shift.cooking.tasks.forEach(t => {
            const menu = cleanProduct(t.menu) || "—";
            if (!cookGroups[menu]) cookGroups[menu] = { tasks:0, kg:0, dur:0, workers:0 };
            cookGroups[menu].tasks++;
            cookGroups[menu].kg   += t.kg_output || 0;
            cookGroups[menu].dur  += t.duration_min || 0;
            cookGroups[menu].workers = Math.max(cookGroups[menu].workers, t.workers || 0);
        });
        const cookRows = Object.entries(cookGroups).map(([menu, v]) => `
            <tr>
                <td style="max-width:240px;word-break:break-word">${menu}</td>
                <td>${v.tasks}</td><td>${fmtKg(Math.round(v.kg*10)/10)}</td>
                <td>${fmtMin(v.dur)}</td><td>${v.workers||"—"}</td>
            </tr>`).join("");

        return `
            <div class="tr-lr-shift">
                <div class="tr-lr-shift__header">
                    <strong>${shift.shift_type} Shift</strong>
                    <span class="tr-lr-shift__time">${shift.shift_type === "Night" ? "19:00–07:00" : "07:00–19:00"}</span>
                    ${pill(shift.shift_type === "Night" ? "Night" : "Day", "gray")}
                </div>
                <div class="tr-lr-stats-row">
                    <div class="tr-lr-stat"><span class="tr-lr-stat__val">${fp.menu_count||0}</span><span class="tr-lr-stat__lbl">Menus ${confBadge("measured")}</span></div>
                    <div class="tr-lr-stat"><span class="tr-lr-stat__val">${fmtKg(fp.total_kg_output)}</span><span class="tr-lr-stat__lbl">Prep Output ${confBadge("measured")}</span></div>
                    <div class="tr-lr-stat"><span class="tr-lr-stat__val">${fmtKg(ck.total_kg_output)}</span><span class="tr-lr-stat__lbl">Cooking Output ${confBadge("measured")}</span></div>
                    <div class="tr-lr-stat"><span class="tr-lr-stat__val">${fp.avg_kg_man_hr ? fp.avg_kg_man_hr+" kg/mhr" : "—"}</span><span class="tr-lr-stat__lbl">Prep Rate ${confBadge("derived")}</span></div>
                    <div class="tr-lr-stat"><span class="tr-lr-stat__val">${fp.peak_workers||"—"}</span><span class="tr-lr-stat__lbl">Peak Workers</span></div>
                </div>
                ${fpTableRows ? `
                    <div class="tr-lr-subsection-title">Food Prep Breakdown</div>
                    <div class="tr-lr-table-wrap"><table class="data-table tr-stage-table">
                        <thead><tr><th>Section</th><th>Tasks</th><th>Output</th><th>Peak Workers</th></tr></thead>
                        <tbody>${fpTableRows}</tbody>
                    </table></div>` : ""}
                ${cookRows ? `
                    <div class="tr-lr-subsection-title" style="margin-top:10px">Cooking by Menu</div>
                    <div class="tr-lr-table-wrap"><table class="data-table tr-stage-table">
                        <thead><tr><th>Menu</th><th>Tasks</th><th>Output</th><th>Total Duration</th><th>Peak Workers</th></tr></thead>
                        <tbody>${cookRows}</tbody>
                    </table></div>` : ""}
            </div>`;
    }

    function buildLrDaySection(dateStr, shifts) {
        const dayLabel = dateStr.replace("2026-03-","") + " Mar";
        return `
            <div class="tr-lr-day">
                <div class="tr-lr-day__label">
                    <span class="eyebrow">${dayLabel}</span>
                    <span class="tr-date-badge tr-date-badge--production">Production Date</span>
                </div>
                ${shifts.map(buildLrShiftSummary).join("")}
            </div>`;
    }

    function buildAssemblyDayCard(hrDay) {
        const dayLabel = hrDay.date.replace("2026-03-","") + " Mar";
        const cleanedProducts = [...new Set(hrDay.batches.map(b => cleanProduct(b.product)).filter(Boolean))];
        const reworkCount = hrDay.batches.filter(b => b.product && b.product.includes("ย้อน")).length;
        const reworkPct = hrDay.batches.length > 0 ? (reworkCount / hrDay.batches.length * 100).toFixed(0) : 0;

        const batchRows = hrDay.batches.map(b => {
            const isRework = b.product && b.product.includes("ย้อน");
            const hasWait  = b.remark && (b.remark.toLowerCase().includes("wait") || b.remark.toLowerCase().includes("hr -"));
            return `
                <tr${isRework ? ' class="tr-rework-row"' : ""}>
                    <td>
                        ${cleanProduct(b.product) || "—"}
                        ${isRework ? pill("Rework", "amber") : ""}
                    </td>
                    <td>${b.batch_no}</td>
                    <td>${b.target ? num(b.target) : "—"}</td>
                    <td>${b.staff||"—"}</td>
                    <td>${b.start && b.stop ? `${b.start}–${b.stop}` : (b.start||"—")}</td>
                    <td>${b.duration_min ? fmtMin(b.duration_min) : "—"}</td>
                    <td>${b.line||"—"}</td>
                    <td>${hasWait ? `<span class="tr-wait-flag">⚠ ${b.remark}</span>` : (b.remark || "")}</td>
                </tr>`;
        }).join("");

        const totalTarget = hrDay.batches.reduce((s,b) => s + (b.target||0), 0);
        const peakStaff   = Math.max(...hrDay.batches.map(b => b.staff||0).filter(Boolean), 0);

        return `
            <div class="tr-assembly-day-card">
                <div class="tr-assembly-day-card__header">
                    <div>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <p class="eyebrow">${dayLabel}</p>
                            <span class="tr-date-badge tr-date-badge--assembly">Assembly Date</span>
                        </div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                            ${cleanedProducts.map(p => `<span class="tr-lr-product-tag">${p}</span>`).join("")}
                        </div>
                        ${reworkCount > 0 ? `<div style="margin-top:6px">${pill(reworkPct + "% rework (" + reworkCount + "/" + hrDay.batches.length + " batches)", Number(reworkPct) > 50 ? "red" : "amber")}</div>` : ""}
                    </div>
                    <div class="tr-assembly-day-card__totals">
                        <span><strong>${hrDay.batches.length}</strong> batches</span>
                        <span>Target: <strong>${num(totalTarget)}</strong> meals</span>
                        ${peakStaff > 0 ? `<span>Peak: <strong>${peakStaff}</strong> staff</span>` : ""}
                        ${confBadge("measured")}
                    </div>
                </div>
                <div class="tr-lr-table-wrap">
                    <table class="data-table tr-stage-table">
                        <thead>
                            <tr><th>Product</th><th>Batch</th><th>Target</th><th>Staff</th>
                                <th>Time</th><th>Duration</th><th>Line</th><th>Remark</th></tr>
                        </thead>
                        <tbody>${batchRows}</tbody>
                    </table>
                </div>
            </div>`;
    }

    function buildPackingDayCard(mrDay, assembledMeals) {
        const dayLabel = mrDay.packing_date.replace("2026-03-","") + " Mar";
        const cleanedProducts = [...new Set(mrDay.sessions.map(s => cleanProduct(s.menu)).filter(Boolean))];
        const totalMeals   = mrDay.sessions.reduce((s,x) => s + (x.meals||0), 0);
        const totalCartons = mrDay.sessions.reduce((s,x) => s + (x.cartons||0), 0);
        const rates        = mrDay.sessions.filter(s => s.meal_man_hr).map(s => s.meal_man_hr);
        const avgRate      = rates.length ? (rates.reduce((a,b) => a+b, 0) / rates.length).toFixed(1) : null;
        const minRate      = rates.length ? Math.min(...rates).toFixed(1) : null;
        const maxRate      = rates.length ? Math.max(...rates).toFixed(1) : null;
        const yieldPct     = assembledMeals && totalMeals > 0 ? ((totalMeals / assembledMeals) * 100).toFixed(1) : null;
        const yieldColor   = yieldPct !== null ? (yieldPct >= 98 ? "green" : yieldPct >= 94 ? "amber" : "red") : "gray";

        const sessionRows = mrDay.sessions.map(s => `
            <tr>
                <td>${s.section||"—"}</td>
                <td style="max-width:190px;word-break:break-word">${cleanProduct(s.menu)||"—"}</td>
                <td><span class="tr-lot-badge">Lot ${s.lot||"—"}</span></td>
                <td>${s.meals ? num(s.meals) : "—"}</td>
                <td>${s.cartons||"—"}</td>
                <td>${s.workers||"—"}</td>
                <td>${s.start && s.stop ? `${s.start}–${s.stop}` : (s.start||"—")}</td>
                <td>${s.duration_min ? fmtMin(s.duration_min) : "—"}</td>
                <td>${s.meal_man_hr||"—"} ${s.meal_man_hr ? confBadge("measured") : ""}</td>
                <td style="font-size:0.75rem;color:var(--text-soft)">${s.machine||""} ${s.remark ? `· ${s.remark}` : ""}</td>
            </tr>`).join("");

        return `
            <div class="tr-assembly-day-card">
                <div class="tr-assembly-day-card__header">
                    <div>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <p class="eyebrow">${dayLabel}</p>
                            <span class="tr-date-badge tr-date-badge--packing">Packing Date (Spiral Freezer)</span>
                        </div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                            ${cleanedProducts.map(p => `<span class="tr-lr-product-tag">${p}</span>`).join("")}
                        </div>
                        <p style="font-size:0.73rem;color:var(--text-muted);margin-top:4px">Packing date ≠ assembly date — meals assembled prior day run through spiral freezer</p>
                    </div>
                    <div class="tr-assembly-day-card__totals">
                        <span><strong>${mrDay.sessions.length}</strong> sessions</span>
                        ${totalMeals > 0 ? `<span><strong>${num(totalMeals)}</strong> meals packed ${confBadge("measured")}</span>` : ""}
                        ${assembledMeals ? `<span>of <strong>${num(assembledMeals)}</strong> assembled</span>` : ""}
                        ${yieldPct !== null ? `<span>${pill(yieldPct + "% yield", yieldColor)} ${confBadge("derived")}</span>` : ""}
                        ${totalCartons > 0 ? `<span><strong>${totalCartons}</strong> cartons ${confBadge("measured")}</span>` : ""}
                        ${avgRate ? `<span>Rate: <strong>${minRate}–${maxRate}</strong> meal/man/hr</span>` : ""}
                    </div>
                </div>
                <div class="tr-lr-table-wrap">
                    <table class="data-table tr-stage-table">
                        <thead>
                            <tr><th>Section</th><th>Menu</th><th>Lot</th><th>Meals</th><th>Cartons</th>
                                <th>Workers</th><th>Time</th><th>Duration</th><th>Meal/Man/Hr</th><th>Machine / Remark</th></tr>
                        </thead>
                        <tbody>${sessionRows}</tbody>
                    </table>
                </div>
            </div>`;
    }

    function buildProductRow(product) {
        const oeePct = product.oee_pct;
        const timingStr = product.start && product.stop ? `${product.start}–${product.stop}` : "—";
        const pptMin = (product.assembly_min ?? 0) + (product.bake_down_min ?? 0);
        const pptStr = pptMin > 0 ? `${pptMin} min` : "—";
        return `
            <div class="tr-product-row">
                <div class="tr-product-name">
                    <strong>${product.name}</strong>
                    <span class="tr-product-lot">Lot ${product.lot}</span>
                </div>
                <div class="tr-product-metrics">
                    <div class="tr-product-metric">
                        <span class="tr-pm-label">Attainment</span>
                        <span class="tr-pm-value">${pill(pct(product.attainment_pct), attainColor(product.attainment_pct))}</span>
                        <span class="tr-pm-sub">${num(product.assembled)} / ${num(product.ordered)}</span>
                        ${confBadge("measured")}
                    </div>
                    <div class="tr-product-metric">
                        <span class="tr-pm-label">OEE</span>
                        <span class="tr-pm-value">${oeePct !== null ? pill(pct(oeePct), oeeColor(oeePct)) : confBadge("na")}</span>
                        <span class="tr-pm-sub">${oeePct !== null ? `A:${pct(product.avail_pct)} P:${pct(product.perf_pct)}` : "Timing not recorded"}</span>
                        ${oeePct !== null ? confBadge("derived") : ""}
                    </div>
                    <div class="tr-product-metric">
                        <span class="tr-pm-label">Rate</span>
                        <span class="tr-pm-value">${product.actual_rate !== null ? product.actual_rate + " t/min" : `— ${confBadge("na")}`}</span>
                        <span class="tr-pm-sub">Plan: ${product.planned_rate} t/min</span>
                    </div>
                    <div class="tr-product-metric">
                        <span class="tr-pm-label">Time</span>
                        <span class="tr-pm-value" style="font-size:0.82rem">${timingStr}</span>
                        <span class="tr-pm-sub">PPT: ${pptStr}</span>
                    </div>
                </div>
                ${product.notes ? `<div class="tr-product-note">${product.notes}</div>` : ""}
            </div>`;
    }

    function buildDayCard(day) {
        const oee = day.oee?.pct;
        const ole = day.ole?.pct;
        const sessionStr = day.ole?.session_start
            ? `${day.ole.session_start}–${day.ole.session_stop} (${day.ole.session_span_min} min) ${confBadge("measured")}`
            : `No session timing ${confBadge("na")}`;
        return `
            <div class="tr-day-card">
                <div class="tr-day-card__header">
                    <div>
                        <p class="eyebrow">${day.label}</p>
                        <div class="tr-day-card__pills">
                            ${pill(pct(day.attainment_pct) + " attainment", attainColor(day.attainment_pct))}
                            ${oee !== null ? pill("OEE " + pct(oee), oeeColor(oee)) + confBadge("derived") : confBadge("na")}
                            ${ole !== null ? pill("OLE " + pct(ole), oeeColor(ole)) : ""}
                        </div>
                    </div>
                    <div class="tr-day-card__totals">
                        <span>${num(day.total_assembled)} / ${num(day.total_ordered)} meals</span>
                        <span class="tr-day-card__session">${sessionStr}</span>
                    </div>
                </div>
                ${oee !== null ? `
                    <div class="tr-day-card__oee-bars">
                        ${oeeBar(day.oee?.availability_pct, "Availability")}
                        ${oeeBar(day.oee?.performance_pct, "Performance")}
                        ${oeeBar(day.ole?.utilisation_pct, "Utilisation (OLE)")}
                    </div>` : `<p class="tr-no-timing">${day.note || "No timing data for this day."}</p>`}
                <div class="tr-day-card__products">
                    ${day.products.map(buildProductRow).join("")}
                </div>
                ${day.note ? `<p class="tr-day-note">${day.note}</p>` : ""}
            </div>`;
    }

    /* ── Process Flow main render ───────────────────────────────────────────── */
    async function renderTrialRunProcessFlow() {
        const data   = await fetchTrialData();
        const stages = data.stages || {};

        // Hide live elements
        const stageShell    = document.querySelector(".pfx-stage-shell");
        const processDataCard = document.getElementById("pfxProcessDataCard");
        [document.getElementById("pfxStaticGanttCard"),
         document.getElementById("pfxAssemblyGanttCard"),
         document.getElementById("pfxPackingGanttCard")].forEach(el => { if (el) el.style.display = "none"; });
        if (stageShell)     stageShell.style.display = "none";
        if (processDataCard) processDataCard.style.display = "none";

        const existing = document.getElementById("trialRunSection");
        if (existing) existing.remove();

        const benchOEE = data.benchmarks?.oee_pct ?? 81.6;
        const benchOLE = data.benchmarks?.ole_pct ?? 86.3;
        const validDays = data.days.filter(d => d.oee?.pct !== null);
        const avgOEE = validDays.length ? validDays.reduce((s,d) => s + d.oee.pct, 0) / validDays.length : null;
        const avgOLE = validDays.length ? validDays.reduce((s,d) => s + d.ole.pct, 0) / validDays.length : null;

        // LR grouped by date
        const lrByDate = {};
        (stages.lr_shifts || []).forEach(s => { (lrByDate[s.shift_date] = lrByDate[s.shift_date] || []).push(s); });
        const lrDates = Object.keys(lrByDate).sort();

        const foodPrepHtml = lrDates.map(date => {
            const shifts = (lrByDate[date] || []).filter(s => s.food_prep.tasks.length > 0);
            return shifts.length ? buildLrDaySection(date, shifts) : "";
        }).filter(Boolean).join("");

        const cookingHtml = lrDates.map(date => {
            const shifts = (lrByDate[date] || []).filter(s => s.cooking.tasks.length > 0);
            return shifts.length ? buildLrDaySection(date, shifts) : "";
        }).filter(Boolean).join("");

        const assemblyHtml = (stages.hr_days || []).map(buildAssemblyDayCard).join("");

        const assembledByDate = {};
        data.days.forEach(d => { assembledByDate[d.date] = d.total_assembled; });
        const totalAssembled = data.days.reduce((s,d) => s + (d.total_assembled||0), 0);
        const totalPacked    = (stages.mr_days || []).reduce((s,d) => s + d.sessions.reduce((ss,x) => ss + (x.meals||0), 0), 0);
        const overallYieldPct = totalAssembled > 0 ? ((totalPacked / totalAssembled) * 100).toFixed(1) : null;

        const packingHtml = (stages.mr_days || []).map(d =>
            buildPackingDayCard(d, assembledByDate[d.packing_date] || null)
        ).join("");

        const section = document.createElement("section");
        section.id = "trialRunSection";
        section.innerHTML = `

            <!-- ─── SECTION A: Executive Summary ─── -->
            <div class="tr-section-header">
                <span class="tr-section-label">A — Executive Summary</span>
            </div>
            <div class="tr-context-banner">
                <div class="tr-context-banner__left">
                    <p class="eyebrow" style="color:var(--amber)">Historical Data</p>
                    <h2>${data.meta.label} — ${data.meta.date_range}</h2>
                    <p style="font-size:0.87rem;color:var(--text-soft);margin-top:4px">${data.meta.facility}</p>
                </div>
            </div>
            ${buildExecSummary(data, stages)}
            ${buildBestWorstBand(data)}
            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Workforce</p>
                        <h2>Headcount by Zone</h2>
                        <p class="card__helper">Fixed staffing basis used for the Stage 2 trial view.</p>
                    </div>
                </div>
                ${buildHeadcountTable()}
            </article>

            <!-- ─── SECTION B: Stage Flow ─── -->
            <div class="tr-section-header" style="margin-top:28px">
                <span class="tr-section-label">B — Stage Flow</span>
            </div>
            ${buildStageProdCards(data, stages)}

            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Stage 1 — Low Risk Zone</p>
                        <h2>Food Preparation</h2>
                        <p class="card__helper">Task-level prep data from LR Excel — day and night shifts, 24–27 Mar. 28 Mar not applicable (Stage 1 run).</p>
                    </div>
                </div>
                <div class="tr-lr-days">${foodPrepHtml || "<p class=\"tr-no-data\">No food prep data.</p>"}</div>
            </article>

            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Stage 2 — Low Risk Zone</p>
                        <h2>Cooking</h2>
                        <p class="card__helper">Component-level cooking breakdown per shift — output, timing, workers, machine utilisation.</p>
                    </div>
                </div>
                <div class="tr-lr-days">${cookingHtml || "<p class=\"tr-no-data\">No cooking data.</p>"}</div>
            </article>

            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Stage 3 — High Risk Zone</p>
                        <h2>Assembly</h2>
                        <p class="card__helper">Batch-level assembly from HR Excel. Benchmarks: OEE ${pct(benchOEE)} / OLE ${pct(benchOLE)}. Rework batches highlighted. Wait events flagged.</p>
                    </div>
                </div>
                <div class="tr-stages-list">${assemblyHtml || "<p class=\"tr-no-data\">No assembly data.</p>"}</div>
            </article>

            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Stage 4 — Medium Risk Zone</p>
                        <h2>Packing</h2>
                        <p class="card__helper">MR Excel packing sessions. <strong>Date = spiral freezer run date, not assembly date.</strong> Productivity range and yield vs assembled shown per day.</p>
                    </div>
                    ${overallYieldPct !== null ? `
                    <div style="text-align:right">
                        <p class="eyebrow">Trial Yield ${confBadge("derived")}</p>
                        <div style="font-size:1.6rem;font-weight:700;color:${Number(overallYieldPct) >= 98 ? "var(--green)" : Number(overallYieldPct) >= 94 ? "var(--amber)" : "var(--red)"}">${overallYieldPct}%</div>
                        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${num(totalPacked)} packed / ${num(totalAssembled)} assembled</p>
                    </div>` : ""}
                </div>
                <div class="tr-stages-list">${packingHtml || "<p class=\"tr-no-data\">No packing data.</p>"}</div>
            </article>

            <!-- ─── SECTION C: Exceptions ─── -->
            <div class="tr-section-header" style="margin-top:28px">
                <span class="tr-section-label">C — Exceptions</span>
            </div>
            ${buildExceptionsPanel(data, stages)}

            <!-- Assembly OEE detail cards -->
            <article class="card" style="margin-top:14px">
                <div class="card__header">
                    <div>
                        <p class="eyebrow">Assembly OEE Detail</p>
                        <h2>Per-Day / Per-Product OEE Breakdown</h2>
                        <p class="card__helper">25 Mar: no timing recorded — OEE not available. 26–28 Mar: OEE = Availability × Performance (Quality = 100% assumed). Benchmarks: OEE ${pct(benchOEE)} / OLE ${pct(benchOLE)}.</p>
                    </div>
                </div>
                <div class="tr-assembly-grid">${data.days.map(buildDayCard).join("")}</div>
            </article>

            `;

        const anchor = document.getElementById("pfxStaticGanttCard") || document.querySelector(".pfx-flow-card");
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(section, anchor);
        else document.querySelector(".content-area, main, body").appendChild(section);
    }

    function restoreLiveProcessFlow() {
        const stageShell = document.querySelector(".pfx-stage-shell");
        const processDataCard = document.getElementById("pfxProcessDataCard");
        if (stageShell) stageShell.style.display = "";
        if (processDataCard) processDataCard.style.display = "";
        const existing = document.getElementById("trialRunSection");
        if (existing) existing.remove();
        const staticGantt = document.getElementById("pfxStaticGanttCard");
        if (staticGantt) staticGantt.style.display = "";
    }

    /* ── public API ─────────────────────────────────────────────────────────── */
    window.TrialRunView = {
        renderOverview:          renderTrialRunOverview,
        renderProcessFlow:       renderTrialRunProcessFlow,
        restoreLiveProcessFlow,
    };

})();
