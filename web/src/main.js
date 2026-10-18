import * as demo from './demo.js';
import { readIpa } from './ipa.js';
import * as store from './store.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);
const LEVEL_NAMES = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert' };
let actx = null, game = null;
const backgrounds = new Map(); // key -> ImageBitmap | false
const urls = [];

const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const best = (id, lvl) => Number(ls.get(`best:${id}:${lvl}`, 0));

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

async function render() {
  urls.splice(0).forEach(URL.revokeObjectURL);
  const list = $('songs');
  list.replaceChildren();
  const imported = await store.listSongs().catch(() => []);
  for (const meta of [...imported, demo.track()]) {
    let art = null;
    if (meta.id !== 'demo') {
      const b = await store.getBlob(meta.id + ':art').catch(() => null);
      if (b) { art = URL.createObjectURL(b); urls.push(art); }
    }
    const row = el('div', { className: 'levels' });
    for (const lvl of Object.keys(meta.levels).map(Number).sort()) {
      const b = best(meta.id, lvl);
      const btn = el('button', { className: 'lvl' }, LEVEL_NAMES[lvl] || 'Level ' + lvl);
      if (b) btn.append(el('small', {}, String(b)));
      btn.onclick = () => play(meta, lvl);
      row.append(btn);
    }
    list.append(el('div', { className: 'card' },
      el('div', { className: 'head' },
        art ? el('img', { src: art, alt: '' }) : el('div', { className: 'noart' }, '♪'),
        el('div', {}, el('div', { className: 'title' }, meta.title), el('div', { className: 'artist' }, meta.artist))),
      row));
  }
  $('clear').hidden = imported.length === 0;
}

async function loadBuffer(meta) {
  if (meta.id === 'demo') {
    const s = demo.samples();
    const buf = actx.createBuffer(1, s.length, demo.SAMPLE_RATE);
    buf.copyToChannel(s, 0);
    return buf;
  }
  const blob = await store.getBlob(meta.id + ':audio');
  if (!blob) throw new Error('Audio missing, please import the IPA again');
  try {
    return await actx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("this browser can't decode the song's AAC audio. Try Chrome, Safari or Firefox");
  }
}

/** The song's own theme backdrop, else the shared one, else nothing. */
async function loadBackground(id) {
  for (const key of [id + ':bg', 'background']) {
    if (!backgrounds.has(key)) {
      const b = await store.getBlob(key).catch(() => null);
      backgrounds.set(key, b ? await createImageBitmap(b).catch(() => false) : false);
    }
    if (backgrounds.get(key)) return backgrounds.get(key);
  }
  return null;
}

async function play(meta, level) {
  const status = $('status');
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await actx.resume();
    status.textContent = 'Loading…';
    const buffer = await loadBuffer(meta);
    const background = await loadBackground(meta.id);
    status.textContent = '';
    $('menu').hidden = true; $('stage').hidden = false;
    game = new Game($('canvas'), actx, meta, buffer, {
      level, offsetMs: Number($('offset').value), background, best: best(meta.id, level),
      onFinish: (score) => {
        const isBest = score > best(meta.id, level);
        if (isBest) ls.set(`best:${meta.id}:${level}`, String(score));
        return isBest;
      },
      onExit: () => { game.destroy(); game = null; window.__ttGame = null; $('stage').hidden = true; $('menu').hidden = false; render(); },
    });
    window.__ttGame = game; // handy for automated tests
    await game.start();
  } catch (e) {
    status.textContent = 'Could not start: ' + (e.message || e);
    $('menu').hidden = false; $('stage').hidden = true;
  }
}

$('import').onchange = async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  const status = $('status');
  let total = 0;
  try {
    for (const file of files) {
      status.textContent = 'Opening ' + file.name + '…';
      const result = await readIpa(file, (m) => { status.textContent = `${file.name}: ${m}`; });
      status.textContent = 'Saving…';
      await store.saveImport(result);
      total += result.songs.length;
    }
    backgrounds.clear();
    status.textContent = `Imported ${total} song${total === 1 ? '' : 's'}.`;
    await render();
  } catch (e) {
    status.textContent = 'Import failed: ' + (e.message || e);
    await render();
  }
};

$('clear').onclick = async () => {
  if (!confirm('Remove all imported songs from this device?')) return;
  await store.clearAll(); backgrounds.clear();
  $('status').textContent = 'Imported songs removed.';
  render();
};

$('offset').value = ls.get('offsetMs', '0');
$('offsetLabel').textContent = $('offset').value + ' ms';
$('offset').oninput = () => { $('offsetLabel').textContent = $('offset').value + ' ms'; ls.set('offsetMs', $('offset').value); };

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
