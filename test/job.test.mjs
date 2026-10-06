import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeJob, decodeJob, safeSegment } from '../src/js/core/job.js';

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

test('a 2d job round-trips layers inside a zip', async () => {
  const bytes = encodeJob({
    id: 'pic-ab12', name: 'Pic', width: 8, height: 4, active: 1, savepoint: 't1',
    layers: [
      { id: 1, name: 'Background', visible: true, opacity: 1, blend: 'source-over', png },
      { id: 2, name: 'Paint', visible: false, opacity: 0.5, blend: 'multiply', png },
    ],
  });
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const job = await decodeJob(bytes);
  assert.equal(job.format, '2dlayered');
  assert.equal(job.layers.length, 2);
  assert.equal(job.layers[1].name, 'Paint');
  assert.equal(job.layers[1].blend, 'multiply');
  assert.equal(job.layers[1].visible, false);
  assert.deepEqual(job.layers[0].png, png);
  assert.equal(job.mesh, null);
  assert.equal(job.agentLog, '');
});

test('a job keeps the agent transcript as agent.txt', async () => {
  const bytes = encodeJob({
    id: 'pic-ab12', name: 'Pic', width: 2, height: 2, active: 0, savepoint: 't',
    layers: [{ id: 1, name: 'Background', png }],
    agentLog: 'Stratum agent debug\nstop: length\n{"cmd":"apply"}\n',
  });
  const job = await decodeJob(bytes);
  assert.match(job.agentLog, /stop: length/);
  assert.match(job.agentLog, /"cmd":"apply"/);
});

test('a 3d job keeps the mesh buffers', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bytes = encodeJob({
    kind: '3dlayered', id: 'mine-1', name: 'Mine', width: 32, height: 32, active: 0, savepoint: 't2',
    layers: [{ id: 3, name: 'Background', png }],
    mesh: { positions, indices, uvs, groups: [{ name: 'body', start: 0, count: 1 }], charts: 1, showWires: true },
  });
  const job = await decodeJob(bytes);
  assert.equal(job.format, '3dlayered');
  assert.deepEqual(job.mesh.positions, positions);
  assert.deepEqual(job.mesh.indices, indices);
  assert.deepEqual(job.mesh.uvs, uvs);
  assert.equal(job.mesh.groups[0].name, 'body');
});

test('path segments cannot escape the internal folder', () => {
  assert.equal(safeSegment('../etc/passwd'), 'etc-passwd');
  assert.equal(safeSegment('...'), 'job');
  assert.equal(safeSegment('Demo mine'), 'Demo-mine');
});
