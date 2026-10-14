// Reads the tracks of a Tap Tap Revenge 3 .ipa entirely in the browser (nothing is uploaded).
import { ZipReader } from './zip.js';
import { unarchive, readInfo } from './plist.js';
import { midiToNotes } from './midi.js';

/**
 * @returns {Promise<{songs: {meta: object, audio: Uint8Array, artwork: Uint8Array|null}[], background: Uint8Array|null}>}
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
  for (const [i, id] of ids.entries()) {
    const base = `${app}Tracks/${id}.track/`;
    onProgress(`Reading track ${i + 1} of ${ids.length}…`);
    const info = readInfo(await zip.read(base + 'info.plist'));
    const charts = unarchive(await zip.read(base + 'taptrack.ttr2_track'));
    const levels = {};
    for (const [lvl, c] of Object.entries(charts)) levels[lvl] = midiToNotes(c.rawData);
    songs.push({
      meta: {
        id, title: info.kTTRDownloadableItemTitleKey || id, artist: info.kTTRDownloadableItemSubtitleKey || '',
        durationMs: Math.round((info.audioFileDuration || 0) * 1000), levels,
      },
      audio: await zip.read(base + 'audio.m4a'),
      artwork: zip.has(base + 'artwork.png') ? await zip.read(base + 'artwork.png') : null,
    });
  }
  const bg = app + 'Themes/TTRDJ.ttrTheme/background.jpg';
  return { songs, background: zip.has(bg) ? await zip.read(bg) : null };
}
