import { createInterface } from 'readline';
import {
  loadConfig,
  validateConfig,
  computeSplits,
  dryRunAll,
  printPlan,
  runWalletCli,
} from './planner.js';
import type { PayoutLine, ExecutedPayout } from './types.js';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function parseSignature(output: string): string | undefined {
  // Try several patterns to handle different wallet-cli output formats
  const patterns = [
    /broadcast\s*[→>]\s*([A-Za-z0-9]{44,})/i,
    /signature[:\s]+([A-Za-z0-9]{44,})/i,
    /Signed[^→>\n]*[→>][^→>\n]*[→>]\s*([A-Za-z0-9]{44,})/i,
    /([A-Za-z0-9]{87,88})\s*$/m, // Solana signatures are 87-88 base58 chars
  ];
  for (const p of patterns) {
    const m = output.match(p);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function wasRejected(output: string, exitCode: number): boolean {
  // exitCode 0 = success; only treat as rejected if process errored or explicit rejection text
  if (exitCode !== 0) return true;
  return /reject|cancel|denied|refused|user did not approve/i.test(output);
}

async function executePayouts(
  lines: PayoutLine[],
  treasuryLabel: string,
): Promise<ExecutedPayout[]> {
  const results: ExecutedPayout[] = [];

  for (const line of lines) {
    console.log(`\n  ▶  ${line.recipient.name}  —  ${line.amount_sol.toFixed(6)} SOL`);
    console.log(`     To: ${line.recipient.address}`);
    console.log('     → Review on your Ledger screen and approve or reject.\n');

    const { stdout, stderr, exitCode } = await runWalletCli(
      `send ${treasuryLabel} --to ${line.recipient.address} --amount '${line.amount_sol} SOL'`
    );
    const combined = (stdout + stderr).trim();
    const sig = parseSignature(combined);
    const rejected = wasRejected(combined, exitCode);

    if (!rejected) {
      const displaySig = sig ?? '(see output above)';
      console.log(`     ✔  Signed → broadcast → ${displaySig}`);
      results.push({ recipient: line.recipient, amount_sol: line.amount_sol, signature: sig, rejected: false, raw_output: combined });
    } else {
      console.log('     ✗  Rejected on device — nothing broadcast.');
      results.push({ recipient: line.recipient, amount_sol: line.amount_sol, rejected: true, raw_output: combined });
    }
  }

  return results;
}

async function main(): Promise<void> {
  console.log('\n  ╔════════════════════════════════════════════════════╗');
  console.log('  ║       SHAKEDOWN PAYOUT AGENT  ·  Ledger Stack      ║');
  console.log('  ╚════════════════════════════════════════════════════╝');
  console.log('\n  DISCLAIMER: Technology demo. Not a financial service.');
  console.log('  Every transfer requires physical approval on the Ledger device.\n');

  const cfg = loadConfig();
  validateConfig(cfg);

  const lines = computeSplits(cfg);

  console.log('  Computing splits and running dry-run previews...\n');
  await dryRunAll(lines, cfg.treasury.label);
  printPlan(lines, cfg);

  // --dry-run flag: print plan and exit
  if (process.argv.includes('--dry-run')) {
    console.log('\n  [--dry-run]  Plan preview only — no transfers executed.\n');
    return;
  }

  console.log('\n  Each payout will pause for device approval. Rejecting any one stops that transfer.');
  const confirm = await prompt('\n  Execute all payouts? (yes/no): ');
  if (confirm !== 'yes') {
    console.log('\n  Aborted. No transfers executed.\n');
    return;
  }

  console.log('\n  Ensure your Ledger Nano S Plus is plugged in and the Solana app is open.');
  const ready = await prompt('  Ready to proceed? (yes/no): ');
  if (ready !== 'yes') {
    console.log('\n  Aborted.\n');
    return;
  }

  const results = await executePayouts(lines, cfg.treasury.label);

  const succeeded = results.filter(r => !r.rejected);
  const rejected = results.filter(r => r.rejected);

  console.log('\n' + '─'.repeat(64));
  console.log('  PAYOUT RESULTS');
  console.log('─'.repeat(64));
  for (const r of results) {
    const status = r.rejected
      ? '✗  REJECTED'
      : `✔  ${r.signature?.slice(0, 10)}...`;
    console.log(
      pad(`  ${r.recipient.name}`, 14) +
      pad(`  ${r.amount_sol.toFixed(6)} SOL`, 18) +
      `  ${status}`
    );
  }
  console.log('─'.repeat(64));
  console.log(`  Sent: ${succeeded.length}  |  Rejected: ${rejected.length}`);
  if (succeeded.length > 0) {
    console.log(`\n  Verify with: wallet-cli operations ${cfg.treasury.label}`);
  }
  console.log('─'.repeat(64) + '\n');
}

main().catch(err => {
  console.error('\n  ERROR:', (err as Error).message);
  process.exit(1);
});
