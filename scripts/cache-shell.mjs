import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
const root = new URL("../dist/", import.meta.url).pathname;
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.name !== "sw.js" && !entry.name.endsWith(".map"))
      files.push(path);
  }
  return files;
}
const files = (await walk(root)).sort();
const hash = createHash("sha256");
for (const file of files) hash.update(await readFile(file));
const version = hash.digest("hex").slice(0, 16);
const paths = ["/", ...files.map((file) => "/" + relative(root, file))];
const worker = `
const CACHE = 'orb-shell-${version}';
const SHELL = ${JSON.stringify(paths)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('orb-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = event.request.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(path)) || fetch(event.request)));
});
`;
await writeFile(join(root, "sw.js"), worker);
console.log(
  `Offline shell: ${paths.length} bundled assets, version ${version}. No user content is cached.`,
);
