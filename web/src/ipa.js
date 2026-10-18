// Reads the tracks of a Tap Tap Revenge 3 .ipa entirely in the browser (nothing is uploaded).
import { ZipReader } from './zip.js';
import { unarchive, readInfo } from './plist.js';
import { toWebImage } from './image.js';
import { midiToNotes, DEFAULT_COLUMNS, DEFAULT_HOLD_MIN_MS } from './midi.js';

function safeImage(bytes) {
  try { return toWebImage(bytes); } catch { return null; } // artwork is optional
}

/**
 * @returns {Promise<{songs: {meta: object, audio: Uint8Array, artwork: Uint8Array|null, background: Uint8Array|null}[], background: Uint8Array|null}>}
 */
export async function readIpa(file, onProgress = () => {}) {
  const zip = await new ZipReader(file).open();
  const infoName = zip.names().find((n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
  if (!infoName) throw new Error('This does not look like an iOS app (.ipa)');
  const app = infoName.slice(0, -'Info.plist'.length);
  const ids = [...new Set(zip.names().filter((n) => n.startsWith(app + 'Tracks/') && n.endsWith('.track/info.plist'))
    .map((n) => n.slice((app + 'Tracks/').length).split('/')[0].replace(/\.track$/, '')))].sort();
  if (!ids.length) throw new Error('No tracks found in this IPA');
  const songs = [];
  const decoder = new TextDecoder();
  const themeDir = (info, lvl) => `${app}Themes/${(lvl !== undefined && info.levelThemes?.[lvl]) || info.themeName || ''}.ttrTheme/`;
  const holdMs = async (dir) => { // theme.cfg may override the hold threshold
    if (!zip.has(dir + 'theme.cfg')) return DEFAULT_HOLD_MIN_MS;
    const m = /game\.tapAndHoldThresholdDuration\s*=\s*([0-9.]+)/.exec(decoder.decode(await zip.read(dir + 'theme.cfg')));
    return m ? Math.round(parseFloat(m[1]) * 1000) : DEFAULT_HOLD_MIN_MS;
  };
  for (const [i, id] of ids.entries()) {
    const base = `${app}Tracks/${id}.track/`;
    onProgress(`Reading track ${i + 1} of ${ids.length}…`);
    const info = readInfo(await zip.read(base + 'info.plist'));
    const charts = unarchive(await zip.read(base + 'taptrack.ttr2_track'));
    const levels = {}, lanes = {};
    for (const [lvl, c] of Object.entries(charts)) {
      const cols = Number(info.columnCountPerLevel?.[lvl] ?? DEFAULT_COLUMNS);
      levels[lvl] = midiToNotes(c.rawData, cols, await holdMs(themeDir(info, lvl)));
      lanes[lvl] = Math.max(3, cols);
    }
    const bgName = themeDir(info) + 'background.jpg';
    songs.push({
      meta: {
        id, title: info.kTTRDownloadableItemTitleKey || id, artist: info.kTTRDownloadableItemSubtitleKey || '',
        durationMs: Math.round((info.audioFileDuration || 0) * 1000), lanes, levels,
      },
      audio: await zip.read(base + 'audio.m4a'),
      artwork: zip.has(base + 'artwork.png') ? safeImage(await zip.read(base + 'artwork.png')) : null,
      background: zip.has(bgName) ? await zip.read(bgName) : null,
    });
  }
  const bg = app + 'Themes/TTRDJ.ttrTheme/background.jpg';
  return { songs, background: zip.has(bg) ? await zip.read(bg) : null };
}
