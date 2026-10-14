import { Judge } from './judge.js';

const W = 320, H = 480, HIT_Y = 427, APPROACH_MS = 1500, LEAD_IN_S = 3;
const LANE_X = [55.5, 160, 263];
const LANE_COLOR = ['#ff4d6d', '#ffd23f', '#3fa7ff'];
const GRADE_COLOR = { PERFECT: '#5aff78', GREAT: '#ffe65a', GOOD: '#78c8ff', MISS: '#ff5050' };
const DIFFICULTY = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert' };
const KEYS = { ArrowLeft: 0, KeyZ: 0, KeyJ: 0, KeyA: 0, ArrowDown: 1, KeyX: 1, KeyK: 1, KeyS: 1, ArrowRight: 2, KeyC: 2, KeyL: 2, KeyD: 2 };

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
    this.judge = new Judge(this.notes);
    this.chartEnd = Math.max(0, ...this.notes.map((n) => n.timeMs + n.durMs)) + 1200;
    this.state = 'playing'; // playing | paused | results
    this.songMs = -LEAD_IN_S * 1000;
    this.ref = null; this.feedback = null; this.flash = [0, 0, 0]; this.down = [0, 0, 0];
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
      if (e.code in KEYS) { e.preventDefault(); this.#laneDown('k' + e.code, KEYS[e.code], e.timeStamp); }
    });
    on(window, 'keyup', (e) => { if (e.code in KEYS) this.#pointerUp('k' + e.code, e.timeStamp); });
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
      this.#laneDown(e.pointerId, vx < W / 3 ? 0 : vx < 2 * W / 3 ? 1 : 2, e.timeStamp);
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
    this.#lanes(g); this.#drawNotes(g); this.#hud(g);
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

  #lanes(g) {
    const now = performance.now();
    for (let i = 0; i < 3; i++) {
      const lit = this.down[i] > 0 || now < this.flash[i];
      g.globalAlpha = lit ? 0.35 : 0.14; g.fillStyle = LANE_COLOR[i];
      g.fillRect(i * W / 3 + 3, 0, W / 3 - 6, H);
      g.globalAlpha = 1; g.strokeStyle = LANE_COLOR[i]; g.lineWidth = lit ? 5 : 3;
      g.beginPath(); g.arc(LANE_X[i], HIT_Y, 27, 0, Math.PI * 2); g.stroke();
    }
  }

  #y(noteMs) { return -20 + (1 - (noteMs - this.songMs) / APPROACH_MS) * (HIT_Y + 20); }

  #drawNotes(g) {
    const t = this.songMs - this.o.offsetMs;
    for (const n of this.notes) {
      if (n.timeMs > t + APPROACH_MS) break;
      if (n.timeMs + n.durMs < t - 250) continue;
      const held = n.durMs > 0 && this.judge.isHolding(n.lane);
      if (this.judge.isResolved(n) && !held) continue;
      const headY = held ? HIT_Y : this.#y(n.timeMs + this.o.offsetMs);
      const x = LANE_X[n.lane];
      if (n.durMs > 0) {
        const tailY = this.#y(n.timeMs + n.durMs + this.o.offsetMs);
        g.globalAlpha = held ? 0.8 : 0.5; g.fillStyle = LANE_COLOR[n.lane];
        g.beginPath(); g.roundRect(x - 10, tailY, 20, headY - tailY, 10); g.fill(); g.globalAlpha = 1;
      }
      const r = 12 + 14 * Math.min(1, Math.max(0, (headY + 20) / (HIT_Y + 20)));
      g.fillStyle = LANE_COLOR[n.lane]; g.beginPath(); g.arc(x, headY, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.63)'; g.beginPath(); g.arc(x, headY, r * 0.45, 0, Math.PI * 2); g.fill();
    }
  }

  #text(g, s, x, y, size, color, align = 'center', bold = true) {
    g.font = `${bold ? 'bold ' : ''}${size}px system-ui, sans-serif`; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y);
  }

  #hud(g) {
    const j = this.judge;
    this.#text(g, String(j.score), 10, 30, 24, '#fff', 'left');
    this.#text(g, 'x' + j.multiplier, W - 10, 30, 26, j.multiplier > 1 ? LANE_COLOR[1] : '#ccc', 'right');
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
    this.#text(g, '★'.repeat(s) + '☆'.repeat(5 - s), W / 2, 150, 34, LANE_COLOR[1]);
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
