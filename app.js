// 찬양팀 콘티 웹
// 모드
//  - local (인도자, 내 컴퓨터): tools/serve.py 로 실행. 편집 가능, 저장하면 data/setlists.json 에 바로 기록
//  - team  (팀원 공유 사이트): tools/build_site.py 가 만든 암호화 사이트. 비밀번호로 열고 보기 전용

const MODE = window.SITE_MODE || 'local';
const CAN_EDIT = MODE !== 'team';
const KEY_ORDER = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// 예배 목록: data/services.json (팀 사이트에서는 암호화된 lib.bin 안에 있음)
let serviceList = [];
const services = () => [...new Set([...serviceList.map((x) => x.name), ...setlists.map((x) => x.service)])];
const serviceOf = (name) => serviceList.find((x) => x.name === name || (x.aliases || []).includes(name));
// 예배 이름으로 기본 요일 정하기 (수=3, 금=5, 주일=0)
const serviceDow = (name) => (/수요/.test(name) ? 3 : /금요/.test(name) ? 5 : /주일/.test(name) ? 0 : 5);
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const LOCAL_KEY = 'worship.setlists.v1';
const KEY_STORE = 'worship.teamkey.v1';

let songs = [];
let songMap = {};
let setlists = [];
let ui = { key: '전체', q: '', sort: 'title', editing: false };
let serverSave = false; // serve.py 로 열렸으면 true

/* ---------- 데이터 ---------- */
const slId = (s) => `${s.date}_${s.service}`;

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { edited: {}, deleted: [] }; }
  catch { return { edited: {}, deleted: [] }; }
}
function writeLocal(local) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch {}
}

function setData(s, list) {
  songs = s;
  songMap = Object.fromEntries(songs.map((x) => [x.id, x]));
  setlists = list.sort((a, b) => b.date.localeCompare(a.date));
}

async function load() {
  if (MODE === 'team') return loadTeam();
  const [s, base, svc] = await Promise.all([
    fetch('../data/songs.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('../data/setlists.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('../data/services.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => []),
  ]);
  serviceList = svc;
  serverSave = await fetch('/api/ping', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  const local = readLocal();
  const map = {};
  base.forEach((x) => (map[slId(x)] = x));
  Object.entries(local.edited).forEach(([id, x]) => (map[id] = x));
  local.deleted.forEach((id) => delete map[id]);
  setData(s, Object.values(map));
  if (serverSave && (Object.keys(local.edited).length || local.deleted.length)) await persist();
}

// 인도자 컴퓨터: data/setlists.json 에 저장. 서버가 없으면 이 브라우저에 임시 저장
async function persist() {
  if (!serverSave) return false;
  const body = JSON.stringify([...setlists].sort((a, b) => a.date.localeCompare(b.date)), null, 2);
  const ok = await fetch('/api/setlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then((r) => r.ok).catch(() => false);
  if (ok) writeLocal({ edited: {}, deleted: [] });
  else toast('파일 저장에 실패했어요. 이 브라우저에 임시 저장했어요');
  return ok;
}

function saveSetlist(sl, oldId) {
  const local = readLocal();
  const id = slId(sl);
  if (oldId && oldId !== id) { delete local.edited[oldId]; local.deleted.push(oldId); }
  local.edited[id] = sl;
  local.deleted = local.deleted.filter((x) => x !== id);
  writeLocal(local);
  const i = setlists.findIndex((x) => slId(x) === (oldId || id));
  if (i >= 0) setlists[i] = sl; else setlists.push(sl);
  setlists.sort((a, b) => b.date.localeCompare(a.date));
  persist();
}

function deleteSetlist(id) {
  const local = readLocal();
  delete local.edited[id];
  if (!local.deleted.includes(id)) local.deleted.push(id);
  writeLocal(local);
  setlists = setlists.filter((x) => slId(x) !== id);
  persist();
}

/* ---------- 팀 사이트: 암호화된 데이터 열기 ----------
   열쇠 구조
   - 비밀번호(마스터·예배별) → PBKDF2 → '출입 열쇠'(KEK)
   - meta.locks: 출입 열쇠로 잠근 상자들. 맞는 상자를 열면 { role, label, lib, svc:{예배id: 열쇠} } 가 나옴
   - lib.bin(곡·악보함)과 악보 이미지는 lib 열쇠, svc-<id>.bin(그 예배 콘티)은 예배 열쇠로 잠겨 있음 */
let libKey = null;            // 악보함 열쇠
let svcKeys = {};             // { 예배id: 열쇠 }
let access = null;            // { role: 'master'|'team', label }
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => { const r = s.replace(/-/g, '+').replace(/_/g, '/'); return r + '==='.slice((r.length + 3) % 4); };
async function decryptWith(key, buf) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
}
const decryptBuf = (buf) => decryptWith(libKey, buf); // 악보 이미지용
const importAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
async function deriveKey(password, meta) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(meta.salt), iterations: meta.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
// 출입 열쇠로 맞는 상자를 찾아 열기
async function tryKey(kek, meta) {
  for (const lock of meta.locks || []) {
    try {
      const box = JSON.parse(new TextDecoder().decode(await decryptWith(kek, b64(lock))));
      libKey = await importAes(b64(box.lib));
      svcKeys = {};
      for (const [id, k] of Object.entries(box.svc || {})) svcKeys[id] = await importAes(b64(k));
      access = { role: box.role, label: box.label };
      return true;
    } catch {}
  }
  return false;
}
async function loadTeam() {
  const meta = await fetch('meta.json', { cache: 'no-store' }).then((r) => r.json());
  let saved = null;
  try { saved = localStorage.getItem(KEY_STORE); } catch {}
  if (saved) {
    const key = await importAes(b64(saved)).catch(() => null);
    if (!(key && (await tryKey(key, meta)))) { try { localStorage.removeItem(KEY_STORE); } catch {} }
  }
  // 초대 링크(#k=...)로 들어온 경우: 비밀번호 없이 열고 이 기기에 기억
  const inv = location.hash.match(/^#k=([A-Za-z0-9_-]+)/);
  let inviteFailed = false;
  if (inv) {
    history.replaceState(null, '', location.pathname + location.search + '#/');
    const key = await importAes(b64(b64url(inv[1]))).catch(() => null);
    if (key && (await tryKey(key, meta))) {
      try { localStorage.setItem(KEY_STORE, b64url(inv[1])); } catch {}
    } else inviteFailed = true;
  }
  if (!libKey) await lockScreen(meta, inviteFailed);
  const get = (f) => fetch(f, { cache: 'no-store' }).then((r) => r.arrayBuffer());
  const lib = JSON.parse(new TextDecoder().decode(await decryptWith(libKey, await get('lib.bin'))));
  serviceList = lib.services || [];
  let list = [];
  for (const [id, key] of Object.entries(svcKeys)) {
    try { list = list.concat(JSON.parse(new TextDecoder().decode(await decryptWith(key, await get(`svc-${id}.bin`))))); } catch {}
  }
  setData(lib.songs, list);
}
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function lockScreen(meta, inviteFailed) {
  document.body.classList.add('locked');
  $('#app').innerHTML = `<div class="card lock"><h1>찬양팀 콘티</h1>
    <p class="sub">${inviteFailed ? '초대 링크가 만료됐어요. 예배 비밀번호를 입력해 주세요' : '예배 비밀번호를 입력해 주세요'}</p>
    <form id="lockform">
      <div class="pwrow"><input id="pw" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="비밀번호 또는 초대 링크 붙여넣기" autofocus>
        <button type="button" class="btn small" id="pwtoggle">보기</button></div>
      <label class="row" style="gap:6px;margin-top:10px;font-size:14px"><input type="checkbox" id="remember" checked>이 기기에서 기억하기</label>
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:14px">열기</button>
      ${standalone() ? '<p class="sub" style="margin:10px 0 0;font-size:13px">📱 홈 화면 앱은 처음 한 번 비밀번호나 초대 링크를 넣어야 해요. 카톡의 초대 링크를 길게 눌러 복사한 뒤 위 칸에 붙여넣어도 돼요.</p>' : ''}
      <p id="pwmsg" class="sub" style="margin:10px 0 0;color:var(--warn)"></p></form></div>`;
  $('#pwtoggle').addEventListener('click', () => {
    const i = $('#pw'); const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; $('#pwtoggle').textContent = show ? '숨기기' : '보기'; i.focus();
  });
  return new Promise((resolve) => {
    $('#lockform').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#pwmsg').textContent = '확인 중…';
      const val = $('#pw').value.trim().normalize('NFC');
      // 초대 링크(또는 열쇠)를 붙여넣은 경우
      const inv = val.match(/#k=([A-Za-z0-9_-]{40,})/) || val.match(/^([A-Za-z0-9_-]{43})$/);
      let key = null;
      if (inv) {
        const raw = inv[1].replace(/-/g, '+').replace(/_/g, '/');
        key = await crypto.subtle.importKey('raw', b64(raw + '==='.slice((raw.length + 3) % 4)), 'AES-GCM', true, ['decrypt']).catch(() => null);
        if (!(key && (await tryKey(key, meta)))) { $('#pwmsg').textContent = '초대 링크가 만료됐어요. 인도자에게 새 링크를 받아 주세요'; return; }
      } else {
        key = await deriveKey(val, meta);
        if (!(await tryKey(key, meta))) { $('#pwmsg').textContent = '비밀번호가 맞지 않아요'; return; }
      }
      if ($('#remember').checked) {
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
        try { localStorage.setItem(KEY_STORE, btoa(String.fromCharCode(...raw))); } catch {}
      }
      document.body.classList.remove('locked');
      resolve();
    });
  });
}
function logout() {
  try { localStorage.removeItem(KEY_STORE); } catch {}
  location.reload();
}

// 악보 이미지: 팀 사이트에서는 암호화된 파일을 받아 풀어서 보여줌
const imgCache = {};
async function hydrateImg(img) {
  const p = img.dataset.src;
  img.removeAttribute('data-src');
  if (MODE !== 'team') { img.src = '../' + p.split('/').map(encodeURIComponent).join('/'); return; }
  try {
    if (!imgCache[p]) {
      imgCache[p] = fetch(p + '.bin').then((r) => r.arrayBuffer()).then(decryptBuf).then((plain) => {
        const ext = p.split('.').pop().toLowerCase();
        const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/png';
        return URL.createObjectURL(new Blob([plain], { type }));
      });
    }
    img.src = await imgCache[p];
  } catch { img.alt = '악보를 불러오지 못했어요'; }
}
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); hydrateImg(e.target); } }), { rootMargin: '600px' })
  : null;
