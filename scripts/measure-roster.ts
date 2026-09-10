#!/usr/bin/env bun
/**
 * Roster routability measurement (E6 E2, read-only).
 *
 * Enumerates session registrations and applies the production liveness rules
 * from src/activation/transport/roster.ts (/proc + procStart mandatory, socket
 * path present, protocol v1) with the real process probe. Writes nothing: no
 * registration, no cleanup, no socket sends.
 *
 * Usage:
 *   bun scripts/measure-roster.ts [--dir <roster-dir>] [--json]
 *
 * Decision rule (unitAI-t2kol.10 §3):
 *   live-route rate <50%  → socket-send stays opt-in-only on this host
 *   50–80%                → opt-in-only (caution; not sustained)
 *   ≥80% sustained        → coordinator MAY propose default-on
 *                           (still needs E3 receipt test PASS)
 *
 * Terminology (spec §AG): the roster is a discovery surface for the
 * undocumented peer-socket transport. It is NOT an XTRM Channel (the durable,
 * provider-neutral message abstraction) and NOT the Claude Channel transport
 * (the research-preview delivery adapter). A stale entry here erases nothing:
 * the durable XTRM Channel message remains readable via polling.
 */

import { existsSync, readdirSync } from 'node:fs';
import { scanRoster, procProbe, defaultRosterDir } from '../src/activation/transport/roster.js';
import type { RouteRejection } from '../src/activation/transport/roster.js';

function parseArgs(argv: string[]): { dir: string; json: boolean } {
  let dir = defaultRosterDir();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) { dir = argv[++i]; }
    else if (argv[i] === '--json') { json = true; }
  }
  return { dir, json };
}

async function main(): Promise<void> {
  const { dir, json } = parseArgs(process.argv.slice(2));

  if (!existsSync(dir)) {
    const empty = { dir, total: 0, live: 0, live_rate: 1, by_reason: {}, verdict: 'NO-DATA (no roster dir; polling-authoritative unaffected)' };
    if (json) console.log(JSON.stringify(empty, null, 2));
    else console.log(`roster dir missing: ${dir}\nverdict: ${empty.verdict}`);
    return;
  }

  const scan = scanRoster({ dir, probe: procProbe() });
  const byReason: Record<RouteRejection, number> = {
    unparsable: 0, no_proc_entry: 0, missing_proc_start: 0,
    proc_start_mismatch: 0, unsupported_peer_protocol: 0, no_socket_path: 0,
  };
  for (const r of scan.rejected) byReason[r.reason]++;

  const total = scan.live.length + scan.rejected.length;
  const liveRate = total === 0 ? 1 : scan.live.length / total;
  const verdict =
    total === 0 ? 'NO-DATA (empty roster; polling-authoritative unaffected)'
    : liveRate < 0.5 ? 'OPT-IN-ONLY (live-route rate <50%: socket-send must not be default-on here)'
    : liveRate < 0.8 ? 'OPT-IN-ONLY (caution: below the ≥80% sustained bar for any default-on proposal)'
    : 'MAY-PROPOSE-DEFAULT-ON (still needs E3 receipt test PASS; decision record required)';

  // Informational only: socket files accumulate garbage (128 for 20 registrations on
  // the authoring host) and socket presence is NEVER liveness evidence. Counted, never used.
  let orphanSockets: number | null = null;
  try {
    const { peerSocketDir } = await import('../src/activation/transport/peer-transport.js');
    const sockDir = peerSocketDir(dir);
    orphanSockets = existsSync(sockDir)
      ? readdirSync(sockDir).filter(f => f.endsWith('.sock')).length
      : 0;
  } catch { orphanSockets = null; }

  const report = {
    dir,
    total,
    live: scan.live.length,
    live_rate: Math.round(liveRate * 1000) / 1000,
    by_reason: {
      stale_no_proc: byReason.no_proc_entry,
      stale_procstart_mismatch: byReason.proc_start_mismatch,
      missing_procstart: byReason.missing_proc_start,
      no_socket_path: byReason.no_socket_path,
      unparsable: byReason.unparsable,
      unsupported_protocol: byReason.unsupported_peer_protocol,
    },
    orphan_sock_files_informational_only: orphanSockets,
    verdict,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`roster: ${dir}`);
  console.log(`total registrations: ${total}  live: ${scan.live.length}  live-rate: ${(liveRate * 100).toFixed(1)}%`);
  console.log(`stale_no_proc=${byReason.no_proc_entry} procstart_mismatch=${byReason.proc_start_mismatch} missing_procstart=${byReason.missing_proc_start} no_socket=${byReason.no_socket_path} unparsable=${byReason.unparsable} unsupported_protocol=${byReason.unsupported_peer_protocol}`);
  if (orphanSockets !== null) console.log(`orphan .sock files (informational, never liveness): ${orphanSockets}`);
  console.log(`verdict: ${verdict}`);
}

await main();
