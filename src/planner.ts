import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PayoutConfig, PayoutLine } from './types.js';

const execAsync = promisify(exec);

export function loadConfig(): PayoutConfig {
  const path = join(process.cwd(), 'payout.config.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as PayoutConfig;
}

export function validateConfig(cfg: PayoutConfig): void {
  const total = cfg.splits.reduce((sum, s) => sum + s.pct, 0);
  if (total !== 100) {
    throw new Error(`Splits must sum to 100, got ${total}`);
  }
  if (cfg.gross_revenue_sol <= 0) {
    throw new Error('gross_revenue_sol must be positive');
  }
  for (const s of cfg.splits) {
    if (s.address.startsWith('FILL_IN')) {
      throw new Error(
        `Recipient "${s.name}" has a placeholder address — run wallet-cli account discover solana and update payout.config.json`
      );
    }
  }
}

export function computeSplits(cfg: PayoutConfig): PayoutLine[] {
  return cfg.splits.map(r => ({
    recipient: r,
    // Round to lamport precision (9 decimals) to avoid floating-point dust
    amount_sol: Math.round((r.pct / 100) * cfg.gross_revenue_sol * 1_000_000_000) / 1_000_000_000,
    fee_sol: null,
    dry_run_output: '',
  }));
}

export async function runWalletCli(args: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(`wallet-cli ${args}`, { timeout: 120_000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), exitCode: err.code ?? 1 };
  }
}

function parseFee(output: string): number | null {
  // Matches "Fees:   0.000005 SOL" (wallet-cli dry-run format)
  const solMatch = output.match(/fees?[:\s]+([0-9.]+)\s*SOL/i);
  if (solMatch) return parseFloat(solMatch[1]);
  const lamportMatch = output.match(/fees?[:\s]+([0-9]+)\s*lamports?/i);
  if (lamportMatch) return parseInt(lamportMatch[1]) / 1_000_000_000;
  return null;
}

export async function dryRunAll(lines: PayoutLine[], treasuryLabel: string): Promise<void> {
  for (const line of lines) {
    const { stdout, stderr } = await runWalletCli(
      `send ${treasuryLabel} --to ${line.recipient.address} --amount '${line.amount_sol} SOL' --dry-run`
    );
    const combined = (stdout + stderr).trim();
    line.fee_sol = parseFee(combined);
    line.dry_run_output = combined;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function printPlan(lines: PayoutLine[], cfg: PayoutConfig): void {
  const totalPayout = lines.reduce((s, l) => s + l.amount_sol, 0);
  const totalFees = lines.reduce((s, l) => s + (l.fee_sol ?? 0.000005), 0);
  const FALLBACK_FEE = '~0.000005';

  console.log('\n' + '─'.repeat(64));
  console.log('  SHAKEDOWN PAYOUT PLAN');
  console.log(`  ${cfg.show.name}`);
  console.log(`  ${cfg.show.date} · ${cfg.show.venue}`);
  console.log('─'.repeat(64));
  console.log(
    pad('  Recipient', 16) +
    pad('  Pct', 6) +
    pad('  Amount (SOL)', 18) +
    pad('  Est. Fee', 16) +
    '  Address'
  );
  console.log('─'.repeat(64));

  for (const l of lines) {
    const fee = l.fee_sol != null ? l.fee_sol.toFixed(6) : FALLBACK_FEE;
    const shortAddr = l.recipient.address.slice(0, 8) + '...' + l.recipient.address.slice(-4);
    console.log(
      pad(`  ${l.recipient.name}`, 16) +
      pad(`  ${l.recipient.pct}%`, 6) +
      pad(`  ${l.amount_sol.toFixed(6)} SOL`, 18) +
      pad(`  ${fee} SOL`, 16) +
      `  ${shortAddr}`
    );
  }

  console.log('─'.repeat(64));
  console.log(`  Total payout : ${totalPayout.toFixed(6)} SOL`);
  console.log(`  Est. fees    : ${totalFees.toFixed(6)} SOL`);
  console.log(`  Treasury     : ${cfg.treasury.label} (${cfg.treasury.address})`);
  console.log('─'.repeat(64));
}
