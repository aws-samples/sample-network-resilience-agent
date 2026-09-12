#!/usr/bin/env node
//
// build-lambda-zip.mjs — Build the SSO backend Lambda artifact (lambda.zip)
// WITHOUT the AWS SAM CLI, so it can be deployed via the CloudFormation console.
//
// CROSS-PLATFORM: pure Node.js, no bash, no `zip` binary, ZERO external deps.
// Runs identically on Windows (CMD/PowerShell/Git Bash), macOS, and Linux —
// the only prerequisite is Node >= 22 + npm, which this project already needs.
//
// What it does (mirrors what `sam deploy` does internally, minus SAM):
//   1. npm ci        — reproducible install from the committed package-lock.json
//   2. npm audit      — SECURITY GATE. If vulnerabilities >= threshold are found,
//                       the build HALTS and NO zip is produced. Scanners read
//                       package-lock.json; building from it keeps the artifact
//                       honest. Uses `npm audit --json` for a reliable gate.
//   3. npm run build  — esbuild bundles src/lambda.ts -> dist/lambda.js (ESM)
//   4. zip            — dist/lambda.js + package.json {"type":"module"} -> lambda.zip
//                       (written by a built-in zlib-based zip writer; no `zip` tool)
//
// Why not `npm audit fix` here: `audit fix` mutates package-lock.json on THIS
// machine only, leaving the committed repo lockfile still vulnerable. This
// script VERIFIES (and blocks); it does not patch.
//
// Usage:
//   node console-deployment/build-lambda-zip.mjs                 # gate at "moderate"
//   AUDIT_LEVEL=high node console-deployment/build-lambda-zip.mjs
//   node console-deployment/build-lambda-zip.mjs --skip-audit    # NOT recommended
//
// Exit codes: 0 = success, 1 = build error, 2 = audit gate blocked, 3 = missing prereq.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  writeFileSync, appendFileSync, readFileSync, statSync,
  existsSync, rmSync, mkdirSync,
} from 'node:fs';
import { deflateRawSync } from 'node:zlib';

// CRC-32 (IEEE) — self-contained so we don't depend on zlib.crc32, which only
// exists in Node >= 22.2 (this project allows Node >= 22.0).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- paths (script lives in backend/console-deployment/) --------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(SCRIPT_DIR, '..');
const DIST_DIR = join(BACKEND_DIR, 'dist');
const OUT_ZIP = join(SCRIPT_DIR, 'lambda.zip');
const IS_WIN = process.platform === 'win32';

// ---- config -----------------------------------------------------------------
const AUDIT_LEVELS = ['low', 'moderate', 'high', 'critical'];
const AUDIT_LEVEL = process.env.AUDIT_LEVEL || 'moderate';
const SKIP_AUDIT = process.argv.includes('--skip-audit');

// ---- logging: console + timestamped logfile (tee-style) ---------------------
const TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const LOG = join(SCRIPT_DIR, `build-${TS}.log`);
writeFileSync(LOG, '');
function log(line = '') {
  console.log(line);
  appendFileSync(LOG, line + '\n');
}
function banner(title) {
  log('\n========================================');
  log(' ' + title);
  log('========================================');
}
const OK = '\u2714';   // ✔
const NO = '\u2716';   // ✖
const WARN = '\u26a0'; // ⚠
const step = (n, msg) => log(`\n[${n}/4] ${msg}`);
const ok = (msg) => log(`      ${OK} ${msg}`);
const bad = (msg) => log(`      ${NO} ${msg}`);

// ---- run a command, streaming combined output into the log ------------------
// shell:true on Windows so `npm`/`npm.cmd` resolves on PATH.
function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: BACKEND_DIR,
    shell: IS_WIN,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  if (!capture && out.trim()) appendFileSync(LOG, out);
  if (!capture && out.trim()) process.stdout.write(out);
  return { status: res.status ?? 1, out };
}

function die(code, title, lines = []) {
  banner(title);
  for (const l of lines) log(l);
  log(`\n  Full log: ${LOG}`);
  process.exit(code);
}

// =============================================================================
banner('Building SSO backend Lambda (no SAM CLI) — cross-platform');
log(`  platform : ${process.platform} (${IS_WIN ? 'Windows' : 'POSIX'})`);
log(`  backend  : ${BACKEND_DIR}`);
log(`  output   : ${OUT_ZIP}`);
log(`  log      : ${LOG}`);
log(`  audit    : failing at level '>= ${AUDIT_LEVEL}'${SKIP_AUDIT ? '  (SKIPPED via --skip-audit)' : ''}`);

