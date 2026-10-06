import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { lstatSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";

function canonicalizePath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(path, root) {
  const normalizedRoot = resolve(root);
  return path === normalizedRoot || path.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

function pathsOverlap(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}

/** Return a canonical, new destination; never permit an existing path or protected-root overlap. */
export function assertSafeMemoryDir(memoryDir, sessionsRoot, dshHome = process.env.DSH_HOME || join(homedir(), ".dsh"), extraProtectedRoots = []) {
  if (!memoryDir) throw new Error("--memory-dir is required");
  const requested = resolve(memoryDir);
  const requestedParent = dirname(requested);
  let parentStat;
  try {
    parentStat = statSync(requestedParent);
  } catch (error) {
    throw new Error(`memory-dir parent must already exist: ${requestedParent} (${String(error)})`);
  }
  if (!parentStat.isDirectory()) throw new Error(`memory-dir parent is not a directory: ${requestedParent}`);

  const destination = resolve(realpathSync(requestedParent), basename(requested));
  try {
    lstatSync(destination);
    throw new Error(`refusing existing memory-dir destination: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const protectedRoots = [
    { label: "session storage", path: realpathSync(sessionsRoot) },
    { label: "DSH home", path: canonicalizePath(dshHome) },
    ...extraProtectedRoots.filter(Boolean).map((path) => ({ label: "configured live memory storage", path: canonicalizePath(path) })),
  ];
  for (const root of protectedRoots) {
    if (pathsOverlap(destination, root.path)) {
      throw new Error(`refusing memory-dir overlap with ${root.label}: ${root.path}`);
    }
  }
  return destination;
}

const SENSITIVE_KEY_PARTS = [
  "password", "passwd", "pwd", "secret", "token", "apikey", "authorization",
  "cookie", "privatekey", "recoverycode",
];

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/** Extract credential probes from both serialized text and structured key/value payloads. */
export function collectSecretProbes(event) {
  const probes = new Set();
  const scanText = (text) => {
    if (typeof text !== "string" || text.length < 8 || text.length > 5000) return;
    const patterns = [
      /"(?:password|passwd|pwd|secret|token|api[_-]?key|apiKey|authorization|cookie|privateKey|recoveryCode)"\s*:\s*"([^"\\]{8,200})"/gi,
      /(?:Bearer|bearer)\s+([A-Za-z0-9_\-./]{16,200})/g,
      /(?:api[_-]?key|token|password|passwd)=([A-Za-z0-9_\-./]{16,200})/gi,
      /Authorization:\s*Basic\s+([A-Za-z0-9+/=]{16,200})/gi,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) probes.add(match[1]);
  };
  const walk = (value, depth = 0, sensitive = false) => {
    if (value === null || value === undefined || depth > 8) return;
    if (typeof value === "string") {
      scanText(value);
      if (sensitive && value.length >= 8 && value.length <= 5000) probes.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1, sensitive);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, depth + 1, sensitive || isSensitiveKey(key));
    }
  };
  walk(event);
  return probes;
}

function listRegularFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) listRegularFiles(root, path, out);
    else if (entry.isFile()) out.push(path.slice(root.length + 1));
  }
  return out;
}

function isSqliteArtifact(path) {
  return /\.(?:db|sqlite)(?:$|[-.])/i.test(basename(path));
}

export function judgeRolloutEvidence({ leaks, secretProbesChecked, totalEpisodes, retryEpisodes, redactionMarkersOnDisk }) {
  if (leaks.length > 0) return { verdict: "FAIL", inconclusiveReasons: [] };
  const inconclusiveReasons = [];
  if (secretProbesChecked === 0) inconclusiveReasons.push("no-credential-probes");
  if (totalEpisodes === 0) inconclusiveReasons.push("no-episodes");
  if (retryEpisodes === 0) inconclusiveReasons.push("no-retry-evidence");
  if (inconclusiveReasons.length > 0) return { verdict: "inconclusive", inconclusiveReasons };
  if (!redactionMarkersOnDisk) return { verdict: "FAIL", inconclusiveReasons: [] };
  return { verdict: "pass", inconclusiveReasons: [] };
}

/** Scan every regular file after the store is closed, including db, WAL, SHM, journal, and backup files. */
export function scanStoreArtifacts(memoryDir, secretProbes) {
  const filesScanned = listRegularFiles(memoryDir).sort();
  const sqliteArtifacts = filesScanned.filter(isSqliteArtifact);
  const leaks = [];
  let redactionMarkersOnDisk = false;
  for (const relativePath of filesScanned) {
    const text = readFileSync(join(memoryDir, relativePath)).toString("latin1");
    if (isSqliteArtifact(relativePath) && text.includes("[REDACTED]")) redactionMarkersOnDisk = true;
    for (const probe of secretProbes) {
      if (probe.length >= 8 && text.includes(probe)) {
        leaks.push({ artifact: relativePath, probe: probe.slice(0, 12) + "…", len: probe.length });
      }
    }
  }
  return { filesScanned, sqliteArtifacts, leaks, redactionMarkersOnDisk };
}
