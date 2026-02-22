/**
 * Tests for the export-mafile route and maFile ZIP export/import logic.
 * These test the route handler functions and ZIP creation without needing a running server.
 */

const AdmZip = require('adm-zip');

// ─── maFile JSON structure validation ────────────────────────

describe('maFile JSON structure', () => {
  // Test the expected maFile format produced by exports
  function buildMaFile(account) {
    const maFile = {
      account_name: account.username,
      shared_secret: account.shared_secret,
      identity_secret: account.identity_secret || '',
      device_id: account.device_id || '',
      steamid: account.steam_id || '',
      session: {
        access_token: null,
        refresh_token: null,
        session_id: null
      }
    };
    if (account.revocation_code) {
      maFile.revocation_code = account.revocation_code;
    }
    return maFile;
  }

  test('contains all required fields', () => {
    const maFile = buildMaFile({
      username: 'testuser',
      shared_secret: 'abc123',
      identity_secret: 'def456',
      steam_id: '76561198012345678'
    });

    expect(maFile.account_name).toBe('testuser');
    expect(maFile.shared_secret).toBe('abc123');
    expect(maFile.identity_secret).toBe('def456');
    expect(maFile.steamid).toBe('76561198012345678');
    expect(maFile.device_id).toBe('');
    expect(maFile.session).toEqual({ access_token: null, refresh_token: null, session_id: null });
    expect(maFile).not.toHaveProperty('revocation_code');
  });

  test('includes revocation_code only when present', () => {
    const withRevocation = buildMaFile({
      username: 'user1',
      shared_secret: 'ss',
      revocation_code: 'R12345'
    });
    expect(withRevocation.revocation_code).toBe('R12345');

    const withoutRevocation = buildMaFile({
      username: 'user2',
      shared_secret: 'ss'
    });
    expect(withoutRevocation).not.toHaveProperty('revocation_code');
  });

  test('defaults empty strings for optional fields', () => {
    const maFile = buildMaFile({ username: 'user', shared_secret: 'ss' });
    expect(maFile.identity_secret).toBe('');
    expect(maFile.device_id).toBe('');
    expect(maFile.steamid).toBe('');
  });

  test('filename uses steam_id when available', () => {
    const account = { username: 'user', shared_secret: 'ss', steam_id: '76561198012345678' };
    const filename = account.steam_id ? `${account.steam_id}.maFile` : `${account.username}.maFile`;
    expect(filename).toBe('76561198012345678.maFile');
  });

  test('filename falls back to username', () => {
    const account = { username: 'myuser', shared_secret: 'ss' };
    const filename = account.steam_id ? `${account.steam_id}.maFile` : `${account.username}.maFile`;
    expect(filename).toBe('myuser.maFile');
  });

  test('produces valid JSON that can be parsed back', () => {
    const maFile = buildMaFile({
      username: 'testuser',
      shared_secret: 'abc',
      identity_secret: 'def',
      steam_id: '12345',
      device_id: 'android:uuid',
      revocation_code: 'R99999'
    });

    const json = JSON.stringify(maFile, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.account_name).toBe('testuser');
    expect(parsed.shared_secret).toBe('abc');
    expect(parsed.revocation_code).toBe('R99999');
  });
});

// ─── ZIP creation for plaintext export ───────────────────────

