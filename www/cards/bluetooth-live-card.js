/*
 * bluetooth-live-card: live Bluetooth views for the Admins > Bluetooth page.
 *
 *   type: custom:bluetooth-live-card
 *   view: stats | radar | proxies | sensors | makers | batteries | feed
 *
 * All cards on a page share one set of websocket subscriptions (scanner
 * details, connection slots and the live advertisement stream), held in
 * window.__btLive and dropped a minute after the last card goes away.
 * Nothing is hard-coded: proxies come from HA's scanner list, our own
 * devices from the device registry's Bluetooth connections, sensors from
 * entities of the bthome platform.
 */
(() => {
  const VERSION = '1.0.0';
  const FRESH = 300;          // s: a device counts as "nearby" if heard in the last 5 min
  const SENSOR_STALE = 1800;  // s: a sensor is "quiet" after 30 min
  const BUCKET = 30;          // s per adverts-rate bucket
  const BUCKETS = 20;         // 10 minutes of rate history

  // Bluetooth SIG company ids / 16-bit service UUIDs -> maker
  const COMPANY = {
    76: 'Apple', 6: 'Microsoft', 117: 'Samsung', 224: 'Google', 2985: 'Shelly', 1447: 'Sonos',
    196: 'LG', 89: 'Nordic', 741: 'Espressif', 301: 'Sony', 135: 'Garmin', 343: 'Xiaomi',
    3: 'IBM', 15: 'Broadcom', 10: 'Qualcomm', 2409: 'Govee', 1177: 'Ruuvi', 919: 'Tile',
    1363: 'Amazon', 171: 'Amazon', 911: 'Fitbit', 7: 'Lucent', 1839: 'Nothing', 2324: 'Huawei',
    637: 'Huawei', 1021: 'OnePlus', 1301: 'Bose', 158: 'Bose', 87: 'Harman', 2242: 'Tesla',
  };
  const SERVICE = {
    fcd2: 'BTHome', fef3: 'Google', fcf1: 'Google', fe9f: 'Google', fe2c: 'Google', fdf7: 'HP',
    fd6f: 'Exposure', feaa: 'Eddystone', fe95: 'Xiaomi', fdcd: 'Qingping', fe07: 'Sonos',
    fd5a: 'Samsung', fe78: 'HP', fe03: 'Amazon', fe0f: 'Philips Hue', fd3d: 'SwitchBot',
    fe8f: 'CSR', fdab: 'Xiaomi', fd81: 'CANDY', feed: 'Tile', fe33: 'Garmin',
  };
  const MAKER_COLOUR = {
    'Ours': 'var(--green-color)', BTHome: 'var(--teal-color, #009688)', Apple: 'var(--purple-color, #9c27b0)',
    Google: 'var(--amber-color)', Microsoft: 'var(--blue-color)', Samsung: 'var(--indigo-color, #3f51b5)',
    Shelly: 'var(--cyan-color, #00bcd4)', Sonos: 'var(--brown-color, #795548)', Unknown: 'var(--disabled-text-color)',
  };
  const PALETTE = ['var(--deep-orange-color, #ff5722)', 'var(--pink-color, #e91e63)', 'var(--lime-color, #cddc39)',
    'var(--light-blue-color, #03a9f4)', 'var(--deep-purple-color, #673ab7)', 'var(--light-green-color, #8bc34a)'];

  // ---------------------------------------------------------------- store
  const S = window.__btLive || (window.__btLive = {
    hass: null, unsubs: null, starting: false, primed: false, stopTimer: null,
    scanners: new Map(), slots: new Map(), devs: new Map(), rate: new Map(),
    feed: [], cards: new Set(), dirty: false,
  });

  const now = () => Date.now() / 1000;
  const up = m => (m || '').toUpperCase();

  function markDirty() {
    if (S.dirty) return;
    S.dirty = true;
    setTimeout(() => { S.dirty = false; S.cards.forEach(c => c._render()); }, 700);
  }

  function pushFeed(item) {
    S.feed.unshift({ t: now(), ...item });
    if (S.feed.length > 40) S.feed.length = 40;
  }

  function onAdvert(a) {
    const addr = up(a.address);
    let d = S.devs.get(addr);
    const t = a.time || now();
    if (!d) {
      d = { addr, count: 0, hist: [], srcs: {}, handoffs: 0, first: t };
      S.devs.set(addr, d);
      if (S.primed) {
        const k = known(addr);
        pushFeed({ kind: 'new', addr, name: k ? k.name : (a.name && up(a.name) !== addr ? a.name : ''), rssi: a.rssi, source: up(a.source) });
      }
    }
    if (d.source && d.source !== up(a.source)) {
      d.handoffs++;
      if (S.primed && known(addr)) pushFeed({ kind: 'handoff', addr, name: known(addr).name, from: d.source, source: up(a.source), rssi: a.rssi });
    }
    d.gone = 0;
    d.name = a.name;
    d.rssi = a.rssi;
    d.source = up(a.source);
    d.time = t;
    d.tx = a.tx_power;
    d.conn = a.connectable;
    d.mfr = Object.keys(a.manufacturer_data || {}).map(Number);
    d.svc = Object.keys(a.service_data || {}).concat(a.service_uuids || []).map(u => u.length > 8 ? u.slice(4, 8) : u).map(s => s.toLowerCase());
    d.count++;
    d.hist.push([t, a.rssi]);
    if (d.hist.length > 40) d.hist.shift();
    d.srcs[d.source] = { rssi: a.rssi, time: t };
    if (S.primed) {
      const b = Math.floor(now() / BUCKET);
      const r = S.rate.get(d.source) || new Map();
      r.set(b, (r.get(b) || 0) + 1);
      for (const k of r.keys()) if (k < b - BUCKETS) r.delete(k);
      S.rate.set(d.source, r);
    }
  }

  function onAdvertEvent(ev) {
    for (const k of ['add', 'change']) (ev[k] || []).forEach(onAdvert);
    (ev.remove || []).forEach(r => {
      const d = S.devs.get(up(typeof r === 'string' ? r : r.address));
      if (d) d.gone = now();
    });
    S.primed = true;
    markDirty();
  }

  function onScanners(ev) {
    (ev.add || []).forEach(s => S.scanners.set(up(s.source), s));
    (ev.remove || []).forEach(s => S.scanners.delete(up(typeof s === 'string' ? s : s.source)));
    markDirty();
  }

  function onSlots(ev) {
    (Array.isArray(ev) ? ev : [ev]).forEach(s => s && S.slots.set(up(s.source), s));
    markDirty();
  }

  async function start(hass) {
    S.hass = hass;
    if (S.stopTimer) { clearTimeout(S.stopTimer); S.stopTimer = null; }
    if (S.unsubs || S.starting) return;
    S.starting = true;
    try {
      const c = hass.connection;
      S.unsubs = await Promise.all([
        c.subscribeMessage(onScanners, { type: 'bluetooth/subscribe_scanner_details' }),
        c.subscribeMessage(onSlots, { type: 'bluetooth/subscribe_connection_allocations' }),
        c.subscribeMessage(onAdvertEvent, { type: 'bluetooth/subscribe_advertisements' }),
      ]);
    } catch (e) {
      S.error = e?.message || String(e);
      markDirty();
    } finally {
      S.starting = false;
    }
  }

  function stopSoon() {
    if (S.stopTimer || S.cards.size) return;
    S.stopTimer = setTimeout(() => {
      S.stopTimer = null;
      if (S.cards.size || !S.unsubs) return;
      S.unsubs.forEach(u => { try { u(); } catch (e) { /* already gone */ } });
      S.unsubs = null;
      S.primed = false;
    }, 60000);
  }

  // ------------------------------------------------------------- lookups
  let _idx = null, _idxDevices = null;
  function index() {
    const h = S.hass;
    if (_idx && _idxDevices === h.devices) return _idx;
    const byMac = new Map();
    const sensors = [];
    const devEntities = new Map();
    for (const e of Object.values(h.entities || {})) {
      if (!e.device_id) continue;
      if (!devEntities.has(e.device_id)) devEntities.set(e.device_id, []);
      devEntities.get(e.device_id).push(e);
    }
    for (const d of Object.values(h.devices || {})) {
      const mac = (d.connections || []).find(c => c[0] === 'bluetooth')?.[1];
      if (!mac) continue;
      const ents = devEntities.get(d.id) || [];
      const isSensor = ents.some(e => e.platform === 'bthome');
      const item = {
        id: d.id, mac: up(mac), name: d.name_by_user || d.name || up(mac), model: d.model || '',
        area: h.areas?.[d.area_id]?.name || '', ents, sensor: isSensor,
      };
      byMac.set(item.mac, item);
      if (isSensor) sensors.push(item);
    }
    _idx = { byMac, sensors };
    _idxDevices = h.devices;
    return _idx;
  }
  const known = mac => (S.hass ? index().byMac.get(up(mac)) : null);

  function scannerName(src) {
    const s = S.scanners.get(up(src));
    const n = s?.adapter || s?.name || src || '?';
    return n.replace(/\s*\([0-9A-F:]{17}\)\s*$/i, '');
  }

  function maker(d) {
    if (known(d.addr)) return 'Ours';
    for (const m of d.mfr || []) if (COMPANY[m]) return COMPANY[m];
    for (const s of d.svc || []) if (SERVICE[s]) return SERVICE[s];
    return 'Unknown';
  }
  function makerColour(m, i = 0) { return MAKER_COLOUR[m] || PALETTE[i % PALETTE.length]; }

  const nearby = () => [...S.devs.values()].filter(d => !d.gone && now() - d.time < FRESH);

  function ago(t) {
    if (!t) return '—';
    const s = Math.max(0, Math.round(now() - t));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function rssiColour(r) {
    if (r == null) return 'var(--disabled-text-color)';
    return r >= -65 ? 'var(--green-color)' : r >= -78 ? 'var(--light-green-color, #8bc34a)' : r >= -88 ? 'var(--amber-color)' : 'var(--red-color)';
  }
  function bars(r, size = 14) {
    const n = r == null ? 0 : r >= -65 ? 4 : r >= -75 ? 3 : r >= -85 ? 2 : 1;
    const c = rssiColour(r);
    let s = `<svg class="bars" width="${size}" height="${size}" viewBox="0 0 16 16">`;
    for (let i = 0; i < 4; i++) {
      const h = 4 + i * 4;
      s += `<rect x="${i * 4}" y="${16 - h}" width="3" height="${h}" rx="1" fill="${i < n ? c : 'var(--divider-color)'}"/>`;
    }
    return s + '</svg>';
  }
  function ring(pct, colour, size = 34, stroke = 4, label = '') {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct || 0));
    return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--divider-color)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${colour}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="${size * 0.3}" font-weight="700" fill="var(--primary-text-color)">${label}</text>
    </svg>`;
  }
  function battColour(b) {
    return b == null ? 'var(--disabled-text-color)' : b <= 20 ? 'var(--red-color)' : b <= 40 ? 'var(--amber-color)' : 'var(--green-color)';
  }
  function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0); }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function sensorReadings(item) {
    const h = S.hass, out = {};
    for (const e of item.ents) {
      const st = h.states[e.entity_id];
      if (!st) continue;
      const dc = st.attributes.device_class;
      if (dc === 'temperature') out.temp = st;
      else if (dc === 'humidity') out.hum = st;
      else if (dc === 'battery') out.batt = st;
      else if (e.entity_id.startsWith('event.')) (out.buttons ||= []).push(st);
    }
    return out;
  }

  // --------------------------------------------------------------- views
  const VIEWS = {
    stats() {
      const nb = nearby();
      const proxies = [...S.scanners.keys()];
      const activeProxies = proxies.filter(p => nb.some(d => d.srcs[p] && now() - d.srcs[p].time < 120)).length;
      const all = index().sensors;
      const sensors = all.filter(s => sensorReadings(s).temp);
      const fresh = sensors.filter(s => { const d = S.devs.get(s.mac); return d && now() - d.time < SENSOR_STALE; }).length;
      const batts = all.map(s => ({ s, b: parseFloat(sensorReadings(s).batt?.state) })).filter(x => !isNaN(x.b)).sort((a, b) => a.b - b.b);
      const low = batts[0];
      const ours = nb.filter(d => known(d.addr)).length;
      const tile = (icon, colour, value, unit, label, sub, pct) => `
        <div class="stat">
          <div class="ic" style="--c:${colour}">${pct != null ? ring(pct, colour, 46, 5, '') : ''}<ha-icon icon="${icon}"></ha-icon></div>
          <div class="v">${value}<span>${unit}</span></div>
          <div class="l">${label}</div><div class="s">${sub}</div>
        </div>`;
      return `<div class="stats">
        ${tile('mdi:access-point-network', activeProxies === proxies.length ? 'var(--green-color)' : 'var(--amber-color)',
          activeProxies, `/${proxies.length || '–'}`, 'Proxies listening', 'Shelly Bluetooth gateways', proxies.length ? (activeProxies / proxies.length) * 100 : 0)}
        ${tile('mdi:radar', 'var(--blue-color)', nb.length, '', 'Devices nearby', `${ours} ours · heard in last 5 min`, null)}
        ${tile('mdi:thermometer-bluetooth', fresh === sensors.length ? 'var(--green-color)' : 'var(--amber-color)',
          fresh, `/${sensors.length}`, 'Sensors reporting', 'heard in last 30 min', sensors.length ? (fresh / sensors.length) * 100 : 0)}
        ${tile('mdi:battery-heart-variant', battColour(low?.b), low ? Math.round(low.b) : '—', low ? '%' : '', 'Lowest battery',
          low ? esc(low.s.name.replace(/^BLUHT /, '')) : '', low ? low.b : null)}
      </div>`;
    },

    radar() {
      const nb = nearby();
      const proxies = [...S.scanners.keys()].sort((a, b) => scannerName(a).localeCompare(scannerName(b)));
      const n = Math.max(proxies.length, 1);
      const C = 200, R = 150;
      const rad = rssi => { const x = Math.min(100, Math.max(35, -rssi)); return ((x - 35) / 65) * R; };
      let svg = `<svg viewBox="0 0 400 400" class="radar">
        <defs>
          <radialGradient id="rg"><stop offset="0" stop-color="var(--primary-color)" stop-opacity="0.18"/><stop offset="1" stop-color="var(--primary-color)" stop-opacity="0.02"/></radialGradient>
          <linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--primary-color)" stop-opacity="0"/><stop offset="1" stop-color="var(--primary-color)" stop-opacity="0.35"/></linearGradient>
        </defs>
        <circle cx="${C}" cy="${C}" r="${R}" fill="url(#rg)"/>`;
      for (const [db, lbl] of [[-55, '-55'], [-70, '-70'], [-85, '-85'], [-100, '-100 dBm']]) {
        svg += `<circle cx="${C}" cy="${C}" r="${rad(db)}" fill="none" stroke="var(--divider-color)" stroke-dasharray="2 4"/>
          <text x="${C + 3}" y="${C - rad(db) + 10}" class="rl">${lbl}</text>`;
      }
      proxies.forEach((p, i) => {
        const a = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x2 = C + Math.cos(a) * R, y2 = C + Math.sin(a) * R;
        const lx = C + Math.cos(a) * (R + 16), ly = C + Math.sin(a) * (R + 16);
        const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
        const heard = nb.filter(d => d.source === p).length;
        svg += `<line x1="${C}" y1="${C}" x2="${x2}" y2="${y2}" stroke="var(--divider-color)"/>
          <text x="${lx}" y="${ly}" text-anchor="${anchor}" dy="0.35em" class="pl">${esc(scannerName(p))} <tspan class="pc">${heard}</tspan></text>`;
      });
      svg += `<g class="sweep" style="animation-delay:-${((Date.now() / 1000) % 6).toFixed(2)}s"><path d="M${C},${C} L${C + R},${C} A${R},${R} 0 0,0 ${C + R * Math.cos(-0.5)},${C + R * Math.sin(-0.5)} Z" fill="url(#sw)"/></g>
        <circle cx="${C}" cy="${C}" r="4" fill="var(--primary-color)"/>`;
      const ord = nb.slice().sort((a, b) => (known(a.addr) ? 1 : 0) - (known(b.addr) ? 1 : 0));
      const makers = new Map();
      for (const d of ord) {
        const i = Math.max(0, proxies.indexOf(d.source));
        const spread = ((hash(d.addr) % 1000) / 1000 - 0.5) * 0.85;
        const a = ((i + spread) / n) * 2 * Math.PI - Math.PI / 2;
        const r = rad(d.rssi);
        const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
        const m = maker(d);
        if (!makers.has(m)) makers.set(m, makers.size);
        const col = makerColour(m, makers.get(m));
        const k = known(d.addr);
        const age = now() - d.time;
        const op = Math.max(0.25, 1 - age / FRESH);
        const recent = age < 8;
        svg += `<g opacity="${op.toFixed(2)}"><title>${esc(k ? k.name : d.name && up(d.name) !== d.addr ? d.name : d.addr)}
