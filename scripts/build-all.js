#!/usr/bin/env node

/**
 * Build script for steam-hour-boost
 * Creates: binaries, tarballs, .deb, .rpm, and Docker image
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PKG_JSON = require(path.join(ROOT_DIR, 'package.json'));
const VERSION = PKG_JSON.version;
const APP_NAME = 'steam-hour-boost';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logStep(step) {
  log(`\n${'='.repeat(50)}`, 'cyan');
  log(`  ${step}`, 'bright');
  log(`${'='.repeat(50)}`, 'cyan');
}

function exec(cmd, options = {}) {
  log(`> ${cmd}`, 'yellow');
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT_DIR, ...options });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanDist() {
  logStep('Cleaning dist directory');
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  ensureDir(DIST_DIR);
}

async function buildBinaries() {
  logStep('Building standalone binaries');
  exec('npm ci');
  exec('npx @yao-pkg/pkg . --compress GZip');

  for (const arch of ['x64', 'arm64']) {
    // pkg outputs as steam-hour-boost-{arch} not steam-hour-boost-linux-{arch}
    const from = path.join(DIST_DIR, `${APP_NAME}-${arch}`);
    const to = path.join(DIST_DIR, `${APP_NAME}-${VERSION}-linux-${arch}`);
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
      fs.chmodSync(to, 0o755);
      log(`Created: ${APP_NAME}-${VERSION}-linux-${arch}`, 'green');
    }
  }
}

async function buildTarball() {
  logStep('Building tarballs');
  const archiver = require('archiver');

  for (const arch of ['x64', 'arm64']) {
    const binaryPath = path.join(DIST_DIR, `${APP_NAME}-${VERSION}-linux-${arch}`);
    if (!fs.existsSync(binaryPath)) continue;

    const tarPath = path.join(DIST_DIR, `${APP_NAME}-${VERSION}-linux-${arch}.tar.gz`);
    const output = fs.createWriteStream(tarPath);
    const archive = archiver('tar', { gzip: true });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.file(binaryPath, { name: `${APP_NAME}/${APP_NAME}`, mode: 0o755 });
      archive.append(getInstallScript(), { name: `${APP_NAME}/install.sh`, mode: 0o755 });
      archive.append(getSystemdService(), { name: `${APP_NAME}/steam-hour-boost.service` });
      archive.append(getReadme(), { name: `${APP_NAME}/README.txt` });
      archive.finalize();
    });

    log(`Created: ${APP_NAME}-${VERSION}-linux-${arch}.tar.gz`, 'green');
  }
}

async function buildDeb() {
  logStep('Building .deb packages');

  try {
    execSync('which dpkg-deb', { stdio: 'pipe' });
  } catch {
    log('dpkg-deb not available, skipping .deb', 'yellow');
    return;
  }

  for (const arch of ['x64', 'arm64']) {
    const debArch = arch === 'x64' ? 'amd64' : 'arm64';
    const binaryPath = path.join(DIST_DIR, `${APP_NAME}-${VERSION}-linux-${arch}`);
    if (!fs.existsSync(binaryPath)) continue;

    const debName = `${APP_NAME}_${VERSION}_${debArch}`;
    const debDir = path.join(DIST_DIR, debName);

    ensureDir(path.join(debDir, 'DEBIAN'));
    ensureDir(path.join(debDir, 'usr/bin'));
    ensureDir(path.join(debDir, 'usr/lib/systemd/system'));

    fs.copyFileSync(binaryPath, path.join(debDir, 'usr/bin/steam-hour-boost'));
    fs.chmodSync(path.join(debDir, 'usr/bin/steam-hour-boost'), 0o755);

    fs.writeFileSync(path.join(debDir, 'DEBIAN/control'), `Package: steam-hour-boost
Version: ${VERSION}
Section: games
Priority: optional
Architecture: ${debArch}
Maintainer: CS2Central <noreply@github.com>
Description: Steam hour booster with web UI
 Multi-account Steam hour booster with web dashboard,
 automatic 2FA via MAFiles, and encrypted credentials.
Homepage: https://github.com/cs2central/steam-hour-boost
`);

    fs.writeFileSync(path.join(debDir, 'DEBIAN/postinst'), `#!/bin/bash
mkdir -p /var/lib/steam-hour-boost
systemctl daemon-reload
echo "Start with: sudo systemctl start steam-hour-boost"
echo "Web UI: http://localhost:8869"
`);
    fs.chmodSync(path.join(debDir, 'DEBIAN/postinst'), 0o755);

    fs.writeFileSync(path.join(debDir, 'DEBIAN/prerm'), `#!/bin/bash
systemctl stop steam-hour-boost 2>/dev/null || true
systemctl disable steam-hour-boost 2>/dev/null || true
`);
    fs.chmodSync(path.join(debDir, 'DEBIAN/prerm'), 0o755);

    fs.writeFileSync(
      path.join(debDir, 'usr/lib/systemd/system/steam-hour-boost.service'),
      getSystemdServiceDeb()
    );

    exec(`dpkg-deb --build --root-owner-group ${debDir}`);
    fs.renameSync(`${debDir}.deb`, path.join(DIST_DIR, `${debName}.deb`));
    fs.rmSync(debDir, { recursive: true });
    log(`Created: ${debName}.deb`, 'green');
  }
}

async function buildRpm() {
  logStep('Building .rpm packages');

  try {
    execSync('which rpmbuild', { stdio: 'pipe' });
  } catch {
    log('rpmbuild not available, skipping .rpm', 'yellow');
    return;
  }

  for (const arch of ['x64', 'arm64']) {
    const rpmArch = arch === 'x64' ? 'x86_64' : 'aarch64';
    const binaryPath = path.join(DIST_DIR, `${APP_NAME}-${VERSION}-linux-${arch}`);
    if (!fs.existsSync(binaryPath)) continue;

    const rpmDir = path.join(DIST_DIR, 'rpmbuild');
    for (const dir of ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']) {
      ensureDir(path.join(rpmDir, dir));
    }

    fs.copyFileSync(binaryPath, path.join(rpmDir, 'SOURCES', APP_NAME));
    fs.writeFileSync(path.join(rpmDir, 'SOURCES', 'steam-hour-boost.service'), getSystemdService());
    fs.writeFileSync(path.join(rpmDir, 'SPECS', `${APP_NAME}.spec`), getRpmSpec());

    try {
      exec(`rpmbuild --define "_topdir ${rpmDir}" --target ${rpmArch} -bb ${rpmDir}/SPECS/${APP_NAME}.spec`);
      const rpms = fs.readdirSync(path.join(rpmDir, 'RPMS', rpmArch) || []);
      for (const rpm of rpms.filter(f => f.endsWith('.rpm'))) {
        fs.renameSync(path.join(rpmDir, 'RPMS', rpmArch, rpm), path.join(DIST_DIR, rpm));
        log(`Created: ${rpm}`, 'green');
      }
    } catch {
      log(`RPM build failed for ${arch}`, 'yellow');
    }
    fs.rmSync(rpmDir, { recursive: true });
  }
}

function createDockerFiles() {
  logStep('Creating Docker files');

  fs.writeFileSync(path.join(ROOT_DIR, 'Dockerfile'), `FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src
COPY views ./views
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production PORT=8869 DATA_DIR=/data
EXPOSE 8869

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
`);

  fs.writeFileSync(path.join(ROOT_DIR, 'docker-compose.yml'), `version: '3.8'

services:
  steam-hour-boost:
    build: .
    image: cs2central/steam-hour-boost:${VERSION}
    container_name: steam-hour-boost
    restart: unless-stopped
    ports:
      - "8869:8869"
    volumes:
      - steam-hour-boost-data:/data

volumes:
  steam-hour-boost-data:
`);

  log('Created: Dockerfile', 'green');
  log('Created: docker-compose.yml', 'green');
}

function createChecksums() {
  logStep('Creating checksums');
  const files = fs.readdirSync(DIST_DIR).filter(f =>
    f.endsWith('.deb') || f.endsWith('.rpm') || f.endsWith('.tar.gz') || f.match(/linux-(x64|arm64)$/)
  );

  let sums = '';
  for (const file of files) {
    const sha = execSync(`sha256sum "${path.join(DIST_DIR, file)}"`, { encoding: 'utf8' }).split(' ')[0];
    sums += `${sha}  ${file}\n`;
  }
  fs.writeFileSync(path.join(DIST_DIR, 'SHA256SUMS'), sums);
  log('Created: SHA256SUMS', 'green');
}

function getInstallScript() {
  return `#!/bin/bash
set -e
[ "$EUID" -ne 0 ] && echo "Run as root: sudo ./install.sh" && exit 1
install -Dm755 steam-hour-boost /usr/local/bin/steam-hour-boost
install -Dm644 steam-hour-boost.service /etc/systemd/system/steam-hour-boost.service
mkdir -p /var/lib/steam-hour-boost
systemctl daemon-reload
echo "Installed! Start with: sudo systemctl start steam-hour-boost"
echo "Web UI: http://localhost:8869"
`;
}

function getSystemdService() {
  return `[Unit]
Description=Steam Hour Boost
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/steam-hour-boost
Restart=on-failure
WorkingDirectory=/var/lib/steam-hour-boost
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/steam-hour-boost

[Install]
WantedBy=multi-user.target
`;
}

function getSystemdServiceDeb() {
  return `[Unit]
Description=Steam Hour Boost
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/steam-hour-boost
Restart=on-failure
WorkingDirectory=/var/lib/steam-hour-boost
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/steam-hour-boost

[Install]
WantedBy=multi-user.target
`;
}

function getReadme() {
  return `Steam Hour Boost v${VERSION}

Install: sudo ./install.sh
Start:   sudo systemctl start steam-hour-boost
Enable:  sudo systemctl enable steam-hour-boost
Web UI:  http://localhost:8869

https://github.com/cs2central/steam-hour-boost
`;
}

function getRpmSpec() {
  return `Name:           steam-hour-boost
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        Steam hour booster with web UI
License:        MIT
URL:            https://github.com/cs2central/steam-hour-boost
Source0:        steam-hour-boost
Source1:        steam-hour-boost.service

%description
Multi-account Steam hour booster with web dashboard.

%install
mkdir -p %{buildroot}/usr/bin %{buildroot}/usr/lib/systemd/system %{buildroot}/var/lib/steam-hour-boost
install -m 755 %{SOURCE0} %{buildroot}/usr/bin/steam-hour-boost
install -m 644 %{SOURCE1} %{buildroot}/usr/lib/systemd/system/steam-hour-boost.service

%post
systemctl daemon-reload

%preun
systemctl stop steam-hour-boost 2>/dev/null || true

%files
/usr/bin/steam-hour-boost
/usr/lib/systemd/system/steam-hour-boost.service
%dir /var/lib/steam-hour-boost
`;
}

async function main() {
  log(`\nBuilding steam-hour-boost v${VERSION}\n`, 'bright');

  try {
    cleanDist();
    await buildBinaries();
    await buildTarball();
    await buildDeb();
    await buildRpm();
    createDockerFiles();
    createChecksums();

    log(`\n${'='.repeat(50)}`, 'green');
    log('  BUILD COMPLETE', 'bright');
    log(`${'='.repeat(50)}`, 'green');

    log(`\nArtifacts in ${DIST_DIR}:`, 'cyan');
    for (const f of fs.readdirSync(DIST_DIR)) {
      const size = (fs.statSync(path.join(DIST_DIR, f)).size / 1024 / 1024).toFixed(2);
      log(`  ${f} (${size} MB)`);
    }
  } catch (err) {
    log(`\nBuild failed: ${err.message}`, 'red');
    process.exit(1);
  }
}

main();
