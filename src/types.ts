export interface Recipient {
  name: string;
  address: string;
  pct: number;
}

export interface Show {
  name: string;
  date: string;
  venue: string;
}

export interface Treasury {
  label: string;
  address: string;
}

export interface PayoutConfig {
  show: Show;
  treasury: Treasury;
  gross_revenue_sol: number;
  splits: Recipient[];
}

export interface PayoutLine {
  recipient: Recipient;
  amount_sol: number;
  fee_sol: number | null;
  dry_run_output: string;
}

export interface ExecutedPayout {
  recipient: Recipient;
  amount_sol: number;
  signature?: string;
  rejected: boolean;
  raw_output: string;
}
