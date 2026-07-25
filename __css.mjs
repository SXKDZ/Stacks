// Read the COMPILED css the dev server serves, so we compare what actually renders
// rather than racing the file watcher.
const html = await (await fetch("http://127.0.0.1:3000/")).text();
const hrefs = [...html.matchAll(/href="(\/_next\/static\/[^"]+\.css[^"]*)"/g)].map(m=>m[1]);
let all = "";
for (const h of hrefs) all += await (await fetch("http://127.0.0.1:3000"+h)).text();
process.stdout.write(all);
