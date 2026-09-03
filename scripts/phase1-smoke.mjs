import { Connection, WorkflowClient } from '@temporalio/client';

const endpoints = [
  ['miniapp-live', 'http://localhost:3000/api/health/live'],
  ['miniapp-ready', 'http://localhost:3000/api/health/ready'],
  ['admin-live', 'http://localhost:3001/api/health/live'],
  ['admin-ready', 'http://localhost:3001/api/health/ready'],
  ['api-live', 'http://localhost:3002/health/live'],
  ['api-ready', 'http://localhost:3002/health/ready'],
  ['bot-live', 'http://localhost:3003/health/live'],
  ['bot-ready', 'http://localhost:3003/health/ready'],
  ['worker-live', 'http://localhost:3004/health/live'],
  ['worker-ready', 'http://localhost:3004/health/ready'],
  ['signer-live', 'http://localhost:3005/health/live'],
  ['signer-ready', 'http://localhost:3005/health/ready'],
];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHealth(name, url) {
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && body.status === 'ok') {
        console.log(`${name}: ok`);
        return body;
      }
      lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(`${name} did not become healthy`, { cause: lastError });
}

const results = new Map();
for (const [name, url] of endpoints) results.set(name, await waitForHealth(name, url));

const apiReadiness = results.get('api-ready');
const componentNames = new Set(
  apiReadiness.components?.filter((item) => item.state === 'ok').map((item) => item.name),
);
for (const required of ['postgresql', 'redis', 'temporal']) {
  if (!componentNames.has(required)) throw new Error(`API readiness did not verify ${required}`);
}

const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'alex-rewards-foundation';
const connection = await Connection.connect({ address });
try {
  const client = new WorkflowClient({ connection, namespace });
  const result = await client.execute('foundationProbe', {
    taskQueue,
    workflowId: `phase1-smoke-${crypto.randomUUID()}`,
    args: ['smoke'],
    workflowExecutionTimeout: '30 seconds',
  });
  if (result !== 'foundation-ok:smoke')
    throw new Error(`Unexpected Temporal result: ${String(result)}`);
  console.log('temporal-foundation-workflow: ok');
} finally {
  connection.close();
}

console.log('Phase 1 smoke test passed.');