// ---- prereq checks ----------------------------------------------------------
if (!AUDIT_LEVELS.includes(AUDIT_LEVEL)) {
  die(3, `${NO} INVALID AUDIT_LEVEL`, [`  AUDIT_LEVEL must be one of: ${AUDIT_LEVELS.join(', ')}`]);
}
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  die(3, `${NO} PREREQUISITE`, [`  Node ${process.version} detected; this project targets Node >= 22.`]);
}
{
  const v = run('npm', ['--version'], { capture: true });
  if (v.status !== 0) die(3, `${NO} PREREQUISITE MISSING`, ['  npm not found on PATH.']);
}

// ---- 1. install from lockfile ------------------------------------------------
step(1, 'Installing dependencies from lockfile (npm ci)...');
if (run('npm', ['ci']).status !== 0) {
  die(1, `${NO} BUILD FAILED (dependency install)`,
    ['  npm ci failed — package-lock.json may not satisfy package.json.']);
}
ok('dependencies installed, tree matches package-lock.json');

// ---- 2. SECURITY GATE: npm audit --json -------------------------------------
step(2, `Security audit (npm audit --audit-level=${AUDIT_LEVEL})...`);
if (SKIP_AUDIT) {
  bad('audit SKIPPED (--skip-audit). You are bundling UNVERIFIED dependencies.');
} else {
  const audit = run('npm', ['audit', '--json'], { capture: true });
  let report;
  try { report = JSON.parse(audit.out); }
  catch { die(1, `${NO} AUDIT ERROR`, ['  Could not parse `npm audit --json` output.']); }

  const sev = (report.metadata && report.metadata.vulnerabilities) || {};
  const order = ['low', 'moderate', 'high', 'critical'];
  const threshold = order.indexOf(AUDIT_LEVEL);
  const blocking = order.filter((s, i) => i >= threshold).reduce((n, s) => n + (sev[s] || 0), 0);

  log(`      severity counts: low=${sev.low || 0} moderate=${sev.moderate || 0} high=${sev.high || 0} critical=${sev.critical || 0}`);

  if (blocking === 0) {
    ok(`no vulnerabilities at or above '${AUDIT_LEVEL}'`);
  } else {
    bad(`${blocking} vulnerabilit${blocking === 1 ? 'y' : 'ies'} at or above '${AUDIT_LEVEL}' — BUILD HALTED`);

    // list advisories + decide whether a safe (non-force) fix exists via
    // the structured `fixAvailable` field (true = safe, object = needs a
    // specific version that may be a semver-major bump).
    let needsForce = false;
    const vulns = report.vulnerabilities || {};
    log('\n  --- advisories ---');
    for (const name of Object.keys(vulns)) {
      const v = vulns[name];
      const via = (v.via || []).map((x) => (typeof x === 'string' ? x : `${x.title || ''}${x.url ? ' (' + x.url + ')' : ''}`)).filter(Boolean);
      log(`    ${name}  [${v.severity}]  range: ${v.range || 'n/a'}`);
      for (const a of via) log(`      - ${a}`);
      if (v.fixAvailable === false) needsForce = true;
      else if (typeof v.fixAvailable === 'object' && v.fixAvailable.isSemVerMajor) needsForce = true;
    }

    // --- alert banner: what happened ---
    banner(`${NO} BUILD BLOCKED — vulnerabilities detected`);
    log('  No lambda.zip was produced (refusing to bundle vulnerable code).');

    // --- separate banner: how to fix (kept visually distinct from the alert) ---
    banner('HOW TO FIX');
    if (!needsForce) {
      log('  Safe, non-breaking fix. Run these commands, then re-run this script:');
      log('');
      log(`      cd "${BACKEND_DIR}"`);
      log('      npm audit fix                 # updates package-lock.json locally');
      log('');
      log('      node console-deployment/build-lambda-zip.mjs');
      log('');
      log('  This applies the fix on THIS machine, which is all that is needed to');
      log('  build a clean lambda.zip here.');
    } else {
      log(`  ${WARN}  A plain 'npm audit fix' CANNOT resolve all of these without --force.`);
      log('     --force may upgrade major versions and BREAK the app, so it is NOT');
      log('     run automatically. Review manually:');
      log('');
      log(`      cd "${BACKEND_DIR}"`);
      log('      npm audit                     # read the advisories');
      log('      npm audit fix --dry-run       # preview what --force would change');
      log('      # decide per-package, test the app, then re-run this script.');
    }
    log('');
    log('  Then re-run:  node console-deployment/build-lambda-zip.mjs');
    log(`\n  Full log: ${LOG}`);
    process.exit(2);
  }
}

