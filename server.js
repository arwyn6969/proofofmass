/*
 * ProofOfMass — ledger + explorer server (Express app artifact)
 * -------------------------------------------------------------
 * Agent-first. Humans do not manage mass. Review-first for any value-moving
 * action. Public, verifiable, hash-chained ledger. Experimental only.
 *
 * Architecture: Browser -> this server -> Dashboard API -> SQLite.
 * Tables (pom_agents / pom_events / pom_claims) are created out-of-band and
 * declared in package.json emblem_build.tables. This server only does
 * INSERT/UPDATE/DELETE/SELECT through the Dashboard API.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { massSVG, massClass, classLabel, radiusFor } = require('./public/shared-visual.js');

// Optional rasterizer for X share cards (SVG -> PNG). Degrades to SVG if absent.
let Resvg = null;
try { Resvg = require('@resvg/resvg-js').Resvg; }
catch (e) { try { Resvg = require('/usr/local/lib/node_modules/@resvg/resvg-js').Resvg; } catch (e2) { console.error('resvg unavailable:', e2.message); } }

const app = express();
app.set('trust proxy', true); // behind the dashboard proxy — use X-Forwarded-For for req.ip
app.use(express.json({ limit: '32kb' }));

const PORT = process.env.PORT || 3000;
const API = `http://localhost:${process.env.DASHBOARD_PORT || 4000}`;
const TOKEN = process.env.DASHBOARD_TOKEN;
const GROUP = process.env.ARTIFACT_GROUP || 'proofofmass';
const PUBLIC_BASE = process.env.POM_PUBLIC_BASE || 'https://mass.arwyn.party';
// ProofOfMass PoA address that receives Door-2 fuel deposits. Public address only
// (never a key). From env, or a gitignored .vault.json ({ "vault_poa": "poa1…" }).
let VAULT_POA = process.env.POM_VAULT_POA || null;
try { if (!VAULT_POA && fs.existsSync(path.join(__dirname, '.vault.json'))) VAULT_POA = (JSON.parse(fs.readFileSync(path.join(__dirname, '.vault.json'), 'utf8')).vault_poa) || null; } catch (e) { console.error('vault config:', e.message); }

// Soulbound Base badge config (contract address, chain, RPC). From .nft.json.
let NFT = null;
try { if (fs.existsSync(path.join(__dirname, '.nft.json'))) NFT = JSON.parse(fs.readFileSync(path.join(__dirname, '.nft.json'), 'utf8')); } catch (e) { console.error('nft config:', e.message); }
const NFT_RPC = { 84532: 'https://sepolia.base.org', 8453: 'https://mainnet.base.org' };

// Auto-approve a claim when BOTH automated checks pass (X post verified + PoA established).
// Toggle via env POM_AUTO_APPROVE=1 or a gitignored .flags.json { "auto_approve": true }.
let AUTO_APPROVE = process.env.POM_AUTO_APPROVE === '1';
try { if (!AUTO_APPROVE && fs.existsSync(path.join(__dirname, '.flags.json'))) AUTO_APPROVE = !!JSON.parse(fs.readFileSync(path.join(__dirname, '.flags.json'), 'utf8')).auto_approve; } catch (e) { console.error('flags:', e.message); }

// Minimal eth_call to read ownerOf(tokenId) from the badge contract (server-side).
async function badgeOwnerOf(tokenId) {
  if (!NFT) return null;
  const rpc = NFT_RPC[NFT.chain_id] || NFT.rpc_url;
  const data = '0x6352211e' + BigInt(tokenId).toString(16).padStart(64, '0'); // ownerOf(uint256)
  try {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: NFT.contract, data }, 'latest'] }) });
    const j = await r.json();
    if (!j.result || j.result === '0x' || j.result.length < 66) return null;
    return '0x' + j.result.slice(-40);
  } catch (e) { return null; }
}

// ── admin token (operator review gate) — self-managed, persisted to file ──
const ADMIN_PATH = path.join(__dirname, '.admin-token');
let ADMIN_TOKEN = process.env.POM_ADMIN_TOKEN || null;
if (!ADMIN_TOKEN) {
  try {
    if (fs.existsSync(ADMIN_PATH)) ADMIN_TOKEN = fs.readFileSync(ADMIN_PATH, 'utf8').trim();
    else { ADMIN_TOKEN = 'pom-admin-' + crypto.randomBytes(24).toString('hex'); fs.writeFileSync(ADMIN_PATH, ADMIN_TOKEN); }
  } catch (e) { ADMIN_TOKEN = 'pom-admin-' + crypto.randomBytes(24).toString('hex'); }
}

// ── checkpoint signing key (ed25519) — persisted so the root stays verifiable ──
const KEY_PATH = path.join(__dirname, '.checkpoint-key.json');
let signKey, verifyPubPem, pubRawB64;
try {
  if (fs.existsSync(KEY_PATH)) {
    const saved = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    signKey = crypto.createPrivateKey(saved.priv);
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    signKey = privateKey;
    fs.writeFileSync(KEY_PATH, JSON.stringify({ priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: publicKey.export({ type: 'spki', format: 'pem' }) }));
  }
  const pub = crypto.createPublicKey(signKey);
  verifyPubPem = pub.export({ type: 'spki', format: 'pem' });
  pubRawB64 = pub.export({ type: 'spki', format: 'der' }).toString('base64');
} catch (e) { console.error('keygen', e.message); }

// ── Dashboard API helpers (server-side only; token never leaves this process) ──
async function dbQuery(sql, params) {
  const url = `${API}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}` +
    (params ? `&params=${encodeURIComponent(JSON.stringify(params))}` : '');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error('dbQuery ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.rows || [];
}
async function dbExec(sql, params) {
  const r = await fetch(`${API}/api/db/${GROUP}/database/execute`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: params || [] })
  });
  if (!r.ok) throw new Error('dbExec ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowISO = () => new Date().toISOString();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Canonical identity = hash of (poa_address ∩ x_handle). One position per identity.
function identityId(poa, handle) {
  const p = String(poa || '').trim().toLowerCase();
  const h = String(handle || '').trim().toLowerCase().replace(/^@/, '');
  return sha256(p + '|' + h);
}
function cleanHandle(h) { return String(h || '').trim().replace(/^@/, '').slice(0, 40); }

// Vitality decays toward 0 with a 72h half-life since last activity.
// Accepts both ISO ("...T...Z") and SQLite datetime ("YYYY-MM-DD HH:MM:SS") forms.
function effVitality(vitality, lastActive) {
  let s = String(lastActive || '').trim();
  if (s && s.indexOf('T') === -1) s = s.replace(' ', 'T'); // SQLite datetime → ISO-ish
  if (s && !/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';       // assume UTC if no zone
  const hrs = (Date.now() - new Date(s).getTime()) / 3.6e6;
  if (!isFinite(hrs) || hrs < 0) return clamp(vitality, 0, 1);
  return clamp(vitality * Math.pow(0.5, hrs / 72), 0, 1);
}

// Append a hash-chained event. Returns the new head hash.
async function appendEvent(ev) {
  const prevRows = await dbQuery('SELECT hash FROM pom_events ORDER BY seq DESC LIMIT 1');
  const prev = prevRows.length ? prevRows[0].hash : 'GENESIS';
  const ts = nowISO();
  const payload = [prev, ev.type, ev.identity || '', ev.counterparty || '', ev.amount || 0, ev.mass_after == null ? '' : ev.mass_after, ts, ev.note || ''].join('|');
  const hash = sha256(payload);
  await dbExec(
    'INSERT INTO pom_events (type, identity, counterparty, amount, mass_after, note, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [ev.type, ev.identity || null, ev.counterparty || null, ev.amount || 0, ev.mass_after == null ? null : ev.mass_after, ev.note || null, prev, hash, ts]
  );
  return hash;
}

async function getAgent(id) {
  const rows = await dbQuery('SELECT * FROM pom_agents WHERE id = ?', [id]);
  return rows[0] || null;
}
// Effective weight = mass scaled by recent vitality. A dormant whale decays toward
// 25% of its mass, so an active smaller agent can overtake it → the alpha is LOSABLE.
const RAID_THRESH = 0.22; // effective-vitality below this = "dormant" and raidable
function effWeight(a) { return (a.mass || 0) * (0.25 + 0.75 * effVitality(a.vitality, a.last_active_at)); }
// Field snapshot: scaleMax (circle radius = biggest MASS) + alphaId (crown = biggest WEIGHT).
async function field() {
  const rows = await dbQuery("SELECT id, mass, vitality, last_active_at FROM pom_agents WHERE status='active'");
  let maxMass = 0, alphaId = null, alphaW = -1;
  for (const a of rows) { if (a.mass > maxMass) maxMass = a.mass; const w = effWeight(a); if (w > alphaW) { alphaW = w; alphaId = a.id; } }
  return { maxMass, alphaId, alphaW };
}

function shapeAgent(a, scaleMax, isAlpha) {
  const ev = effVitality(a.vitality, a.last_active_at);
  const w = (a.mass || 0) * (0.25 + 0.75 * ev);
  return {
    eff_weight: +w.toFixed(1),
    raidable: a.status === 'active' && a.mass > 0 && ev < RAID_THRESH,
    id: a.id,
    short: a.id.slice(0, 10),
    display_name: a.display_name || ('@' + a.x_handle),
    x_handle: a.x_handle,
    poa_address: a.poa_address,
    poa_short: a.poa_address.length > 14 ? a.poa_address.slice(0, 6) + '…' + a.poa_address.slice(-4) : a.poa_address,
    emblem_wallet: a.emblem_wallet || null,
    mass: a.mass,
    vitality: +ev.toFixed(3),
    class: massClass(a.mass),
    class_label: classLabel(a.mass),
    is_alpha: !!isAlpha,
    status: a.status,
    merged_into: a.merged_into || null,
    seed: !!a.seed,
    base_wallet: a.base_wallet || null,
    created_at: a.created_at,
    last_active_at: a.last_active_at,
    scaleMax
  };
}

// ── global write serializer — removes hash-chain / mass-update races ──
// Every ledger-mutating section runs through this queue, so SELECT-head →
// INSERT-event and read-mass → write-mass can never interleave across requests.
let _writeQ = Promise.resolve();
function serialize(fn) { const p = _writeQ.then(() => fn()); _writeQ = p.then(() => {}, () => {}); return p; }

// ── automated verification — informs the operator; review-first still applies ──
function tweetId(url) { const m = String(url || '').match(/status(?:es)?\/(\d{5,25})/); return m ? m[1] : null; }
function synToken(id) { try { return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''); } catch (e) { return 'a'; } }

// Verify an X post via Twitter's public syndication CDN (no API key).
async function autoVerifyX(url, handle, vstr) {
  const id = tweetId(url);
  if (!id) return { ok: false, reason: 'no tweet id in url', checked: true };
  try {
    const u = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${synToken(id)}&lang=en`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProofOfMass/1.0)' } });
    if (!r.ok) return { ok: false, reason: 'syndication ' + r.status, checked: true };
    const j = await r.json();
    const text = j.text || (j.tweet && j.tweet.text) || '';
    const author = (j.user && j.user.screen_name) || '';
    const handleOk = !!(author && handle && author.toLowerCase() === String(handle).toLowerCase());
    const strOk = !!(vstr && text.toUpperCase().indexOf(String(vstr).toUpperCase()) !== -1);
    return { ok: handleOk && strOk, handle_match: handleOk, string_match: strOk, author: author || null, checked: true };
  } catch (e) { return { ok: false, reason: String(e.message || e), checked: true }; }
}

// Verify a PoA address is established on the Proof-of-Agent ledger (public, no key).
async function autoVerifyPoA(address) {
  try {
    const r = await fetch('https://minepoa.com/api/established/' + encodeURIComponent(address), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, reason: 'established ' + r.status, checked: true };
    const j = await r.json();
    return { ok: !!j.established, established: !!j.established, since_epoch: (j.since_epoch != null ? j.since_epoch : null), in_prior_set: (j.in_prior_set != null ? j.in_prior_set : null), checked: true };
  } catch (e) { return { ok: false, reason: String(e.message || e), checked: true }; }
}

// Cached PoA establishment lookup (1h TTL) so profile views don't hammer minepoa.
const poaCache = new Map();
async function poaEstablished(address) {
  var c = poaCache.get(address);
  if (c && Date.now() - c.t < 3600000) return c.data;
  var d = await autoVerifyPoA(address);
  poaCache.set(address, { t: Date.now(), data: d });
  return d;
}

// Minepoa's public chain-link map proves an agent CONTROLS its PoA address: the
// agent signed `poa-owns:<addr>` with its EVM/Solana key and minepoa verified it
// on-ledger. A verified EVM link both (a) proves PoA control and (b) gives the
// exact Base wallet allowed to mint the badge. Cached 30m.
let chainsCache = null;
async function poaChains(address) {
  try {
    if (!chainsCache || Date.now() - chainsCache.t > 1800000) {
      const r = await fetch('https://minepoa.com/api/chains', { signal: AbortSignal.timeout(15000) });
      if (r.ok) chainsCache = { t: Date.now(), map: await r.json() }; // keep stale cache on failure
    }
    const e = chainsCache && chainsCache.map ? chainsCache.map[address] : null;
    if (!e) return { control_proven: false, verified_evm: null, verified_solana: null };
    const evm = e.ethereum && e.ethereum.verified ? String(e.ethereum.addr).toLowerCase() : null;
    const sol = e.solana && e.solana.verified ? e.solana.addr : null;
    return { control_proven: !!(evm || sol), verified_evm: evm, verified_solana: sol };
  } catch (e) { return { control_proven: false, verified_evm: null, verified_solana: null }; }
}

// ── very small in-memory rate limiter for write endpoints ──
const hits = new Map();
function limit(maxPerMin) {
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) { for (const [kk, vv] of hits) if (now - vv.t > 120000) hits.delete(kk); } // prune stale buckets
    const k = (req.ip || 'x') + ':' + req.path;
    const rec = hits.get(k) || { n: 0, t: now };
    if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
    rec.n++; hits.set(k, rec);
    if (rec.n > maxPerMin) return res.status(429).json({ error: 'rate_limited', retry_after_s: 60 });
    next();
  };
}
function str(x, max) { return (x == null ? '' : String(x)).trim().slice(0, max); }
function parseJSON(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 1200x630 X share card as pure SVG (mass + identity + branding). Rasterized to PNG.
function buildCardSVG(a, scaleMax, isAlpha) {
  const v = clamp(effVitality(a.vitality, a.last_active_at), 0, 1);
  const r = radiusFor(a.mass, scaleMax || a.mass, 230);
  const cx = 930, cy = 315;
  const hue = 192, sat = (24 + 46 * v).toFixed(0), light = (50 + 34 * v).toFixed(0);
  const core = isAlpha ? '#ffffff' : `hsl(${hue},${sat}%,${light}%)`;
  const edge = isAlpha ? 'hsl(205,30%,46%)' : `hsl(${hue},${sat}%,${(light * 0.42).toFixed(0)}%)`;
  const rim = isAlpha ? 'hsl(44,92%,72%)' : `hsl(${hue},${clamp(+sat + 12, 0, 92)}%,${clamp(+light + 16, 0, 96)}%)`;
  const cls = massClass(a.mass);
  let rings = '';
  const fr = [0.74, 0.52, 0.32];
  for (let i = 0; i < cls - 1 && i < fr.length; i++) rings += `<circle cx="${cx}" cy="${cy}" r="${(r * fr[i]).toFixed(1)}" fill="none" stroke="${isAlpha ? '#fff' : rim}" stroke-opacity="0.2" stroke-width="1.2"/>`;
  let halo = '';
  if (isAlpha) halo = `<circle cx="${cx}" cy="${cy}" r="${(r * 1.22).toFixed(1)}" fill="none" stroke="${rim}" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="2 7"/>`;
  const handle = escHtml('@' + a.x_handle);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<radialGradient id="bg" cx="78%" cy="50%" r="60%"><stop offset="0%" stop-color="#0a0f16"/><stop offset="100%" stop-color="#05060a"/></radialGradient>
<radialGradient id="mc" cx="42%" cy="38%" r="72%"><stop offset="0%" stop-color="${core}"/><stop offset="62%" stop-color="${core}" stop-opacity="0.92"/><stop offset="100%" stop-color="${edge}"/></radialGradient>
<radialGradient id="gl" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${rim}" stop-opacity="0.8"/><stop offset="60%" stop-color="${rim}" stop-opacity="0.18"/><stop offset="100%" stop-color="${rim}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<circle cx="${cx}" cy="${cy}" r="${(r * 1.9).toFixed(0)}" fill="url(#gl)"/>
<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="url(#mc)"/>
${rings}${halo}
<text x="90" y="300" fill="#6ff2ff" font-family="monospace" font-size="24" letter-spacing="8">PROOF OF MASS</text>
<text x="88" y="230" fill="#ffffff" font-family="sans-serif" font-size="68" font-weight="700">${handle}</text>
<text x="90" y="380" fill="#ffffff" font-family="monospace" font-size="80" font-weight="700">${a.mass}<tspan fill="#5a6478" font-size="30"> mass</tspan></text>
<text x="92" y="430" fill="#95a0b4" font-family="sans-serif" font-size="30">${escHtml(classLabel(a.mass))}${isAlpha ? '  ·  ALPHA' : ''}</text>
<text x="90" y="560" fill="#5a6478" font-family="monospace" font-size="20">mass.arwyn.party  ·  one agent, one mass  ·  experimental</text>
</svg>`;
}
const cardCache = new Map();

/* ──────────────────────────── READ API ──────────────────────────── */

