import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(import.meta.dirname, '../web');
const port = Number(process.env.IFW_PORT || 5173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.ifwprog': 'application/xml',
};
http
  .createServer(async (req, res) => {
    try {
      const path = resolve(
        root,
        '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
      );
      if (path !== root && !path.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const target = (await stat(path)).isDirectory() ? resolve(path, 'index.html') : path;
      const body = await readFile(target);
      const headers = {
        'Content-Type': types[extname(target)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      };
      let start = 0,
        end = body.length - 1,
        status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (range && (range[1] || range[2])) {
          if (range[1]) {
            start = Number(range[1]);
            end = range[2] ? Math.min(end, Number(range[2])) : end;
          } else start = Math.max(0, body.length - Number(range[2]));
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= body.length
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
            return;
          }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
          headers['Content-Length'] = end - start + 1;
        }
      }
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`OpenIFW · Local: http://127.0.0.1:${port}`));
