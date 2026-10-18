import { Judge } from './judge.js';

const W = 320, H = 480, HIT_Y = 427, APPROACH_MS = 1500, LEAD_IN_S = 3;
const PALETTES = {
  3: ['#ff4d6d', '#ffd23f', '#3fa7ff'],
  4: ['#ff4d6d', '#ffd23f', '#5aff78', '#3fa7ff'],
  5: ['#ff4d6d', '#ffd23f', '#5aff78', '#3fa7ff', '#c77dff'],
};
const ACCENT = '#ffd23f';
const GRADE_COLOR = { PERFECT: '#5aff78', GREAT: '#ffe65a', GOOD: '#78c8ff', MISS: '#ff5050' };
const DIFFICULTY = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert' };
// Keyboard: several rows work at once, the Nth key of a row is lane N.
const KEY_ROWS = [
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'], ['KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'], ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'],
];
const ARROWS = { 3: ['ArrowLeft', 'ArrowDown', 'ArrowRight'], 4: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'] };
function keyMap(n) {
  const m = {};
  for (const row of [...KEY_ROWS, ARROWS[n] || []]) row.slice(0, n).forEach((code, lane) => { m[code] = lane; });
  return m;
}

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {AudioContext} actx
   * @param {{title:string, durationMs:number, levels:object}} song
   * @param {AudioBuffer} buffer
   * @param {{level:number, offsetMs:number, background?:ImageBitmap|HTMLImageElement|null, best:number,
   *          onFinish:(score:number)=>boolean, onExit:()=>void}} opts
   */
  constructor(canvas, actx, song, buffer, opts) {
    this.canvas = canvas; this.g = canvas.getContext('2d'); this.actx = actx; this.song = song; this.buffer = buffer; this.o = opts;
    this.notes = song.levels[opts.level] || [];
    this.lanes = song.lanes?.[opts.level] ?? 3;
    this.colors = PALETTES[this.lanes] || PALETTES[5];
    this.keys = keyMap(this.lanes);
    this.laneW = W / this.lanes;
    this.noteR = Math.min(26, this.laneW * 0.4);
    this.judge = new Judge(this.notes);
    this.chartEnd = Math.max(0, ...this.notes.map((n) => n.timeMs + n.durMs)) + 1200;
    this.state = 'playing'; // playing | paused | results
    this.songMs = -LEAD_IN_S * 1000;
    this.ref = null; this.feedback = null; this.flash = new Array(this.lanes).fill(0); this.down = new Array(this.lanes).fill(0);
    this.pointers = new Map(); this.newRecord = false; this.resultsAt = 0; this.raf = 0; this.dead = false;
    this.scale = 1; this.offX = 0; this.offY = 0;
    this.#bind();
  }

  async start() {
    await this.actx.resume();
    this.startCtx = this.actx.currentTime + LEAD_IN_S;
    this.source = this.actx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.actx.destination);
    this.source.onended = () => { this.audioEnded = true; };
    this.source.start(this.startCtx);
    this.#resize();
    this.raf = requestAnimationFrame(() => this.#frame());
  }

  destroy() {
    this.dead = true; cancelAnimationFrame(this.raf);
    try { this.source?.stop(); } catch { /* not started */ }
    this.source?.disconnect();
    for (const [t, fn, opt] of this.listeners) t.removeEventListener(fn[0], fn[1], opt);
  }

  // ---- clock -----------------------------------------------------------------------------------------------

  /** Song position in ms at a performance.now()-style timestamp. */
  #songAt(perf) {
    const r = this.ref;
    return r ? (r.ctxTime - this.startCtx) * 1000 + (perf - r.perf) : this.songMs;
  }

  #updateClock() {
    const ts = this.actx.getOutputTimestamp ? this.actx.getOutputTimestamp() : null;
    this.ref = ts && ts.contextTime > 0 && ts.performanceTime > 0
      ? { ctxTime: ts.contextTime, perf: ts.performanceTime }
      : { ctxTime: this.actx.currentTime, perf: performance.now() };
    this.songMs = Math.max(this.songMs, this.#songAt(performance.now()));
  }

  // ---- input -----------------------------------------------------------------------------------------------

  #bind() {
    this.listeners = [];
    const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); this.listeners.push([target, [type, fn], opt]); };
    const c = this.canvas;
    on(c, 'pointerdown', (e) => { e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer */ }
      this.#pointerDown(e); }, { passive: false });
    const up = (e) => { e.preventDefault(); this.#pointerUp(e.pointerId, e.timeStamp); };
    on(c, 'pointerup', up, { passive: false }); on(c, 'pointercancel', up, { passive: false });
    on(c, 'contextmenu', (e) => e.preventDefault());
    on(window, 'resize', () => this.#resize());
    on(window, 'keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Escape') { this.state === 'paused' ? this.resume() : this.pause(); return; }
      if (e.code in this.keys) { e.preventDefault(); this.#laneDown('k' + e.code, this.keys[e.code], e.timeStamp); }
    });
    on(window, 'keyup', (e) => { if (e.code in this.keys) this.#pointerUp('k' + e.code, e.timeStamp); });
    on(document, 'visibilitychange', () => { if (document.hidden) this.pause(); });
  }

  #virtual(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * (this.canvas.width / r.width) - this.offX) / this.scale,
            ((e.clientY - r.top) * (this.canvas.height / r.height) - this.offY) / this.scale];
  }

  #pointerDown(e) {
    const [vx, vy] = this.#virtual(e);
    if (this.state === 'paused') {
      if (vy >= 190 && vy <= 250) this.resume(); else if (vy >= 270 && vy <= 330) this.o.onExit();
    } else if (this.state === 'results') {
      if (performance.now() - this.resultsAt > 500) this.o.onExit();
    } else if (vy < 40 && vx > W - 60) {
      this.pause();
    } else {
      this.#laneDown(e.pointerId, Math.max(0, Math.min(this.lanes - 1, Math.floor(vx / this.laneW))), e.timeStamp);
    }
  }

  #judgeTime(stamp) { return this.#songAt(stamp) - this.o.offsetMs; }

  #laneDown(id, lane, stamp) {
    if (this.state !== 'playing' || !this.ref) return;
    this.pointers.set(id, lane); this.down[lane]++;
    const ev = this.judge.onPress(lane, this.#judgeTime(stamp));
    if (ev) this.#event(ev);
  }

  #pointerUp(id, stamp) {
    const lane = this.pointers.get(id);
    if (lane === undefined) return;
    this.pointers.delete(id); this.down[lane] = Math.max(0, this.down[lane] - 1);
    if (this.state === 'playing' && this.down[lane] === 0) {
      const ev = this.judge.onRelease(lane, this.#judgeTime(stamp));
      if (ev) this.#event(ev);
    }
  }

  #event(ev) {
    this.feedback = { grade: ev.grade, at: performance.now() };
    this.flash[ev.note.lane] = performance.now() + 150;
    if (ev.grade !== 'MISS' && navigator.vibrate) navigator.vibrate(8);
  }

  // ---- state -----------------------------------------------------------------------------------------------

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused'; this.actx.suspend();
    this.pointers.clear(); this.down.fill(0);
  }

  async resume() {
    if (this.state !== 'paused') return;
    await this.actx.resume();
    this.ref = null; this.state = 'playing';
  }

  #finish() {
    for (const e of this.judge.update(1e9)) this.#event(e);
    try { this.source.stop(); } catch { /* ended */ }
    this.newRecord = this.o.onFinish(this.judge.score);
    this.state = 'results'; this.resultsAt = performance.now();
  }

  // ---- frame -----------------------------------------------------------------------------------------------

  #frame() {
    if (this.dead) return;
    if (this.state === 'playing') {
      this.#updateClock();
      for (const e of this.judge.update(this.songMs - this.o.offsetMs)) this.#event(e);
      if (this.songMs > 0 && (this.audioEnded || (this.songMs > this.chartEnd && this.judge.resolvedAll))) this.#finish();
    }
    this.#draw();
    this.raf = requestAnimationFrame(() => this.#frame());
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(window.innerWidth * dpr); this.canvas.height = Math.round(window.innerHeight * dpr);
    this.scale = Math.min(this.canvas.width / W, this.canvas.height / H);
    this.offX = (this.canvas.width - W * this.scale) / 2; this.offY = (this.canvas.height - H * this.scale) / 2;
  }

  // ---- drawing ---------------------------------------------------------------------------------------------

  #draw() {
    const g = this.g, sw = this.canvas.width, sh = this.canvas.height;
    this.#background(g, sw, sh);
    g.save(); g.translate(this.offX, this.offY); g.scale(this.scale, this.scale);
    this.#lanes(g);
    g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip(); this.#drawNotes(g); g.restore();
    this.#hud(g);
    if (this.state === 'playing' && this.songMs < 0) this.#countdown(g);
    if (this.state === 'paused') this.#pauseMenu(g);
    if (this.state === 'results') this.#results(g);
    g.restore();
  }

  #background(g, sw, sh) {
    const bg = this.o.background;
    if (bg) {
      const s = Math.max(sw / bg.width, sh / bg.height), w = bg.width * s, h = bg.height * s;
      g.drawImage(bg, (sw - w) / 2, (sh - h) / 2, w, h);
      g.fillStyle = 'rgba(0,0,0,.47)'; g.fillRect(0, 0, sw, sh);
    } else {
      const grad = g.createLinearGradient(0, 0, 0, sh);
      grad.addColorStop(0, '#220e46'); grad.addColorStop(1, '#060410');
      g.fillStyle = grad; g.fillRect(0, 0, sw, sh);
    }
  }

  #laneX(i) { return (i + 0.5) * this.laneW; }

  #lanes(g) {
    const now = performance.now(), n = this.lanes;
    for (let i = 0; i < n; i++) {
      const lit = this.down[i] > 0 || now < this.flash[i];
      g.globalAlpha = lit ? 0.35 : 0.14; g.fillStyle = this.colors[i];
      g.fillRect(i * this.laneW + 3, 0, this.laneW - 6, H);
      g.globalAlpha = 1; g.strokeStyle = this.colors[i]; g.lineWidth = lit ? 5 : 3;
      g.beginPath(); g.arc(this.#laneX(i), HIT_Y, this.noteR + 1, 0, Math.PI * 2); g.stroke();
    }
  }

  #y(noteMs) { return -20 + (1 - (noteMs - this.songMs) / APPROACH_MS) * (HIT_Y + 20); }

  #drawNotes(g) {
    const off = this.o.offsetMs, t = this.songMs - off;
    const visible = [];
    for (const note of this.notes) {
      if (note.timeMs > t + APPROACH_MS) break;
      if (note.timeMs + note.durMs < t - 300) continue;
      const state = this.judge.noteState(note);
      if (state === 'hit' || state === 'broken' || (state === 'missed' && note.durMs === 0)) continue;
      visible.push({ note, state });
    }
    // Bodies first so no head is ever covered by another note's tail. State is per note: the next hold
    // in a lane stays at its real position while the current one is being held.
    for (const { note, state } of visible) {
      if (note.durMs <= 0) continue;
      const x = this.#laneX(note.lane), w = this.laneW * 0.3;
      const headY = state === 'holding' ? HIT_Y : this.#y(note.timeMs + off);
      const tailY = this.#y(note.timeMs + note.durMs + off);
      if (tailY >= headY) continue;
      const color = state === 'missed' ? '#888' : this.colors[note.lane];
      g.globalAlpha = state === 'holding' ? 0.85 : state === 'missed' ? 0.3 : 0.5;
      g.fillStyle = color; g.beginPath(); g.roundRect(x - w / 2, tailY, w, headY - tailY, w / 2); g.fill();
      g.globalAlpha = state === 'holding' ? 0.9 : 0.35; g.fillStyle = '#fff';
      g.beginPath(); g.roundRect(x - w / 6, tailY + 2, w / 3, Math.max(0, headY - tailY - 4), w / 6); g.fill();
      g.globalAlpha = 1;
    }
    for (const { note, state } of visible) {
      const x = this.#laneX(note.lane);
      const headY = state === 'holding' ? HIT_Y : this.#y(note.timeMs + off);
      const k = Math.min(1, Math.max(0, (headY + 20) / (HIT_Y + 20)));
      const r = this.noteR * (0.45 + 0.55 * k) * (state === 'holding' ? 1.12 : 1);
      const missed = state === 'missed';
      g.globalAlpha = missed ? 0.4 : 1;
      g.fillStyle = missed ? '#888' : this.colors[note.lane];
      g.beginPath(); g.arc(x, headY, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.63)'; g.beginPath(); g.arc(x, headY, r * 0.45, 0, Math.PI * 2); g.fill();
      if (note.durMs > 0) { g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(x, headY, r + 2, 0, Math.PI * 2); g.stroke(); }
      g.globalAlpha = 1;
    }
  }

  #text(g, s, x, y, size, color, align = 'center', bold = true) {
    g.font = `${bold ? 'bold ' : ''}${size}px system-ui, sans-serif`; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y);
  }

  #hud(g) {
    const j = this.judge;
    this.#text(g, String(j.score), 10, 30, 24, '#fff', 'left');
    this.#text(g, 'x' + j.multiplier, W - 10, 30, 26, j.multiplier > 1 ? ACCENT : '#ccc', 'right');
    if (j.streak >= 5) this.#text(g, j.streak + ' streak', W / 2, 58, 16, 'rgba(255,255,255,.8)');
    const prog = this.buffer.duration ? Math.min(1, Math.max(0, this.songMs / 1000 / this.buffer.duration)) : 0;
    g.fillStyle = 'rgba(255,255,255,.63)'; g.fillRect(0, 0, W * prog, 3);
    this.#text(g, '❚❚', W - 24, 54, 14, 'rgba(255,255,255,.55)');
    const f = this.feedback;
    if (f) {
      const age = performance.now() - f.at;
      if (age < 450) { g.globalAlpha = 1 - age / 450; this.#text(g, f.grade, W / 2, 330 - age / 30, 26, GRADE_COLOR[f.grade]); g.globalAlpha = 1; }
    }
  }

  #countdown(g) {
    this.#text(g, this.song.title, W / 2, 190, 22, '#fff');
    this.#text(g, DIFFICULTY[this.o.level] || 'Level ' + this.o.level, W / 2, 216, 15, '#ccc', 'center', false);
    this.#text(g, String(Math.floor(-this.songMs / 1000) + 1), W / 2, 290, 64, '#fff');
  }

  #pauseMenu(g) {
    g.fillStyle = 'rgba(0,0,0,.75)'; g.fillRect(0, 0, W, H);
    this.#text(g, 'PAUSED', W / 2, 160, 28, '#fff');
    ['RESUME', 'QUIT'].forEach((label, i) => {
      const y = 190 + i * 80;
      g.fillStyle = '#3c286e'; g.beginPath(); g.roundRect(70, y, 180, 60, 14); g.fill();
      this.#text(g, label, W / 2, y + 38, 22, '#fff');
    });
  }

  #results(g) {
    const j = this.judge;
    g.fillStyle = 'rgba(8,4,20,.85)'; g.fillRect(0, 0, W, H);
    this.#text(g, this.song.title, W / 2, 70, 22, '#fff');
    this.#text(g, DIFFICULTY[this.o.level] || '', W / 2, 94, 14, '#ccc', 'center', false);
    const s = j.stars();
    this.#text(g, '★'.repeat(s) + '☆'.repeat(5 - s), W / 2, 150, 34, ACCENT);
    this.#text(g, String(j.score), W / 2, 205, 40, '#fff');
    if (this.newRecord) this.#text(g, 'NEW BEST!', W / 2, 232, 18, GRADE_COLOR.PERFECT);
    else if (this.o.best > 0) this.#text(g, 'Best ' + this.o.best, W / 2, 232, 14, '#ccc', 'center', false);
    ['PERFECT', 'GREAT', 'GOOD', 'MISS'].forEach((k, i) => {
      this.#text(g, k, 80, 280 + i * 26, 17, '#ccc', 'left', false);
      this.#text(g, String(j.counts[k]), 240, 280 + i * 26, 17, '#fff', 'right');
    });
    this.#text(g, `Best streak ${j.bestStreak}   Accuracy ${Math.floor(j.accuracy * 100)}%`, W / 2, 396, 14, '#ccc', 'center', false);
    this.#text(g, 'Tap to continue', W / 2, 450, 15, 'rgba(255,255,255,.8)', 'center', false);
  }
}
