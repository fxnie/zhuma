import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseWorkflowTemplate, previewResourcePackage } from '@zhuma/agent-core';
import { importArchiveReader } from '../dist/asset-import.js';
import { legacyRouteEffects } from '../dist/legacy-route-effects.js';
import { applyIdentity } from '../dist/identity-session.js';
import {
  configureDeploymentMode,
  deploymentMode,
  LEGACY_OWNER_ROUTES,
  memberCredential,
} from '../dist/member-session.js';
import { apply } from '../dist/workbench-plugin.js';
import {
  importCommand as packageCommand,
  packageFixture,
  packageZip,
} from '../../../tests/fixtures/asset-package.mjs';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const seen = { preview: 0, read: 0, parse: 0 };
const real = {
  preview: legacyRouteEffects.previewAssetImport,
  read: importArchiveReader.read,
  parse: legacyRouteEffects.previewResourcePackage,
};
legacyRouteEffects.previewAssetImport = async (...args) => {
  seen.preview += 1;
  return real.preview(...args);
};
importArchiveReader.read = async (...args) => {
  seen.read += 1;
  return real.read(...args);
};
legacyRouteEffects.previewResourcePackage = (...args) => {
  seen.parse += 1;
  return real.parse(...args);
};

function resetSeen() {
  seen.preview = 0;
  seen.read = 0;
  seen.parse = 0;
}

const SECRET = Buffer.from('GLOBAL_DIRECTORY_BYTES').toString('base64');
const SECRET_VERSION = '11111111-1111-4111-8111-111111111111';