new MutationObserver(() => {
  document.querySelectorAll('img[data-src]:not([data-watch])').forEach((img) => {
    img.dataset.watch = '1';
    if (io) io.observe(img); else hydrateImg(img);
  });
}).observe(document.body, { childList: true, subtree: true });

/* ---------- 도우미 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  const w = DAYS[new Date(y, m - 1, day).getDay()];
  return `${y}.${String(m).padStart(2, '0')}.${String(day).padStart(2, '0')} (${w})`;
}
function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function nextDay(dow) { // 0=일, 5=금
  const t = new Date();
  t.setDate(t.getDate() + ((dow - t.getDay() + 7) % 7));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function versionOf(song, key) {
  return song.versions.find((v) => v.key === key) || song.versions[0];
}
function hasScore(song) { return song.versions.some((v) => v.files && v.files.length); }

/* ---------- 인도 기록 통계 ---------- */
const RECENT_DAYS = 21; // 이 기간 안에 부른 곡은 "최근에 불렀어요" 경고

// songId가 들어간 콘티 목록 (최신순). before가 있으면 그 날짜보다 앞선 것만, 없으면 오늘까지
function usage(songId, before) {
  const limit = before || todayStr();
  return setlists
    .filter((x) => (before ? x.date < limit : x.date <= limit) && x.songs.some((it) => it.songId === songId))
    .sort((a, b) => b.date.localeCompare(a.date));
}
function daysBetween(a, b) {
  const p = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); };
  return Math.round((p(b) - p(a)) / 86400000);
}
function agoText(days) {
  if (days <= 0) return '오늘';
  if (days < 7) return `${days}일 전`;
  if (days < 60) return `${Math.round(days / 7)}주 전`;
  return `${Math.round(days / 30)}개월 전`;
}
function recentWarn(songId, onDate) {
  const prev = usage(songId, onDate)[0];
  if (!prev) return null;
  const d = daysBetween(prev.date, onDate);
  return d <= RECENT_DAYS ? { prev, days: d } : null;
}
function ytId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function keyBadge(k) { return k ? `<span class="badge">${esc(k)}</span>` : `<span class="badge none">키 ?</span>`; }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- 모달 ---------- */
function openModal(html, narrow) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet card ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true">
    <button class="close" aria-label="닫기" data-close>×</button>${html}</div>`;
  m.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  const m = $('#modal');
  m.hidden = true; m.innerHTML = '';
  document.body.style.overflow = '';
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wm) closeModal(); });

function openYoutube(songId, url) {
  const s = songMap[songId];
  const id = ytId(url || (s && s.youtube));
  if (!id) return;
  openModal(`<h1>${esc(s.title)}</h1>
    <div class="video"><iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0"
      allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span>
      <a class="btn small" href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">유튜브에서 열기 ↗</a></div>`);
}

