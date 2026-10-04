// Static frontend inspection only. The browser tests explicitly stub /api/me.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("web/dist");
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".html": "text/html",
};
createServer(async (req, res) => {
  const path = req.url.startsWith("/assets/")
    ? resolve(root, `.${req.url}`)
    : resolve(root, "index.html");
  if (!path.startsWith(root)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader(
      "Content-Type",
      types[extname(path)] || "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(8081, "127.0.0.1");