async function mount(mode = 'legacy-single-user') {
  resetSeen();
  const routes = new Map();
  const audits = new Map();
  const effects = [];
  const opened = [];
  const packages = new Map();
  const touches = { read: 0, write: 0 };
  const grants = new Map();
  const pause = { open: null, close: null };
  let identityDomain;
  let state = fixture().state;
  packages.set(SECRET_VERSION, {
    versionId: SECRET_VERSION,
    digest: 'a'.repeat(64),
    files: [{ path: 'secret/global.md', data: SECRET }],
  });
  const ctx = {
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
    },
    credentials: {
      async modifyRecord(key, mutate) {
        const next = await mutate(grants.get(key));
        if (next !== undefined) grants.set(key, next);
        return grants.get(key);
      },
    },
    webServer: {
      register() {
        return () => {};
      },
    },
    remoteAccess: {
      registerPolicy() {
        return () => {};
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
        },
      },
      requestRejection() {
        return undefined;
      },
      admit() {
        return { peer: { principal: { kind: 'owner' } } };
      },
    },
    storageDomain: {
      async open(spec) {
        opened.push(spec.name);
        if (spec.name === 'zhuma_identity') {
          const domain = memoryDomain(structuredClone(spec.global.initial));
          identityDomain = domain;
          const holdOpen = pause.open;
          pause.open = null;
          if (holdOpen) {
            holdOpen.started();
            await holdOpen.gate;
          }
          const finish = domain.close;
          domain.close = async () => {
            const holdClose = pause.close;
            pause.close = null;
            if (holdClose) {
              holdClose.started();
              await holdClose.gate;
            }
            await finish();
          };
          return domain;
        }
        if (spec.name === 'zhuma_asset_packages') {
          assert.equal(spec.layout, 'per-record');
          assert.equal(spec.version, 1);
          return {
            close() {},
            table: (name) => {
              assert.equal(name, 'versions');
              return {
                get: (id) => {
                  touches.read += 1;
                  return packages.get(id);
                },
                put: async (id, value) => {
                  touches.write += 1;
                  packages.set(id, value);
                },
              };
            },
          };
        }
        assert.equal(spec.name, 'zhuma_workbench');
        return {
          close() {},
          global: {
            get: () => state,
            set: async (value) => {
              state = value;
            },
          },
          table: () => ({
            get: (id) => audits.get(id),
            put: async (id, value) => {
              audits.set(id, value);
            },
            keys: () => audits.keys(),
            delete: (id) => audits.delete(id),
          }),
        };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    },
    llm: {
      prepareCall: async () => {
        throw new Error('secret-provider-value');
      },
    },
  };
  if (mode !== null) configureDeploymentMode(ctx, mode);
  await apply(ctx);
  async function request(endpoint, payload, method = `zhuma/${endpoint}`, cookie) {
    const headers = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return routes.get(`/api/zhuma/${endpoint}`).fetch(
      new Request(`http://localhost/api/zhuma/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
      }),
    );
  }
  return {
    ctx,
    routes,
    request,
    effects,
    opened,
    packages,
    touches,
    pause,
    grants,
    identityDomain: () => identityDomain,
    revision: () => state.revision,
  };
}

function memoryDomain(initial) {
  const tables = new Map();
  let global = initial;
  return {
    async close() {},
    global: {
      get: () => global,
      set: async (value) => {
        global = value;
      },
    },
    table(name) {
      let rows = tables.get(name);
      if (rows === undefined) {
        rows = new Map();
        tables.set(name, rows);
      }
      return {
        get: (id) => rows.get(id),
        put: async (id, value) => {
          rows.set(id, value);
        },
        delete: async (id) => {
          rows.delete(id);
        },
        keys: () => rows.keys(),
        entries: () => rows.entries(),
        get size() {
          return rows.size;
        },
      };
    },
  };
}

function createHold() {
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return { ready, gate, started, release: () => release() };
}

const VERIFIER = `scrypt$16384$8$1$${'ab'.repeat(16)}$${'cd'.repeat(32)}`;

function memberImport() {
  return { accounts: [{ id: 'lin', passwordHash: VERIFIER }] };
}

async function startIdentity(mounted, imported = memberImport()) {
  const before = mounted.effects.length;
  await applyIdentity(mounted.ctx, imported);
  return async () => {
    for (const dispose of mounted.effects.slice(before)) await dispose();
  };
}

async function memberCookie(mounted) {
  const record = mounted.grants.get('zhuma-identity/member-session');
  const secret = Buffer.from(record.payload.secret, 'base64url');
  const sessionId = randomUUID();
  const expiresAt = Date.now() + 60_000;
  await mounted.identityDomain().table('sessions').put(sessionId, {
    id: sessionId,
    accountId: 'lin',
    expiresAt,
  });
  return `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`;
}

function importPayload() {
  const source = packageFixture();
  return packageCommand(previewResourcePackage(source, parseWorkflowTemplate), source);
}

function assertUntouched(touches, revision) {
  assert.equal(seen.preview, 0);
  assert.equal(seen.read, 0);
  assert.equal(seen.parse, 0);
  assert.equal(touches.read, 0);
  assert.equal(touches.write, 0);
  assert.equal(revision(), 0);
}

async function assertDenied(mounted, status, code, cookie) {
  const zip = packageZip(packageFixture().slice(0, 2));
  const command = importPayload();
  assert.equal(command.type, 'import-package');
  const payloads = {
    snapshot: {},
    command,
    plan: { requestId: randomUUID(), expectedRevision: 0, taskId: 'task', instruction: '' },
    'preview-import': { kind: 'zip', data: zip },
    'resource-files': { kind: 'expert', id: 'imported-1', versionId: SECRET_VERSION },
  };
  for (const endpoint of LEGACY_OWNER_ROUTES) {
    const refused = await mounted.request(
      endpoint,
      payloads[endpoint],
      `zhuma/${endpoint}`,
      cookie,
    );
    assert.equal(refused.status, status, endpoint);
    assert.equal(refused.headers.get('cache-control'), 'no-store', endpoint);
    const body = await refused.json();
    assert.deepEqual(body, { ok: false, error: { code } });
    assert.equal(Object.hasOwn(body, 'files'), false, endpoint);
    assert.equal(JSON.stringify(body).includes(SECRET), false, endpoint);
    assert.equal(JSON.stringify(body).includes('GLOBAL_DIRECTORY_BYTES'), false, endpoint);
    assert.equal(JSON.stringify(body).includes('tasks'), false, endpoint);
    assert.equal(seen.preview, 0, endpoint);
    assert.equal(seen.read, 0, endpoint);
    assert.equal(seen.parse, 0, endpoint);
    assert.equal(mounted.touches.read, 0, endpoint);
    assert.equal(mounted.touches.write, 0, endpoint);
  }
  const malformed = await mounted.routes.get('/api/zhuma/preview-import').fetch(
    new Request('http://localhost/api/zhuma/preview-import', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie !== undefined ? { cookie } : {}),
      },
      body: '{',
    }),
  );
  assert.equal(malformed.status, status);
  assert.deepEqual(await malformed.json(), { ok: false, error: { code } });
  assertUntouched(mounted.touches, mounted.revision);
}

test('Host route contract: exact authenticated carrier contribution, protocol identity and error redaction', async () => {
  const { routes, request, effects, opened, touches } = await mount();
  assert.deepEqual(opened, ['zhuma_workbench', 'zhuma_asset_packages']);
  assert.equal(routes.has('/api/zhuma/versions'), false);
  assert.deepEqual(
    [...routes.keys()],
    LEGACY_OWNER_ROUTES.map((endpoint) => `/api/zhuma/${endpoint}`),
  );
  assert.equal((await request('snapshot', {}, 'zhuma/command')).status, 400);
  const response = await (await request('snapshot', {})).json();
  assert.equal(response.type, 'server-response');
  assert.equal(response.rpcId, 'test');
  assert.equal(response.result.value.state.tasks.length, 1);
  const failed = await (
    await request('plan', {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      taskId: 'task',
      instruction: '',
    })
  ).json();
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.error.code, 'unavailable');
  assert.ok(!JSON.stringify(failed).includes('secret-provider-value'));
  assert.equal(touches.read, 0);
  assert.equal(touches.write, 0);
  for (const dispose of effects) await dispose();
  const stopped = await (await request('snapshot', {})).json();
  assert.equal(stopped.result.error.code, 'cancelled');
});

test('Host import route contract: preview is read-only; source queries return just the selected definition files', async () => {
  const { request, effects, packages, touches } = await mount();
  const source = packageFixture();
  const preview = await (await request('preview-import', { kind: 'files', files: source })).json();
  assert.equal(preview.result.ok, true);
  assert.equal(preview.result.value.items.length, 2);
  assert.equal(seen.preview, 1);
  assert.equal(seen.read, 0);
  assert.equal(touches.write, 0);
  const before = await (await request('snapshot', {})).json();
  assert.equal(before.result.value.state.revision, 0);
  const command = packageCommand(previewResourcePackage(source, parseWorkflowTemplate), source);
  const imported = await (
    await request('command', { requestId: crypto.randomUUID(), expectedRevision: 0, command })
  ).json();
  assert.equal(imported.result.ok, true);
  assert.equal(seen.parse, 1);
  assert.equal(touches.write, 1);
  const stored = packages.get(command.input.versionId);
  stored.files.push({ path: 'secret/global.md', data: SECRET });
  const expert = await (
    await request('resource-files', { kind: 'expert', id: 'imported-1' })
  ).json();
  assert.equal(expert.result.value.files.length, 3);
  assert.equal(
    expert.result.value.files.some(
      (file) =>
        file.path.includes('skills/') ||
        file.path.endsWith('USER.md') ||
        file.path === 'secret/global.md',
    ),
    false,
  );
  assert.equal(JSON.stringify(expert).includes('GLOBAL_DIRECTORY_BYTES'), false);
  assert.equal(expert.result.value.versionId, command.input.versionId);
  const directory = await (await request('resource-files', { versionId: SECRET_VERSION })).json();
  assert.equal(directory.result.ok, false);
  assert.equal(directory.result.error.code, 'validation');
  const missing = await (
    await request('resource-files', { kind: 'expert', id: 'not-an-expert' })
  ).json();
  assert.equal(missing.result.error.code, 'not-found');
  for (const dispose of effects) await dispose();
});

test('legacy-single-user previews a zip without writing the package', async () => {
  const { request, touches } = await mount();
  const preview = await (
    await request('preview-import', { kind: 'zip', data: packageZip(packageFixture()) })
  ).json();
  assert.equal(preview.result.ok, true);
  assert.equal(seen.preview, 1);
  assert.equal(seen.read, 1);
  assert.equal(seen.parse, 0);
  assert.equal(touches.read, 0);
  assert.equal(touches.write, 0);
});

test('an unset deployment mode denies asset routes before parse, read, or persist', async () => {
  const mounted = await mount(null);
  assert.equal(deploymentMode(mounted.ctx), undefined);
  await assertDenied(mounted, 401, 'deployment-mode-unset');
  await assertDenied(mounted, 401, 'deployment-mode-unset', 'dsh-browser=owner');
  await assertDenied(mounted, 401, 'deployment-mode-unset', 'zhuma-member=not-a-cookie');
});

test('multi-member denies every owner route when identity is not ready', async () => {
  const mounted = await mount('multi-member');
  assert.equal(deploymentMode(mounted.ctx), 'multi-member');
  assert.equal(mounted.identityDomain(), undefined);
  await assertDenied(mounted, 404, 'not-found');
  await assertDenied(mounted, 404, 'not-found', 'dsh-browser=owner');
});

test('multi-member denies every owner route when identity failed', async () => {
  const mounted = await mount('multi-member');
  await assert.rejects(
    () => applyIdentity(mounted.ctx, { accounts: [] }),
    /identity import was rejected: accounts is empty/,
  );
  assert.equal(deploymentMode(mounted.ctx), 'multi-member');
  await assertDenied(mounted, 404, 'not-found');
  await assertDenied(mounted, 404, 'not-found', 'zhuma-member=not-a-cookie');
  await assertDenied(mounted, 404, 'not-found', 'dsh-browser=owner');
});

test('multi-member denies every owner route when the cookie is missing', async () => {
  const mounted = await mount('multi-member');
  await startIdentity(mounted);
  await assertDenied(mounted, 404, 'not-found');
});

test('multi-member denies every owner route for an invalid cookie', async () => {
  const mounted = await mount('multi-member');
  await startIdentity(mounted);
  const accepted = await memberCookie(mounted);
  await assertDenied(mounted, 404, 'not-found', 'zhuma-member=not-a-cookie');
  await assertDenied(mounted, 404, 'not-found', 'dsh-browser=owner');
  await assertDenied(mounted, 404, 'not-found', accepted);
});

test('multi-member denies every owner route while identity unmounts', async () => {
  const mounted = await mount('multi-member');
  const stop = await startIdentity(mounted);
  const hold = createHold();
  mounted.pause.close = hold;
  const stopping = stop();
  await hold.ready;
  await assertDenied(mounted, 404, 'not-found');
  await assertDenied(mounted, 404, 'not-found', 'zhuma-member=not-a-cookie');
  hold.release();
  await stopping;
  assert.equal(mounted.identityDomain().global.get().importComplete, true);
  await assertDenied(mounted, 404, 'not-found');
  await assertDenied(mounted, 404, 'not-found', 'dsh-browser=owner');
});

test('multi-member denies every owner route while identity remounts', async () => {
  const mounted = await mount('multi-member');
  const stop = await startIdentity(mounted);
  await stop();
  const hold = createHold();
  mounted.pause.open = hold;
  const remounting = startIdentity(mounted);
  await hold.ready;
  await assertDenied(mounted, 404, 'not-found');
  await assertDenied(mounted, 404, 'not-found', 'zhuma-member=not-a-cookie');
  hold.release();
  const stopAgain = await remounting;
  const accepted = await memberCookie(mounted);
  await assertDenied(mounted, 404, 'not-found', accepted);
  await assertDenied(mounted, 404, 'not-found');
  await stopAgain();
  await assertDenied(mounted, 404, 'not-found', 'dsh-browser=owner');
});