function openSong(songId, key) {
  const s = songMap[songId];
  const v = versionOf(s, key);
  const tabs = s.versions.length > 1
    ? `<div class="vtabs">${s.versions.map((x) => `<button class="btn small ${x.key === v.key ? 'primary' : ''}" data-act="song-ver" data-id="${s.id}" data-key="${esc(x.key)}">${esc(x.key)} 키</button>`).join('')}</div>` : '';
  const flow = v.flow || s.flow;
  const used = usage(s.id);
  const statLine = used.length
    ? `<div class="stat-line">지금까지 <b>${used.length}번</b> 인도 · 마지막 ${fmtDate(used[0].date)} ${esc(used[0].service)} (${agoText(daysBetween(used[0].date, todayStr()))})
        ${used.length > 1 ? `<details><summary>전체 날짜 보기</summary>${used.map((x) => `<a href="#/setlist/${encodeURIComponent(slId(x))}" data-close>${fmtDate(x.date)} ${esc(x.service)}</a>`).join('')}</details>` : ''}</div>`
    : `<div class="stat-line">아직 인도한 기록이 없어요</div>`;
  openModal(`<h1>${esc(s.title)}</h1>
    <div class="row">${keyBadge(v.key)}${s.artist ? `<span class="sub" style="margin:0">${esc(s.artist)}</span>` : ''}
      ${s.time ? `<span class="sub" style="margin:0">${esc(s.time)}${s.tempo ? ` · ♩=${s.tempo}` : ''}</span>` : ''}</div>
    ${tabs}
    ${statLine}
    ${flow ? `<div class="flow">${esc(flow)}</div>` : ''}
    ${s.memo ? `<div class="memo">${esc(s.memo)}</div>` : ''}
    <div class="row song-actions">
      ${CAN_EDIT ? `<button class="btn primary" data-act="add-to" data-id="${s.id}" data-key="${esc(v.key || '')}">＋ 콘티에 추가</button>` : ''}
      ${ytId(s.youtube) ? `<button class="btn yt" data-act="yt" data-id="${s.id}">▶ 유튜브</button>` : ''}
    </div>
    ${v.files.length ? `<div class="scores">${v.files.map((f) => `<img data-src="${esc(f)}" alt="${esc(s.title)} 악보">`).join('')}</div>`
      : `<div class="noscore">아직 악보 파일이 없어요</div>`}`);
}

function openAddTo(songId, key) {
  const s = songMap[songId];
  const today = todayStr();
  const upcoming = setlists.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const opts = upcoming.map((x) => `<option value="${esc(slId(x))}">${fmtDate(x.date)} ${esc(x.service)}</option>`).join('');
  openModal(`<h1>콘티에 추가</h1>
    <p class="sub">${esc(s.title)} ${keyBadge(key)}</p>
    <div class="field"><label>콘티 선택</label>
      <select id="add-target">${opts}<option value="__new">＋ 새 콘티 만들기</option></select></div>
    <div id="new-fields" ${opts ? 'hidden' : ''}>
      <div class="field"><label>날짜</label><input type="date" id="add-date" value="${nextDay(serviceDow(services()[0] || ""))}"></div>
      <div class="field"><label>예배</label><select id="add-svc">${services().map((x) => `<option>${x}</option>`).join('')}</select></div>
    </div>
    ${s.versions.length > 1 ? `<div class="field"><label>키</label><select id="add-key">${s.versions.map((v) => `<option ${v.key === key ? 'selected' : ''}>${esc(v.key)}</option>`).join('')}</select></div>` : ''}
    <div class="row" style="margin-top:16px"><span class="spacer"></span>
      <button class="btn primary" data-act="add-confirm" data-id="${s.id}" data-key="${esc(key || '')}">추가</button></div>`, true);
  const sel = $('#add-target');
  sel.value = opts ? sel.options[0].value : '__new';
  sel.addEventListener('change', () => ($('#new-fields').hidden = sel.value !== '__new'));
  $('#add-svc').addEventListener('change', (e) => {
    $('#add-date').value = nextDay(serviceDow(e.target.value));
  });
}

function confirmAdd(songId, key) {
  const k = $('#add-key') ? $('#add-key').value : key || null;
  const target = $('#add-target').value;
  let sl;
  if (target === '__new') {
    const date = $('#add-date').value;
    const service = $('#add-svc').value;
    if (!date) return toast('날짜를 선택해 주세요');
    sl = setlists.find((x) => slId(x) === `${date}_${service}`) || { date, service, songs: [], memo: '' };
  } else {
    sl = setlists.find((x) => slId(x) === target);
  }
  sl = structuredClone(sl);
  sl.songs.push({ songId, key: k });
  saveSetlist(sl);
  closeModal();
  const w = recentWarn(songId, sl.date);
  toast(w ? `추가했어요 · ⚠ ${w.days}일 전에도 부른 곡이에요` : `${fmtDate(sl.date)} ${sl.service} 콘티에 추가했어요`);
  location.hash = `#/setlist/${encodeURIComponent(slId(sl))}`;
}

function openNewSetlist() {
  openModal(`<h1>새 콘티</h1>
    <div class="field"><label>예배</label><select id="new-svc">${services().map((x) => `<option>${x}</option>`).join('')}</select></div>
    <div class="field"><label>날짜</label><input type="date" id="new-date" value="${nextDay(serviceDow(services()[0] || ""))}"></div>
    <div class="row" style="margin-top:16px"><span class="spacer"></span>
      <button class="btn primary" data-act="new-confirm">만들기</button></div>`, true);
  $('#new-svc').addEventListener('change', (e) => {
    $('#new-date').value = nextDay(serviceDow(e.target.value));
  });
}


