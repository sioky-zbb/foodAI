/* FoodLens 本地服务器：在同一 Wi-Fi 下用手机访问，用于本地测试。
   用法：node server.js  （默认端口 4173，可用 PORT 环境变量修改） */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log('FoodLens 本地服务器已启动：');
  console.log(`  本机访问: http://localhost:${port}`);
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    interfaces[name].forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) {
        console.log(`  手机访问（同一 Wi-Fi）: http://${info.address}:${port}`);
      }
    });
  });
  console.log('在 iPhone Safari 中打开上面的地址即可使用；如需安装到主屏幕请使用 HTTPS 部署。');
});