${m} · ${d.rssi} dBm via ${esc(scannerName(d.source))} · ${ago(d.time)}</title>
          ${recent ? `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${col}" class="ping"/>` : ''}
          <circle cx="${x}" cy="${y}" r="${k ? 5 : 3.2}" fill="${col}" ${k ? 'stroke="var(--card-background-color)" stroke-width="1.5"' : ''}/></g>`;
      }
      svg += '</svg>';
      const counts = {};
      nb.forEach(d => { const m = maker(d); counts[m] = (counts[m] || 0) + 1; });
      const legend = [...makers.keys()].sort((a, b) => counts[b] - counts[a]).map(m =>
        `<span><i style="background:${makerColour(m, makers.get(m))}"></i>${m === 'Ours' ? 'Our devices' : m} ${counts[m]}</span>`).join('');
      return `<div class="radar-wrap">${svg}</div><div class="legend">${legend || '<span>Listening…</span>'}</div>
        <div class="hint">Each spoke is a proxy; dots sit on the spoke that hears them best, closer to the middle = stronger signal. Hover a dot for details.</div>`;
    },

    proxies() {
      const nb = nearby();
      const b = Math.floor(now() / BUCKET);
      const rows = [...S.scanners.entries()].map(([src, s]) => {
        const r = S.rate.get(src) || new Map();
        const series = Array.from({ length: BUCKETS }, (_, i) => r.get(b - BUCKETS + 1 + i) || 0);
        const heard = nb.filter(d => d.source === src);
        const last = Math.max(0, ...nb.filter(d => d.srcs[src]).map(d => d.srcs[src].time));
        const best = heard.length ? Math.max(...heard.map(d => d.rssi)) : null;
        const ours = heard.filter(d => known(d.addr)).length;
        const slot = S.slots.get(src);
        return { src, s, series, heard: heard.length, ours, last, best, slot, perMin: series.slice(-2).reduce((x, y) => x + y, 0) };
      }).sort((a, b) => b.heard - a.heard);
      const maxHeard = Math.max(1, ...rows.map(r => r.heard));
      const maxRate = Math.max(1, ...rows.flatMap(r => r.series));
      const spark = series => {
        const w = 80, h = 22, bw = w / series.length;
        return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${series.map((v, i) => {
          const bh = v ? Math.max(2, (v / maxRate) * h) : 1;
          return `<rect x="${i * bw + 0.5}" y="${h - bh}" width="${bw - 1}" height="${bh}" rx="1" fill="${v ? 'var(--primary-color)' : 'var(--divider-color)'}" opacity="${0.35 + (i / series.length) * 0.65}"/>`;
        }).join('')}</svg>`;
      };
      if (!rows.length) return `<div class="empty">${S.error ? 'Bluetooth unavailable: ' + esc(S.error) : 'Waiting for proxies…'}</div>`;
      return `<div class="proxies">${rows.map(r => {
        const live = r.last && now() - r.last < 120;
        return `<div class="px">
          <div class="dot ${live ? 'on' : ''}"></div>
          <div class="nm"><b>${esc(scannerName(r.src))}</b>
            <small>${r.s.connectable ? 'connectable' : 'passive'} · ${r.s.scanner_type || ''}${r.slot && r.slot.slots ? ` · ${r.slot.free}/${r.slot.slots} slots free` : ''} · ${live ? 'heard ' + ago(r.last) : 'quiet'}</small></div>
          <div class="hb"><div class="fill" style="width:${(r.heard / maxHeard) * 100}%"></div>
            <span>${r.heard} device${r.heard === 1 ? '' : 's'}${r.ours ? ` · ${r.ours} ours` : ''}</span></div>
          <div class="sp">${spark(r.series)}</div>
          <div class="bs" title="Strongest signal">${bars(r.best)}<span>${r.best != null ? r.best : '—'}</span></div>
        </div>`;
      }).join('')}</div>
      <div class="hint">Bar: devices this proxy currently hears best. Sparkline: adverts it passed on, 30-second buckets over the last 10 minutes (fills in while the page is open).</div>`;
    },

    sensors() {
      const list = index().sensors.slice().sort((a, b) => (a.area || a.name).localeCompare(b.area || b.name));
      if (!list.length) return '<div class="empty">No BTHome sensors found</div>';
      return `<div class="sensors">${list.map(s => {
        const rd = sensorReadings(s);
        const d = S.devs.get(s.mac);
        const t = d?.time;
        const age = t ? now() - t : null;
        const isRemote = !rd.temp && rd.buttons;
        const state = isRemote ? 'unk' : age == null ? 'stale' : age < 600 ? 'ok' : age < SENSOR_STALE ? 'late' : 'stale';
        const b = parseFloat(rd.batt?.state);
        const temp = parseFloat(rd.temp?.state), hum = parseFloat(rd.hum?.state);
        const hist = (d?.hist || []).slice(-24);
        let line = '';
        if (hist.length > 1) {
          const xs = hist.map((_, i) => (i / (hist.length - 1)) * 100);
          const ys = hist.map(h => 18 - ((Math.min(-40, Math.max(-100, h[1])) + 100) / 60) * 16);
          line = `<svg class="rl" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline fill="none" stroke="${rssiColour(d.rssi)}" stroke-width="1.5" vector-effect="non-scaling-stroke"
            points="${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')}"/></svg>`;
        }
        const lastPress = isRemote ? rd.buttons.map(x => x.state).filter(x => x && x !== 'unknown' && x !== 'unavailable').sort().pop() : null;
        const name = s.name.replace(/^BLUHT /, '').replace(/^Master Bedroom Bedside /, 'Bedside ');
        return `<div class="sn ${state}">
          <div class="hd"><span class="st"></span><b title="${esc(s.name)}">${esc(name)}</b>${ring(b, battColour(b), 26, 3, isNaN(b) ? '' : Math.round(b))}</div>
          ${isRemote
            ? `<div class="big"><ha-icon icon="mdi:remote"></ha-icon><span class="sub">${lastPress ? 'pressed ' + ago(new Date(lastPress).getTime() / 1000) : 'remote'}</span></div>`
            : `<div class="big">${isNaN(temp) ? '—' : temp.toFixed(1)}<span class="u">°</span>
                <span class="hum"><ha-icon icon="mdi:water-percent"></ha-icon>${isNaN(hum) ? '—' : Math.round(hum)}%</span></div>`}
          ${line || '<div class="rl none"></div>'}
          <div class="ft">${bars(d?.rssi, 12)}<span>${d ? d.rssi + ' dBm · ' + esc(scannerName(d.source)) : isRemote ? 'asleep until pressed' : 'not heard yet'}</span></div>
          <div class="ft2">${d ? `heard ${ago(t)}` : (rd.batt ? 'updated ' + ago(new Date(rd.batt.last_updated).getTime() / 1000) : '')}${d && d.handoffs ? ` · ${d.handoffs} hand-off${d.handoffs > 1 ? 's' : ''}` : ''}</div>
        </div>`;
      }).join('')}</div>`;
    },

    makers() {
      const nb = nearby();
      const counts = new Map();
      nb.forEach(d => { const m = maker(d); counts.set(m, (counts.get(m) || 0) + 1); });
      const items = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const total = nb.length || 1;
      const R = 70, r = 46, C = 90;
      let a0 = -Math.PI / 2, paths = '';
      items.forEach(([m, n], i) => {
        const a1 = a0 + (n / total) * 2 * Math.PI - 0.0001;
        const big = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rr, a) => `${C + rr * Math.cos(a)},${C + rr * Math.sin(a)}`;
        paths += `<path d="M${p(R, a0)} A${R},${R} 0 ${big} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${big} 0 ${p(r, a0)} Z" fill="${makerColour(m, i)}"><title>${m}: ${n}</title></path>`;
        a0 = a1 + 0.0001;
      });
      return `<div class="makers"><svg viewBox="0 0 180 180" class="donut">${paths}
          <text x="90" y="86" text-anchor="middle" class="dn">${nb.length}</text><text x="90" y="104" text-anchor="middle" class="dl">nearby</text></svg>
        <div class="ml">${items.map(([m, n], i) => `<div><i style="background:${makerColour(m, i)}"></i><span>${m === 'Ours' ? 'Our devices' : m}</span><b>${n}</b>
          <em style="width:${(n / total) * 100}%;background:${makerColour(m, i)}"></em></div>`).join('') || '<div>Listening…</div>'}</div></div>
        <div class="hint">Worked out from each advert's Bluetooth company id or service. Phones and watches change their address every ~15 min, so one phone can show up more than once.</div>`;
    },

    batteries() {
      const list = index().sensors.map(s => {
        const st = sensorReadings(s).batt;
        return { s, b: parseFloat(st?.state), id: st?.entity_id };
      }).filter(x => !isNaN(x.b)).sort((a, b) => a.b - b.b);
      return `<div class="batts">${list.map(x => `
        <div class="bt" data-eid="${x.id}"><span class="bn">${esc(x.s.name.replace(/^BLUHT /, '').replace(/^Master Bedroom Bedside /, 'Bedside '))}</span>
          <div class="bb"><div style="width:${x.b}%;background:${battColour(x.b)}"></div>${[25, 50, 75].map(p => `<i style="left:${p}%"></i>`).join('')}</div>
          <b style="color:${battColour(x.b)}">${Math.round(x.b)}%</b></div>`).join('')}</div>`;
    },

    feed() {
      if (!S.feed.length) return '<div class="empty">New devices and sensor hand-offs between proxies will show here while the page is open.</div>';
      return `<div class="feed">${S.feed.slice(0, 14).map(f => `
        <div class="fi"><ha-icon icon="${f.kind === 'new' ? 'mdi:bluetooth-connect' : 'mdi:swap-horizontal'}" style="color:${f.kind === 'new' ? 'var(--blue-color)' : 'var(--amber-color)'}"></ha-icon>
          <div><b>${f.kind === 'new' ? esc(f.name || 'New device') : esc(f.name)}</b>
          <small>${f.kind === 'new' ? `appeared via ${esc(scannerName(f.source))} · ${f.rssi} dBm${f.name ? '' : ' · ' + maker(S.devs.get(f.addr) || { addr: f.addr })}`
            : `${esc(scannerName(f.from))} → ${esc(scannerName(f.source))} · ${f.rssi} dBm`}</small></div>
          <span class="fa">${ago(f.t)}</span></div>`).join('')}</div>`;
    },
  };

  const CSS = `
    ha-card { padding: 14px; overflow: hidden; }
    .hint { font-size: 0.72rem; color: var(--secondary-text-color); margin-top: 10px; line-height: 1.35; }
    .empty { color: var(--secondary-text-color); padding: 14px 4px; font-size: 0.85rem; text-align: center; }
    ha-icon { --mdc-icon-size: 18px; }
    /* stats */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .stat { background: color-mix(in srgb, var(--primary-text-color) 4%, transparent); border-radius: 14px; padding: 12px; }
    .stat .ic { position: relative; width: 46px; height: 46px; display: flex; align-items: center; justify-content: center; color: var(--c);
      border-radius: 50%; background: color-mix(in srgb, var(--c) 12%, transparent); }
    .stat .ic .ring { position: absolute; inset: 0; }
    .stat .ic ha-icon { --mdc-icon-size: 22px; }
    .stat .v { font-size: 1.9rem; font-weight: 700; margin-top: 8px; line-height: 1; }
    .stat .v span { font-size: 0.9rem; font-weight: 500; color: var(--secondary-text-color); margin-left: 2px; }
    .stat .l { font-weight: 600; font-size: 0.85rem; margin-top: 4px; }
    .stat .s { font-size: 0.72rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* radar */
    .radar-wrap { max-width: 460px; margin: 0 auto; }
    .radar { width: 100%; display: block; overflow: visible; }
    .radar .rl { font-size: 8px; fill: var(--secondary-text-color); }
    .radar .pl { font-size: 9.5px; fill: var(--primary-text-color); font-weight: 600; }
    .radar .pc { fill: var(--primary-color); font-weight: 700; }
    .radar .sweep { transform-origin: 200px 200px; animation: spin 6s linear infinite; }
    .radar .ping { transform-box: fill-box; transform-origin: center; animation: ping 1.6s ease-out infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes ping { from { transform: scale(1); opacity: 0.9; } to { transform: scale(3.2); opacity: 0; } }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 12px; justify-content: center; font-size: 0.75rem; color: var(--secondary-text-color); margin-top: 6px; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i, .ml i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
    /* proxies */
    .proxies { display: flex; flex-direction: column; gap: 4px; }
    .px { display: grid; grid-template-columns: 10px minmax(0, 1.2fr) minmax(0, 1fr) 80px 52px; gap: 10px; align-items: center;
      padding: 7px 4px; border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 60%, transparent); }
    .px:last-child { border-bottom: none; }
    .px .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--disabled-text-color); }
    .px .dot.on { background: var(--green-color); box-shadow: 0 0 0 0 var(--green-color); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green-color) 60%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    .px .nm { min-width: 0; } .px .nm b { display: block; font-size: 0.86rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .px small { font-size: 0.7rem; color: var(--secondary-text-color); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .px .hb { position: relative; height: 20px; border-radius: 6px; background: color-mix(in srgb, var(--primary-text-color) 5%, transparent); overflow: hidden; }
    .px .hb .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--primary-color) 35%, transparent); border-radius: 6px; transition: width .6s; }
    .px .hb span { position: relative; font-size: 0.72rem; line-height: 20px; padding-left: 7px; white-space: nowrap; }
    .px .bs { display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--secondary-text-color); justify-content: flex-end; }
    @media (max-width: 520px) { .px { grid-template-columns: 10px minmax(0, 1fr) 80px; } .px .hb, .px .bs { display: none; } }
    /* sensors */
    .sensors { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .sn { border-radius: 14px; padding: 10px 11px 9px; background: color-mix(in srgb, var(--primary-text-color) 4%, transparent);
      border: 1px solid transparent; display: flex; flex-direction: column; gap: 4px; }
    .sn.stale { border-color: color-mix(in srgb, var(--red-color) 50%, transparent); }
    .sn.late { border-color: color-mix(in srgb, var(--amber-color) 50%, transparent); }
    .sn .hd { display: flex; align-items: center; gap: 6px; }
    .sn .hd b { flex: 1; font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sn .st { width: 7px; height: 7px; border-radius: 50%; background: var(--disabled-text-color); flex: none; }
    .sn.ok .st { background: var(--green-color); } .sn.late .st { background: var(--amber-color); } .sn.stale .st { background: var(--red-color); }
    .sn .big { font-size: 1.6rem; font-weight: 700; display: flex; align-items: baseline; gap: 2px; line-height: 1.1; }
    .sn .big .u { font-size: 1rem; color: var(--secondary-text-color); }
    .sn .big ha-icon { --mdc-icon-size: 26px; color: var(--secondary-text-color); align-self: center; }
    .sn .big .sub { font-size: 0.72rem; font-weight: 500; color: var(--secondary-text-color); align-self: center; margin-left: 4px; }
    .sn .hum { margin-left: auto; font-size: 0.85rem; font-weight: 600; color: var(--blue-color); display: inline-flex; align-items: center; }
    .sn .hum ha-icon { --mdc-icon-size: 15px; }
    .sn .rl { width: 100%; height: 20px; display: block; }
    .sn .rl.none { border-bottom: 1px dashed var(--divider-color); height: 10px; margin-bottom: 10px; }
    .sn .ft { display: flex; align-items: center; gap: 5px; font-size: 0.7rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; }
    .sn .ft span { overflow: hidden; text-overflow: ellipsis; }
    .sn .ft2 { font-size: 0.68rem; color: var(--secondary-text-color); }
    /* makers */
    .makers { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; justify-content: center; }
    .donut { width: 160px; flex: none; }
    .donut .dn { font-size: 28px; font-weight: 700; fill: var(--primary-text-color); }
    .donut .dl { font-size: 11px; fill: var(--secondary-text-color); }
    .ml { flex: 1; min-width: 160px; display: flex; flex-direction: column; gap: 5px; }
    .ml div { display: grid; grid-template-columns: 10px 1fr auto; gap: 7px; align-items: center; font-size: 0.8rem; position: relative; }
    .ml em { grid-column: 2 / 4; height: 3px; border-radius: 2px; opacity: 0.6; }
    /* batteries */
    .batts { display: flex; flex-direction: column; gap: 7px; }
    .bt { display: grid; grid-template-columns: minmax(0, 120px) 1fr 40px; gap: 10px; align-items: center; font-size: 0.8rem; cursor: pointer; }
    .bt .bn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bt .bb { position: relative; height: 10px; border-radius: 5px; background: color-mix(in srgb, var(--primary-text-color) 7%, transparent); overflow: hidden; }
    .bt .bb div { height: 100%; border-radius: 5px; transition: width .6s; }
    .bt .bb i { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--card-background-color); opacity: 0.6; }
    .bt b { text-align: right; }
    /* feed */
    .feed { display: flex; flex-direction: column; }
    .fi { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 6px 2px;
      border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 60%, transparent); }
    .fi:last-child { border-bottom: none; }
    .fi b { font-size: 0.82rem; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fi small { font-size: 0.7rem; color: var(--secondary-text-color); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fa { font-size: 0.7rem; color: var(--secondary-text-color); }
  `;

  class BluetoothLiveCard extends HTMLElement {
    setConfig(config) {
      if (!VIEWS[config.view]) throw new Error(`view must be one of: ${Object.keys(VIEWS).join(', ')}`);
      this._config = config;
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card><div id="b"></div></ha-card>`;
        this.shadowRoot.addEventListener('click', e => {
          const el = e.target.closest('[data-eid]');
          if (el) this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: el.dataset.eid }, bubbles: true, composed: true }));
        });
      }
    }
    set hass(h) {
      const first = !S.hass;
      S.hass = h;
      start(h);
      if (first || !this._drawn) this._render();
      else if (['sensors', 'batteries', 'stats'].includes(this._config.view)) {
        // entity-driven views: redraw at most every few seconds on state churn
        if (!this._pending) { this._pending = setTimeout(() => { this._pending = null; this._render(); }, 2500); }
      }
    }
    connectedCallback() {
      S.cards.add(this);
      if (S.hass) start(S.hass);
      this._tick = setInterval(() => this._render(), 5000);
    }
    disconnectedCallback() {
      S.cards.delete(this);
      clearInterval(this._tick);
      stopSoon();
    }
    _render() {
      if (!S.hass || !this.shadowRoot || !this.isConnected) return;
      try {
        this.shadowRoot.getElementById('b').innerHTML = VIEWS[this._config.view]();
        this._drawn = true;
      } catch (e) {
        this.shadowRoot.getElementById('b').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
      }
    }
    getCardSize() { return { radar: 8, sensors: 8, proxies: 6, makers: 4, batteries: 5, feed: 5, stats: 2 }[this._config?.view] || 4; }
    getGridOptions() { return { columns: 'full', rows: 'auto' }; }
  }

  if (!customElements.get('bluetooth-live-card')) customElements.define('bluetooth-live-card', BluetoothLiveCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'bluetooth-live-card', name: 'Bluetooth live', description: `Live Bluetooth proxies, radar and sensors (v${VERSION})` });
})();
