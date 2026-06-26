(function () {
    function fmtSize(bytes) {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${bytes} B`;
    }

    // cfg: { prefix, uploadUrl, resetUrl, statusKey, defaultText }
    function initUploadCard(cfg) {
        const $ = (suffix) => document.getElementById(cfg.prefix + suffix);
        const fileInput  = $("File");
        const dropzone   = $("Dropzone");
        const preview    = $("Preview");
        const fileName   = $("FileName");
        const fileSize   = $("FileSize");
        const fileRemove = $("FileRemove");
        const uploadBtn  = $("UploadBtn");
        const resetBtn   = $("ResetBtn");
        const statusText = $("StatusText");
        const statusWrap = $("Status");
        const result     = $("Result");
        if (!fileInput) return;

        let selectedFile = null;

        const showResult = (msg, kind) => {
            result.hidden = false;
            result.textContent = msg;
            result.className = `upload-result upload-result--${kind}`;
        };
        const clearResult = () => { result.hidden = true; };
        const isXlsx = (f) => /\.(xlsx|xlsm)$/i.test(f.name);

        function selectFile(file) {
            if (!file) return;
            if (!isXlsx(file)) { showResult("That isn't an Excel .xlsx file.", "error"); return; }
            clearResult();
            selectedFile = file;
            fileName.textContent = file.name;
            fileSize.textContent = fmtSize(file.size);
            preview.hidden = false;
            dropzone.hidden = true;
            uploadBtn.disabled = false;
        }

        function clearSelection() {
            selectedFile = null;
            fileInput.value = "";
            preview.hidden = true;
            dropzone.hidden = false;
            uploadBtn.disabled = true;
        }

        dropzone.addEventListener("click", () => fileInput.click());
        dropzone.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
        });
        fileInput.addEventListener("change", () => selectFile(fileInput.files && fileInput.files[0]));
        fileRemove.addEventListener("click", clearSelection);

        ["dragenter", "dragover"].forEach((evt) =>
            dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dropzone--over"); }));
        ["dragleave", "dragend"].forEach((evt) =>
            dropzone.addEventListener(evt, () => dropzone.classList.remove("dropzone--over")));
        dropzone.addEventListener("drop", (e) => {
            e.preventDefault();
            dropzone.classList.remove("dropzone--over");
            selectFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
        });

        function renderStatus(data) {
            const c = (data && data[cfg.statusKey]) || {};
            const meta = c.meta || {};
            statusWrap.classList.toggle("upload-status--uploaded", c.source === "uploaded");
            if (c.source === "uploaded") {
                statusText.innerHTML =
                    `Using uploaded file <strong>${meta.filename || "(unknown)"}</strong>` +
                    (meta.uploaded_at ? ` — uploaded ${meta.uploaded_at.replace("T", " ")}` : "") +
                    (meta.dates ? ` · ${meta.dates} days, ${meta.menus} menus, ${meta.rows} rows` : "");
                resetBtn.hidden = false;
            } else {
                statusText.innerHTML = cfg.defaultText;
                resetBtn.hidden = true;
            }
        }

        function loadStatus() {
            fetch("/api/data-status")
                .then((r) => r.json())
                .then(renderStatus)
                .catch(() => { statusText.textContent = "Could not load data source status."; });
        }

        function setBusy(busy) {
            uploadBtn.disabled = busy || !selectedFile;
            resetBtn.disabled = busy;
            uploadBtn.textContent = busy ? "Uploading…" : "Upload & apply";
        }

        uploadBtn.addEventListener("click", function () {
            if (!selectedFile) { showResult("Choose an .xlsx file first.", "error"); return; }
            const body = new FormData();
            body.append("file", selectedFile);
            setBusy(true);
            clearResult();
            fetch(cfg.uploadUrl, { method: "POST", body })
                .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
                .then(({ ok, data }) => {
                    if (!ok || data.error) { showResult(data.error || "Upload failed.", "error"); return; }
                    const s = data.summary || {};
                    showResult(`✓ Applied. Parsed ${s.dates} days, ${s.menus} menus, ${s.rows} rows.`, "ok");
                    clearSelection();
                    loadStatus();
                })
                .catch(() => showResult("Upload failed (network or server error).", "error"))
                .finally(() => setBusy(false));
        });

        resetBtn.addEventListener("click", function () {
            setBusy(true);
            fetch(cfg.resetUrl, { method: "POST" })
                .then((r) => r.json())
                .then(() => { showResult("Reverted to the default source.", "ok"); loadStatus(); })
                .catch(() => showResult("Could not reset.", "error"))
                .finally(() => setBusy(false));
        });

        loadStatus();
    }

    initUploadCard({
        prefix: "cooking",
        uploadUrl: "/api/upload/cooking",
        resetUrl: "/api/reset/cooking",
        statusKey: "cooking",
        defaultText: "Using bundled default <strong>LR_production_march.xlsx</strong>.",
    });

    initUploadCard({
        prefix: "assembly",
        uploadUrl: "/api/upload/assembly",
        resetUrl: "/api/reset/assembly",
        statusKey: "assembly",
        defaultText: "Using the curated report <strong>oee_ole_trial_report.json</strong>.",
    });

    initUploadCard({
        prefix: "packing",
        uploadUrl: "/api/upload/packing",
        resetUrl: "/api/reset/packing",
        statusKey: "packing",
        defaultText: "Using the curated report <strong>oee_ole_trial_report.json</strong>.",
    });
})();
