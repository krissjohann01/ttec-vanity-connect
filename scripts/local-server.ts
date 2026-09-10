import './local-env';
import dynaliteFactory from 'dynalite';
import * as http from 'http';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { handler as vanityLookupHandler, ConnectLambdaEvent } from '../lambda/vanity-lookup/index';
import { handler as callersApiHandler, FunctionUrlEvent } from '../lambda/callers-api/index';

/**
 * A local testing tool -- this is NOT part of what actually gets deployed.
 * It runs the real Lambda code, unchanged, against dynalite (a small tool
 * that copies DynamoDB's behavior in plain JavaScript), so you can test the
 * whole call -> Lambda -> database -> bonus API path with no AWS account,
 * Docker, or Java needed. See README.md, "Try it locally first".
 *
 * What this can't test: Amazon Connect itself (the actual phone number and
 * call flow). There's no local version of Connect to test against -- that
 * part only gets checked once you actually deploy. This tool sends the
 * Lambda the same kind of data Connect would send it, so everything except
 * "does a real phone call actually reach it" gets tested here.
 */
const DYNALITE_PORT = 8000;
const SERVER_PORT = 4000;

// A small, no-frills test page, served at GET / -- this is NOT the bonus
// web app (that's web/index.html, which can point at either the real
// deployed API or this local one). This page just exists so you can try
// the local server out in a browser instead of using curl.
const DEBUG_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Local dev server</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  input { padding: 0.4rem; width: 220px; }
  button { padding: 0.4rem 0.8rem; margin-left: 0.5rem; }
  pre { background: #111; color: #eee; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  section { margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Vanity Connect -- local test server</h1>
<p>This page is just for local testing (served by <code>scripts/local-server.ts</code>) -- it's not the actual bonus web app, that's <code>web/index.html</code>. Use this page to try out the real Lambda code without needing curl.</p>

<section>
  <h2>Simulate an inbound call</h2>
  <input id="phone" placeholder="+15122255669" value="+15122255669" />
  <button id="callBtn">Simulate call</button>
  <pre id="callResult">(results appear here)</pre>
</section>

<section>
  <h2>Last 5 callers</h2>
  <button id="callersBtn">Refresh</button>
  <pre id="callersResult">(results appear here)</pre>
</section>

<script>
document.getElementById('callBtn').addEventListener('click', async () => {
  const phoneNumber = document.getElementById('phone').value;
  const out = document.getElementById('callResult');
  out.textContent = 'Loading...';
  try {
    const res = await fetch('/simulate-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    });
    out.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
});

document.getElementById('callersBtn').addEventListener('click', async () => {
  const out = document.getElementById('callersResult');
  out.textContent = 'Loading...';
  try {
    const res = await fetch('/callers');
    out.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
});

document.getElementById('callersBtn').click();
</script>
</body>
</html>`;

async function main(): Promise<void> {
  const dynaliteServer = dynaliteFactory({ createTableMs: 0 });
  await new Promise<void>((resolve, reject) => {
    dynaliteServer.listen(DYNALITE_PORT, (err: Error | undefined) => (err ? reject(err) : resolve()));
  });
  console.log(`dynalite (local DynamoDB emulator) listening on :${DYNALITE_PORT}`);

  const ddb = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
  await ddb.send(
    new CreateTableCommand({
      TableName: process.env.TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  console.log(`Created local table "${process.env.TABLE_NAME}"`);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.listen(SERVER_PORT, () => {
    console.log(`\nLocal dev server ready: http://localhost:${SERVER_PORT}`);
    console.log(`  Open in a browser: http://localhost:${SERVER_PORT}  (simple click-to-test debug page)`);
    console.log(
      `  Simulate a call:  curl -X POST http://localhost:${SERVER_PORT}/simulate-call -H "Content-Type: application/json" -d '{"phoneNumber":"+15122255669"}'`,
    );
    console.log(`  Last 5 callers:   curl http://localhost:${SERVER_PORT}/callers`);
    console.log(
      `  Web app:           cp web/config.example.js web/config.js, set window.API_URL = "http://localhost:${SERVER_PORT}/callers", then open web/index.html\n`,
    );
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DEBUG_PAGE_HTML);
      return;
    }

    if (req.method === 'POST' && req.url === '/simulate-call') {
      const body = await readJsonBody(req);
      if (!body.phoneNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'phoneNumber is required, e.g. {"phoneNumber":"+15122255669"}' }));
        return;
      }
      // Copies the same data shape Connect would send from its "Invoke AWS
      // Lambda function" step -- see ConnectLambdaEvent in lambda/vanity-lookup/index.ts.
      const event: ConnectLambdaEvent = {
        Details: {
          ContactData: {
            ContactId: `local-${Date.now()}`,
            CustomerEndpoint: { Address: body.phoneNumber, Type: 'TELEPHONE_NUMBER' },
          },
        },
      };
      const result = await vanityLookupHandler(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (req.method === 'GET' && req.url === '/callers') {
      const event: FunctionUrlEvent = { requestContext: { http: { method: 'GET' } } };
      const result = await callersApiHandler(event);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', routes: ['POST /simulate-call', 'GET /callers'] }));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<{ phoneNumber?: string }> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

main().catch((err) => {
  console.error('Failed to start local dev server', err);
  process.exit(1);
});
