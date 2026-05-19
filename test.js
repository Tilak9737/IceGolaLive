
        /* ══ CONFIG ══════════════════════════ */
        const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
            ? 'http://localhost:3001' 
            : 'https://shoptrack-api-gfte.onrender.com';
            
        let SHOP_PIN = localStorage.getItem('shoptrack_pin');
        const AMT = [10, 20, 30, 40, 50, 70, 100, 150, 200];
        const SKEY = 'shoptrack_v5';

        /* ══ STATE ═══════════════════════════ */
        let MENU = [];
        let S = { customers: [], createdAt: Date.now(), version: 0 };
        let activeFilter = 'all';
        let syncStatus = 'offline';
        let activeUpiCustomerId = null;
        const CLIENT_KEY = 'shoptrack_client_id';
        let CLIENT_ID = localStorage.getItem(CLIENT_KEY);
        if (!CLIENT_ID) {
            CLIENT_ID = uid();
            localStorage.setItem(CLIENT_KEY, CLIENT_ID);
        }
        let lastServerVersion = Number(S.version) || 0;

        /* ══ PERSIST / API ════════════════════ */
        let isSyncing = false;
        let syncQueue = false;

        function stateContentKey(state) {
            const copy = JSON.parse(JSON.stringify(state || {}));
            delete copy.version;
            delete copy.savedAt;
            delete copy.serverSavedAt;
            return JSON.stringify(copy);
        }

        function applyServerState(nextState, shouldRender = true) {
            if (!nextState || !Array.isArray(nextState.customers)) return false;
            const changed = stateContentKey(nextState) !== stateContentKey(S);
            S = nextState;
            lastServerVersion = Number(S.version) || lastServerVersion;
            try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch(e){}
            if (shouldRender && changed) renderAll();
            return changed;
        }

        async function save() {
            const baseVersion = lastServerVersion;
            S.version++;
            S.savedAt = Date.now();
            try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) { }
            if (typeof updateSavedAt === 'function') updateSavedAt();
            
            if (!SHOP_PIN) return;
            if (isSyncing) {
                syncQueue = true;
                return;
            }
            
            isSyncing = true;
            try {
                const res = await fetch(`${API_BASE}/api/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-shop-pin': SHOP_PIN },
                    body: JSON.stringify({ state: S, baseVersion, clientId: CLIENT_ID })
                });
                const data = await res.json().catch(() => null);
                if (res.status === 401) {
                    toast('Invalid PIN!', 'warn');
                    requirePin();
                } else if (data && data.state) {
                    if (syncQueue && res.ok) {
                        lastServerVersion = Number(data.state.version) || lastServerVersion;
                    } else {
                        const changed = applyServerState(data.state, true);
                        if (!res.ok || changed) {
                            toast('State synced with server', res.ok ? 'ok' : 'warn');
                        }
                    }
                } else if (!res.ok) {
                    toast('State synced with server', 'warn');
                }
            } catch (err) {
                console.error('Sync failed', err);
            } finally {
                isSyncing = false;
                if (syncQueue) {
                    syncQueue = false;
                    save();
                }
            }
        }

        async function load() {
            try {
                const r = localStorage.getItem(SKEY); 
                if (r) {
                    const d = JSON.parse(r);
                    if (d && d.customers) S = d;
                }
            } catch (e) { localStorage.removeItem(SKEY); }

            if (!SHOP_PIN) return requirePin();

            try {
                const res = await fetch(`${API_BASE}/api/state`, {
                    headers: { 'x-shop-pin': SHOP_PIN }
                });
                if (res.status === 401) return requirePin();
                if (res.ok) {
                    const data = await res.json();
                    applyServerState(data.state, false);
                    MENU = data.menu;
                    renderAll();
                    setupSSE();
                }
            } catch (err) {
                console.error('Initial load failed', err);
                toast('Offline mode', 'warn');
                setupSSE();
            }
        }

        function requirePin() {
            const pin = prompt('Enter 4-digit Shop PIN:');
            if (pin) {
                SHOP_PIN = pin;
                localStorage.setItem('shoptrack_pin', pin);
                load();
            }
        }

        let evtSource;
        function setupSSE() {
            if (evtSource) evtSource.close();
            if (!SHOP_PIN) return;
            evtSource = new EventSource(`${API_BASE}/api/events?pin=${SHOP_PIN}`);
            
            evtSource.onopen = () => {
                syncStatus = 'live';
                updateSyncUI();
            };
            
            evtSource.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data.type === 'init' || data.type === 'update') {
                        if (data.state && (data.type === 'init' || Number(data.state.version) > lastServerVersion)) {
                            applyServerState(data.state, true);
                        }
                        if (data.menu) MENU = data.menu;
                    }
                } catch(err) {}
            };
            
            evtSource.onerror = () => {
                syncStatus = 'offline';
                updateSyncUI();
                evtSource.close();
                setTimeout(setupSSE, 5000);
            };
        }

        function updateSyncUI() {
            const el = document.getElementById('sync-dot');
            if (el) {
                if (syncStatus === 'live') el.style.background = 'var(--green)';
                else el.style.background = 'var(--red)';
            }
        }

        /* ══ UTILS ═══════════════════════════ */
        function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
        function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        let _tt;
        function toast(msg, type = 'ok') {
            const el = document.getElementById('toast');
            el.textContent = msg; el.className = 'show ' + type;
            clearTimeout(_tt); _tt = setTimeout(() => el.className = '', 2600);
        }

        /* ══ LOOKUPS ══════════════════════════ */
        function gc(cid) { return S.customers.find(c => c.id === cid); }
        function gi(cid, iid) { return gc(cid)?.items.find(i => i.id === iid); }

        /* ══ MODAL ═══════════════════════════ */
        // (modal removed — customers created directly)

        /* ══ CUSTOMER ACTIONS ════════════════ */
        function createCustomer() {
            // find lowest number not already in use
            const used = new Set(S.customers.map(c => {
                const m = c.name.match(/^Customer (\d+)$/);
                return m ? parseInt(m[1]) : null;
            }).filter(n => n !== null));
            let n = 1;
            while (used.has(n)) n++;
            const name = 'Customer ' + n;
            S.customers.unshift({ id: uid(), name, served: false, createdAt: Date.now(), items: [], paid: 0 });
            save(); renderAll(); toast(name + ' added!');
        }

        function removeCustomer(cid) {
            // Two-click guard — no confirm() (blocked in iframes)
            const btn = document.querySelector(`[data-action="delcust"][data-cid="${cid}"]`);
            if (!btn) return;
            if (btn.dataset.armed === '1') {
                S.customers = S.customers.filter(c => c.id !== cid);
                save(); renderAll(); toast('Customer removed', 'warn');
            } else {
                btn.dataset.armed = '1';
                btn.textContent = 'Sure?';
                btn.style.background = 'rgba(240,93,93,.3)';
                setTimeout(() => {
                    if (btn && btn.isConnected) { btn.dataset.armed = '0'; btn.textContent = '✕'; btn.style.background = ''; }
                }, 2500);
            }
        }

        function toggleServed(cid) {
            const c = gc(cid); if (!c) return;
            // block marking served if not paid (only when trying to serve, not when reopening)
            if (!c.served && !c.paid) {
                toast('💳 Mark as paid first!', 'warn'); return;
            }
            c.served = !c.served; save(); renderAll();
            toast(c.served ? '✅ Customer marked served' : 'Reopened');
        }

        function completeCustomer(cid) {
            const c = gc(cid); if (!c) return;
            if (!c.paid) {
                toast('💳 Mark as paid first!', 'warn'); return;
            }
            c.items.forEach(i => { i.served = true; if (i.total > 0) i.gave = i.total; });
            c.served = true;
            save(); renderAll();
            toast('🎉 ' + c.name + ' completed!');
        }

        /* ══ ITEM ACTIONS ════════════════════ */
        function addItem(cid) {
            const c = gc(cid); if (!c) return;
            const newId = uid();
            c.items.push({ id: newId, name: 'New Item', total: 0, gave: 0, served: false });
            save(); rebuildCard(cid);
            setTimeout(() => {
                const inp = document.querySelector(`#item-${cid}-${newId} .item-name-inp`);
                if (inp) { inp.focus(); inp.select(); }
            }, 50);
        }

        function removeItem(cid, iid) {
            const c = gc(cid); if (!c) return;
            c.items = c.items.filter(i => i.id !== iid);
            save(); rebuildCard(cid);
        }

        function serveItem(cid, iid) {
            const item = gi(cid, iid); if (!item) return;
            item.served = true;
            item.gave = item.total;   // gave = full cost when served
            save(); rebuildCard(cid); updateSummary();
            checkAllDone(cid);
        }

        function unserveItem(cid, iid) {
            const item = gi(cid, iid); if (!item) return;
            item.served = false;
            save(); rebuildCard(cid); updateSummary();
        }

        // (partial panel always open — no toggle needed)

        /* adds to COST (total) — what + buttons do */
        function addCost(cid, iid, amount) {
            const item = gi(cid, iid); if (!item) return;
            item.total = item.total + amount;
            save();
            const row = document.getElementById('item-' + cid + '-' + iid);
            if (row) {
                const inp = row.querySelector('.cost-inp');
                if (inp) inp.value = item.total;
                const serveBtn = row.querySelector('.serve-btn');
                if (serveBtn) serveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> SERVE &nbsp;•&nbsp; ₹${item.total}`;
                const cr = row.querySelector('.cost-row');
                if (cr) { cr.style.borderColor = 'var(--green)'; setTimeout(() => cr.style.borderColor = '', 400); }
            }
            refreshCardTotals(cid); updateSummary();
        }

        function addCustomCost(cid, iid) {
            const inp = document.querySelector(`#item-${cid}-${iid} .custom-inp`);
            if (!inp) return;
            const v = parseInt(inp.value);
            if (!v || v <= 0) { inp.focus(); return; }
            addCost(cid, iid, v); inp.value = ''; inp.focus();
        }

        function setTotal(cid, iid, raw) {
            const item = gi(cid, iid); if (!item) return;
            item.total = Math.max(0, parseInt(raw) || 0);
            save();
            const row = document.getElementById('item-' + cid + '-' + iid);
            if (row) {
                const serveBtn = row.querySelector('.serve-btn');
                if (serveBtn) serveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> SERVE &nbsp;•&nbsp; ₹${item.total}`;
            }
            refreshCardTotals(cid); updateSummary();
        }

        function setItemName(cid, iid, v) { const i = gi(cid, iid); if (i) { i.name = v; save(); } }

        function toggleParcel(cid, iid) {
            const item = gi(cid, iid); if (!item) return;
            item.parcel = !item.parcel;
            save();
            const row = document.getElementById('item-' + cid + '-' + iid);
            if (!row) return;
            const btn = row.querySelector('.parcel-btn');
            if (btn) {
                btn.classList.toggle('is-parcel', !!item.parcel);
                btn.innerHTML = item.parcel ? '📦 Parcel' : '📦 Parcel?';
            }
        }
        function setCustName(cid, v) {
            const c = gc(cid); if (!c) return; c.name = v;
            const av = document.querySelector('#card-' + cid + ' .cavatar');
            if (av) av.textContent = (v || '?')[0].toUpperCase();
            save();
        }

        /* ══ PAYMENT ACTIONS ══════════════════ */
        function billTotal(c) { return c.items.reduce((s, i) => s + i.total, 0); }
        function payStatus(c) { return c.paid ? 'paid' : 'unpaid'; }

        function getUpiId() { return (document.getElementById('upi-id-input')?.value || '').trim(); }
        function getUpiName() { return (document.getElementById('upi-name-input')?.value || 'ShopTrack').trim(); }
        function isValidUpiId(value) { return /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z0-9.\-_]{2,}$/.test((value || '').trim()); }
        function formatUpiAmount(amount) { return Math.max(0, Math.round(Number(amount || 0) * 100) / 100).toFixed(2); }
        function buildUpiUrl(c) {
            const amount = formatUpiAmount(billTotal(c));
            const params = new URLSearchParams({
                pa: getUpiId(),
                pn: getUpiName(),
                am: amount,
                cu: 'INR',
                tn: 'ShopTrack ' + (c.name || 'payment')
            });
            return 'upi://pay?' + params.toString();
        }

        async function renderUpiQr(c) {
            const upiId = document.getElementById('upi-id-input').value.trim();
            const upiName = document.getElementById('upi-name-input').value.trim() || 'ShopTrack';
            if (!isValidUpiId(upiId)) {
                toast('Enter a valid UPI ID first', 'warn');
                document.getElementById('upi-id-input').focus();
                return;
            }
            document.getElementById('btn-upi-save').disabled = true;
            try {
                const res = await fetch(`${API_BASE}/api/upi/qr`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-shop-pin': SHOP_PIN },
                    body: JSON.stringify({
                        upiId,
                        upiName,
                        amount: billTotal(c),
                        note: 'ShopTrack ' + (c.name || 'payment')
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to generate QR');
                document.getElementById('upi-qr-img').src = data.qrDataUrl;
                document.getElementById('upi-open-link').href = data.upiUrl || buildUpiUrl(c);
                document.getElementById('upi-qr-box').classList.add('show');
                document.getElementById('upi-link-row').classList.add('show');
            } catch (e) {
                toast(e.message || 'Failed to generate QR', 'warn');
            } finally {
                document.getElementById('btn-upi-save').disabled = false;
            }
        }

        function openUpiModal(cid = null) {
            activeUpiCustomerId = cid;
            const c = cid ? gc(cid) : null;
            const total = c ? billTotal(c) : 0;
            document.getElementById('upi-customer-name').textContent = c ? c.name : 'UPI settings';
            document.getElementById('upi-amount').innerHTML = '&#8377;' + total;
            document.getElementById('upi-id-input').value = '';
            document.getElementById('upi-name-input').value = 'ShopTrack';
            document.getElementById('upi-qr-img').removeAttribute('src');
            document.getElementById('upi-qr-box').classList.remove('show');
            document.getElementById('upi-link-row').classList.remove('show');
            document.getElementById('upi-modal-bg').classList.add('open');
            setTimeout(() => document.getElementById('upi-id-input').focus(), 40);
        }

        function closeUpiModal() {
            document.getElementById('upi-modal-bg').classList.remove('open');
        }

        async function generateActiveUpiQr() {
            const c = activeUpiCustomerId ? gc(activeUpiCustomerId) : null;
            if (!c) {
                const upiId = document.getElementById('upi-id-input').value.trim();
                const upiName = document.getElementById('upi-name-input').value.trim() || 'ShopTrack';
                if (!isValidUpiId(upiId)) return toast('Enter a valid UPI ID first', 'warn');
                toast('UPI ID is entered only when making a QR', 'warn');
                closeUpiModal();
                return;
            }
            if (billTotal(c) <= 0) return toast('Add bill amount before QR', 'warn');
            await renderUpiQr(c);
        }

        async function copyActiveUpiLink() {
            const c = activeUpiCustomerId ? gc(activeUpiCustomerId) : null;
            if (!c || !isValidUpiId(getUpiId())) return;
            try {
                await navigator.clipboard.writeText(buildUpiUrl(c));
                toast('UPI link copied');
            } catch (e) {
                toast('Copy failed', 'warn');
            }
        }

        function markActiveUpiPaid() {
            const c = activeUpiCustomerId ? gc(activeUpiCustomerId) : null;
            if (!c) return;
            c.paid = 1;
            c.payMethod = 'upi';
            save();
            rebuildCard(c.id);
            closeUpiModal();
            toast('Marked UPI paid');
        }

        function togglePaid(cid) {
            const c = gc(cid); if (!c) return;
            c.paid = c.paid ? 0 : 1;
            if (!c.paid) c.payMethod = null; // clear method when unpaid
            save();
            const card = document.getElementById('card-' + cid);
            if (card) {
                const btn = card.querySelector('.paid-btn');
                if (btn) {
                    btn.classList.toggle('is-paid', !!c.paid);
                    btn.innerHTML = c.paid
                        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> PAID'
                        : '💳 PAID?';
                }
                // clear method buttons if unpaid
                if (!c.paid) {
                    card.querySelectorAll('.pay-method-btn').forEach(b => {
                        b.classList.remove('active-cash', 'active-upi');
                    });
                }
                card.classList.toggle('pay-ok', !!c.paid);
                card.classList.toggle('pay-none', !c.paid);
            }
            updateSummary();
            toast(c.paid ? '💚 Payment received!' : 'Marked unpaid', c.paid ? 'ok' : 'warn');
        }

        /* ══ CHECK ALL-DONE ══════════════════ */
        function checkAllDone(cid) {
            const c = gc(cid); if (!c || c.items.length === 0) return;
            if (c.items.every(i => i.served) && !c.served) {
                toast('🎉 All items served — tap Complete!');
                // The card will show the banner via rebuildCard
            }
        }

        /* ══ SELECTIVE DOM UPDATES ═══════════ */
        function refreshItemStats(cid, iid) {
            const item = gi(cid, iid);
            const row = document.getElementById('item-' + cid + '-' + iid);
            if (!item || !row) return;
            const rem = Math.max(0, item.total - item.gave);
            const pct = item.total > 0 ? Math.min(100, Math.round((item.gave / item.total) * 100)) : 0;
            const gv = row.querySelector('.gave-val');
            const rv = row.querySelector('.remains-val');
            const pv = row.querySelector('.pct-val');
            const pf = row.querySelector('.prog-fill');
            if (gv) gv.textContent = '₹' + item.gave;
            if (rv) rv.textContent = '₹' + rem;
            if (pv) pv.textContent = pct + '%';
            if (pf) pf.style.width = pct + '%';
        }

        function refreshCardTotals(cid) {
            const c = gc(cid), el = document.getElementById('card-' + cid);
            if (!c || !el) return;
            const tot = c.items.reduce((s, i) => s + i.total, 0);
            const gav = c.items.reduce((s, i) => s + i.gave, 0);
            const t = el.querySelector('.ct-total');
            const g = el.querySelector('.ct-gave');
            const r = el.querySelector('.ct-rem');
            if (t) t.textContent = tot;
            if (g) g.textContent = gav;
            if (r) r.textContent = Math.max(0, tot - gav);
        }

        /* ══ BUILD ITEM HTML ════════════════ */
        function itemHTML(cid, item) {
            const rem = Math.max(0, item.total - item.gave);
            const pct = item.total > 0 ? Math.min(100, Math.round((item.gave / item.total) * 100)) : 0;

            /* ── SERVED STATE ── */
            if (item.served) {
                return `
    <div class="item-row item-done" id="item-${cid}-${item.id}">
      <div class="item-top">
        <input class="item-name-inp" value="${esc(item.name)}" placeholder="Item name"
          data-action="setname" data-cid="${cid}" data-iid="${item.id}"/>
        <span class="item-served-badge">✓ Served</span>
        ${item.parcel ? '<span style="background:rgba(93,156,240,.12);color:var(--blue);border:1px solid rgba(93,156,240,.3);border-radius:5px;font-size:.62rem;font-weight:700;padding:2px 7px;white-space:nowrap">📦 Parcel</span>' : ''}
        <button class="item-del" data-action="delitem" data-cid="${cid}" data-iid="${item.id}" title="Remove">✕</button>
      </div>
      <div class="served-stats">
        <span>Cost: <strong>₹${item.total}</strong></span>
        <span>Gave: <strong>₹${item.gave}</strong></span>
        <button class="undo-btn" data-action="unserve" data-cid="${cid}" data-iid="${item.id}">↩ Undo</button>
      </div>
      <div class="prog-track"><div class="prog-fill" style="width:100%"></div></div>
    </div>`;
            }

            /* ── ACTIVE STATE ── */
            const amtBtns = AMT.map(a =>
                `<button class="amt-btn" data-action="addcost" data-cid="${cid}" data-iid="${item.id}" data-amt="${a}">+${a}</button>`
            ).join('');

            return `
  <div class="item-row" id="item-${cid}-${item.id}">

    <!-- NAME + AUTOCOMPLETE + DELETE -->
    <div class="item-top">
      <div class="ac-wrap">
        <input class="item-name-inp" value="${esc(item.name)}" placeholder="Type to search menu…"
          data-action="setname" data-cid="${cid}" data-iid="${item.id}"
          autocomplete="off"/>
        <div class="ac-dropdown" id="ac-${cid}-${item.id}"></div>
      </div>
      <button class="item-del" data-action="delitem" data-cid="${cid}" data-iid="${item.id}" title="Remove">✕</button>
    </div>

    <!-- COST FIELD — type or use + buttons below -->
    <div class="cost-row">
      <span class="cost-symbol">₹</span>
      <input class="cost-inp" type="number" value="${item.total || ''}" min="0" placeholder="0"
        data-action="settotal" data-cid="${cid}" data-iid="${item.id}"/>
      <span class="cost-label">item cost</span>
      <button class="parcel-btn${item.parcel ? ' is-parcel' : ''}" data-action="toggleparcel" data-cid="${cid}" data-iid="${item.id}">
        ${item.parcel ? '📦 Parcel' : '📦 Parcel?'}
      </button>
    </div>

    <!-- + SHORTCUTS — hidden once cost is set -->
    <div class="amt-section" id="amts-${cid}-${item.id}" style="${item.total > 0 ? 'display:none' : ''}">
      <div class="amt-section-label">Quick add to cost:</div>
      <div class="amt-row">${amtBtns}</div>
      <div class="custom-row">
        <input class="custom-inp" type="number" min="1" placeholder="other amount…"
          data-cid="${cid}" data-iid="${item.id}"/>
        <button class="confirm-btn" data-action="addcost-custom" data-cid="${cid}" data-iid="${item.id}">+ Add</button>
      </div>
    </div>
    ${item.total > 0 ? `<button class="edit-cost-btn" data-action="showcost" data-cid="${cid}" data-iid="${item.id}">✏️ change cost</button>` : ''}

    <!-- SERVE = mark as given/done -->
    <button class="serve-btn" data-action="serve" data-cid="${cid}" data-iid="${item.id}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      SERVE  •  ₹${item.total || 0}
    </button>

  </div>`;
        }

        /* ══ BUILD CARD HTML ════════════════ */
        function cardHTML(c) {
            const tot = c.items.reduce((s, i) => s + i.total, 0);
            const allDone = c.items.length > 0 && c.items.every(i => i.served) && !c.served;
            const payClass = c.paid ? ' pay-ok' : ' pay-none';

            const itemsHTML = c.items.length
                ? c.items.map(i => itemHTML(c.id, i)).join('')
                : '<div class="no-items">No items yet — click Add Item below</div>';

            const allDoneBanner = allDone
                ? '<div class="all-done-banner"><div class="all-done-text"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>All items served!</div>'
                + '<button class="complete-cust-btn" data-action="completecust" data-cid="' + c.id + '">Complete →</button></div>'
                : '';

            const paidBtnInner = c.paid
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> PAID'
                : '💳 PAID?';

            return `
  <div class="ccard${c.served ? ' served' : ''}${payClass}" id="card-${c.id}">
    <div class="ccard-hdr">
      <div class="cname-wrap">
        <div class="cavatar">${(c.name || '?')[0].toUpperCase()}</div>
        <input class="cname-inp" value="${esc(c.name)}" placeholder="Customer name"
          data-action="setcname" data-cid="${c.id}"/>
      </div>
      ${c.served ? '<span class="served-badge">✓ Served</span>' : ''}
      <div class="ccard-actions">
        <button class="btn btn-sm btn-success" data-action="toggleserved" data-cid="${c.id}"
          title="${c.served ? 'Reopen' : 'Mark customer served'}">${c.served ? '↺' : '✓'}</button>
        <button class="btn btn-sm btn-danger" data-action="delcust" data-cid="${c.id}" title="Remove customer">✕</button>
      </div>
    </div>

    ${allDoneBanner}

    <div class="items-list">${itemsHTML}</div>

    <div class="ccard-footer">
      <button class="btn btn-ghost btn-sm" data-action="additem" data-cid="${c.id}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Item
      </button>
    </div>

    <div class="ccard-totals">
      <div class="ct-grp"><span class="ct-lbl">Bill</span><span class="ct-val orange ct-total">₹${tot}</span></div>
      <div class="ct-grp">
        <button class="paid-btn${c.paid ? ' is-paid' : ''}" data-action="togglepaid" data-cid="${c.id}">
          ${paidBtnInner}
        </button>
      </div>
      <div class="ct-grp">
        <div class="pay-method-row">
          <button class="pay-method-btn${c.payMethod === 'cash' ? ' active-cash' : ''}" data-action="setpaymethod" data-cid="${c.id}" data-method="cash">💵 Cash</button>
          <button class="pay-method-btn${c.payMethod === 'upi' ? ' active-upi' : ''}" data-action="setpaymethod" data-cid="${c.id}" data-method="upi">📲 UPI</button>
          <button class="pay-method-btn pay-qr-btn" data-action="showupi" data-cid="${c.id}" title="Show exact amount UPI QR">QR</button>
        </div>
      </div>
    </div>
  </div>`;
        }

        /* ══ REBUILD CARD ═════════════════════ */
        function rebuildCard(cid) {
            const c = gc(cid), el = document.getElementById('card-' + cid);
            if (!c || !el) { renderAll(); return; }
            const tmp = document.createElement('div');
            tmp.innerHTML = cardHTML(c);
            el.replaceWith(tmp.firstElementChild);
            updateSummary();
        }

        /* ══ RENDER ALL ═══════════════════════ */
        function filtered() {
            if (activeFilter === 'active') return S.customers.filter(c => !c.served);
            if (activeFilter === 'served') return S.customers.filter(c => c.served);
            if (activeFilter === 'unpaid') return S.customers.filter(c => payStatus(c) !== 'paid');
            return S.customers;
        }
        function renderAll() {
            const grid = document.getElementById('customers-grid');
            grid.querySelectorAll('.ccard').forEach(e => e.remove());
            document.getElementById('empty-state').classList.toggle('show', S.customers.length === 0);
            filtered().forEach(c => {
                const tmp = document.createElement('div');
                tmp.innerHTML = cardHTML(c);
                grid.appendChild(tmp.firstElementChild);
            });
            updateSummary();
        }

        /* ══ SUMMARY ══════════════════════════ */
        function updateSummary() {
            let billed = 0, collected = 0;
            S.customers.forEach(c => {
                const b = c.items.reduce((s, i) => s + i.total, 0);
                billed += b;
                if (c.paid) collected += b;
            });
            document.getElementById('sum-total').textContent = '₹' + billed;
            document.getElementById('sum-gave').textContent = '₹' + collected;
            document.getElementById('sum-remains').textContent = '₹' + Math.max(0, billed - collected);
            document.getElementById('sum-custs').textContent = S.customers.length;
            document.getElementById('hdr-active').textContent = S.customers.filter(c => !c.served).length;
            document.getElementById('hdr-served').textContent = S.customers.filter(c => c.served).length;
        }

        /* ══ AUTOCOMPLETE ENGINE ══════════════ */
        function menuSearch(q) {
            if (!q || q.length < 1) return [];
            const lq = q.toLowerCase();
            return MENU.filter(m =>
                m.name.toLowerCase().includes(lq) ||
                m.type.toLowerCase().includes(lq) ||
                (m.name + ' ' + m.type).toLowerCase().includes(lq)
            ).slice(0, 8);
        }

        function highlightMatch(text, q) {
            if (!q) return esc(text);
            const idx = text.toLowerCase().indexOf(q.toLowerCase());
            if (idx < 0) return esc(text);
            return esc(text.slice(0, idx))
                + '<em>' + esc(text.slice(idx, idx + q.length)) + '</em>'
                + esc(text.slice(idx + q.length));
        }

        function applyMenuItem(cid, iid, menuItem, qty, inp, dd) {
            const totalPrice = menuItem.price * qty;
            const label = qty > 1
                ? menuItem.name + ' (' + menuItem.type + ') ×' + qty
                : menuItem.name + ' (' + menuItem.type + ')';
            inp.value = label;
            setItemName(cid, iid, label);
            const item = gi(cid, iid);
            if (item) { item.total = totalPrice; save(); }
            const row = document.getElementById('item-' + cid + '-' + iid);
            if (row) {
                const ci = row.querySelector('.cost-inp');
                if (ci) ci.value = totalPrice;
                const sb = row.querySelector('.serve-btn');
                if (sb) sb.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> SERVE &nbsp;•&nbsp; ₹' + totalPrice;
                const cr = row.querySelector('.cost-row');
                if (cr) { cr.style.borderColor = 'var(--green)'; setTimeout(() => cr.style.borderColor = '', 400); }
            }
            refreshCardTotals(cid); updateSummary();
            dd.classList.remove('open'); dd.innerHTML = '';
            // hide quick-cost picker since cost is now set
            const amts = document.getElementById('amts-' + cid + '-' + iid);
            if (amts) amts.style.display = 'none';
            const editBtn = document.querySelector('#item-' + cid + '-' + iid + ' .edit-cost-btn');
            if (editBtn) editBtn.style.display = '';
        }

        function showAutocomplete(inp, cid, iid) {
            const q = inp.value.trim();
            const dd = document.getElementById('ac-' + cid + '-' + iid);
            if (!dd) return;
            const results = menuSearch(q);
            if (!results.length || !q) { dd.classList.remove('open'); dd.innerHTML = ''; return; }

            dd.innerHTML = results.map((m, i) => {
                const qtyBtns = [1, 2, 3, 4, 5].map(n =>
                    '<button class="ac-qty" data-ridx="' + i + '" data-qty="' + n + '">×' + n + '</button>'
                ).join('');
                return '<div class="ac-item" data-idx="' + i + '">'
                    + '<div class="ac-item-left">'
                    + '<span class="ac-item-name">' + highlightMatch(m.name, q) + '</span>'
                    + '<span class="ac-item-type">' + m.type + '</span>'
                    + '<span class="ac-item-price">₹' + m.price + '</span>'
                    + '</div>'
                    + '<div class="ac-qty-btns">' + qtyBtns + '</div>'
                    + '</div>';
            }).join('');
            dd.classList.add('open');

            // qty button clicks
            dd.querySelectorAll('.ac-qty').forEach(btn => {
                btn.addEventListener('mousedown', e => {
                    e.preventDefault();
                    const m = results[parseInt(btn.dataset.ridx)];
                    const qty = parseInt(btn.dataset.qty);
                    applyMenuItem(cid, iid, m, qty, inp, dd);
                });
            });
        }

        function hideAutocomplete(cid, iid) {
            const dd = document.getElementById('ac-' + cid + '-' + iid);
            if (dd) { dd.classList.remove('open'); dd.innerHTML = ''; }
        }

        /* ══ EVENT DELEGATION ═════════════════ */
        const grid = document.getElementById('customers-grid');

        grid.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]'); if (!btn) return;
            const { action, cid, iid, amt } = btn.dataset;
            if (action === 'serve') serveItem(cid, iid);
            if (action === 'unserve') unserveItem(cid, iid);
            if (action === 'addcost') addCost(cid, iid, parseInt(amt));
            if (action === 'addcost-custom') addCustomCost(cid, iid);
            if (action === 'toggleparcel') toggleParcel(cid, iid);
            if (action === 'showcost') {
                const s = document.getElementById('amts-' + cid + '-' + iid);
                const b = e.target.closest('[data-action]');
                if (s) { s.style.display = ''; if (b) b.style.display = 'none'; }
            }
            if (action === 'delitem') removeItem(cid, iid);
            if (action === 'delcust') removeCustomer(cid);
            if (action === 'toggleserved') toggleServed(cid);
            if (action === 'additem') addItem(cid);
            if (action === 'completecust') completeCustomer(cid);
            if (action === 'togglepaid') togglePaid(cid);
            if (action === 'showupi') openUpiModal(cid);
            if (action === 'setpaymethod') {
                const c = gc(cid); if (!c) return;
                // toggle off if already selected, else set
                c.payMethod = c.payMethod === btn.dataset.method ? null : btn.dataset.method;
                // auto-mark as paid when a method is selected
                if (c.payMethod) c.paid = 1;
                save();
                // update buttons in place
                const card = document.getElementById('card-' + cid);
                if (card) {
                    card.querySelectorAll('.pay-method-btn').forEach(b => {
                        b.classList.toggle('active-cash', c.payMethod === 'cash' && b.dataset.method === 'cash');
                        b.classList.toggle('active-upi', c.payMethod === 'upi' && b.dataset.method === 'upi');
                    });
                    const pb = card.querySelector('.paid-btn');
                    if (pb) {
                        pb.classList.toggle('is-paid', !!c.paid);
                        pb.innerHTML = c.paid
                            ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> PAID'
                            : '💳 PAID?';
                    }
                    card.classList.toggle('pay-ok', !!c.paid);
                    card.classList.toggle('pay-none', !c.paid);
                }
                updateSummary();
            }
        });

        grid.addEventListener('change', e => {
            const el = e.target;
            if (el.matches('.cost-inp')) setTotal(el.dataset.cid, el.dataset.iid, el.value);
            if (el.matches('.item-name-inp')) setItemName(el.dataset.cid, el.dataset.iid, el.value);
            if (el.matches('.cname-inp')) setCustName(el.dataset.cid, el.value);
        });

        grid.addEventListener('input', e => {
            const el = e.target;
            if (el.matches('.item-name-inp')) {
                showAutocomplete(el, el.dataset.cid, el.dataset.iid);
            }
        });

        grid.addEventListener('focusout', e => {
            if (e.target.matches('.item-name-inp')) {
                setTimeout(() => hideAutocomplete(e.target.dataset.cid, e.target.dataset.iid), 150);
            }
        });

        grid.addEventListener('keydown', e => {
            if (e.key === 'Escape' && e.target.matches('.item-name-inp')) {
                hideAutocomplete(e.target.dataset.cid, e.target.dataset.iid);
            }
            if (e.key === 'Enter' && e.target.matches('.custom-inp'))
                addCustomCost(e.target.dataset.cid, e.target.dataset.iid);
        });

        /* ══ TOOLBAR ══════════════════════════ */
        document.getElementById('btn-new').addEventListener('click', createCustomer);

        document.getElementById('btn-clear').addEventListener('click', () => {
            const n = S.customers.filter(c => c.served).length;
            if (!n) { toast('No served customers to clear', 'warn'); return; }
            const btn = document.getElementById('btn-clear');
            if (btn.dataset.armed === '1') {
                S.customers = S.customers.filter(c => !c.served);
                save(); renderAll(); toast(n + ' customer(s) cleared');
                btn.dataset.armed = '0'; btn.textContent = 'Clear Served'; btn.style.color = '';
            } else {
                btn.dataset.armed = '1';
                btn.textContent = 'Confirm clear ' + n + '?';
                btn.style.color = 'var(--red)';
                setTimeout(() => {
                    if (btn) { btn.dataset.armed = '0'; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg> Clear Served`; btn.style.color = ''; }
                }, 2500);
            }
        });

        document.getElementById('btn-export').addEventListener('click', exportPDF);

        /* ══ MENU MANAGEMENT ═════════════════ */
        document.getElementById('btn-menu').addEventListener('click', openMenuModal);
        document.getElementById('btn-menu-close').addEventListener('click', () => document.getElementById('menu-modal-bg').classList.remove('open'));
        document.getElementById('btn-menu-add').addEventListener('click', addMenuItem);
        document.getElementById('btn-upi-close').addEventListener('click', closeUpiModal);
        document.getElementById('btn-upi-save').addEventListener('click', generateActiveUpiQr);
        document.getElementById('btn-upi-copy').addEventListener('click', copyActiveUpiLink);
        document.getElementById('btn-upi-paid').addEventListener('click', markActiveUpiPaid);
        document.getElementById('upi-modal-bg').addEventListener('click', e => {
            if (e.target.id === 'upi-modal-bg') closeUpiModal();
        });

        function renderMenuModal() {
            const list = document.getElementById('menu-list');
            list.innerHTML = MENU.map(m => `
                <div style="display: flex; gap: 8px; align-items: center; background: var(--surface); padding: 8px; border-radius: 6px; border: 1px solid var(--border);">
                    <div style="flex: 1; font-weight: 700; font-size: 0.8rem;">${esc(m.name)} <span style="color:var(--muted); font-weight:normal; font-size:0.7rem;">${esc(m.type || '')}</span></div>
                    <div style="font-family: var(--mono); color: var(--accent); font-size: 0.8rem; font-weight: 700;">₹${m.price}</div>
                    <button class="item-del" onclick="deleteMenuItem('${m.id}')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:1.1rem; padding: 0 5px;">✕</button>
                </div>
            `).join('');
        }

        function openMenuModal() {
            renderMenuModal();
            document.getElementById('menu-modal-bg').classList.add('open');
        }

        async function addMenuItem() {
            const name = document.getElementById('new-menu-name').value.trim();
            const type = document.getElementById('new-menu-type').value.trim();
            const price = document.getElementById('new-menu-price').value;
            if (!name || !price) return toast('Name and price required', 'warn');
            
            const btn = document.getElementById('btn-menu-add');
            btn.disabled = true;
            try {
                const res = await fetch(`${API_BASE}/api/menu`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-shop-pin': SHOP_PIN },
                    body: JSON.stringify({ name, type, price })
                });
                if (res.ok) {
                    const data = await res.json();
                    MENU = data.menu;
                    renderMenuModal();
                    document.getElementById('new-menu-name').value = '';
                    document.getElementById('new-menu-type').value = '';
                    document.getElementById('new-menu-price').value = '';
                    toast('Menu item added');
                }
            } catch (e) { toast('Error adding item', 'warn'); }
            btn.disabled = false;
        }

        window.deleteMenuItem = async function(id) {
            try {
                const res = await fetch(`${API_BASE}/api/menu/${id}`, {
                    method: 'DELETE',
                    headers: { 'x-shop-pin': SHOP_PIN }
                });
                if (res.ok) {
                    MENU = MENU.filter(m => m.id !== id);
                    renderMenuModal();
                    toast('Item deleted');
                }
            } catch (e) { toast('Error deleting', 'warn'); }
        };

        function exportPDF() {
            const now = new Date();
            const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

            let totalCost = 0, totalPaid = 0;
            S.customers.forEach(c => {
                const b = c.items.reduce((s, i) => s + i.total, 0);
                totalCost += b;
                if (c.paid) totalPaid += b;   // paid is boolean 1/0, not money amount
            });
            const totalRem = Math.max(0, totalCost - totalPaid);

            // Build customer rows
            let rows = '';
            S.customers.forEach(c => {
                const cTot = c.items.reduce((s, i) => s + i.total, 0);
                const cPaid = c.paid ? cTot : 0;   // paid=1 means full bill paid
                const cBal = cTot - cPaid;
                const pSt = c.paid ? 'paid' : 'unpaid';
                const pColor = c.paid ? '#3ecf8e' : '#f05d5d';
                const pLabel = c.paid
                    ? ('✓ Paid' + (c.payMethod === 'cash' ? ' · Cash' : c.payMethod === 'upi' ? ' · UPI' : ''))
                    : 'Unpaid';
                const status = c.served ? 'Served' : 'Active';
                const statusColor = c.served ? '#3ecf8e' : '#f5a623';

                if (!c.items.length) {
                    rows += '<tr class="cust-row">'
                        + '<td><span class="cust-name">' + esc(c.name) + '</span></td>'
                        + '<td><span class="badge" style="background:' + statusColor + '20;color:' + statusColor + '">' + status + '</span></td>'
                        + '<td class="item-name muted">—</td>'
                        + '<td class="num">₹0</td>'
                        + '<td class="num">₹' + cPaid + '</td>'
                        + '<td class="num ' + (cBal > 0 ? 'red' : 'grn') + '">₹' + Math.max(0, cBal) + '</td>'
                        + '<td><span class="badge" style="background:' + pColor + '20;color:' + pColor + '">' + pLabel + '</span></td>'
                        + '</tr>';
                } else {
                    c.items.forEach((item, idx) => {
                        const iStatus = item.served ? '✓' : '…';
                        const iColor = item.served ? '#3ecf8e' : '#9898b0';
                        const trClass = idx === 0 ? 'cust-row' : 'cont-row';
                        const custCells = idx === 0
                            ? '<td rowspan="' + c.items.length + '"><span class="cust-name">' + esc(c.name) + '</span></td>'
                            + '<td rowspan="' + c.items.length + '"><span class="badge" style="background:' + statusColor + '20;color:' + statusColor + '">' + status + '</span></td>'
                            : '';
                        const payCells = idx === 0
                            ? '<td rowspan="' + c.items.length + '" class="num grn">₹' + cPaid + '</td>'
                            + '<td rowspan="' + c.items.length + '" class="num ' + (cBal > 0 ? 'red' : 'grn') + '">₹' + Math.max(0, cBal) + '</td>'
                            + '<td rowspan="' + c.items.length + '"><span class="badge" style="background:' + pColor + '20;color:' + pColor + '">' + pLabel + '</span></td>'
                            : '';
                        rows += '<tr class="' + trClass + '">'
                            + custCells
                            + '<td class="item-name"><span style="color:' + iColor + ';margin-right:5px">' + iStatus + '</span>' + esc(item.name) + (item.parcel ? ' <span style="background:#5d9cf020;color:#5d9cf0;border:1px solid #5d9cf040;border-radius:4px;font-size:.6rem;padding:1px 5px;font-weight:700;letter-spacing:.3px">📦 PARCEL</span>' : '') + '</td>'
                            + '<td class="num">₹' + item.total + '</td>'
                            + payCells
                            + '</tr>';
                    });
                }
            });

            // ── ANALYTICS ──────────────────────────
            let cashCount = 0, cashTotal = 0, upiCount = 0, upiTotal = 0;
            let unpaidCount = 0, unpaidTotal = 0, parcelCount = 0;
            let servedCount = 0, activeCount = 0;
            const itemMap = {}; // name → {qty, revenue}

            S.customers.forEach(c => {
                const bill = c.items.reduce((s, i) => s + i.total, 0);
                if (c.served) servedCount++; else activeCount++;
                if (c.paid) {
                    if (c.payMethod === 'cash') { cashCount++; cashTotal += bill; }
                    else if (c.payMethod === 'upi') { upiCount++; upiTotal += bill; }
                    else { cashCount++; cashTotal += bill; } // paid but no method = cash assumed
                } else {
                    unpaidCount++; unpaidTotal += bill;
                }
                c.items.forEach(i => {
                    if (i.parcel) parcelCount++;
                    const key = i.name || 'Unknown';
                    if (!itemMap[key]) itemMap[key] = { qty: 0, revenue: 0 };
                    itemMap[key].qty++;
                    itemMap[key].revenue += i.total;
                });
            });

            // top items by qty
            const topItems = Object.entries(itemMap)
                .sort((a, b) => b[1].qty - a[1].qty)
                .slice(0, 8);

            // avg bill per paid customer
            const paidCusts = cashCount + upiCount;
            const avgBill = paidCusts > 0 ? Math.round((cashTotal + upiTotal) / paidCusts) : 0;

            // cash vs upi split %
            const totalCollected = cashTotal + upiTotal;
            const cashPct = totalCollected > 0 ? Math.round((cashTotal / totalCollected) * 100) : 0;
            const upiPct = totalCollected > 0 ? 100 - cashPct : 0;

            // top items HTML
            const topItemsHTML = topItems.map(([name, d]) => {
                const pct = totalCost > 0 ? Math.round((d.revenue / totalCost) * 100) : 0;
                return '<tr>'
                    + '<td style="padding:7px 10px;font-size:.8rem;color:#1a1a2e;font-weight:600">' + esc(name) + '</td>'
                    + '<td style="padding:7px 10px;text-align:center;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:#0e0e0f">' + d.qty + '×</td>'
                    + '<td style="padding:7px 10px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:#1a9967">₹' + d.revenue + '</td>'
                    + '<td style="padding:7px 10px">'
                    + '<div style="background:#e8e8f0;border-radius:99px;height:6px;overflow:hidden">'
                    + '<div style="background:#3ecf8e;height:100%;width:' + pct + '%;border-radius:99px"></div>'
                    + '</div>'
                    + '</td>'
                    + '</tr>';
            }).join('');

            const analysisSection = `
<div style="margin-top:28px;page-break-inside:avoid">
  <div class="section-title" style="margin-bottom:16px">📊 Day Analysis</div>

  <!-- Payment Method Breakdown -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
    <div style="background:#f0fdf6;border:1px solid #3ecf8e40;border-radius:10px;padding:16px;border-left:4px solid #3ecf8e">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#1a9967;margin-bottom:6px">💵 Cash</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#1a9967;line-height:1">₹${cashTotal}</div>
      <div style="font-size:.68rem;color:#6b6b80;margin-top:4px">${cashCount} customer${cashCount !== 1 ? 's' : ''} &nbsp;·&nbsp; ${cashPct}% of collection</div>
    </div>
    <div style="background:#f0f5ff;border:1px solid #5d9cf040;border-radius:10px;padding:16px;border-left:4px solid #5d9cf0">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#2d72c4;margin-bottom:6px">📲 UPI</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#2d72c4;line-height:1">₹${upiTotal}</div>
      <div style="font-size:.68rem;color:#6b6b80;margin-top:4px">${upiCount} customer${upiCount !== 1 ? 's' : ''} &nbsp;·&nbsp; ${upiPct}% of collection</div>
    </div>
    <div style="background:#fff2f2;border:1px solid #f05d5d40;border-radius:10px;padding:16px;border-left:4px solid #f05d5d">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#c43e3e;margin-bottom:6px">⏳ Unpaid</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#c43e3e;line-height:1">₹${unpaidTotal}</div>
      <div style="font-size:.68rem;color:#6b6b80;margin-top:4px">${unpaidCount} customer${unpaidCount !== 1 ? 's' : ''} pending</div>
    </div>
  </div>

  <!-- Cash vs UPI bar -->
  ${totalCollected > 0 ? `
  <div style="margin-bottom:20px;background:#f8f8fc;border-radius:10px;padding:14px 16px">
    <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#9898b0;margin-bottom:8px">Collection Split</div>
    <div style="display:flex;border-radius:8px;overflow:hidden;height:22px;gap:2px">
      ${cashPct > 0 ? `<div style="background:#3ecf8e;width:${cashPct}%;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace">💵 ${cashPct}%</div>` : ''}
      ${upiPct > 0 ? `<div style="background:#5d9cf0;width:${upiPct}%;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace">📲 ${upiPct}%</div>` : ''}
    </div>
  </div>`: ''}

  <!-- Key Stats Row -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
    <div style="background:#f8f8fc;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:1.3rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#0e0e0f">${S.customers.length}</div>
      <div style="font-size:.6rem;color:#9898b0;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Total Customers</div>
    </div>
    <div style="background:#f8f8fc;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:1.3rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#1a9967">${servedCount}</div>
      <div style="font-size:.6rem;color:#9898b0;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Served</div>
    </div>
    <div style="background:#f8f8fc;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:1.3rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#f5a623">₹${avgBill}</div>
      <div style="font-size:.6rem;color:#9898b0;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Avg Bill</div>
    </div>
    <div style="background:#f8f8fc;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:1.3rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#5d9cf0">${parcelCount}</div>
      <div style="font-size:.6rem;color:#9898b0;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">📦 Parcels</div>
    </div>
  </div>

  <!-- Top Items -->
  ${topItems.length > 0 ? `
  <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#9898b0;margin-bottom:8px">🏆 Top Items</div>
  <table style="width:100%;border-collapse:collapse;background:#f8f8fc;border-radius:10px;overflow:hidden">
    <thead>
      <tr style="background:#0e0e0f">
        <th style="padding:8px 10px;text-align:left;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#fff">Item</th>
        <th style="padding:8px 10px;text-align:center;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#fff">Qty</th>
        <th style="padding:8px 10px;text-align:right;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#fff">Revenue</th>
        <th style="padding:8px 10px;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#fff">Share</th>
      </tr>
    </thead>
    <tbody>${topItemsHTML}</tbody>
  </table>`: ''}
</div>`;

            const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>ShopTrack Report — ${dateStr}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Syne',sans-serif;background:#fff;color:#1a1a2e;padding:32px 40px;font-size:13px}
  
  /* HEADER */
  .report-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #f5a623}
  .brand{display:flex;align-items:center;gap:10px}
  .brand-dot{width:12px;height:12px;border-radius:50%;background:#f5a623}
  .brand-name{font-size:1.5rem;font-weight:800;letter-spacing:-.5px;color:#0e0e0f}
  .brand-sub{font-size:.72rem;color:#9898b0;font-family:'JetBrains Mono',monospace;margin-top:2px}
  .report-meta{text-align:right;font-family:'JetBrains Mono',monospace;font-size:.72rem;color:#6b6b80;line-height:1.7}
  .report-meta strong{color:#0e0e0f;font-size:.8rem}

  /* SUMMARY CARDS */
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
  .scard{border-radius:10px;padding:14px 16px;border:1px solid #e8e8f0}
  .scard.o{background:#fff8ee;border-color:#f5a62340}
  .scard.g{background:#f0fdf6;border-color:#3ecf8e40}
  .scard.r{background:#fff2f2;border-color:#f05d5d40}
  .scard.b{background:#f0f5ff;border-color:#5d9cf040}
  .scard-lbl{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  .scard.o .scard-lbl{color:#c47d0a}
  .scard.g .scard-lbl{color:#1a9967}
  .scard.r .scard-lbl{color:#c43e3e}
  .scard.b .scard-lbl{color:#2d72c4}
  .scard-val{font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;line-height:1}
  .scard.o .scard-val{color:#f5a623}
  .scard.g .scard-val{color:#3ecf8e}
  .scard.r .scard-val{color:#f05d5d}
  .scard.b .scard-val{color:#5d9cf0}

  /* TABLE */
  .section-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#9898b0;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  thead th{background:#0e0e0f;color:#fff;padding:9px 12px;text-align:left;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  thead th.num{text-align:right}
  tbody tr{border-bottom:1px solid #f0f0f5}
  tbody tr:last-child{border-bottom:none}
  td{padding:8px 12px;vertical-align:middle}
  .cust-row td{background:#fafafa}
  .cont-row td{background:#fff}
  .subtotal-row td{background:#f5f5fa;border-top:1px dashed #ddd}
  .cust-name{font-weight:700;font-size:.88rem;color:#0e0e0f}
  .item-name{color:#444;font-size:.8rem}
  .muted{color:#aaa}
  .num{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600}
  .grn{color:#1a9967}
  .red{color:#c43e3e}
  .badge{border-radius:5px;font-size:.62rem;font-weight:700;padding:2px 7px;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap}

  /* GRAND TOTAL */
  .grand-total{margin-top:16px;background:#0e0e0f;border-radius:10px;padding:14px 20px;display:flex;justify-content:flex-end;gap:32px;color:#fff}
  .gt-grp{text-align:right}
  .gt-lbl{font-size:.6rem;text-transform:uppercase;letter-spacing:.8px;color:#6b6b80;margin-bottom:2px}
  .gt-val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.1rem}
  .gt-val.o{color:#f5a623}.gt-val.g{color:#3ecf8e}.gt-val.r{color:#f05d5d}

  /* FOOTER */
  .report-footer{margin-top:24px;text-align:center;font-size:.65rem;color:#ccc;font-family:'JetBrains Mono',monospace;border-top:1px solid #f0f0f5;padding-top:14px}

  @media print{
    body{padding:20px 28px}
    @page{margin:1cm;size:A4}
  }
</style>
</head>
<body>

<div class="report-hdr">
  <div>
    <div class="brand">
      <div class="brand-dot"></div>
      <div class="brand-name">ShopTrack</div>
    </div>
    <div class="brand-sub">Order Report</div>
  </div>
  <div class="report-meta">
    <div><strong>${dateStr}</strong></div>
    <div>${timeStr}</div>
    <div>${S.customers.length} customer(s) &nbsp;·&nbsp; ${S.customers.filter(c => c.served).length} served</div>
  </div>
</div>

<div class="summary">
  <div class="scard o"><div class="scard-lbl">Total Billed</div><div class="scard-val">₹${totalCost}</div></div>
  <div class="scard g"><div class="scard-lbl">Collected</div><div class="scard-val">₹${totalPaid}</div></div>
  <div class="scard r"><div class="scard-lbl">Pending</div><div class="scard-val">₹${totalRem}</div></div>
  <div class="scard b"><div class="scard-lbl">Customers</div><div class="scard-val">${S.customers.length}</div></div>
</div>

<div class="section-title">Order Details</div>
<table>
  <thead>
    <tr>
      <th>Customer</th>
      <th>Status</th>
      <th>Item</th>
      <th class="num">Item Cost</th>
      <th class="num">Paid</th>
      <th class="num">Balance</th>
      <th>Payment</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="grand-total">
  <div class="gt-grp"><div class="gt-lbl">Total Billed</div><div class="gt-val o">₹${totalCost}</div></div>
  <div class="gt-grp"><div class="gt-lbl">Collected</div><div class="gt-val g">₹${totalPaid}</div></div>
  <div class="gt-grp"><div class="gt-lbl">Pending</div><div class="gt-val r">₹${totalRem}</div></div>
</div>

${analysisSection}

<div class="report-footer">Generated by ShopTrack &nbsp;·&nbsp; ${dateStr} ${timeStr} &nbsp;·&nbsp; Use browser Print → Save as PDF</div>

<scr${'i'}pt>window.onload=()=>window.print()</scr${'i'}pt>
</body>
</html>`;

            const w = window.open('', '_blank', 'width=900,height=700');
            if (!w) { toast('Allow popups to export PDF', 'warn'); return; }
            w.document.write(html);
            w.document.close();
            toast('PDF preview opened!');
        }

        /* ══ COMPLETE THE DAY ════════════════ */
        document.getElementById('btn-endday').addEventListener('click', () => {
            const btn = document.getElementById('btn-endday');
            if (btn.dataset.armed === '1') {
                // Export PDF first, then wipe
                exportPDF();
                setTimeout(async () => {
                    try {
                        const res = await fetch(`${API_BASE}/api/end-day`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-shop-pin': SHOP_PIN }
                        });
                        if (res.ok) {
                            const data = await res.json();
                            toast(`🌙 Day completed! Billed: ₹${data.summary.totalBilled}`);
                            // SSE will automatically push the empty state back to us and renderAll
                        } else {
                            toast('Failed to end day on server', 'warn');
                        }
                    } catch (e) {
                        toast('Server error', 'warn');
                    }
                    
                    btn.dataset.armed = '0';
                    btn.classList.remove('armed');
                    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Complete the Day`;
                }, 600);
            } else {
                btn.dataset.armed = '1';
                btn.classList.add('armed');
                btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Tap again to confirm`;
                setTimeout(() => {
                    if (btn.dataset.armed === '1') {
                        btn.dataset.armed = '0';
                        btn.classList.remove('armed');
                        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Complete the Day`;
                    }
                }, 3000);
            }
        });

        /* ══ FILTER TABS ══════════════════════ */
        document.querySelector('.filter-tabs').addEventListener('click', e => {
            const tab = e.target.closest('.tab'); if (!tab) return;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeFilter = tab.dataset.filter;
            renderAll();
        });

        /* ══ KEYBOARD ════════════════════════ */
        document.addEventListener('keydown', e => {
            // nothing currently
        });

        /* ══ SAVED INDICATOR ════════════════ */
        function updateSavedAt() {
            const el = document.getElementById('session-timer');
            if (!S.savedAt) { el.textContent = 'not saved yet'; return; }
            const d = new Date(S.savedAt);
            el.textContent = 'saved ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        }

        /* ══ BOOT ═════════════════════════════ */
        load(); renderAll(); updateSavedAt();
        setInterval(updateSavedAt, 10000);
    
