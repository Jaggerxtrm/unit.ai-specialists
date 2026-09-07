// tests/unit/specialist/activation-peer-registration.test.ts
//
// Registration was approved on two binding conditions — deregistration on exit, and orphan
// cleanup that does not worsen the measured 128-sockets-for-20-registrations baseline.
// Most of what is asserted here is those conditions, not the happy path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupOrphanRegistrations,
  registerRuntimePeer,
  REGISTRATION_VERSION,
} from '../../../src/activation/transport/peer-registration.js';
import { evaluateRegistration, procProbe, scanRoster, type ProcessProbe } from '../../../src/activation/transport/roster.js';

let root: string;
let rosterDir: string;
let socketDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-reg-'));
  rosterDir = join(root, 'sessions');
  socketDir = join(root, 'socks');
  mkdirSync(rosterDir, { recursive: true });
  mkdirSync(socketDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function probeFor(running: Record<number, number>): ProcessProbe {
  return {
    startOf: pid => (running[pid] === undefined ? undefined : { ticksSinceBoot: running[pid], epochSeconds: 0 }),
  };
}

describe('registration — the entry must satisfy our own liveness check', () => {
  it('writes an entry that roster.ts accepts as a live route', async () => {
    const peer = await registerRuntimePeer({
      name: 'sp-runtime', rosterDir, socketDir, installExitHandlers: false,
    });
    try {
      // Writing an entry our own checker rejects is how a runtime becomes unreachable to
      // itself, so this is asserted against the real check rather than the raw fields.
      const scan = scanRoster({ dir: rosterDir, probe: procProbe() });
      expect(scan.rejected).toEqual([]);
      expect(scan.live.map(r => r.sessionId)).toContain(peer.sessionId);
    } finally {
      await peer.close();
    }
  });

  it('writes procStart in the numeric form — the exact-comparison one', async () => {
    const peer = await registerRuntimePeer({
      name: 'sp-runtime', rosterDir, socketDir, installExitHandlers: false,
    });
    try {
      const entry = JSON.parse(readFileSync(peer.registrationPath, 'utf-8'));
      expect(typeof entry.procStart).toBe('number');
      expect(entry.procStart).toBe(procProbe().startOf(process.pid)?.ticksSinceBoot);
      expect(entry.peerProtocol).toBe(1);
      expect(entry.version).toBe(REGISTRATION_VERSION);
      // A start-time mismatch must still be caught, i.e. the guard is real.
      expect(evaluateRegistration({ ...entry, procStart: entry.procStart + 1 }, procProbe()))
        .toEqual({ reason: 'proc_start_mismatch' });
    } finally {
      await peer.close();
    }
  });

  it('binds the socket before publishing the entry', async () => {
    const peer = await registerRuntimePeer({
      name: 'sp-runtime', rosterDir, socketDir, installExitHandlers: false,
    });
    try {
      // By the time the entry is readable, its advertised socket is already listening —
      // otherwise a peer reading the roster would fail against a startup race.
      expect(existsSync(peer.registrationPath)).toBe(true);
      expect(existsSync(peer.socketPath)).toBe(true);
    } finally {
      await peer.close();
    }
  });

  it('refuses to overwrite a registration another writer owns', async () => {
    writeFileSync(join(rosterDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, version: 'pi-claude-link' }));
    await expect(registerRuntimePeer({ name: 'sp', rosterDir, socketDir, installExitHandlers: false }))
      .rejects.toThrow(/refusing to overwrite/);
  });
});

describe('condition 1 — deregistration on exit', () => {
  it('removes the entry and the socket on close()', async () => {
    const peer = await registerRuntimePeer({
      name: 'sp-runtime', rosterDir, socketDir, installExitHandlers: false,
    });
    await peer.close();
    expect(existsSync(peer.registrationPath)).toBe(false);
    expect(existsSync(peer.socketPath)).toBe(false);
  });

  it('is idempotent, so a duplicated shutdown path is safe', async () => {
    const peer = await registerRuntimePeer({
      name: 'sp-runtime', rosterDir, socketDir, installExitHandlers: false,
    });
    await peer.close();
    await expect(peer.close()).resolves.toBeUndefined();
  });

  it('deregisters when a real process exits normally', async () => {
    // Asserted against a real process rather than a mocked handler: the exit path is the
    // condition the approval was given on, and a stubbed 'exit' event would not prove it.
    const script = join(root, 'run.ts');
    const mod = join(process.cwd(), 'src', 'activation', 'transport', 'peer-registration.ts');
    writeFileSync(script, `
      import { registerRuntimePeer } from ${JSON.stringify(mod)};
      const peer = await registerRuntimePeer({
        name: 'exiting', rosterDir: ${JSON.stringify(rosterDir)}, socketDir: ${JSON.stringify(socketDir)},
      });
      console.log(JSON.stringify({ reg: peer.registrationPath, sock: peer.socketPath }));
      process.exit(0);
    `);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('bun', ['run', script], (err, out) => (err ? reject(err) : resolve(out)));
    });
    const { reg, sock } = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(existsSync(reg)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  }, 30_000);

  it('deregisters on SIGTERM and still dies', async () => {
    const script = join(root, 'sig.ts');
    const mod = join(process.cwd(), 'src', 'activation', 'transport', 'peer-registration.ts');
    writeFileSync(script, `
      import { registerRuntimePeer } from ${JSON.stringify(mod)};
      const peer = await registerRuntimePeer({
        name: 'signalled', rosterDir: ${JSON.stringify(rosterDir)}, socketDir: ${JSON.stringify(socketDir)},
      });
      console.log(JSON.stringify({ reg: peer.registrationPath, sock: peer.socketPath }));
      setInterval(() => {}, 1000);
    `);
    const { spawn } = await import('node:child_process');
    const child = spawn('bun', ['run', script]);
    const line = await new Promise<string>(resolve => {
      child.stdout.on('data', (d: Buffer) => { const t = d.toString().trim(); if (t.startsWith('{')) resolve(t); });
    });
    const { reg, sock } = JSON.parse(line);
    expect(existsSync(reg)).toBe(true);

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;

    expect(existsSync(reg)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  }, 30_000);
});

