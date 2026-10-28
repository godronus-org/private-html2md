import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  defineTestSuite,
  runAndExit,
  runFlow,
  mockOrigins,
  assertFinalStatus,
  assertFinalHeader,
} from '@gcoredev/fastedge-test/test';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://origin.example.com';
const PAGE =
  '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
  '<body><h1>Title</h1><p>Hello <b>world</b></p></body></html>';

// Runs one request against a mocked origin and returns the flow result.
async function flow(runner, { accept, origin = {}, requestHeaders = {} }) {
  const mocks = mockOrigins();
  try {
    mocks
      .origin(ORIGIN)
      .intercept({ path: '/page' })
      .reply(origin.status ?? 200, origin.body ?? PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', ...origin.headers },
      });
    return await runFlow(runner, {
      url: `${ORIGIN}/page`,
      requestHeaders: { ...(accept ? { accept } : {}), ...requestHeaders },
    });
  } finally {
    await mocks.close();
  }
}

function header(result, name) {
  const value = result.finalResponse.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await runAndExit(defineTestSuite({
  wasmPath: resolve(here, '../target/wasm32-wasip1/release/html2md.wasm'),
  tests: [
    {
      name: 'converts HTML to Markdown when Accept is text/markdown',
      async run(runner) {
        const result = await flow(runner, { accept: 'text/markdown' });
        assertFinalStatus(result, 200);
        assertFinalHeader(result, 'content-type', 'text/markdown; charset=utf-8');
        const body = result.finalResponse.body;
        assert(body.includes('# Title'), `expected a Markdown heading, got: ${body}`);
        assert(body.includes('**world**'), `expected bold Markdown, got: ${body}`);
        assert(!body.includes('alert') && !body.includes('color:red'),
          `script/style must be dropped, got: ${body}`);
      },
    },
    {
      name: 'passes HTML through unchanged without Accept: text/markdown',
      async run(runner) {
        const result = await flow(runner, { accept: 'text/html' });
        assertFinalStatus(result, 200);
        assert(header(result, 'content-type').startsWith('text/html'), 'content-type must stay text/html');
        assert(result.finalResponse.body.includes('<h1>Title</h1>'), 'body must be the original HTML');
      },
    },
    {
      name: 'does not convert when markdown is explicitly refused (q=0)',
      async run(runner) {
        const result = await flow(runner, { accept: 'text/markdown;q=0, text/html' });
        assert(header(result, 'content-type').startsWith('text/html'), 'q=0 must not convert');
      },
    },
    {
      name: 'does not convert non-HTML responses',
      async run(runner) {
        const result = await flow(runner, {
          accept: 'text/markdown',
          origin: { body: '{"a":1}', headers: { 'content-type': 'application/json' } },
        });
        assert(header(result, 'content-type').startsWith('application/json'), 'JSON must pass through');
        assert(result.finalResponse.body === '{"a":1}', 'JSON body must be unchanged');
      },
    },
    {
      name: 'adds Convert to Vary, merging with the origin Vary',
      async run(runner) {
        const plain = await flow(runner, { accept: 'text/html' });
        assert(/\bconvert\b/i.test(header(plain, 'vary')), `expected Vary: Convert, got "${header(plain, 'vary')}"`);
        const merged = await flow(runner, { accept: 'text/html', origin: { headers: { vary: 'Accept-Encoding' } } });
        const vary = header(merged, 'vary');
        assert(/convert/i.test(vary) && /accept-encoding/i.test(vary), `expected merged Vary, got "${vary}"`);
      },
    },
    {
      name: 'a client-supplied Convert header cannot force conversion',
      async run(runner) {
        const result = await flow(runner, { accept: 'text/html', requestHeaders: { convert: 'markdown' } });
        assert(header(result, 'content-type').startsWith('text/html'), 'spoofed Convert must not trigger conversion');
        assert(result.finalResponse.body.includes('<h1>Title</h1>'), 'body must be the original HTML');
      },
    },
  ],
}));
