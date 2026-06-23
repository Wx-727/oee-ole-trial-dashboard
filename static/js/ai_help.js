(function () {
    const fab        = document.getElementById('aiHelpFab');
    const panel      = document.getElementById('aiHelpPanel');
    const closeBtn   = document.getElementById('aiHelpClose');
    const clearBtn   = document.getElementById('aiHelpClear');
    const expandBtn  = document.getElementById('aiHelpExpand');
    const input      = document.getElementById('aiHelpInput');
    const sendBtn    = document.getElementById('aiHelpSend');
    const messagesEl = document.getElementById('aiHelpMessages');
    const statusEl   = document.getElementById('aiHelpStatus');

    if (!fab) return;

    let isOpen     = false;
    let isExpanded = false;

    const MAX_HISTORY_TURNS = 20;
    const STORAGE_KEY       = 'aiHelpConversation';

    // ── Conversation persistence ──────────────────────────────────────────────

    let conversationHistory = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) conversationHistory = JSON.parse(saved) || [];
    } catch (_) {}

    function persistHistory() {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(conversationHistory.slice(-(MAX_HISTORY_TURNS * 2)))
            );
        } catch (_) {}
    }

    // ── Toggle open / close ───────────────────────────────────────────────────

    function togglePanel() {
        isOpen = !isOpen;
        panel.classList.toggle('ai-help__panel--open', isOpen);
        panel.setAttribute('aria-hidden', String(!isOpen));
        if (isOpen) setTimeout(() => input.focus(), 180);
    }

    fab.addEventListener('click', togglePanel);
    closeBtn.addEventListener('click', togglePanel);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen) togglePanel();
    });

    // ── Expand / collapse ─────────────────────────────────────────────────────

    function toggleExpand() {
        isExpanded = !isExpanded;
        panel.classList.toggle('ai-help__panel--expanded', isExpanded);
        expandBtn.setAttribute('title', isExpanded ? 'Collapse' : 'Expand');
        expandBtn.setAttribute('aria-label', isExpanded ? 'Collapse panel' : 'Expand panel');
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    if (expandBtn) expandBtn.addEventListener('click', toggleExpand);

    // ── Quick-question chips (page-aware) ─────────────────────────────────────

    const CHIPS_BY_PAGE = {
        'oee-ole-analysis':     ['Why is OEE low?',        'Break down Availability',    'What affects Performance?', 'Explain Quality factor'],
        'oee_ole_analysis':     ['Why is OEE low?',        'Break down Availability',    'What affects Performance?', 'Explain Quality factor'],
        'haccp-monitoring':     ['Any HACCP deviations?',  'What is a CCP?',             'Freezer compliance status', 'Blast chill compliance'],
        'haccp_monitoring':     ['Any HACCP deviations?',  'What is a CCP?',             'Freezer compliance status', 'Blast chill compliance'],
        'shipment-tracking':    ['Latest shipment status', 'Any lab test failures?',     'What is lot traceability?', 'Explain ETD vs ETA'],
        'shipment_tracking':    ['Latest shipment status', 'Any lab test failures?',     'What is lot traceability?', 'Explain ETD vs ETA'],
        'inbound-tracking':     ['Any cold chain issues?', 'Inbound PO status',          'What is cold chain?',       'Open vs Closed POs'],
        'inbound_tracking':     ['Any cold chain issues?', 'Inbound PO status',          'What is cold chain?',       'Open vs Closed POs'],
        'inbound-warehouse':    ['Any temperature issues?','What is cold chain?',        'Inbound compliance status', 'Explain CCP'],
        'inbound_warehouse':    ['Any temperature issues?','What is cold chain?',        'Inbound compliance status', 'Explain CCP'],
        'staff-productivity':   ['Staff count this shift', 'Which zone needs more staff?','What is OLE?',             'Explain labour effectiveness'],
        'staff_productivity':   ['Staff count this shift', 'Which zone needs more staff?','What is OLE?',             'Explain labour effectiveness'],
        'process-flow':         ['Current bottleneck?',    'Blast chill status',         'Explain process stages',    'Any downtime events?'],
        'process_flow':         ['Current bottleneck?',    'Blast chill status',         'Explain process stages',    'Any downtime events?'],
        'overview':             ['How is the shift going?','What is the bottleneck?',    'Any active alerts?',        'Explain OEE vs OLE'],
    };

    const DEFAULT_CHIPS = [
        'How is the shift going?',
        'What is OEE?',
        'Explain blast chilling',
        'What does amber status mean?',
    ];

    function getChips() {
        const pageId = (document.body.dataset.page || '').toLowerCase();
        for (const key of Object.keys(CHIPS_BY_PAGE)) {
            if (pageId.includes(key)) return CHIPS_BY_PAGE[key];
        }
        return DEFAULT_CHIPS;
    }

    function renderChips() {
        // Remove old chips container if any
        const existing = messagesEl.querySelector('.ai-help__chips');
        if (existing) existing.remove();

        const chips = getChips();
        const container = document.createElement('div');
        container.className = 'ai-help__chips';

        chips.forEach(function (text) {
            const btn = document.createElement('button');
            btn.className = 'ai-help__chip';
            btn.textContent = text;
            btn.addEventListener('click', function () {
                input.value = text;
                container.remove();
                sendMessage();
            });
            container.appendChild(btn);
        });

        messagesEl.appendChild(container);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Timestamp helpers ─────────────────────────────────────────────────────

    function formatTimestamp(date) {
        const now   = new Date();
        const diffS = Math.floor((now - date) / 1000);
        if (diffS < 60)   return 'just now';
        if (diffS < 3600) return Math.floor(diffS / 60) + ' min ago';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function makeTimestamp(date) {
        const el = document.createElement('time');
        el.className = 'ai-help__timestamp';
        el.dateTime  = date.toISOString();
        el.textContent = formatTimestamp(date);
        // Update relative labels every 60 s while on page
        setInterval(function () {
            el.textContent = formatTimestamp(date);
        }, 60000);
        return el;
    }

    // ── Append a message bubble ───────────────────────────────────────────────

    function appendMessage(role, content, date) {
        const wrapper = document.createElement('div');
        wrapper.className = 'ai-help__message ai-help__message--' + role;

        if (role === 'loading') {
            const dots = document.createElement('div');
            dots.className = 'ai-help__typing-dots';
            dots.innerHTML = '<span></span><span></span><span></span>';
            wrapper.appendChild(dots);
        } else {
            const cleaned = String(content)
                .replace(/\*\*(.+?)\*\*/g, '$1')
                .replace(/\*(.+?)\*/g, '$1')
                .replace(/^[*+\-] /gm, '')
                .replace(/^#{1,6} /gm, '')
                .trim();

            cleaned.split(/\n{2,}/).forEach(function (block) {
                const p = document.createElement('p');
                p.textContent = block.trim();
                if (p.textContent) wrapper.appendChild(p);
            });

            // Timestamp for user and assistant messages only
            if (role === 'user' || role === 'assistant') {
                wrapper.appendChild(makeTimestamp(date || new Date()));
            }
        }

        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return wrapper;
    }

    // ── Restore persisted conversation ────────────────────────────────────────

    function restoreConversation() {
        conversationHistory.forEach(function (m) {
            if (m.role === 'user' || m.role === 'assistant') {
                const date = m.ts ? new Date(m.ts) : new Date();
                appendMessage(m.role, m.content, date);
            }
        });
    }

    // ── Clear conversation ────────────────────────────────────────────────────

    function clearConversation() {
        conversationHistory = [];
        persistHistory();
        // Remove everything except the greeting (first message)
        const all = messagesEl.querySelectorAll('.ai-help__message, .ai-help__chips');
        all.forEach(function (el, i) { if (i > 0) el.remove(); });
        renderChips();
        input.focus();
    }

    if (clearBtn) clearBtn.addEventListener('click', clearConversation);

    // ── Loading state ─────────────────────────────────────────────────────────

    function setLoading(loading) {
        input.disabled  = loading;
        sendBtn.disabled = loading;
        statusEl.textContent = loading ? 'Thinking...' : 'Ready';
    }

    // ── View selector (respects the user's current dashboard view) ────────────

    function getSelectedView() {
        const sel = document.getElementById('viewSelector');
        return (sel && sel.value) ? sel.value : 'current';
    }

    // ── DOM context scrape ────────────────────────────────────────────────────

    function getPageContext() {
        const parts = [];
        parts.push('Page: ' + (document.body.dataset.page || document.title || 'unknown'));

        const cards = document.querySelectorAll('.kpi-card, .metric-card, .stat-card, .overview-stat, .kpi-block, [class*="kpi-"]');
        cards.forEach(function (card) {
            const labelEl = card.querySelector('.kpi-label, .metric-label, .stat-label, .label, [class*="__label"]');
            const valueEl = card.querySelector('.kpi-value, .metric-value, .stat-value, .value, [class*="__value"]');
            if (labelEl && valueEl) {
                const label = labelEl.textContent.trim();
                const value = valueEl.textContent.trim();
                if (label && value) parts.push(label + ': ' + value);
            }
        });

        const badges = document.querySelectorAll('.badge, .status-badge, .alert-badge, [class*="status--"]');
        badges.forEach(function (el) {
            const txt = el.textContent.trim();
            if (txt && txt.length < 60) parts.push('Status: ' + txt);
        });

        document.querySelectorAll('table').forEach(function (table) {
            const headers = Array.from(table.querySelectorAll('th')).map(function (th) { return th.textContent.trim(); });
            Array.from(table.querySelectorAll('tbody tr')).slice(0, 15).forEach(function (row) {
                const rowParts = [];
                row.querySelectorAll('td').forEach(function (cell, i) {
                    if (cell.textContent.trim()) {
                        rowParts.push((headers[i] ? headers[i] + ': ' : '') + cell.textContent.trim());
                    }
                });
                if (rowParts.length) parts.push(rowParts.join(' | '));
            });
        });

        return parts.slice(0, 120).join('\n');
    }

    // ── Send message ──────────────────────────────────────────────────────────

    async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;

        input.value = '';

        // Remove chips once user starts talking
        const chips = messagesEl.querySelector('.ai-help__chips');
        if (chips) chips.remove();

        const now = new Date();
        appendMessage('user', text, now);
        setLoading(true);

        conversationHistory.push({ role: 'user', content: text, ts: now.toISOString() });
        persistHistory();

        const historyToSend = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2));
        const loadingEl     = appendMessage('loading', '');

        try {
            const res = await fetch('/api/ai-help', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message:  text,
                    history:  historyToSend,
                    page:     document.body.dataset.page || document.title,
                    view:     getSelectedView(),
                    context:  getPageContext(),
                    page_kpi: window.PAGE_KPI || null,
                }),
            });

            const data = await res.json();
            loadingEl.remove();

            if (data.error) {
                appendMessage('error', data.error);
                conversationHistory.pop();
                persistHistory();
            } else {
                const replyTime = new Date();
                appendMessage('assistant', data.answer, replyTime);
                conversationHistory.push({ role: 'assistant', content: data.answer, ts: replyTime.toISOString() });
                persistHistory();
            }
        } catch (_) {
            loadingEl.remove();
            appendMessage('error', 'Could not reach the AI assistant. Please try again.');
            conversationHistory.pop();
            persistHistory();
        } finally {
            setLoading(false);
            input.focus();
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // ── Init ──────────────────────────────────────────────────────────────────

    restoreConversation();
    // Show chips only if there is no prior conversation
    if (conversationHistory.length === 0) renderChips();
})();
