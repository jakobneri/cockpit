import express from 'express';
const app = express();

try {
  app.all('/rpc/:path*', (req, res) => res.send('ok'));
  console.log("app.all('/rpc/:path*') SUCCEEDED")
} catch (e) {
  console.log("app.all('/rpc/:path*') FAILED:", e.message);
}

try {
  app.use('/rpc', (req, res) => res.send('ok'));
  console.log("app.use('/rpc') SUCCEEDED")
} catch (e) {
  console.log("app.use('/rpc') FAILED:", e.message);
}

try {
  app.all('/rpc/(.*)', (req, res) => res.send('ok'));
  console.log("app.all('/rpc/(.*)') SUCCEEDED")
} catch (e) {
  console.log("app.all('/rpc/(.*)') FAILED:", e.message);
}