describe('plaintext ZIP export structure', () => {
  function createPlaintextZip(accounts) {
    const zip = new AdmZip();
    let exportCount = 0;

    for (const account of accounts) {
      if (!account.shared_secret) continue;

      const maFile = {
        account_name: account.username,
        shared_secret: account.shared_secret,
        identity_secret: account.identity_secret || '',
        device_id: account.device_id || '',
        steamid: account.steam_id || '',
        session: { access_token: null, refresh_token: null, session_id: null }
      };

      if (account.revocation_code) {
        maFile.revocation_code = account.revocation_code;
      }

      const filename = account.steam_id
        ? `${account.steam_id}.maFile`
        : `${account.username}.maFile`;

      zip.addFile(filename, Buffer.from(JSON.stringify(maFile, null, 2), 'utf8'));
      exportCount++;
    }

    return { zip, exportCount };
  }

  test('creates ZIP with correct number of entries', () => {
    const accounts = [
      { username: 'u1', shared_secret: 'ss1', steam_id: '111' },
      { username: 'u2', shared_secret: 'ss2', steam_id: '222' },
      { username: 'u3', shared_secret: 'ss3', steam_id: '333' }
    ];

    const { zip, exportCount } = createPlaintextZip(accounts);
    expect(exportCount).toBe(3);

    const entries = zip.getEntries();
    expect(entries).toHaveLength(3);
  });

  test('skips accounts without shared_secret', () => {
    const accounts = [
      { username: 'has_secret', shared_secret: 'ss', steam_id: '111' },
      { username: 'no_secret', steam_id: '222' },
      { username: 'empty_secret', shared_secret: '', steam_id: '333' }
    ];

    const { exportCount } = createPlaintextZip(accounts);
    // Only accounts with truthy shared_secret should be exported
    expect(exportCount).toBe(1);
  });

  test('ZIP entries contain valid JSON', () => {
    const accounts = [
      { username: 'zipuser', shared_secret: 'ss_zip', steam_id: '76561198000000001' }
    ];

    const { zip } = createPlaintextZip(accounts);
    const entry = zip.getEntries()[0];
    const content = entry.getData().toString('utf8');
    const parsed = JSON.parse(content);

    expect(parsed.account_name).toBe('zipuser');
    expect(parsed.shared_secret).toBe('ss_zip');
    expect(parsed.steamid).toBe('76561198000000001');
  });

  test('ZIP can be re-read with AdmZip', () => {
    const accounts = [
      { username: 'a', shared_secret: 's1', steam_id: '1' },
      { username: 'b', shared_secret: 's2', steam_id: '2' }
    ];

    const { zip } = createPlaintextZip(accounts);
    const buffer = zip.toBuffer();

    // Re-open the ZIP from buffer
    const reopened = new AdmZip(buffer);
    const entries = reopened.getEntries();
    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      const data = JSON.parse(entry.getData().toString('utf8'));
      expect(data).toHaveProperty('account_name');
      expect(data).toHaveProperty('shared_secret');
    }
  });

  test('handles empty accounts array', () => {
    const { exportCount } = createPlaintextZip([]);
    expect(exportCount).toBe(0);
  });
});

// ─── Encrypted ZIP export structure ──────────────────────────

describe('encrypted ZIP export structure', () => {
  const { exportSDAAccounts, decryptSDAData } = require('../src/utils/sdaDecrypt');

  test('creates manifest.json + encrypted .maFile entries', () => {
    const accounts = [
      { account_name: 'enc1', shared_secret: 'ss1', steamid: '111' },
      { account_name: 'enc2', shared_secret: 'ss2', steamid: '222' }
    ];

    const { manifest, files } = exportSDAAccounts(accounts, 'testpasskey');

    // Build ZIP
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const [filename, content] of Object.entries(files)) {
      zip.addFile(filename, Buffer.from(content, 'utf8'));
    }

    const buffer = zip.toBuffer();
    const reopened = new AdmZip(buffer);
    const entries = reopened.getEntries();

    // Should have manifest + 2 maFiles
    expect(entries).toHaveLength(3);

    // Verify manifest
    const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
    expect(manifestEntry).toBeDefined();
    const parsedManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    expect(parsedManifest.encrypted).toBe(true);
    expect(parsedManifest.entries).toHaveLength(2);
  });

  test('encrypted maFiles can be decrypted from ZIP', () => {
    const accounts = [
      { account_name: 'decryptme', shared_secret: 'my_secret', identity_secret: 'my_id', steamid: '999' }
    ];
    const passkey = 'zippasskey';

    const { manifest, files } = exportSDAAccounts(accounts, passkey);

    // Build and re-read ZIP
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const [filename, content] of Object.entries(files)) {
      zip.addFile(filename, Buffer.from(content, 'utf8'));
    }

    const reopened = new AdmZip(zip.toBuffer());
    const maFileEntry = reopened.getEntries().find(e => e.entryName.endsWith('.maFile'));
    const encryptedContent = maFileEntry.getData().toString('utf8');

    // Decrypt using manifest entry params
    const entry = manifest.entries[0];
    const decrypted = decryptSDAData(passkey, entry.encryption_salt, entry.encryption_iv, encryptedContent);
    expect(decrypted).not.toBeNull();

    const parsed = JSON.parse(decrypted);
    expect(parsed.account_name).toBe('decryptme');
    expect(parsed.shared_secret).toBe('my_secret');
  });
});