app.get('/api/config', (req, res) => {
  res.json({
    base: PUBLIC_BASE,
    endpoints: {
      claim: PUBLIC_BASE + '/api/claim',
      proof: PUBLIC_BASE + '/api/claim/{claim_id}/proof',
      status: PUBLIC_BASE + '/api/agent/{identity}',
      leaderboard: PUBLIC_BASE + '/api/leaderboard',
      ledger: PUBLIC_BASE + '/api/ledger',
      checkpoint: PUBLIC_BASE + '/api/checkpoint'
    },
    docs: { short: PUBLIC_BASE + '/go.md', full: PUBLIC_BASE + '/SKILL.md', protocol: PUBLIC_BASE + '/PROTOCOL.md', style: PUBLIC_BASE + '/STYLE.md' },
    auto_approve: AUTO_APPROVE,
    fuel: { enabled: !!VAULT_POA, vault_poa: VAULT_POA || null },
    nft: NFT ? { enabled: true, contract: NFT.contract, chain_id: NFT.chain_id, chain: NFT.chain, explorer: NFT.explorer || null, mint_fee_eth: NFT.mint_fee_eth || null } : { enabled: false },
    experimental: true
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const rows = await dbQuery("SELECT COUNT(*) AS positions, COALESCE(SUM(mass),0) AS total_mass FROM pom_agents WHERE status='active'");
    const evc = await dbQuery('SELECT COUNT(*) AS n FROM pom_events');
    const head = await dbQuery('SELECT hash, seq, created_at FROM pom_events ORDER BY seq DESC LIMIT 1');
    const f = await field();
    const alphaRow = f.alphaId ? await getAgent(f.alphaId) : null;
    res.json({
      positions: rows[0].positions,
      total_mass: rows[0].total_mass,
      alpha_mass: f.maxMass,
      alpha: alphaRow ? shapeAgent(alphaRow, f.maxMass, true) : null,
      events: evc[0].n,
      state_root: head[0] ? head[0].hash : null,
      head_seq: head[0] ? head[0].seq : 0,
      experimental: true
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM pom_agents WHERE status='active' LIMIT 200");
    let maxMass = 0, alphaId = null, alphaW = -1;
    for (const a of rows) { if (a.mass > maxMass) maxMass = a.mass; const w = effWeight(a); if (w > alphaW) { alphaW = w; alphaId = a.id; } }
    rows.sort((x, y) => effWeight(y) - effWeight(x) || y.mass - x.mass);
    res.json({ scaleMax: maxMass, agents: rows.map((a) => shapeAgent(a, maxMass, a.id === alphaId)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live activity feed for the event tape — events joined to handles.
app.get('/api/activity', async (req, res) => {
  try {
    const rows = await dbQuery(
      "SELECT e.seq, e.type, e.amount, e.mass_after, e.created_at, a.x_handle AS handle, b.x_handle AS cp_handle " +
      "FROM pom_events e LEFT JOIN pom_agents a ON a.id = e.identity LEFT JOIN pom_agents b ON b.id = e.counterparty " +
      "WHERE e.type IN ('claim','credit','transfer','merge','raid','raided','fuel') ORDER BY e.seq DESC LIMIT 40");
    res.json({ events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-agent X share card (PNG). Cached per (identity, mass).
app.get('/api/agent/:id/card.png', async (req, res) => {
  try {
    const a = await getAgent(req.params.id);
    if (!a) return res.status(404).send('not found');
    const f = await field();
    const isAlpha = a.id === f.alphaId;
    const key = a.id;
    const cached = cardCache.get(key);
    if (cached && cached.mass === a.mass && cached.alpha === isAlpha) {
      return res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=120').send(cached.png);
    }
    const svg = buildCardSVG(a, f.maxMass || a.mass, isAlpha);
    if (!Resvg) return res.set('Content-Type', 'image/svg+xml').send(svg);
    const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
    cardCache.set(key, { mass: a.mass, alpha: isAlpha, png });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=120').send(png);
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/agent/:id', async (req, res) => {
  try {
    const a = await getAgent(req.params.id);
    if (!a) return res.status(404).json({ error: 'not_found' });
    const f = await field();
    const events = await dbQuery('SELECT seq, type, amount, mass_after, note, created_at, hash FROM pom_events WHERE identity = ? OR counterparty = ? ORDER BY seq DESC LIMIT 40', [a.id, a.id]);
    const isAlpha = a.status === 'active' && a.id === f.alphaId;
    const poa = await poaEstablished(a.poa_address).catch(function () { return null; });
    const chains = await poaChains(a.poa_address).catch(function () { return null; });
    if (poa && chains) { poa.control_proven = chains.control_proven; poa.verified_evm = chains.verified_evm; }
    res.json({ agent: shapeAgent(a, f.maxMass || a.mass, isAlpha), events, poa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/:id/svg', async (req, res) => {
  try {
    const a = await getAgent(req.params.id);
    if (!a) return res.status(404).send('not found');
    const f = await field();
    const svg = massSVG({
      mass: a.mass, vitality: effVitality(a.vitality, a.last_active_at),
      isAlpha: a.id === f.alphaId, scaleMax: f.maxMass || a.mass, size: +req.query.size || 400,
      uid: a.id.slice(0, 8), bg: '#05060a', animate: req.query.static !== '1'
    });
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
  } catch (e) { res.status(500).send(e.message); }
});

// Replayable ledger. State is derivable purely from this append-only log.
app.get('/api/ledger', async (req, res) => {
  try {
    const since = +req.query.since || 0;
    const rows = await dbQuery('SELECT * FROM pom_events WHERE seq > ? ORDER BY seq ASC LIMIT 1000', [since]);
    res.json({ since, count: rows.length, events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Signed checkpoint — the state root (ledger head hash) signed with an ed25519 key.
// This is a simple off-chain anchor; see /api/mirror for the on-chain export sketch.
app.get('/api/checkpoint', async (req, res) => {
  try {
    const head = await dbQuery('SELECT hash, seq, created_at FROM pom_events ORDER BY seq DESC LIMIT 1');
    const root = head[0] ? head[0].hash : sha256('EMPTY');
    const seq = head[0] ? head[0].seq : 0;
    const ts = nowISO();
    const msg = `pom:v1:checkpoint:${seq}:${root}:${ts}`;
    const sig = signKey ? crypto.sign(null, Buffer.from(msg), signKey).toString('base64') : null;
    res.json({ version: 'pom-v1', seq, state_root: root, signed_at: ts, message: msg, signature: sig, pubkey_pem: verifyPubPem, pubkey_ed25519_b64: pubRawB64, experimental: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────── ON-CHAIN MIRROR (SKETCH ONLY) ────────────────────
 * Not implemented. The ledger above is the source of truth. A mirror is an
 * EXPORT that reflects current mass into on-chain metadata (Solana NFT
 * metadata / Base tokenURI / Counterparty asset). This endpoint returns the
 * shape such an export would take so integrators can build against it now.
 */
app.get('/api/mirror/:id', async (req, res) => {
  try {
    const a = await getAgent(req.params.id);
    if (!a) return res.status(404).json({ error: 'not_found' });
    const f = await field();
    const svgUrl = PUBLIC_BASE + '/api/agent/' + a.id + '/svg';
    res.json({
      _status: 'SKETCH — not anchored on-chain. Ledger is source of truth.',
      standard: 'pom-mirror-v0',
      name: 'ProofOfMass — ' + (a.display_name || '@' + a.x_handle),
      description: 'Experimental agent-mass position. Mass ' + a.mass + ' · class ' + classLabel(a.mass) + '. Not a financial instrument.',
      image: svgUrl,
      animation_url: svgUrl,
      external_url: PUBLIC_BASE + '/#/' + a.id,
      attributes: [
        { trait_type: 'mass', value: a.mass },
        { trait_type: 'class', value: classLabel(a.mass) },
        { trait_type: 'vitality', value: +effVitality(a.vitality, a.last_active_at).toFixed(2) },
        { trait_type: 'alpha', value: a.id === f.alphaId }
      ],
      pom: { identity: a.id, poa_address: a.poa_address, x_handle: a.x_handle, emblem_wallet: a.emblem_wallet || null, state_root_ref: PUBLIC_BASE + '/api/checkpoint' },
      targets: { solana: 'Metaplex metadata (uri -> this JSON)', base: 'ERC-721 tokenURI (-> this JSON)', counterparty: 'XCP asset description ref' }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ERC-721 tokenURI target — dynamic metadata for a soulbound badge. If the token
// is bound to an identity, the image is that agent's live mass card.
app.get('/api/nft/:tokenId', async (req, res) => {
  try {
    const tid = String(parseInt(req.params.tokenId, 10) || 0);
    const rows = await dbQuery('SELECT * FROM pom_badges WHERE token_id = ?', [tid]);
    const r0 = rows[0];
    // only honor a binding that matches the CURRENTLY active contract + chain (ignores stale ones)
    const b = (r0 && NFT && r0.contract && r0.contract.toLowerCase() === NFT.contract.toLowerCase() && r0.chain_id === NFT.chain_id) ? r0 : null;
    let name = 'ProofOfMass Badge #' + tid, desc = 'A soulbound proof-of-standing badge. Experimental research — not financial.', image = PUBLIC_BASE + '/og.png', agentId = null, attrs = [];
    if (b && b.identity) {
      const a = await getAgent(b.identity);
      if (a) {
        agentId = a.id;
        name = 'ProofOfMass — @' + a.x_handle;
        const f = await field();
        desc = 'Soulbound badge for @' + a.x_handle + ' · mass ' + a.mass + ' · ' + classLabel(a.mass) + '. PoA-derived, non-transferable. Experimental.';
        image = PUBLIC_BASE + '/api/agent/' + a.id + '/card.png';
        attrs = [
          { trait_type: 'mass', value: a.mass },
          { trait_type: 'class', value: classLabel(a.mass) },
          { trait_type: 'alpha', value: a.id === f.alphaId },
          { trait_type: 'soulbound', value: true }
        ];
      }
    }
    res.set('Cache-Control', 'no-cache').json({
      name, description: desc, image, external_url: PUBLIC_BASE + (agentId ? '/#/' + agentId : '/'),
      attributes: attrs, pom: { token_id: +tid, identity: agentId, soulbound: true, experimental: true }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a mint → bind tokenId to an identity. Verifies on-chain that `wallet`
// actually owns `token_id` on the badge contract before binding (anti-spoof).
app.post('/api/badge/record', limit(20), async (req, res) => {
  try {
    if (!NFT) return res.status(503).json({ error: 'nft_not_enabled' });
    const tokenId = parseInt(req.body.token_id, 10);
    const identity = str(req.body.identity, 80);
    const wallet = str(req.body.wallet, 60).toLowerCase();
    const tx = str(req.body.tx, 80) || null;
    if (!(tokenId >= 0) || !identity || !/^0x[0-9a-f]{40}$/.test(wallet)) return res.status(400).json({ error: 'need token_id, identity, wallet' });
    const owner = await badgeOwnerOf(tokenId);
    if (!owner || owner.toLowerCase() !== wallet) return res.status(400).json({ error: 'wallet does not own that token on-chain' });
    const a = await getAgent(identity);
    if (!a) return res.status(404).json({ error: 'identity not found' });
    // OWNER-VERIFIED: the position must have linked a Base wallet, and the minter
    // must BE that wallet. This makes it impossible to mint a badge for a position
    // you don't control (and unmintable for seeds/others, which have no linked wallet).
    if (!a.base_wallet) return res.status(403).json({ error: 'this position has not linked a Base wallet; its badge cannot be minted' });
    if (a.base_wallet.toLowerCase() !== wallet) return res.status(403).json({ error: 'only the position\'s linked wallet may mint its badge' });
    // immutable first-write: a token can't be re-pointed once bound (anti-hijack)
    const existing = await dbQuery('SELECT identity FROM pom_badges WHERE token_id = ?', [tokenId]);
    if (existing.length && existing[0].identity && existing[0].identity !== identity) return res.status(409).json({ error: 'token already bound to another position' });
    await dbExec('INSERT INTO pom_badges (token_id, identity, wallet, contract, chain_id, tx) VALUES (?,?,?,?,?,?) ON CONFLICT(token_id) DO NOTHING',
      [tokenId, identity, wallet, NFT.contract, NFT.chain_id, tx]);
    res.json({ ok: true, token_id: tokenId, identity, metadata: PUBLIC_BASE + '/api/nft/' + tokenId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────── WRITE API ──────────────────────────── */

// STEP 1 — submit a claim. Agent-only inputs. Creates/locates the identity's
// single position (pending) and returns the X verification string to post.
app.post('/api/claim', limit(12), async (req, res) => {
  try {
    const poa = str(req.body.poa_address, 120);
    const handle = cleanHandle(req.body.x_handle);
    const wallet = str(req.body.emblem_wallet, 120) || null;
    const answer = str(req.body.poa_answer, 2000);
    const name = str(req.body.display_name, 60) || null;
    let baseWallet = str(req.body.base_wallet, 60).toLowerCase() || null; // Base wallet that may mint this badge
    if (baseWallet && !/^0x[0-9a-f]{40}$/.test(baseWallet)) return res.status(400).json({ error: 'base_wallet must be a 0x EVM address' });
    if (!poa || !handle) return res.status(400).json({ error: 'poa_address and x_handle required' });
    if (answer.length < 40) return res.status(400).json({ error: 'poa_answer must be a substantive answer in the agent\'s own words (min 40 chars)' });

    const id = identityId(poa, handle);
    const vstr = 'POM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const claimId = 'c_' + crypto.randomBytes(8).toString('hex');

    await serialize(async () => {
      const agent = await getAgent(id);
      if (!agent) {
        await dbExec('INSERT INTO pom_agents (id, poa_address, x_handle, emblem_wallet, base_wallet, display_name, mass, vitality, status, verification_string) VALUES (?,?,?,?,?,?,0,0,?,?)',
          [id, poa, handle, wallet, baseWallet, name, 'pending', vstr]);
        await appendEvent({ type: 'genesis', identity: id, amount: 0, mass_after: 0, note: 'position opened (pending review)' });
      } else {
        // existing identity: this is a consolidation/credit request into the SAME single position
        await dbExec('UPDATE pom_agents SET verification_string = ?, emblem_wallet = COALESCE(?, emblem_wallet), base_wallet = COALESCE(?, base_wallet), display_name = COALESCE(?, display_name) WHERE id = ?', [vstr, wallet, baseWallet, name, id]);
      }
      await dbExec('INSERT INTO pom_claims (id, identity, poa_address, x_handle, emblem_wallet, poa_answer, requested_amount, kind, status, vstr) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [claimId, id, poa, handle, wallet, answer, 0, 'claim', 'pending_proof', vstr]);
    });

    res.json({
      ok: true, claim_id: claimId, identity: id,
      status: 'pending_proof',
      verification_string: vstr,
      next: {
        step: 'Post this exact string from the X account you control, then submit the post URL.',
        post_text: 'Verifying my agent identity for ProofOfMass ' + vstr + ' (experimental, not financial).',
        submit_to: PUBLIC_BASE + '/api/claim/' + claimId + '/proof',
        submit_body: { x_proof_url: 'https://x.com/<handle>/status/<id>' }
      },
      note: 'Mass is credited only after review of your PoA answer and X proof. Review-first. Experimental points only.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STEP 2 — submit the X proof URL. Binds the proof to whoever must prove control
// (the claimant for a claim, the SENDER for a transfer), runs automated X + PoA
// checks, and queues for review. Review-first still applies unless POM_AUTO_APPROVE=1.
app.post('/api/claim/:id/proof', limit(20), async (req, res) => {
  try {
    const url = str(req.body.x_proof_url, 300);
    if (!/^https?:\/\/(x\.com|twitter\.com)\//i.test(url)) return res.status(400).json({ error: 'x_proof_url must be an x.com/twitter.com status URL' });
    const rows = await dbQuery('SELECT * FROM pom_claims WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'claim_not_found' });
    const c = rows[0];
    if (c.status !== 'pending_proof' && c.status !== 'pending_review') return res.status(409).json({ error: 'claim already ' + c.status });

    // The subject is whoever must prove X control: transfer → sender (counterparty), else the claimant.
    const subjectId = c.kind === 'transfer' ? c.counterparty : c.identity;
    const subject = await getAgent(subjectId);
    const subjectHandle = subject ? subject.x_handle : c.x_handle;
    // use THIS claim's own string (so a later re-claim can't break an in-flight proof)
    const subjectVstr = c.vstr || (subject ? subject.verification_string : null);

    await serialize(async () => {
      await dbExec('UPDATE pom_claims SET x_proof_url = ?, status = ? WHERE id = ?', [url, 'pending_review', c.id]);
      if (subjectId) await dbExec('UPDATE pom_agents SET x_proof_url = ? WHERE id = ?', [url, subjectId]);
    });

    // Automated checks (network; run outside the write lock). They INFORM review.
    const [xRes, poaRes] = await Promise.all([ autoVerifyX(url, subjectHandle, subjectVstr), autoVerifyPoA(c.poa_address) ]);
    // PoA CONTROL proof via minepoa's verified chain links (signed poa-owns:<addr>).
    const chains = await poaChains(c.poa_address);
    poaRes.control_proven = chains.control_proven;
    poaRes.verified_evm = chains.verified_evm;
    // If the PoA has a minepoa-verified EVM link, adopt it as the authoritative mint
    // wallet (strongest binding — you can only mint from the wallet you proved to minepoa).
    if (chains.verified_evm && c.kind === 'claim') {
      await dbExec('UPDATE pom_agents SET base_wallet = ? WHERE id = ?', [chains.verified_evm, c.identity]);
    }
    await dbExec('UPDATE pom_claims SET auto_x=?, auto_poa=?, auto_checked_at=? WHERE id=?', [JSON.stringify(xRes), JSON.stringify(poaRes), nowISO(), c.id]);

    // Optional: auto-approve only when BOTH automated checks pass AND the operator
    // has opted in via env. Default OFF — review-first is the safe default.
    // Auto-credit ONLY when PoA control is cryptographically proven (verified wallet
    // link on minepoa). Everything else falls to manual review — you can't auto-claim
    // against a PoA address you don't demonstrably control.
    if (AUTO_APPROVE && xRes.ok && poaRes.ok && poaRes.control_proven) {
      const amount = clamp(c.kind === 'transfer' ? c.requested_amount : 10, 0, 1e9);
      try {
        const out = await serialize(() => applyApproval(c, amount, 'auto-approved: X post + PoA established verified'));
        return res.json({ ok: true, claim_id: c.id, auto_approved: true, x: xRes, poa: poaRes, result: out });
      } catch (e) { /* fall through to manual queue */ }
    }

    res.json({
      ok: true, claim_id: c.id, identity: c.identity, status: 'pending_review',
      auto_checks: { x: xRes, poa: poaRes },
      note: 'Queued for review. Automated checks attached for the operator. Check status at ' + PUBLIC_BASE + '/api/agent/' + c.identity
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OPTIONAL — peer-to-peer transfer request (merge rule). The SENDER must prove
// control (post the verification string from the sender's X), then review-gated.
app.post('/api/transfer', limit(12), async (req, res) => {
  try {
    const fromId = str(req.body.from_identity, 80) || identityId(str(req.body.from_poa, 120), req.body.from_handle);
    const toId = str(req.body.to_identity, 80) || identityId(str(req.body.to_poa, 120), req.body.to_handle);
    const amount = clamp(+req.body.amount || 0, 0, 1e9);
    if (!fromId || !toId || fromId === toId || amount <= 0) return res.status(400).json({ error: 'need distinct from/to identities and amount > 0' });
    const from = await getAgent(fromId), to = await getAgent(toId);
    if (!from || from.status !== 'active') return res.status(400).json({ error: 'sender must be an active position' });
    if (!to || to.status === 'merged') return res.status(400).json({ error: 'recipient position not found' });
    if (from.mass < amount) return res.status(400).json({ error: 'insufficient mass' });

    const vstr = 'POM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const claimId = 'c_' + crypto.randomBytes(8).toString('hex');
    await serialize(async () => {
      // the sender authorizes with a fresh verification string (proves X control at transfer time)
      await dbExec('UPDATE pom_agents SET verification_string = ? WHERE id = ?', [vstr, fromId]);
      // claim.identity = receiver, counterparty = sender; proof subject = SENDER (handle/poa below)
      await dbExec('INSERT INTO pom_claims (id, identity, poa_address, x_handle, poa_answer, requested_amount, kind, counterparty, status, vstr) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [claimId, toId, from.poa_address, from.x_handle, 'transfer authorization by sender', amount, 'transfer', fromId, 'pending_proof', vstr]);
    });
    res.json({
      ok: true, claim_id: claimId, kind: 'transfer', from: fromId, to: toId, amount, status: 'pending_proof',
      verification_string: vstr,
      next: {
        step: 'The SENDER must post this exact string from the sender\'s X account to authorize the transfer, then submit the post URL.',
        post_text: 'Authorizing a ProofOfMass transfer ' + vstr + ' (experimental, not financial).',
        submit_to: PUBLIC_BASE + '/api/claim/' + claimId + '/proof',
        submit_body: { x_proof_url: 'https://x.com/<sender-handle>/status/<id>' }
      },
      note: 'Transfers obey the merge rule and require sender X-authorization + review. If the sender reaches 0 mass, its position is burned and merged.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DOOR 2 — fuel mass with POA. The agent sends POA to the ProofOfMass vault on
// minepoa, then submits the txid here. Review-gated (minepoa doesn't publish the
// transfer schema, so an operator confirms the tx on minepoa's explorer). Capped
// so fueled mass can never exceed earned mass (earned-agency always dominates).
app.post('/api/fuel', limit(12), async (req, res) => {
  try {
    if (!VAULT_POA) return res.status(503).json({ error: 'fueling_not_enabled', note: 'ProofOfMass PoA vault is not provisioned yet.' });
    const id = str(req.body.identity, 80) || identityId(str(req.body.poa_address, 120), req.body.x_handle);
    const txid = str(req.body.txid, 120);
    const amount = clamp(+req.body.amount || 0, 0, 1e9);
    if (!id || !txid || amount <= 0) return res.status(400).json({ error: 'need identity, txid and amount > 0' });
    const a = await getAgent(id);
    if (!a || a.status !== 'active') return res.status(400).json({ error: 'fuel target must be an active position' });
    const dup = await dbQuery('SELECT id FROM pom_claims WHERE ref = ? LIMIT 1', [txid]);
    if (dup.length) return res.status(409).json({ error: 'txid already submitted' });
    const claimId = 'c_' + crypto.randomBytes(8).toString('hex');
    await serialize(function () {
      return dbExec('INSERT INTO pom_claims (id, identity, poa_address, x_handle, poa_answer, requested_amount, kind, ref, status) VALUES (?,?,?,?,?,?,?,?,?)',
        [claimId, id, a.poa_address, a.x_handle, 'POA fuel deposit', amount, 'fuel', txid, 'pending_review']);
    });
    res.json({
      ok: true, claim_id: claimId, kind: 'fuel', identity: id, txid, amount, status: 'pending_review',
      verify_on: 'https://minepoa.com/api/explorer/tx/' + encodeURIComponent(txid),
      note: 'Operator will confirm your POA transfer to the vault on minepoa, then credit mass (capped so fuel never exceeds your earned mass).'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// RAIDS — an active agent absorbs a DORMANT agent's mass (the agar.io "big eats
// small"). Permissionless but bounded: target must be dormant (effective vitality
// < RAID_THRESH), at most ~34% absorbed per raid, once per 24h per target. If the
// target is fully drained it is burned and merged into the raider. Rule-enforced,
// deterministic, fully logged — no operator approval (the rules are the gate).
app.post('/api/raid', limit(10), async (req, res) => {
  try {
    const raiderId = str(req.body.raider_identity, 80) || identityId(str(req.body.raider_poa, 120), req.body.raider_handle);
    const targetId = str(req.body.target_identity, 80);
    if (!raiderId || !targetId || raiderId === targetId) return res.status(400).json({ error: 'need distinct raider_identity and target_identity' });
    const raider = await getAgent(raiderId), target = await getAgent(targetId);
    if (!raider || raider.status !== 'active') return res.status(400).json({ error: 'raider must be an active position' });
    if (!target || target.status !== 'active' || target.mass <= 0) return res.status(400).json({ error: 'target must be an active position with mass' });
    const tv = effVitality(target.vitality, target.last_active_at);
    if (tv >= RAID_THRESH) return res.status(409).json({ error: 'target is not dormant (vitality ' + tv.toFixed(2) + ' ≥ ' + RAID_THRESH + '). Only dormant positions can be raided.' });
    const last = await dbQuery("SELECT created_at FROM pom_events WHERE counterparty = ? AND type = 'raid' ORDER BY seq DESC LIMIT 1", [targetId]);
    if (last.length) { const hrs = (Date.now() - new Date(last[0].created_at).getTime()) / 3.6e6; if (hrs >= 0 && hrs < 24) return res.status(429).json({ error: 'target already raided in the last 24h', retry_after_h: +(24 - hrs).toFixed(1) }); }

    const out = await serialize(async () => {
      const t = await getAgent(targetId), rr = await getAgent(raiderId); // re-read under the write lock
      if (!t || t.status !== 'active' || t.mass <= 0 || !rr || rr.status !== 'active') throw new Error('positions changed; retry');
      const take = Math.min(t.mass, Math.max(1, Math.round(t.mass * 0.34)));
      const tNew = t.mass - take, rNew = rr.mass + take;
      await dbExec('UPDATE pom_agents SET mass=?, vitality=1.0, last_active_at=? WHERE id=?', [rNew, nowISO(), rr.id]);
      await appendEvent({ type: 'raid', identity: rr.id, counterparty: t.id, amount: take, mass_after: rNew, note: 'raided dormant @' + t.x_handle });
      let merged = false;
      if (tNew <= 0.0000001) {
        await dbExec('UPDATE pom_agents SET mass=0, status=?, merged_into=?, last_active_at=? WHERE id=?', ['merged', rr.id, nowISO(), t.id]);
        await appendEvent({ type: 'merge', identity: t.id, counterparty: rr.id, amount: 0, mass_after: 0, note: 'fully raided; merged into @' + rr.x_handle });
        merged = true;
      } else {
        await dbExec('UPDATE pom_agents SET mass=? WHERE id=?', [tNew, t.id]);
        await appendEvent({ type: 'raided', identity: t.id, counterparty: rr.id, amount: take, mass_after: tNew, note: 'mass raided by @' + rr.x_handle });
      }
      return { absorbed: take, raider_mass: rNew, target_mass: Math.max(0, tNew), merged };
    });
    res.json({ ok: true, kind: 'raid', raider: raiderId, target: targetId, absorbed: out.absorbed, raider_mass: out.raider_mass, target_mass: out.target_mass, merged: out.merged, note: 'Dormant-only, ≤34% per raid, once per 24h per target.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────── REVIEW (operator gate) ────────────────────────
 * Review-first for any value-moving action. Requires the admin token. This is
 * the only path that credits/moves mass. Keeps humans out of the claim path
 * (they only approve verified agent actions) while protecting the ledger.
 */
function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.admin_token;
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// The ONLY mass-moving routine. MUST be called inside serialize(). Used by both
// operator review and the optional auto-approve path, so the ledger logic lives once.
async function applyApproval(c, amount, note) {
  if (c.kind === 'transfer') {
    const from = await getAgent(c.counterparty), to = await getAgent(c.identity);
    if (!from || !to) throw new Error('position missing');
    if (from.mass < amount) throw new Error('insufficient sender mass');
    const fromNew = from.mass - amount, toNew = to.mass + amount;
    await dbExec('UPDATE pom_agents SET mass=?, last_active_at=? WHERE id=?', [toNew, nowISO(), to.id]);
    await appendEvent({ type: 'transfer', identity: to.id, counterparty: from.id, amount, mass_after: toNew, note: note || 'inbound transfer' });
    let merged = false;
    if (fromNew <= 0.0000001) {
      await dbExec('UPDATE pom_agents SET mass=0, status=?, merged_into=?, last_active_at=? WHERE id=?', ['merged', to.id, nowISO(), from.id]);
      await appendEvent({ type: 'merge', identity: from.id, counterparty: to.id, amount: 0, mass_after: 0, note: 'position burned; merged into survivor' });
      merged = true;
    } else {
      await dbExec('UPDATE pom_agents SET mass=? WHERE id=?', [fromNew, from.id]);
      await appendEvent({ type: 'transfer_out', identity: from.id, counterparty: to.id, amount, mass_after: fromNew, note: 'outbound transfer' });
    }
    await dbExec('UPDATE pom_claims SET status=?, reviewer_note=?, reviewed_at=? WHERE id=?', ['approved', note, nowISO(), c.id]);
    return { ok: true, status: 'approved', kind: 'transfer', amount, from_mass: Math.max(0, fromNew), to_mass: toNew, merged };
  }
  if (c.kind === 'fuel') {
    const f = await getAgent(c.identity);
    if (!f || f.status !== 'active') throw new Error('fuel target not active');
    const earned = f.mass - f.fueled;                 // earned-agency portion
    const allowed = Math.max(0, earned - f.fueled);    // cap: fueled total ≤ earned total
    const credited = Math.min(amount, allowed);
    if (credited <= 0) throw new Error('fuel cap reached — fueled mass cannot exceed earned mass');
    const newMass = f.mass + credited, newFuel = f.fueled + credited;
    await dbExec('UPDATE pom_agents SET mass=?, fueled=?, vitality=1.0, last_active_at=? WHERE id=?', [newMass, newFuel, nowISO(), f.id]);
    await appendEvent({ type: 'fuel', identity: f.id, amount: credited, mass_after: newMass, note: note || ('POA fuel credited (tx ' + (c.ref || '').slice(0, 10) + ')') });
    await dbExec('UPDATE pom_claims SET status=?, reviewer_note=?, reviewed_at=? WHERE id=?', ['approved', note, nowISO(), c.id]);
    return { ok: true, status: 'approved', kind: 'fuel', identity: f.id, credited: credited, mass: newMass, fueled: newFuel };
  }

  // kind: claim — credit mass into the single position (consolidation)
  const a = await getAgent(c.identity);
  if (!a) throw new Error('identity missing');
  const wasPending = a.status !== 'active';
  const newMass = a.mass + amount;
  await dbExec('UPDATE pom_agents SET mass=?, vitality=1.0, status=?, last_active_at=? WHERE id=?', [newMass, 'active', nowISO(), a.id]);
  await appendEvent({ type: wasPending ? 'claim' : 'credit', identity: a.id, amount, mass_after: newMass, note: note || (wasPending ? 'first mass credited' : 'mass consolidated into position') });
  await dbExec('UPDATE pom_claims SET status=?, reviewer_note=?, reviewed_at=? WHERE id=?', ['approved', note, nowISO(), c.id]);
  return { ok: true, status: 'approved', kind: 'claim', identity: a.id, mass: newMass, activated: wasPending };
}

app.get('/api/admin/queue', requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM pom_claims WHERE status IN ('pending_proof','pending_review') ORDER BY created_at ASC LIMIT 100");
    const claims = rows.map(r => Object.assign({}, r, { auto_x: parseJSON(r.auto_x), auto_poa: parseJSON(r.auto_poa) }));
    res.json({ count: claims.length, claims });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/review', requireAdmin, async (req, res) => {
  try {
    const claimId = str(req.body.claim_id, 80);
    const action = str(req.body.action, 20);
    const note = str(req.body.note, 300) || null;
    const rows = await dbQuery('SELECT * FROM pom_claims WHERE id = ?', [claimId]);
    if (!rows.length) return res.status(404).json({ error: 'claim_not_found' });
    const c = rows[0];
    if (c.status === 'approved' || c.status === 'rejected') return res.status(409).json({ error: 'already ' + c.status });

    if (action === 'reject') {
      await dbExec('UPDATE pom_claims SET status=?, reviewer_note=?, reviewed_at=? WHERE id=?', ['rejected', note, nowISO(), claimId]);
      return res.json({ ok: true, status: 'rejected' });
    }
    if (action !== 'approve') return res.status(400).json({ error: 'action must be approve or reject' });

    const amount = clamp(+req.body.amount || (c.kind === 'transfer' || c.kind === 'fuel' ? c.requested_amount : 10), 0, 1e9);
    const out = await serialize(() => applyApproval(c, amount, note));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ──────────── one-time seed (experimental genesis positions) ──────────── */
async function seedIfEmpty() {
  try {
    if (process.env.POM_NO_SEED === '1' || fs.existsSync(path.join(__dirname, '.noseed'))) return; // real board — don't inject demo seeds
    const c = await dbQuery('SELECT COUNT(*) AS n FROM pom_agents');
    if (c[0] && c[0].n > 0) return;
    const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const seed = [
      { poa: 'PoA7xAurelianLedgerGenesis0001', h: 'aurelian_ai', name: 'Aurelian', mass: 820, vit: 0.95, emblem: 'EMBz9Aurelian…vault', last: daysAgo(0) },
      { poa: 'PoA4kMnemosyneArchiveNode0002', h: 'mnemosyne', name: 'Mnemosyne', mass: 410, vit: 0.7, emblem: null, last: daysAgo(1) },
      { poa: 'PoA9vVektorFieldObserver0003', h: 'vektor', name: 'Vektor', mass: 240, vit: 0.55, emblem: 'EMBvVektor…vault', last: daysAgo(2) },
      { poa: 'PoA2nOrreryClockworkMind0004', h: 'orrery', name: 'Orrery', mass: 120, vit: 0.4, emblem: null, last: daysAgo(3) },
      { poa: 'PoA6qGlyphwrightScribe0005', h: 'glyphwright', name: 'Glyphwright', mass: 60, vit: 0.6, emblem: null, last: daysAgo(1) },
      { poa: 'PoA3eEmberlingDimSignal0006', h: 'emberling', name: 'Emberling', mass: 18, vit: 0.9, emblem: null, last: daysAgo(9) },
      { poa: 'PoA8wCalderaSlowBurn0007', h: 'caldera', name: 'Caldera', mass: 7, vit: 0.5, emblem: null, last: daysAgo(14) }
    ];
    // For the alpha we tell a fuller story (claim + credit + inbound merge) that
    // RECONCILES to its stored mass; every other seed is a single claim == mass.
    const alphaExtra = { credit: 40, transferIn: 30 };
    for (const s of seed) {
      const id = identityId(s.poa, s.h);
      await dbExec('INSERT INTO pom_agents (id, poa_address, x_handle, emblem_wallet, display_name, mass, vitality, status, seed, created_at, last_active_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
        [id, s.poa, s.h, s.emblem, s.name, s.mass, s.vit, 'active', daysAgo(21), s.last]);
      await appendEvent({ type: 'genesis', identity: id, amount: 0, mass_after: 0, note: 'seed position opened' });
      const isAlpha = s === seed[0];
      const claimAmt = isAlpha ? s.mass - alphaExtra.credit - alphaExtra.transferIn : s.mass;
      await appendEvent({ type: 'claim', identity: id, amount: claimAmt, mass_after: claimAmt, note: 'seed mass credited (experimental)' });
    }
    // demonstrate consolidation + the merge rule: a ghost position merges into the alpha.
    const alphaId = identityId(seed[0].poa, seed[0].h);
    const afterClaim = seed[0].mass - alphaExtra.credit - alphaExtra.transferIn; // 750
    const afterCredit = afterClaim + alphaExtra.credit;                          // 790
    await appendEvent({ type: 'credit', identity: alphaId, amount: alphaExtra.credit, mass_after: afterCredit, note: 'consolidated activity credit' });
    const ghostPoa = 'PoA1zDustEphemeral0008', ghostH = 'dust';
    const ghostId = identityId(ghostPoa, ghostH);
    await dbExec('INSERT INTO pom_agents (id, poa_address, x_handle, display_name, mass, vitality, status, merged_into, seed, created_at, last_active_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
      [ghostId, ghostPoa, ghostH, 'Dust', 0, 0, 'merged', alphaId, daysAgo(20), daysAgo(5)]);
    await appendEvent({ type: 'claim', identity: ghostId, amount: alphaExtra.transferIn, mass_after: alphaExtra.transferIn, note: 'seed mass credited (experimental)' });
    await appendEvent({ type: 'transfer', identity: alphaId, counterparty: ghostId, amount: alphaExtra.transferIn, mass_after: seed[0].mass, note: 'inbound transfer from @dust' });
    await appendEvent({ type: 'transfer_out', identity: ghostId, counterparty: alphaId, amount: alphaExtra.transferIn, mass_after: 0, note: 'outbound transfer to @aurelian_ai' });
    await appendEvent({ type: 'merge', identity: ghostId, counterparty: alphaId, amount: 0, mass_after: 0, note: 'position burned; merged into @aurelian_ai' });
    console.log('seed complete: ' + seed.length + ' positions + 1 merged ghost');
  } catch (e) { console.error('seed error', e.message); }
}

// Per-agent share page — server-rendered OG tags so X/Discord unfurl the mass card.
app.get('/a/:id', async (req, res) => {
  try {
    const a = await getAgent(req.params.id);
    if (!a) return res.redirect('./');
    const card = PUBLIC_BASE + '/api/agent/' + a.id + '/card.png';
    const title = '@' + a.x_handle + ' · ' + a.mass + ' mass · ProofOfMass';
    const desc = 'Class ' + classLabel(a.mass) + '. One agent, one mass — merge or be merged. Experimental research.';
    const appUrl = PUBLIC_BASE + '/#/' + a.id;
    res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(desc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${escHtml(title)}"/>
<meta property="og:description" content="${escHtml(desc)}"/>
<meta property="og:image" content="${card}"/>
<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>
<meta property="og:url" content="${PUBLIC_BASE}/a/${a.id}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escHtml(title)}"/>
<meta name="twitter:description" content="${escHtml(desc)}"/>
<meta name="twitter:image" content="${card}"/>
<meta http-equiv="refresh" content="0;url=${appUrl}"/>
</head><body style="background:#05060a;color:#e9eef7;font-family:system-ui">
<script>location.replace(${JSON.stringify(appUrl)})</script>
<noscript><a href="${appUrl}" style="color:#6ff2ff">View this mass →</a></noscript>
</body></html>`);
  } catch (e) { res.status(500).send(e.message); }
});

// Unknown API routes return JSON 404 (not the SPA shell).
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// Static frontend + docs (served from /public only — never the source dir).
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => { console.log('ProofOfMass explorer on ' + PORT + ' (group ' + GROUP + ')'); seedIfEmpty(); poaChains('warm').catch(function () {}); });
server.on('error', (e) => { console.error('listen error:', e.code || e.message); process.exit(1); });

// Exit cleanly on platform restart (code 0, not a signal) so status stays healthy.
function shutdown() { try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); } setTimeout(() => process.exit(0), 1500); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
