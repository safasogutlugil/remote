// TV Remote — browser-only. The phone talks straight to the LG TV over its local
// WebSocket API (SSAP, wss://<tv>:3001). No server, nothing to keep running.
(() => {
    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];

    const store = {
        get(k) { try { return localStorage.getItem(k); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
        del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
    };

    // ───────────── state shown in the UI ─────────────
    const st = {
        host: store.get('tv.host') || '',
        link: 'idle', // idle | connecting | prompt | on | off
        power: 'unknown',
        tvName: '',
        model: '',
        volume: null,
        muted: false,
        app: null,
        apps: [],
        inputs: [],
    };
    st.tvName = (st.host && store.get('tv.name.' + st.host)) || 'Your TV';

    // ───────────── SSAP client ─────────────
    let ws = null;
    let paired = false;
    let seq = 0;
    const pending = new Map(); // id -> {resolve, reject, timer}
    const subs = new Map(); // id -> callback
    let pointerWs = null;
    let pointerOpening = null;
    let retryTimer = 0;
    let heartbeat = 0;
    let failures = 0;

    const POWER = {
        Active: 'on', 'Active Standby': 'standby', Suspend: 'off',
        'Screen Off': 'screen_off', 'Screen Saver': 'screen_saver', 'Power Off': 'off',
    };

    function urlsFor(host) {
        const list = [`wss://${host}:3001`];
        // older TVs also listen unencrypted on 3000; only usable when this page itself is http
        if (location.protocol === 'http:') list.push(`ws://${host}:3000`);
        return list;
    }

    function connect() {
        clearTimeout(retryTimer);
        if (!st.host || (ws && ws.readyState <= 1)) return;
        if (st.link === 'idle') setLink('connecting');
        tryUrl(urlsFor(st.host), 0);
    }

    function tryUrl(urls, i) {
        let opened = false;
        let sock;
        try {
            sock = new WebSocket(urls[i]);
        } catch {
            return failed();
        }
        ws = sock;
        // a TV that's off never answers; don't wait for the browser's long default timeout
        const guard = setTimeout(() => { if (!opened) sock.close(); }, 5000);
        sock.onopen = () => {
            opened = true;
            clearTimeout(guard);
            register();
        };
        sock.onmessage = (e) => onMessage(e.data);
        sock.onclose = () => {
            clearTimeout(guard);
            if (ws !== sock) return;
            ws = null;
            if (!opened && i + 1 < urls.length) return tryUrl(urls, i + 1);
            dropped();
        };
    }

    function failed() { ws = null; dropped(); }

    function dropped() {
        const wasOn = paired;
        paired = false;
        clearInterval(heartbeat);
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
        pending.clear();
        subs.clear();
        closePointer();
        failures = wasOn ? 0 : failures + 1;
        Object.assign(st, {link: st.host ? 'off' : 'idle', power: 'off', app: null});
        render();
        if (st.host && document.visibilityState === 'visible') {
            retryTimer = setTimeout(connect, wasOn ? 1500 : Math.min(10000, 2000 + failures * 1500));
        }
    }

    function sendRaw(obj) {
        if (!ws || ws.readyState !== 1) throw new Error('not connected');
        ws.send(JSON.stringify(obj));
    }

    function register() {
        const payload = JSON.parse(JSON.stringify(window.LG_PAIRING));
        const key = store.get('tv.key.' + st.host);
        if (key) payload['client-key'] = key;
        sendRaw({type: 'register', id: 'register_0', payload});
    }

    function onMessage(raw) {
        let m;
        try { m = JSON.parse(raw); } catch { return; }

        if (m.id === 'register_0') {
            if (m.type === 'registered') {
                if (m.payload && m.payload['client-key']) store.set('tv.key.' + st.host, m.payload['client-key']);
                paired = true;
                failures = 0;
                onPaired();
            } else if (m.type === 'response' && m.payload && m.payload.pairingType === 'PROMPT') {
                setLink('prompt');
            } else if (m.type === 'error') {
                toast(/denied|cancel/i.test(m.error || '') ? 'The TV declined. Tap Connect and accept the prompt.' : 'The TV refused: ' + m.error, true);
                ws && ws.close();
            }
            return;
        }
        if (pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.type === 'error' || (m.payload && m.payload.returnValue === false)) {
                p.reject(new Error((m.payload && m.payload.errorText) || m.error || 'TV error'));
            } else p.resolve(m.payload || {});
        } else if (subs.has(m.id) && m.type !== 'error') {
            subs.get(m.id)(m.payload || {});
        }
    }

    function request(uri, payload = {}, timeout = 8000) {
        return new Promise((resolve, reject) => {
            if (!paired) return reject(new Error('not connected'));
            const id = 'r' + ++seq;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeout);
            pending.set(id, {resolve, reject, timer});
            try { sendRaw({type: 'request', id, uri, payload}); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
        });
    }

    function subscribe(uri, cb, payload = {}) {
        const id = 's' + ++seq;
        subs.set(id, cb);
        try { sendRaw({type: 'subscribe', id, uri, payload}); } catch { subs.delete(id); }
    }

    // buttons, pointer moves and clicks go over a second socket the TV hands out
    function pointer() {
        if (pointerWs && pointerWs.readyState === 1) return Promise.resolve(pointerWs);
        if (pointerOpening) return pointerOpening;
        pointerOpening = request('ssap://com.webos.service.networkinput/getPointerInputSocket')
            .then((res) => new Promise((resolve, reject) => {
                const s = new WebSocket(res.socketPath);
                s.onopen = () => { pointerWs = s; resolve(s); };
                s.onerror = () => reject(new Error('pointer socket failed'));
                s.onclose = () => { if (pointerWs === s) pointerWs = null; };
            }))
            .finally(() => { pointerOpening = null; });
        return pointerOpening;
    }
    function closePointer() {
        if (pointerWs) { try { pointerWs.close(); } catch { /* gone */ } }
        pointerWs = null;
    }
    async function input(type, fields = {}) {
        const s = await pointer();
        const lines = ['type:' + type, ...Object.entries(fields).map(([k, v]) => `${k}:${v}`)];
        s.send(lines.join('\n') + '\n\n');
    }

    async function onPaired() {
        setLink('on');
        Object.assign(st, {power: 'on'});
        render();

        // websockets don't notice a TV that vanished; poll it so the status stays honest
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
            request('ssap://com.webos.service.tvpower/power/getPowerState', {}, 4000)
                .then((r) => { st.power = POWER[r.state] || 'on'; render(); })
                .catch(() => ws && ws.close());
        }, 6000);

        subscribe('ssap://com.webos.service.tvpower/power/getPowerState', (r) => {
            st.power = POWER[r.state] || 'on';
            render();
        });
        subscribe('ssap://audio/getVolume', (r) => {
            const vs = r.volumeStatus || r;
            st.volume = typeof vs.volume === 'number' ? vs.volume : null;
            st.muted = Boolean(vs.muteStatus ?? vs.muted ?? r.mute);
            render();
        });

        try {
            const inp = await request('ssap://tv/getExternalInputList');
            st.inputs = (inp.devices || []).map((d) => ({
                id: d.id, label: d.label || d.id, appId: d.appId || null, connected: d.connected !== false,
            }));
        } catch { /* some sources don't list inputs */ }

        try {
            const lp = await request('ssap://com.webos.applicationManager/listLaunchPoints');
            st.apps = (lp.launchPoints || []).filter((p) => p.id && p.title).map((p) => ({
                id: p.id, title: p.title, icon: iconUrl(p.largeIcon || p.icon), color: p.bgColor || p.iconColor || null,
            }));
        } catch { /* keep whatever we had */ }
        render();

        subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (r) => {
            if (!r.appId) return;
            st.app = {id: r.appId, title: appTitle(r.appId)};
            render();
        });

        request('ssap://system/getSystemInfo').then((i) => { st.model = i.modelName || ''; render(); }).catch(() => {});
        request('ssap://settings/getSystemSettings', {category: 'network', keys: ['deviceName']})
            .then((r) => {
                const n = r.settings && r.settings.deviceName;
                if (n) { st.tvName = n; store.set('tv.name.' + st.host, n); render(); }
            })
            .catch(() => {});
    }

    // icons are served by the TV; on an https page, fetch them over its https port
    function iconUrl(u) {
        if (!u) return null;
        if (location.protocol === 'https:') return u.replace(/^http:\/\/([^/:]+):3000\//, 'https://$1:3001/');
        return u;
    }

    function appTitle(id) {
        const a = st.apps.find((x) => x.id === id);
        if (a) return a.title;
        const i = st.inputs.find((x) => x.appId === id);
        if (i) return i.label;
        if (id === 'com.webos.app.livetv') return 'Live TV';
        if (id === 'com.webos.app.home') return 'Home';
        return id.split('.').pop();
    }

    function setLink(link) { st.link = link; render(); }

    const tvReady = () => paired && !['off', 'standby'].includes(st.power);

    // run a TV action and turn failures into one clear message
    async function act(fn) {
        if (!paired) {
            toast(st.link === 'prompt' ? 'Accept the prompt on your TV first' : !st.host ? 'Set up your TV first' : 'Not connected to the TV', true);
            if (!st.host) openSheet('setup');
            return false;
        }
        try { await fn(); return true; } catch (e) { toast('The TV didn’t respond: ' + e.message, true); return false; }
    }

    // ───────────── rendering ─────────────
    const halo = $('#halo');
    function render() {
        let title, sub = '', haloState = '';
        if (!st.host) {
            title = 'Set up your TV';
            sub = 'Tap here to connect';
        } else if (st.link === 'prompt') {
            title = 'Accept the prompt on your TV';
            sub = 'Use the TV’s own remote, once';
            haloState = 'is-prompt';
        } else if (st.link === 'connecting' || st.link === 'idle') {
            title = 'Connecting to ' + st.tvName + '…';
        } else if (st.link === 'off') {
            title = `Can’t reach ${st.tvName}`;
            sub = 'It may be off. Tap here if it’s on';
            haloState = 'is-down';
        } else if (st.power === 'off' || st.power === 'standby') {
            title = `${st.tvName} is off`;
            sub = 'Turn it on with its own remote';
        } else {
            title = st.tvName;
            sub = st.power === 'screen_off' ? 'Screen off, sound on' : st.app ? st.app.title : '';
            haloState = 'is-on';
        }
        $('#statusTitle').textContent = title;
        $('#statusSub').textContent = sub;
        halo.className = 'halo ' + haloState;

        const ready = tvReady();
        $('#volNum').textContent = ready && typeof st.volume === 'number' ? String(st.volume) : '–';
        $('#muteBtn').classList.toggle('is-muted', ready && st.muted);
        $('#volLabel').textContent = ready && st.muted ? 'Muted' : 'Vol';

        renderApps();
        renderInputs();
        $('#factName').textContent = st.model ? `${st.tvName} (${st.model})` : st.tvName;
        $('#factHost').textContent = st.host || 'Not set';
    }

    let appsKey = '';
    function renderApps() {
        const box = $('#apps');
        const key = st.apps.map((a) => a.id).join('|');
        if (key !== appsKey) {
            appsKey = key;
            box.textContent = '';
            if (!st.apps.length) {
                const p = document.createElement('p');
                p.className = 'apps-empty';
                p.textContent = 'Your TV’s apps show up here once it’s connected.';
                box.append(p);
            }
            for (const a of st.apps) {
                const b = document.createElement('button');
                b.className = 'app';
                b.dataset.app = a.id;
                b.setAttribute('aria-label', 'Open ' + a.title);
                const tile = document.createElement('span');
                tile.className = 'app-tile';
                if (a.color) tile.style.background = a.color;
                const initial = () => {
                    tile.textContent = '';
                    const s = document.createElement('span');
                    s.className = 'app-initial';
                    s.textContent = a.title.trim().charAt(0).toUpperCase();
                    tile.append(s);
                };
                if (a.icon) {
                    const img = new Image();
                    img.alt = '';
                    img.src = a.icon;
                    img.onerror = initial;
                    tile.append(img);
                } else initial();
                const name = document.createElement('span');
                name.className = 'app-name';
                name.textContent = a.title;
                b.append(tile, name);
                b.addEventListener('click', () => {
                    haptic();
                    act(() => request('ssap://system.launcher/launch', {id: a.id})).then((ok) => ok && toast('Opening ' + a.title));
                });
                box.append(b);
            }
        }
        const cur = tvReady() && st.app ? st.app.id : '';
        $$('.app', box).forEach((b) => b.classList.toggle('is-current', b.dataset.app === cur));
    }

    let inputsKey = '';
    function renderInputs() {
        const list = $('#inputList');
        const key = st.inputs.map((i) => i.id + i.label + i.connected).join('|');
        if (key !== inputsKey) {
            inputsKey = key;
            list.textContent = '';
            if (!st.inputs.length) {
                const p = document.createElement('p');
                p.className = 'sheet-note';
                p.textContent = 'Inputs appear once the TV is connected.';
                list.append(p);
            }
            for (const i of st.inputs) {
                const b = document.createElement('button');
                b.className = 'list-item';
                b.dataset.app = i.appId || '';
                const l = document.createElement('span');
                l.textContent = i.label;
                const s = document.createElement('small');
                s.textContent = i.connected ? 'Connected' : 'Nothing plugged in';
                b.append(l, s);
                b.addEventListener('click', () => {
                    haptic();
                    act(() => request('ssap://tv/switchInput', {inputId: i.id})).then((ok) => {
                        if (ok) { toast('Switching to ' + i.label); closeSheets(); }
                    });
                });
                list.append(b);
            }
        }
        const cur = st.app ? st.app.id : '';
        $$('.list-item', list).forEach((b) => b.classList.toggle('is-current', Boolean(b.dataset.app) && b.dataset.app === cur));
    }

    // ───────────── feedback ─────────────
    function haptic() { if (navigator.vibrate) navigator.vibrate(6); }
    let flashT;
    function flash() {
        if (!tvReady()) return;
        halo.classList.add('is-flash');
        clearTimeout(flashT);
        flashT = setTimeout(() => halo.classList.remove('is-flash'), 90);
    }
    let toastT;
    function toast(text, isError) {
        const t = $('#toast');
        t.textContent = text;
        t.classList.toggle('is-error', Boolean(isError));
        t.classList.add('is-shown');
        clearTimeout(toastT);
        toastT = setTimeout(() => t.classList.remove('is-shown'), isError ? 3800 : 1800);
    }

    // ───────────── buttons (press-and-hold repeats) ─────────────
    function fire(el) {
        haptic();
        flash();
        if (el.dataset.key) act(() => input('button', {name: el.dataset.key}));
        else if (el.dataset.vol) act(() => request(Number(el.dataset.vol) > 0 ? 'ssap://audio/volumeUp' : 'ssap://audio/volumeDown'));
    }

    $$('[data-key], [data-vol]').forEach((el) => {
        let delay, rep;
        const stop = () => { clearTimeout(delay); clearInterval(rep); el.classList.remove('is-down'); };
        el.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            e.preventDefault();
            el.classList.add('is-down');
            fire(el);
            if (el.hasAttribute('data-repeat')) delay = setTimeout(() => { rep = setInterval(() => fire(el), 110); }, 380);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el.addEventListener(ev, stop));
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        el.addEventListener('click', (e) => { if (e.detail === 0) fire(el); });
    });

    $('#powerBtn').addEventListener('click', () => {
        haptic();
        if (paired && st.power === 'screen_off') {
            act(() => request('ssap://com.webos.service.tvpower/power/turnOnScreen'));
        } else if (tvReady()) {
            act(() => request('ssap://system/turnOff')).then((ok) => ok && toast('Turning off'));
        } else {
            toast('Browsers can’t turn a TV on. Use its own remote, then this one takes over.', true);
        }
    });
    $('#muteBtn').addEventListener('click', () => {
        haptic();
        act(() => request('ssap://audio/setMute', {mute: !st.muted}));
    });
    $('#status').addEventListener('click', () => {
        if (!st.host || st.link === 'off') openSheet('setup');
    });

    // ───────────── arrows / touchpad ─────────────
    function setMode(mode) {
        $$('.mode-btn').forEach((b) => {
            const on = b.dataset.mode === mode;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-selected', String(on));
        });
        $('#dpad').hidden = mode !== 'dpad';
        $('#pad').hidden = mode !== 'pad';
        store.set('mode', mode);
    }
    $$('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    setMode(store.get('mode') === 'pad' ? 'pad' : 'dpad');

    const pad = $('#padSurface');
    const touches = new Map();
    const acc = {dx: 0, dy: 0, sy: 0};
    let travel = 0, downAt = 0, maxTouches = 0, frame = 0;
    const SENS = 1.6;
    const clamp = (n) => Math.max(-100, Math.min(100, Math.round(n)));

    function flush() {
        frame = 0;
        if (!paired) { acc.dx = acc.dy = acc.sy = 0; return; }
        if (Math.abs(acc.dx) >= 1 || Math.abs(acc.dy) >= 1) {
            input('move', {dx: clamp(acc.dx * SENS), dy: clamp(acc.dy * SENS), down: 0}).catch(() => {});
            acc.dx = acc.dy = 0;
        }
        if (Math.abs(acc.sy) >= 6) {
            input('scroll', {dx: 0, dy: clamp(-acc.sy)}).catch(() => {});
            acc.sy = 0;
        }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    pad.addEventListener('pointerdown', (e) => {
        pad.setPointerCapture(e.pointerId);
        touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
        if (touches.size === 1) { travel = 0; downAt = performance.now(); maxTouches = 1; }
        maxTouches = Math.max(maxTouches, touches.size);
    });
    pad.addEventListener('pointermove', (e) => {
        const prev = touches.get(e.pointerId);
        if (!prev) return;
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        prev.x = e.clientX; prev.y = e.clientY;
        travel += Math.abs(dx) + Math.abs(dy);
        if (touches.size >= 2) acc.sy += dy / touches.size;
        else { acc.dx += dx; acc.dy += dy; }
        schedule();
    });
    const lift = (e) => {
        if (!touches.delete(e.pointerId)) return;
        if (touches.size === 0 && maxTouches === 1 && travel < 10 && performance.now() - downAt < 280) {
            haptic();
            act(() => input('click'));
        }
    };
    pad.addEventListener('pointerup', lift);
    pad.addEventListener('pointercancel', lift);

    // ───────────── sheets ─────────────
    const scrim = $('#scrim');
    function openSheet(name) {
        closeSheets();
        $('#sheet-' + name).classList.add('is-open');
        scrim.classList.add('is-shown');
        if (name === 'keyboard') setTimeout(() => $('#textIn').focus(), 280);
        if (name === 'setup' && !$('#hostIn').value) $('#hostIn').value = st.host;
    }
    function closeSheets() {
        $$('.sheet.is-open').forEach((s) => s.classList.remove('is-open'));
        scrim.classList.remove('is-shown');
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    $$('[data-sheet]').forEach((b) => b.addEventListener('click', () => { haptic(); openSheet(b.dataset.sheet); }));
    $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
    scrim.addEventListener('click', closeSheets);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

    // keyboard: mirror what you type into the TV's focused text box
    const textIn = $('#textIn');
    let sent = '';
    textIn.addEventListener('input', () => {
        const now = textIn.value;
        let common = 0;
        while (common < now.length && common < sent.length && now[common] === sent[common]) common++;
        const remove = sent.length - common;
        const add = now.slice(common);
        if (remove > 0) act(() => request('ssap://com.webos.service.ime/deleteCharacters', {count: remove}));
        if (add) act(() => request('ssap://com.webos.service.ime/insertText', {text: add, replace: 0}));
        sent = now;
    });
    const go = () => { haptic(); act(() => request('ssap://com.webos.service.ime/sendEnterKey')); };
    textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    $('#textGo').addEventListener('click', go);
    $('#textClear').addEventListener('click', () => {
        if (sent.length) act(() => request('ssap://com.webos.service.ime/deleteCharacters', {count: sent.length}));
        textIn.value = sent = '';
        textIn.focus();
    });

    // setup
    // decimal keypads in some regions (Turkish, German…) only offer a comma
    $('#hostIn').addEventListener('input', (e) => {
        const el = e.target;
        if (el.value.includes(',')) el.value = el.value.replace(/,/g, '.');
    });
    function readHost() {
        const v = $('#hostIn').value.trim().replace(/,/g, '.').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
        if (!/^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(v)) {
            toast('Enter the TV’s IP address, like 192.168.1.20', true);
            return '';
        }
        return v;
    }
    function useHost(h) {
        if (h === st.host) return;
        if (ws) { const old = ws; ws = null; old.close(); }
        paired = false;
        st.host = h;
        st.tvName = store.get('tv.name.' + h) || 'Your TV';
        Object.assign(st, {apps: [], inputs: [], app: null, model: '', volume: null});
        store.set('tv.host', h);
    }
    $('#certBtn').addEventListener('click', () => {
        const h = readHost();
        if (!h) return;
        useHost(h);
        window.open(`https://${h}:3001/`, '_blank');
    });
    $('#connectBtn').addEventListener('click', () => {
        const h = readHost();
        if (!h) return;
        useHost(h);
        failures = 0;
        closeSheets();
        if (!ws) connect();
    });
    $('#screenOffBtn').addEventListener('click', () => {
        act(() => request('ssap://com.webos.service.tvpower/power/turnOffScreen')).then((ok) => ok && toast('Screen off. Press power to turn it back on.'));
    });
    $('#unpairBtn').addEventListener('click', () => {
        if (!st.host || !confirm('Reset pairing? The TV will ask you to accept this phone again.')) return;
        store.del('tv.key.' + st.host);
        if (ws) ws.close();
        else connect();
    });
    $('#shareBtn').addEventListener('click', async () => {
        const url = location.href.split('#')[0];
        if (navigator.share) {
            try { await navigator.share({title: 'TV Remote', text: 'Open this on the home Wi-Fi to control the TV', url}); return; }
            catch { /* cancelled */ }
        }
        $('#shareNote').textContent = `Send this link to anyone on the home Wi-Fi: ${url}`;
    });

    // phones freeze background tabs; reconnect as soon as the remote is back on screen
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !paired) { failures = 0; connect(); }
    });
    window.addEventListener('pageshow', () => { if (!paired) connect(); });

    render();
    if (st.host) connect();
    else openSheet('setup');
})();
