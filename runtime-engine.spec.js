const assert = require('node:assert/strict');
const test = require('node:test');

const packageJson = require('./package.json');
const packageLock = require('./package-lock.json');

function minimumMajor(engineRange) {
  const match = /^>=(\d+)$/.exec(engineRange || '');
  assert.ok(match, `Expected a simple minimum Node engine, received ${engineRange}`);
  return Number(match[1]);
}

test('deployment runtime satisfies production dependency Node requirements', () => {
  const runtimeMajor = minimumMajor(packageJson.engines.node);

  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
  assert.ok(runtimeMajor >= 22, 'WMS365 production requires Node 22 or newer');

  for (const dependency of [
    'google-auth-library',
    'gcp-metadata',
    'google-logging-utils',
  ]) {
    const engine = packageLock.packages[`node_modules/${dependency}`]?.engines?.node;
    assert.ok(engine, `${dependency} must declare a Node engine`);
    assert.ok(
      minimumMajor(engine) <= runtimeMajor,
      `${dependency} requires ${engine}, above the configured runtime ${packageJson.engines.node}`,
    );
  }
});
