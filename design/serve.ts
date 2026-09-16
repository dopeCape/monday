// Static design server. Run: bun design/serve.ts  (http://localhost:6969)
const root = new URL("./", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 6969);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(root + path);
    if (await file.exists()) return new Response(file);
    return new Response("Not found: " + path, { status: 404 });
  },
});
console.log(`monday design server → http://localhost:${port}`);
