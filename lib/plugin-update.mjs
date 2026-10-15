export const PI_CAW_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/TohmaN233/pi-CAW/main/package.json';
export const PI_CAW_UPDATE_TIMEOUT_MS = 5_000;
export const PI_CAW_UPDATE_CACHE_MS = 5 * 60_000;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemVer(version) {
  if (typeof version !== 'string') throw new TypeError('Plugin version must be a semantic version string');
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new TypeError(`Invalid semantic version: ${version}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left), b = parseSemVer(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const aPart = a.prerelease[index], bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^(0|[1-9]\d*)$/.test(aPart), bNumeric = /^(0|[1-9]\d*)$/.test(bPart);
    if (aNumeric && bNumeric) return BigInt(aPart) < BigInt(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export function classifyPluginUpdate(currentVersion, latestVersion) {
  const comparison = compareSemVer(latestVersion, currentVersion);
  const status = comparison > 0 ? 'update_available' : comparison < 0 ? 'local_ahead' : 'up_to_date';
  return { status, currentVersion, latestVersion };
}

function updateError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function createPluginUpdateChecker({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = PI_CAW_UPDATE_TIMEOUT_MS, cacheMs = PI_CAW_UPDATE_CACHE_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Plugin update checker requires fetch');
  let cachedLatest = null;
  let pendingFetch = null;

  async function fetchLatestVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(PI_CAW_PACKAGE_JSON_URL, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw updateError('PI_CAW_UPDATE_CHECK_FAILED', `GitHub returned HTTP ${response.status} while checking for updates`);
      const metadata = await response.json();
      parseSemVer(metadata?.version);
      return metadata.version;
    } catch (error) {
      if (controller.signal.aborted) throw updateError('PI_CAW_UPDATE_CHECK_TIMEOUT', `Update check timed out after ${timeoutMs} ms`, error);
      if (error?.code === 'PI_CAW_UPDATE_CHECK_FAILED') throw error;
      throw updateError('PI_CAW_UPDATE_CHECK_FAILED', `Unable to read the pi-CAW package version: ${error.message}`, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function latestVersion() {
    if (cachedLatest && now() - cachedLatest.checkedAt < cacheMs) return cachedLatest.version;
    if (!pendingFetch) {
      pendingFetch = fetchLatestVersion().then(version => {
        cachedLatest = { version, checkedAt: now() };
        return version;
      });
    }
    try {
      return await pendingFetch;
    } finally {
      pendingFetch = null;
    }
  }

  return async function checkPluginUpdate(currentVersion) {
    parseSemVer(currentVersion);
    const newest = await latestVersion();
    return classifyPluginUpdate(currentVersion, newest);
  };
}

export const checkPluginUpdate = createPluginUpdateChecker();
