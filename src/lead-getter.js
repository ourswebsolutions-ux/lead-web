'use strict';

// /lead-getter/* belongs to the Lead Getter licence server (the
// lead-getter repository's server/, port 8787 by default), not to this site.
// The desktop app calls it there: GET /lead-getter/api/plans, device-signed
// GET /lead-getter/api/license, POST /lead-getter/api/trial/consume and
// /lead-getter/api/applications, plus the Approve/Cancel email pages.
//
// Normally nginx routes /lead-getter/ straight to the licence server. When it
// doesn't, the request reaches this app, which used to answer with its admin
// login (401). This forwards those requests, unchanged, to the licence server
// instead. They need no admin credentials here: the licence server
// authenticates every device request with the device's own signature and
// applies its own limits. Admin credentials are never forwarded.

const http = require('node:http');
const https = require('node:https');

// Not passed on: browser-held credentials for this site, and hop-by-hop headers.
const DROP_REQUEST = ['authorization', 'proxy-authorization', 'cookie', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer'];
const DROP_RESPONSE = ['connection', 'keep-alive', 'set-cookie'];

function createLeadGetterProxy({ upstream, timeoutMs = 120_000, logger = console }) {
  const target = new URL(upstream);
  const client = target.protocol === 'https:' ? https : http;

  return function leadGetter(req, res) {
    const headers = { ...req.headers };
    for (const h of DROP_REQUEST) delete headers[h];
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';

    // The full original path (/lead-getter/...): the licence server removes
    // the prefix itself, exactly as with the nginx location.
    const up = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), method: req.method, path: req.originalUrl, headers, timeout: timeoutMs },
      (upRes) => {
        const out = { ...upRes.headers };
        for (const h of DROP_RESPONSE) delete out[h];
        res.writeHead(upRes.statusCode, out);
        upRes.pipe(res);
      },
    );
    up.on('timeout', () => up.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      logger.error(`[lead-getter] licence server at ${target.origin} unavailable: ${err.code || err.message}`);
      res.status(502).set('Cache-Control', 'no-store').json({ error: { code: 'licence_server_unavailable', message: 'The Lead Getter licence server is not running. Please try again later.' } });
    });
    req.pipe(up);
  };
}

module.exports = { createLeadGetterProxy };
