const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const HTML = path.join(__dirname, "test-page.html");

http
  .createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(HTML));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(PORT, () => {
    console.log(`Test page: http://localhost:${PORT}`);
  });
