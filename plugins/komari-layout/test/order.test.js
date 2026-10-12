const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
function setup(files = new Map()) {
  const routes = new Map();
  const nodes = [{ uuid: 'a', weight: 0 }, { uuid: 'b', weight: 1 }, { uuid: 'c', weight: 2 }, { uuid: 'hidden', weight: 3, hidden: true }];
  const runtime = vm.createContext({ __storageDir__: '/data', require(name) {
    return { path, fs: { existsSync: p => files.has(p), readFileSync: p => files.get(p), writeFileSync: (p, data) => files.set(p, data), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); } }, server: { call: async () => nodes, route: (method, p, fn) => routes.set(method, fn) } }[name];
  }});
  vm.runInContext(source, runtime);runtime.load();
  return { files, nodes, async request(body, admin = true) {
    let output;
    const res = { statusCode: 200, setHeader() {}, end(data) { output = { code: this.statusCode, body: JSON.parse(data) }; } };
    await routes.get(body ? 'POST' : 'GET')({ body: JSON.stringify(body), context: admin ? { principal: { roles: ['admin'] } } : {} }, res);
    return output;
  }};
}
test('anonymous readers see shared order but cannot write or see hidden nodes', async () => {
  const p = setup();
  assert.deepEqual((await p.request(null, false)).body.grid, ['a','b','c']);
  assert.equal((await p.request({ revision: 0, kind: 'grid', value: ['b','a'] }, false)).code, 403);
  assert.equal(p.files.size, 0);
});
test('filtered reorder preserves unseen slots and is shared with another runtime', async () => {
  const p = setup();
  assert.equal((await p.request({ revision: 0, kind: 'grid', value: ['c','a'] })).code, 200);
  assert.deepEqual((await setup(p.files).request()).body.grid, ['c','b','a','hidden']);
});
test('table order survives follow-mode toggles and grid changes', async () => {
  const p = setup();
  assert.equal((await p.request({ revision: 0, kind: 'table', value: ['b','a'] })).code, 409);
  await p.request({ revision: 0, kind: 'follow', value: false });
  await p.request({ revision: 1, kind: 'table', value: ['b','c','a'] });
  await p.request({ revision: 2, kind: 'follow', value: true });
  await p.request({ revision: 3, kind: 'grid', value: ['c','b','a'] });
  await p.request({ revision: 4, kind: 'follow', value: false });
  const state = (await p.request()).body;
  assert.deepEqual(state.table, ['b','c','a','hidden']);assert.deepEqual(state.grid, ['c','b','a','hidden']);
});
test('stale writers and invalid identifiers cannot overwrite saved order', async () => {
  const p = setup();
  await p.request({ revision: 0, kind: 'grid', value: ['b','a'] });
  assert.equal((await p.request({ revision: 0, kind: 'grid', value: ['a','b'] })).code, 409);
  for (const value of [['a','a'], ['unknown'], [], 'a']) assert.equal((await p.request({ revision: 1, kind: 'grid', value })).code, 400);
  assert.deepEqual((await p.request()).body.grid, ['b','a','c','hidden']);
});
test('new nodes append and removed nodes disappear without erasing other orders', async () => {
  const p = setup();await p.request({ revision: 0, kind: 'grid', value: ['b','a'] });
  p.nodes.push({ uuid: 'new', weight: 4 });p.nodes.splice(2, 1);
  assert.deepEqual((await p.request()).body.grid, ['b','a','hidden','new']);
});
test('corrupt storage is not silently replaced', async () => {
  const p = setup(new Map([['/data/layout.json', 'broken']]));
  await assert.rejects(p.request({ revision: 0, kind: 'grid', value: ['b','a'] }));
  assert.equal(p.files.get('/data/layout.json'), 'broken');
});