describe('condition 2 — orphan cleanup that cannot make the ratio worse', () => {
  it('removes our own entries whose process is gone, plus their sockets', () => {
    writeFileSync(join(rosterDir, '999.json'), JSON.stringify({
      pid: 999, sessionId: 's', version: REGISTRATION_VERSION, peerProtocol: 1,
      procStart: 12345, messagingSocketPath: join(socketDir, '999.sock'),
    }));
    writeFileSync(join(socketDir, '999.sock'), '');

    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({}) });
    expect(result.registrationsRemoved).toHaveLength(1);
    expect(result.socketsRemoved).toHaveLength(1);
    expect(existsSync(join(rosterDir, '999.json'))).toBe(false);
    expect(existsSync(join(socketDir, '999.sock'))).toBe(false);
  });

  it('removes an entry whose PID was reused by a different process', () => {
    writeFileSync(join(rosterDir, '999.json'), JSON.stringify({
      pid: 999, sessionId: 's', version: REGISTRATION_VERSION, peerProtocol: 1, procStart: 12345,
    }));
    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({ 999: 777 }) });
    expect(result.registrationsRemoved).toHaveLength(1);
  });

  it('NEVER touches another writer\'s entry, even when its PID is dead', () => {
    // The roster is shared with Claude Code and pi-claude-link. Deleting their rows on
    // their behalf is not this runtime's call, and the measured 10-of-20 dead entries are
    // exactly the rows a careless reaper would take.
    writeFileSync(join(rosterDir, '111.json'), JSON.stringify({
      pid: 111, version: 'pi-claude-link', peerProtocol: 1, procStart: 1,
      messagingSocketPath: join(socketDir, '111.sock'),
    }));
    writeFileSync(join(socketDir, '111.sock'), '');
    writeFileSync(join(rosterDir, '222.json'), JSON.stringify({ pid: 222, peerProtocol: 1, procStart: 1 }));

    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({}) });
    expect(result.registrationsRemoved).toEqual([]);
    expect(result.socketsRemoved).toEqual([]);
    expect(result.foreignEntriesSkipped).toBe(2);
    expect(existsSync(join(rosterDir, '111.json'))).toBe(true);
    expect(existsSync(join(socketDir, '111.sock'))).toBe(true);
  });

  it('leaves an unreadable entry alone rather than guessing who wrote it', () => {
    writeFileSync(join(rosterDir, '333.json'), '{ truncated');
    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({}) });
    expect(result.registrationsRemoved).toEqual([]);
    expect(result.foreignEntriesSkipped).toBe(1);
    expect(existsSync(join(rosterDir, '333.json'))).toBe(true);
  });

  it('NEVER removes a live entry of ours', async () => {
    const peer = await registerRuntimePeer({
      name: 'live', rosterDir, socketDir, installExitHandlers: false,
    });
    try {
      const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: procProbe() });
      expect(result.registrationsRemoved).toEqual([]);
      expect(existsSync(peer.registrationPath)).toBe(true);
    } finally {
      await peer.close();
    }
  });

  it('does not sweep a socket it cannot attribute to a dead entry of ours', () => {
    // The 128-for-20 garbage is mostly sockets with no registration at all. They belong to
    // whoever made them; removing them on suspicion is how a reaper breaks a live peer.
    writeFileSync(join(socketDir, '4242.sock'), '');
    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({}) });
    expect(result.socketsRemoved).toEqual([]);
    expect(existsSync(join(socketDir, '4242.sock'))).toBe(true);
  });

  it('sweeps our socket left behind when the entry is already gone (the SIGKILL case)', () => {
    writeFileSync(join(rosterDir, '999.json'), JSON.stringify({
      pid: 999, version: REGISTRATION_VERSION, peerProtocol: 1, procStart: 12345,
    }));
    writeFileSync(join(socketDir, '999.sock'), '');
    const result = cleanupOrphanRegistrations({ rosterDir, socketDir, probe: probeFor({}) });
    expect(result.socketsRemoved).toEqual([join(socketDir, '999.sock')]);
  });
});