/* ---------- 예배 모드 (전체화면 악보 넘기기) ---------- */
let wm = null; // { pages, i, fit, hud, lock }
function openWorship(sl) {
  if (!sl || !sl.songs.length) return;
  const pages = [];
  sl.songs.forEach((it, si) => {
    const s = songMap[it.songId];
    if (!s) return;
    const v = versionOf(s, it.key);
    const meta = { si, title: s.title, key: it.key || v.key, flow: v.flow || s.flow, note: it.note, link: it.linkNext };
    if (v.files.length) v.files.forEach((f, pi) => pages.push({ ...meta, file: f, pi, pn: v.files.length }));
    else pages.push({ ...meta, file: null, pi: 0, pn: 1 });
  });
  const titles = sl.songs.map((it) => (songMap[it.songId] || {}).title || '');
  const el = document.createElement('div');
  el.id = 'worship';
  el.innerHTML = `
    <div class="w-hud">
      <div class="w-top"><span class="w-pos"></span><span class="w-title"></span><span class="spacer"></span>
        <button class="w-btn" data-w="fit" title="화면 맞춤 바꾸기">↔</button>
        <button class="w-btn" data-w="close" aria-label="닫기">✕</button></div>
      <div class="w-flow"></div>
    </div>
    <div class="w-stage">${pages.map((pg, k) => `<div class="w-page" data-k="${k}" hidden>${pg.file
        ? `<img data-watch="1" data-src="${esc(pg.file)}" alt="${esc(pg.title)} 악보">`
        : `<div class="w-noscore"><div class="t">${esc(pg.title)}</div><div class="k">${esc(pg.key || '')}</div><div class="f">${esc(pg.flow || '악보 없음')}</div></div>`}</div>`).join('')}</div>
    <div class="w-next"></div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  wm = { el, pages, titles, i: 0, fit: innerWidth < 600 ? 'width' : 'screen', hud: true, lock: null };
  el.classList.add('fit-' + wm.fit);
  // 전체화면 + 화면 꺼짐 방지 (지원하는 기기에서만)
  try { const r = document.documentElement.requestFullscreen; if (r) document.documentElement.requestFullscreen().catch(() => {}); } catch {}
  keepAwake();
  el.addEventListener('click', onWorshipClick);
  el.addEventListener('touchstart', (e) => { wm.tx = e.touches[0].clientX; wm.ty = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - wm.tx, dy = e.changedTouches[0].clientY - wm.ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { wm.swiped = true; go(dx < 0 ? 1 : -1); }
  }, { passive: true });
  showPage(0);
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) wm.lock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (wm && document.visibilityState === 'visible') keepAwake(); });
function closeWorship() {
  if (!wm) return;
  try { wm.lock && wm.lock.release(); } catch {}
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch {}
  wm.el.remove(); wm = null;
  document.body.style.overflow = '';
}
function go(d) { if (wm) showPage(Math.max(0, Math.min(wm.pages.length - 1, wm.i + d))); }
function showPage(k) {
  const { el, pages } = wm;
  wm.i = k;
  el.querySelectorAll('.w-page').forEach((p) => (p.hidden = +p.dataset.k !== k));
  // 현재·앞뒤 장 미리 불러오기
  [k, k + 1, k - 1, k + 2].forEach((j) => {
    const img = el.querySelector(`.w-page[data-k="${j}"] img[data-src]`);
    if (img) hydrateImg(img);
  });
  const cur = el.querySelector(`.w-page[data-k="${k}"]`);
  cur.scrollTop = 0;
  const pg = pages[k];
  el.querySelector('.w-pos').textContent = `${pg.si + 1}/${wm.titles.length}`;
  el.querySelector('.w-title').innerHTML = `${esc(pg.title)} ${keyBadge(pg.key)}${pg.pn > 1 ? ` <small>${pg.pi + 1}/${pg.pn}쪽</small>` : ''}`;
  el.querySelector('.w-flow').textContent = [pg.flow, pg.note].filter(Boolean).join('  ·  ');
  const nextSong = wm.titles[pg.si + 1];
  const lastPageOfSong = pg.pi === pg.pn - 1;
  el.querySelector('.w-next').textContent = lastPageOfSong
    ? (nextSong ? `다음 ${pg.link ? '(이어서) ' : ''}▶ ${nextSong}` : '마지막 곡') : `다음 쪽 ▶`;
}
function onWorshipClick(e) {
  const b = e.target.closest('[data-w]');
  if (b) {
    if (b.dataset.w === 'close') closeWorship();
    if (b.dataset.w === 'fit') {
      wm.el.classList.remove('fit-' + wm.fit);
      wm.fit = wm.fit === 'screen' ? 'width' : 'screen';
      wm.el.classList.add('fit-' + wm.fit);
    }
    return;
  }
  if (wm.swiped) { wm.swiped = false; return; }
  if (e.target.closest('.w-hud')) return;
  const x = e.clientX / innerWidth;
  if (x < 0.3) go(-1);
  else if (x > 0.7) go(1);
  else { wm.hud = !wm.hud; wm.el.classList.toggle('hud-off', !wm.hud); }
}
document.addEventListener('keydown', (e) => {
  if (!wm) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go(1); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key === 'Escape') closeWorship();
});

/* ---------- 화면: 홈 ---------- */
function setlistCard(x) {
  const titles = x.songs.map((it) => {
    const s = songMap[it.songId];
    return `<li>${esc(s ? s.title : '(알 수 없는 곡)')}${it.key ? ` <small>${esc(it.key)}</small>` : ''}</li>`;
  }).join('');
  return `<a class="card setlist-card" href="#/setlist/${encodeURIComponent(slId(x))}">
    <div class="svc">${esc(x.service)}</div><div class="date">${fmtDate(x.date)}</div>
    ${titles ? `<ol>${titles}</ol>` : `<p class="sub" style="margin:8px 0 0">아직 곡이 없어요</p>`}</a>`;
}

function renderHome() {
  const today = todayStr();
  const upcoming = setlists.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = setlists.filter((x) => x.date < today).slice(0, 4);
  return `<div class="row"><div><h1>콘티</h1><p class="sub">금요 찬양 · 주일 오전 찬양</p></div>
      <span class="spacer"></span>${CAN_EDIT ? '<button class="btn primary" data-act="new-setlist">＋ 새 콘티</button>' : ''}</div>
    <h2>다가오는 예배</h2>
    ${upcoming.length ? `<div class="setlist-cards">${upcoming.map(setlistCard).join('')}</div>`
      : `<div class="card empty">예정된 콘티가 없어요.${CAN_EDIT ? '<br>악보함에서 곡을 골라 "콘티에 추가"를 눌러 보세요.' : '<br>인도자가 콘티를 올리면 여기에 보여요.'}</div>`}
    ${past.length ? `<h2>최근 인도</h2><div class="setlist-cards">${past.map(setlistCard).join('')}</div>` : ''}`;
}

/* ---------- 화면: 악보함 ---------- */
function libraryKeys() {
  const count = {};
  songs.forEach((s) => s.versions.forEach((v) => {
    const k = v.files.length ? v.key || '?' : '악보 없음';
    count[k] = (count[k] || 0) + 1;
  }));
  const keys = KEY_ORDER.filter((k) => count[k]);
  if (count['?']) keys.push('?');
  if (count['악보 없음']) keys.push('악보 없음');
  return { keys, count };
}

function renderLibrary() {
  const { keys, count } = libraryKeys();
  return `<h1>악보함</h1><p class="sub">${songs.filter(hasScore).length}곡 · 키별로 정리</p>
    <div class="toolbar"><input class="search" id="q" type="search" placeholder="곡 제목 검색" value="${esc(ui.q)}">
      <select class="search" id="sort" style="flex:0 1 170px">
        ${[['title', '제목순'], ['most', '많이 부른 순'], ['oldest', '오래 안 부른 순']].map(([v, t]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
    <div class="keytabs">
      <button data-act="key" data-key="전체" class="${ui.key === '전체' ? 'on' : ''}">전체<span class="n">${songs.filter(hasScore).length}</span></button>
      ${keys.map((k) => `<button data-act="key" data-key="${esc(k)}" class="${ui.key === k ? 'on' : ''}">${esc(k)}<span class="n">${count[k]}</span></button>`).join('')}
    </div>
    <div class="song-grid" id="grid">${renderGrid()}</div>`;
}

function renderGrid() {
  const q = ui.q.trim().replace(/\s/g, '');
  const cards = [];
  const today = todayStr();
  const stat = Object.fromEntries(songs.map((s) => [s.id, usage(s.id)]));
  const list = [...songs];
  if (ui.sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  if (ui.sort === 'most') list.sort((a, b) => stat[b.id].length - stat[a.id].length || a.title.localeCompare(b.title, 'ko'));
  if (ui.sort === 'oldest') list.sort((a, b) => ((stat[a.id][0] || {}).date || '').localeCompare((stat[b.id][0] || {}).date || '') || a.title.localeCompare(b.title, 'ko'));
  list.forEach((s) => {
    if (q && !s.title.replace(/\s/g, '').includes(q)) return;
    let vs = s.versions;
    if (ui.key === '악보 없음') vs = vs.filter((v) => !v.files.length);
    else if (ui.key === '전체' && !q) vs = vs.filter((v) => v.files.length);
    else vs = vs.filter((v) => v.files.length && (v.key || '?') === ui.key);
    if (!vs.length) return;
    const v = vs[0];
    const keys = (ui.key === '전체' ? s.versions.filter((x) => x.files.length || !hasScore(s)) : vs).map((x) => keyBadge(x.key)).join('');
    const u = stat[s.id];
    const last = u[0] ? daysBetween(u[0].date, today) : null;
    const usedTag = u.length
      ? `<span class="used ${last <= RECENT_DAYS ? 'recent' : ''}">${u.length}회 · ${agoText(last)}</span>`
      : `<span class="used">아직 안 부름</span>`;
    cards.push(`<button class="card song-card" data-act="song" data-id="${s.id}" data-key="${esc(v.key || '')}">
      <div class="thumb">${v.files.length ? `<img loading="lazy" data-src="${esc(v.files[0])}" alt="">` : '악보 없음'}</div>
      <div class="meta"><div class="title">${esc(s.title)}</div><div class="keys">${keys}</div>${usedTag}</div></button>`);
  });
  return cards.join('') || `<p class="empty" style="grid-column:1/-1">검색 결과가 없어요</p>`;
}

/* ---------- 화면: 콘티 ---------- */
function renderSetlist(id) {
  const sl = setlists.find((x) => slId(x) === id);
  if (!sl) return `<p class="empty">콘티를 찾을 수 없어요. <a href="#/">처음으로</a></p>`;
  const ed = CAN_EDIT && ui.editing;
  const keyLine = sl.songs.map((it, i) => {
    const link = it.linkNext && i < sl.songs.length - 1 ? '<span class="link">이어서</span>' : '';
    return keyBadge(it.key) + (i < sl.songs.length - 1 ? ` ${link}<span class="arrow">→</span>` : '');
  }).join(' ');

  const blocks = sl.songs.map((it, i) => {
    const s = songMap[it.songId];
    if (!s) return '';
    const v = versionOf(s, it.key);
    const flow = v.flow || s.flow;
    const files = v.files;
    const keyChanged = it.key && v.key !== it.key;
    const warn = recentWarn(s.id, sl.date);
    const nth = usage(s.id, sl.date).length + 1;
    const warnHtml = warn
      ? `<div class="warnline">⚠ ${warn.days}일 전(${fmtDate(warn.prev.date).slice(5)} ${esc(warn.prev.service)})에도 불렀어요</div>` : '';
    const editRow = ed ? `<div class="edit-row">
        <button class="btn small" data-act="mv" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-act="mv" data-i="${i}" data-d="1" ${i === sl.songs.length - 1 ? 'disabled' : ''}>↓</button>
        ${s.versions.length > 1 ? `<select data-act="set-key" data-i="${i}">${s.versions.map((x) => `<option ${x.key === it.key ? 'selected' : ''}>${esc(x.key)}</option>`).join('')}</select>` : ''}
        <label class="row" style="gap:4px;font-size:13px"><input type="checkbox" data-act="link" data-i="${i}" ${it.linkNext ? 'checked' : ''}>다음 곡과 이어서</label>
        <button class="btn small danger" data-act="rm" data-i="${i}">삭제</button>
        <input type="text" data-act="note" data-i="${i}" placeholder="인도자 메모 (예: 후렴 2번 반복)" value="${esc(it.note || '')}">
      </div>` : '';
    return `<section class="card song-block">
        <div class="song-head"><span class="num">${i + 1}</span>
          <div style="flex:1"><div class="t">${esc(s.title)} ${keyBadge(it.key || v.key)}</div>
            <div class="artist">${s.artist ? `${esc(s.artist)} · ` : ''}${nth === 1 ? '처음 부르는 곡' : `${nth}번째 인도`}</div></div></div>
        ${warnHtml}
        ${flow ? `<div class="flow">${esc(flow)}</div>` : ''}
        ${it.note ? `<div class="memo">📝 ${esc(it.note)}</div>` : ''}
        ${keyChanged ? `<div class="memo">※ ${esc(it.key)} 키 악보가 없어 ${esc(v.key)} 악보를 보여줘요</div>` : ''}
        ${editRow}
        ${files.length ? `<div class="scores">${files.map((f) => `<img loading="lazy" data-src="${esc(f)}" alt="${esc(s.title)} 악보">`).join('')}</div>`
          : `<div class="noscore">아직 악보 파일이 없어요</div>`}
        <div class="row song-actions">
          ${ytId(it.youtube || s.youtube) ? `<button class="btn yt" data-act="yt" data-id="${s.id}" data-url="${esc(it.youtube || '')}">▶ 유튜브로 듣기</button>` : `<span class="sub" style="margin:0;font-size:13px">유튜브 링크 없음</span>`}
        </div>
      </section>
      ${it.linkNext && i < sl.songs.length - 1 ? '<div class="linknext">↓ 이어서</div>' : ''}`;
  }).join('');

  return `<div class="row">
      <div><div class="sub" style="margin:0;color:var(--accent);font-weight:500">${esc(sl.service)}${sl.meetTime ? ` · ${esc(sl.meetTime)} 모임` : ''}</div>
        <h1>${fmtDate(sl.date)}</h1></div>
      <span class="spacer"></span>
      ${sl.songs.length ? '<button class="btn primary" data-act="worship">▶ 예배 모드</button>' : ''}
      <button class="btn" data-act="copy">카톡용 복사</button>
      ${CAN_EDIT ? `<button class="btn ${ed ? 'primary' : ''}" data-act="edit">${ed ? '편집 완료' : '편집'}</button>` : ''}
    </div>
    ${sl.songs.length ? `<div class="flowline">${keyLine}</div>` : ''}
    ${ed ? `<div class="field" style="margin-bottom:16px"><label>콘티 메모</label>
      <textarea id="sl-memo" rows="2" placeholder="예: 금요일 오후 7:50 모임">${esc(sl.memo || '')}</textarea></div>` : (sl.memo ? `<p class="memo" style="margin:-8px 0 16px">${esc(sl.memo)}</p>` : '')}
    ${blocks || `<div class="card empty">아직 곡이 없어요.${CAN_EDIT ? ' <a href="#/library">악보함</a>에서 곡을 추가해 주세요.' : ''}</div>`}
    ${ed ? `<div class="row"><a class="btn" href="#/library">＋ 곡 추가하러 가기</a><span class="spacer"></span>
      <button class="btn danger" data-act="del-setlist">콘티 삭제</button></div>` : ''}`;
}

function currentSetlist() {
  const m = location.hash.match(/^#\/setlist\/(.+)$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return setlists.find((x) => slId(x) === id) || null;
}
function mutate(fn) {
  const sl = structuredClone(currentSetlist());
  fn(sl);
  saveSetlist(sl);
  render();
}

function copyText(sl) {
  const d = fmtDate(sl.date);
  const lines = [`${d} ${sl.service} 콘티입니다`, ''];
  sl.songs.forEach((it, i) => {
    const s = songMap[it.songId];
    lines.push(`${String(i + 1).padStart(2, '0')} ${s ? s.title : ''}${it.key ? ` ${it.key}` : ''}`);
    if (s && (it.youtube || s.youtube)) lines.push(it.youtube || s.youtube);
    lines.push('');
  });
  if (sl.memo) lines.push(sl.memo);
  return lines.join('\n').trim();
}

/* ---------- 화면: 기록 ---------- */
function renderHistory() {
  if (!setlists.length) return `<h1>인도 기록</h1><p class="empty">아직 기록이 없어요</p>`;
  let month = '';
  const items = setlists.map((x) => {
    const m = x.date.slice(0, 7).replace('-', '년 ') + '월';
    const head = m !== month ? `<div class="history-month">${m}</div>` : '';
    month = m;
    const titles = x.songs.map((it) => (songMap[it.songId] || {}).title).filter(Boolean).join(' · ');
    return `${head}<a class="card history-item" href="#/setlist/${encodeURIComponent(slId(x))}">
      <span class="d">${fmtDate(x.date).slice(5)}</span><span class="s">${esc(x.service)}</span>
      <span class="songs">${esc(titles) || '곡 없음'}</span></a>`;
  }).join('');
  const today = todayStr();
  const past = setlists.filter((x) => x.date <= today);
  const counts = songs.map((s) => ({ s, u: usage(s.id) }));
  const sung = counts.filter((c) => c.u.length);
  const top = [...sung].sort((a, b) => b.u.length - a.u.length || b.u[0].date.localeCompare(a.u[0].date)).slice(0, 10);
  const notYet = counts.filter((c) => !c.u.length && hasScore(c.s));
  const bySvc = (name) => past.filter((x) => x.service === name).length;
  const songRow = (c) => `<button class="stat-row" data-act="song" data-id="${c.s.id}" data-key="">
      <span class="name">${esc(c.s.title)}</span><span class="cnt">${c.u.length}회</span>
      <span class="last">${fmtDate(c.u[0].date).slice(2, 10)}</span></button>`;

  return `<h1>인도 기록</h1><p class="sub">어떤 찬양을 언제 했는지 한눈에</p>
    <div class="stats">
      <div class="card stat"><div class="v">${past.length}</div><div class="l">인도한 예배</div></div>
      <div class="card stat"><div class="v">${bySvc('금요 찬양')}</div><div class="l">금요 찬양</div></div>
      <div class="card stat"><div class="v">${bySvc('주일 오전')}</div><div class="l">주일 오전</div></div>
      <div class="card stat"><div class="v">${sung.length}</div><div class="l">부른 곡 (전체 ${songs.length})</div></div>
    </div>
    ${top.length ? `<h2>많이 부른 곡</h2><div class="card stat-list">
      <div class="stat-row head"><span class="name">곡</span><span class="cnt">횟수</span><span class="last">마지막</span></div>
      ${top.map(songRow).join('')}</div>` : ''}
    ${notYet.length ? `<h2>악보는 있는데 아직 안 부른 곡 <small class="sub">${notYet.length}곡</small></h2>
      <div class="chips">${notYet.map((c) => `<button class="chip" data-act="song" data-id="${c.s.id}" data-key="">${esc(c.s.title)}</button>`).join('')}</div>` : ''}
    <h2>날짜별 기록</h2>${items}`;
}


/* ---------- 화면: 관리 (인도자 컴퓨터에서만) ---------- */
function renderAdmin() {
  if (!(CAN_EDIT && serverSave)) return `<p class="empty">관리 메뉴는 인도자 컴퓨터에서만 쓸 수 있어요.<br><small>"인도자 화면 열기"로 열어 주세요.</small></p>`;
  return `<h1>마스터 관리</h1><p class="sub">마스터만 보이는 메뉴예요 · 바꾼 내용은 [저장하고 반영]을 눌러야 팀 사이트에 적용돼요</p>
    <section class="card" style="padding:16px">
      <h2 style="margin-top:0">예배 · 인도자 · 팀원 비밀번호</h2>
      <p class="sub" style="margin:0 0 8px">팀원은 자기 예배 비밀번호로 <b>그 예배 콘티 + 악보함</b>만 볼 수 있어요. 비밀번호를 비워 두면 그 예배는 마스터만 봐요.</p>
      <div id="svc-admin"><p class="sub">불러오는 중…</p></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="svc-save">저장하고 팀 사이트에 반영</button></div>
      <p class="memo" id="svcmsg"></p>
    </section>
    <section class="card" style="padding:16px;margin-top:16px">
      <h2 style="margin-top:0">마스터 비밀번호 <small class="sub">(모든 예배 보기)</small></h2>
      <div class="row"><span>현재:</span> <b id="curpw">••••••</b>
        <button class="btn small" data-act="pw-show">보기</button>
        <button class="btn small" data-act="svc-invite" data-sid="master">마스터 초대 링크 복사</button></div>
      <div class="field"><label>새 비밀번호 (영문·숫자 4자 이상, 한글·띄어쓰기 안 됨)</label><input type="password" id="pw1" autocomplete="new-password"></div>
      <div class="field"><label>새 비밀번호 확인</label><input type="password" id="pw2" autocomplete="new-password"></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="pw-save">마스터 비밀번호 바꾸고 반영</button></div>
    </section>
    <section class="card" style="padding:16px;margin-top:16px">
      <h2 style="margin-top:0">팀 사이트에 반영</h2>
      <p class="sub" style="margin:0 0 8px">콘티를 편집한 뒤 누르면 팀원 사이트가 업데이트돼요 (1~2분).</p>
      <button class="btn primary" data-act="deploy">지금 반영하기</button>
      <p class="memo" id="deploymsg"></p>
    </section>`;
}
let adminSvc = [];
async function loadSvcAdmin() {
  adminSvc = await fetch('/api/services', { cache: 'no-store' }).then((r) => r.json()).catch(() => []);
  drawSvcAdmin();
}
function drawSvcAdmin() {
  const box = $('#svc-admin');
  if (!box) return;
  box.innerHTML = adminSvc.map((x, si) => `
    <div class="svc-card" data-si="${si}">
      <div class="row"><h3>${esc(x.name)}</h3>
        <span class="badge ${x.password ? '' : 'none'}">${x.password ? '팀원 공개' : '마스터만'}</span>
        <span class="spacer"></span>
        <button class="btn small" data-act="svc-invite" data-sid="${esc(x.id)}" ${x.password ? '' : 'disabled'}>초대 링크 복사</button></div>
      <div class="field"><label>팀원 비밀번호 (영문·숫자 4자 이상 · 비우면 팀원 접근 안 됨)</label>
        <div class="pwrow"><input type="password" class="svc-pw" value="${esc(x.password || '')}" autocomplete="off">
          <button class="btn small" data-act="svc-pwshow">보기</button></div></div>
      <div class="field"><label>인도자</label>
        ${(x.leaders || []).map((l, li) => `<div class="pwrow ld" style="margin-top:6px">
          <input class="ld-name" placeholder="이름" value="${esc(l.name)}">
          <input class="ld-login" placeholder="아이디 (예: fri1)" value="${esc(l.login || '')}">
          <button class="btn small danger" data-act="ld-rm" data-si="${si}" data-li="${li}">삭제</button></div>`).join('') || '<p class="sub" style="margin:2px 0">아직 인도자가 없어요</p>'}
        <div><button class="btn small" data-act="ld-add" data-si="${si}" style="margin-top:6px">＋ 인도자 추가</button></div></div>
    </div>`).join('');
}
// 화면에 입력한 값을 adminSvc 에 반영
function collectSvcAdmin() {
  document.querySelectorAll('.svc-card').forEach((c) => {
    const x = adminSvc[+c.dataset.si];
    x.password = c.querySelector('.svc-pw').value.trim();
    x.leaders = [...c.querySelectorAll('.ld')].map((r) => ({ name: r.querySelector('.ld-name').value.trim(), login: r.querySelector('.ld-login').value.trim() }));
  });
}
async function adminCall(path, body, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '반영 중… (최대 1분)';
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (x) => ({ ok: x.ok, text: await x.text() })).catch((e) => ({ ok: false, text: String(e) }));
  btn.disabled = false; btn.textContent = label;
  return r;
}

/* ---------- 라우터 ---------- */
function render() {
  const h = location.hash || '#/';
  let tab = 'home', html;
  if (h.startsWith('#/library')) { tab = 'library'; html = renderLibrary(); }
  else if (h.startsWith('#/history')) { tab = 'history'; html = renderHistory(); }
  else if (h.startsWith('#/admin')) { tab = 'admin'; html = renderAdmin(); setTimeout(loadSvcAdmin); }
  else if (h.startsWith('#/setlist/')) { html = renderSetlist(decodeURIComponent(h.slice(10))); }
  else html = renderHome();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $('#app').innerHTML = html;
  const q = $('#q');
  if (q) q.addEventListener('input', (e) => { ui.q = e.target.value; $('#grid').innerHTML = renderGrid(); });
  const sort = $('#sort');
  if (sort) sort.addEventListener('change', (e) => { ui.sort = e.target.value; $('#grid').innerHTML = renderGrid(); });
  const memo = $('#sl-memo');
  if (memo) memo.addEventListener('change', (e) => mutate((sl) => (sl.memo = e.target.value)));
}

window.addEventListener('hashchange', () => { ui.editing = false; render(); window.scrollTo(0, 0); });

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'text') return;
  const { act, id, key, i, d } = el.dataset;
  switch (act) {
    case 'song': openSong(id, key); break;
    case 'song-ver': openSong(id, key); break;
    case 'yt': openYoutube(id, el.dataset.url); break;
    case 'add-to': openAddTo(id, key); break;
    case 'add-confirm': confirmAdd(id, key); break;
    case 'new-setlist': openNewSetlist(); break;
    case 'new-confirm': {
      const date = $('#new-date').value, service = $('#new-svc').value;
      if (!date) return toast('날짜를 선택해 주세요');
      const sid = `${date}_${service}`;
      if (!setlists.find((x) => slId(x) === sid)) saveSetlist({ date, service, songs: [], memo: '' });
      closeModal();
      ui.editing = true;
      location.hash = `#/setlist/${encodeURIComponent(sid)}`;
      break;
    }
    case 'key': ui.key = key; render(); break;
    case 'edit': ui.editing = !ui.editing; render(); break;
    case 'mv': mutate((sl) => { const a = +i, b = a + +d; [sl.songs[a], sl.songs[b]] = [sl.songs[b], sl.songs[a]]; }); break;
    case 'rm': mutate((sl) => sl.songs.splice(+i, 1)); break;
    case 'worship': openWorship(currentSetlist()); break;
    case 'pw-show': {
      const t = await fetch('/api/password').then((r) => r.text()).catch(() => '');
      $('#curpw').textContent = t || '(없음)'; break;
    }
    case 'pw-save': {
      const a = $('#pw1').value.trim(), b2 = $('#pw2').value.trim();
      if (a.length < 4) return toast('비밀번호는 4자 이상이어야 해요');
      if (!/^[\x21-\x7E]+$/.test(a)) return toast('영문·숫자·기호만 쓸 수 있어요 (아이폰은 비밀번호 칸에 한글 입력이 안 돼요)');
      if (a !== b2) return toast('두 비밀번호가 서로 달라요');
      if (!confirm('마스터 비밀번호를 바꾸고 팀 사이트에 반영할까요?')) return;
      const r = await adminCall('/api/password', { password: a }, el);
      if (r.ok) { $('#pw1').value = $('#pw2').value = ''; $('#curpw').textContent = '••••••'; toast('비밀번호를 바꿨어요. 1~2분 뒤 팀 사이트에 적용돼요'); }
      else toast('실패: ' + r.text);
      break;
    }
    case 'svc-pwshow': {
      const inp = el.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password'; el.textContent = inp.type === 'password' ? '보기' : '숨기기'; break;
    }
    case 'ld-add': collectSvcAdmin(); adminSvc[+el.dataset.si].leaders.push({ name: '', login: '' }); drawSvcAdmin(); break;
    case 'ld-rm': collectSvcAdmin(); adminSvc[+el.dataset.si].leaders.splice(+el.dataset.li, 1); drawSvcAdmin(); break;
    case 'svc-save': {
      collectSvcAdmin();
      for (const x of adminSvc) {
        if (x.password && (x.password.length < 4 || !/^[\x21-\x7E]+$/.test(x.password))) return toast(`${x.name}: 비밀번호는 영문·숫자 4자 이상이어야 해요`);
      }
      const r = await adminCall('/api/services', { services: adminSvc }, el);
      $('#svcmsg').textContent = r.ok ? '✅ 저장했어요 · 1~2분 뒤 팀 사이트에 적용돼요' : '❌ ' + r.text;
      if (r.ok) loadSvcAdmin();
      break;
    }
    case 'svc-invite': {
      const sid = el.dataset.sid;
      const r = await fetch('/api/invite?id=' + encodeURIComponent(sid)).then(async (x) => ({ ok: x.ok, text: await x.text() })).catch(() => ({ ok: false, text: '연결 실패' }));
      if (!r.ok) return toast(r.text);
      const name = sid === 'master' ? '마스터' : (adminSvc.find((x) => x.id === sid) || {}).name || '';
      const text = sid === 'master' ? r.text
        : `🎵 ${name} 찬양팀 콘티\n이번 주 콘티 · 악보 · 유튜브를 한곳에서 볼 수 있어요.\n아래 링크를 누르면 바로 열려요 (비밀번호 필요 없음)\n${r.text}\n\n📱 홈 화면에 추가하면 앱처럼 쓸 수 있어요\n⚠ ${name} 팀원 외에는 공유하지 말아 주세요`;
      try { await navigator.clipboard.writeText(text); toast(`${name} 초대 링크를 복사했어요`); }
      catch { openModal(`<h1>${esc(name)} 초대 링크</h1><textarea style="width:100%;height:220px">${esc(text)}</textarea>`); }
      break;
    }
    case 'deploy': {
      const r = await adminCall('/api/deploy', {}, el);
      $('#deploymsg').textContent = r.ok ? '✅ ' + r.text + ' · 1~2분 뒤 팀 사이트에 보여요' : '❌ ' + r.text;
      break;
    }
    case 'copy': {
      const text = copyText(currentSetlist());
      try { await navigator.clipboard.writeText(text); toast('카톡에 붙여넣을 수 있게 복사했어요'); }
      catch { openModal(`<h1>콘티 텍스트</h1><textarea style="width:100%;height:300px">${esc(text)}</textarea>`); }
      break;
    }
    case 'del-setlist': {
      const sl = currentSetlist();
      if (confirm(`${fmtDate(sl.date)} ${sl.service} 콘티를 삭제할까요?`)) { deleteSetlist(slId(sl)); location.hash = '#/'; }
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const i = +el.dataset.i;
  if (el.dataset.act === 'set-key') mutate((sl) => (sl.songs[i].key = el.value));
  if (el.dataset.act === 'link') mutate((sl) => (sl.songs[i].linkNext = el.checked));
  if (el.dataset.act === 'note') mutate((sl) => (sl.songs[i].note = el.value));
});

if (MODE === 'team') {
  const b = document.createElement('button');
  b.className = 'btn small logout'; b.textContent = '잠그기'; b.title = '이 기기에서 비밀번호 지우기';
  b.addEventListener('click', logout);
  const who = document.createElement('span');
  who.className = 'who'; who.id = 'who';
  document.querySelector('.topbar').appendChild(who);
  document.querySelector('.topbar').appendChild(b);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

function addAdminTab() {
  if (!(CAN_EDIT && serverSave) || document.querySelector('[data-tab=admin]')) return;
  const a = document.createElement('a');
  a.href = '#/admin'; a.dataset.tab = 'admin'; a.textContent = '관리';
  document.querySelector('.tabs').appendChild(a);
}

load().then(() => { addAdminTab(); if (access && $('#who')) $('#who').textContent = access.role === 'master' ? '마스터' : access.label; render(); }).catch((err) => {
  $('#app').innerHTML = `<p class="empty">데이터를 불러오지 못했어요.<br><small>${esc(err.message)}</small></p>`;
});
