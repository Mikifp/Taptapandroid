// IndexedDB storage for imported songs (stays on this device).
const DB = 'taptap', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('songs', { keyPath: 'id' });
      db.createObjectStore('blobs');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function saveImport({ songs, background }) {
  const db = await open();
  const tx = db.transaction(['songs', 'blobs'], 'readwrite');
  for (const s of songs) {
    tx.objectStore('songs').put(s.meta);
    tx.objectStore('blobs').put(new Blob([s.audio], { type: 'audio/mp4' }), s.meta.id + ':audio');
    if (s.artwork) tx.objectStore('blobs').put(new Blob([s.artwork], { type: 'image/png' }), s.meta.id + ':art');
    if (s.background) tx.objectStore('blobs').put(new Blob([s.background], { type: 'image/jpeg' }), s.meta.id + ':bg');
  }
  if (background) tx.objectStore('blobs').put(new Blob([background], { type: 'image/jpeg' }), 'background');
  await done(tx);
  db.close();
}

export async function listSongs() {
  const db = await open();
  const songs = await wrap(db.transaction('songs').objectStore('songs').getAll());
  db.close();
  return songs;
}

export async function getBlob(key) {
  const db = await open();
  const b = await wrap(db.transaction('blobs').objectStore('blobs').get(key));
  db.close();
  return b || null;
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction(['songs', 'blobs'], 'readwrite');
  tx.objectStore('songs').clear(); tx.objectStore('blobs').clear();
  await done(tx);
  db.close();
}