// ---- 3. bundle --------------------------------------------------------------
step(3, 'Bundling src/lambda.ts -> dist/lambda.js (esbuild)...');
if (run('npm', ['run', 'build']).status !== 0) {
  die(1, `${NO} BUILD FAILED (bundling)`, ['  esbuild bundling failed.']);
}
const lambdaJs = join(DIST_DIR, 'lambda.js');
if (!existsSync(lambdaJs)) {
  die(1, `${NO} BUILD FAILED`, ['  build reported success but dist/lambda.js is missing.']);
}
ok(`dist/lambda.js (${(statSync(lambdaJs).size / 1048576).toFixed(1)} MB, ESM, node22)`);

// ---- 4. package zip (pure Node, no `zip` binary) ----------------------------
step(4, 'Packaging lambda.zip...');
if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });
const pkgMarker = join(DIST_DIR, 'package.json');
writeFileSync(pkgMarker, '{ "type": "module" }\n');

// Minimal ZIP writer: supports multiple files, DEFLATE (method 8), zlib crc32.
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (s) => Buffer.from(s, 'utf8');

  for (const { name, data } of entries) {
    const nameBuf = enc(name);
    const crc = crc32(data) >>> 0;
    const compressed = deflateRawSync(data);
    const useStore = compressed.length >= data.length; // store if deflate didn't help
    const body = useStore ? data : compressed;
    const method = useStore ? 0 : 8;

    // local file header (sig 0x04034b50)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(method, 8);      // compression method
    lh.writeUInt16LE(0, 10);          // mod time
    lh.writeUInt16LE(0x21, 12);       // mod date (arbitrary valid date)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);   // compressed size
    lh.writeUInt32LE(data.length, 22);   // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra len
    chunks.push(lh, nameBuf, body);

    // central directory record (sig 0x02014b50)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0, 8);           // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);          // mod time
    ch.writeUInt16LE(0x21, 14);       // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra len
    ch.writeUInt16LE(0, 32);          // comment len
    ch.writeUInt16LE(0, 34);          // disk number
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);     // local header offset
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // EOCD sig
  eocd.writeUInt16LE(0, 4);                   // disk
  eocd.writeUInt16LE(0, 6);                   // cd start disk
  eocd.writeUInt16LE(entries.length, 8);      // entries on disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);  // central dir size
  eocd.writeUInt32LE(offset, 16);             // central dir offset
  eocd.writeUInt16LE(0, 20);                  // comment len
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

if (existsSync(OUT_ZIP)) rmSync(OUT_ZIP);
const zipBuf = buildZip([
  { name: 'lambda.js', data: readFileSync(lambdaJs) },
  { name: 'package.json', data: readFileSync(pkgMarker) },
]);
writeFileSync(OUT_ZIP, zipBuf);
ok(`${OUT_ZIP} (${(statSync(OUT_ZIP).size / 1024).toFixed(0)} KB)`);
log('         \u2514\u2500 lambda.js + package.json {"type":"module"}');

// ---- resolved production dependency manifest (visibility) -------------------
log('\n  --- production dependencies bundled into lambda.js ---');
const tree = run('npm', ['ls', '--omit=dev', '--all'], { capture: true });
for (const l of tree.out.split('\n')) if (l.trim()) log('      ' + l);

// ---- done -------------------------------------------------------------------
banner(`\u2705 SUCCESS — artifact is CVE-clean and ready`);
log('  Next steps (CloudFormation console, no SAM CLI):');
log(`    1. Upload  ${OUT_ZIP}  to an S3 bucket in your target region.`);
log('    2. CloudFormation -> Create stack -> upload template-console.yaml');
log('    3. Parameters: ArtifactBucket=<bucket>, ArtifactKey=lambda.zip,');
log('                   AllowedOrigins=<your SPA origin, NO trailing slash>');
log("    4. Tick 'I acknowledge ... IAM resources' -> Create.");
log('    5. Copy the ApiUrl output into the SPA (VITE_SSO_BACKEND_URL or in-app).');
log('\n  See README.md for the full walkthrough.');
log(`  Full log: ${LOG}`);
process.exit(0);