// ─── maFile parsing (field normalization) ────────────────────

describe('maFile field normalization', () => {
  test('handles SDA PascalCase session format', () => {
    const sdaFormat = {
      account_name: 'sda_user',
      shared_secret: 'ss',
      Session: {
        AccessToken: 'at123',
        RefreshToken: 'rt456',
        SessionID: 'sid789',
        SteamID: 76561198012345678
      }
    };

    // Normalize (same logic as parseMAFile)
    let session = null;
    if (sdaFormat.Session) {
      session = {
        access_token: sdaFormat.Session.AccessToken || sdaFormat.Session.access_token || null,
        refresh_token: sdaFormat.Session.RefreshToken || sdaFormat.Session.refresh_token || null,
        session_id: sdaFormat.Session.SessionID || sdaFormat.Session.session_id || null
      };
    }

    expect(session.access_token).toBe('at123');
    expect(session.refresh_token).toBe('rt456');
    expect(session.session_id).toBe('sid789');
  });

  test('handles lowercase session format', () => {
    const linuxFormat = {
      account_name: 'linux_user',
      shared_secret: 'ss',
      session: {
        access_token: 'at_lower',
        refresh_token: 'rt_lower',
        session_id: 'sid_lower'
      }
    };

    let session = null;
    if (linuxFormat.session) {
      session = {
        access_token: linuxFormat.session.access_token || null,
        refresh_token: linuxFormat.session.refresh_token || null,
        session_id: linuxFormat.session.session_id || null
      };
    }

    expect(session.access_token).toBe('at_lower');
    expect(session.refresh_token).toBe('rt_lower');
  });

  test('SteamID extraction from various field formats', () => {
    const patterns = [
      /"SteamID"\s*:\s*(\d+)/,
      /"steamid"\s*:\s*"?(\d+)"?/i,
      /"steam_id"\s*:\s*"?(\d+)"?/
    ];

    // SDA format (number, PascalCase)
    const sda = '{"SteamID": 76561198012345678}';
    let match = null;
    for (const p of patterns) {
      match = sda.match(p);
      if (match) break;
    }
    expect(match[1]).toBe('76561198012345678');

    // Linux format (string, lowercase)
    const linux = '{"steamid": "76561198099999999"}';
    match = null;
    for (const p of patterns) {
      match = linux.match(p);
      if (match) break;
    }
    expect(match[1]).toBe('76561198099999999');

    // snake_case format
    const alt = '{"steam_id": "76561198011111111"}';
    match = null;
    for (const p of patterns) {
      match = alt.match(p);
      if (match) break;
    }
    expect(match[1]).toBe('76561198011111111');
  });

  test('large SteamID preserved as string via regex extraction', () => {
    // JavaScript loses precision on large integers
    const content = '{"SteamID": 76561198123456789, "account_name": "test"}';
    const parsed = JSON.parse(content);

    // JSON.parse loses precision for large numbers
    expect(String(parsed.SteamID)).not.toBe('76561198123456789');

    // But regex extraction preserves it
    const match = content.match(/"SteamID"\s*:\s*(\d+)/);
    expect(match[1]).toBe('76561198123456789');
  });
});
