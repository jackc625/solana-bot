import type { Connection, Keypair, PublicKey } from '@solana/web3.js';

export interface TradeParams {
  connection: Connection;
  wallet: Keypair;
  mint: string;
  amount: number;
  action: 'buy' | 'sell';
  denominatedInSol: boolean;
  slippage?: number;
  pool?: string;
  customTipAmount?: number;
  maxDelayMs?: number;
  priorityFee?: number;
}

export interface TradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  executionTime: number;
}

export interface ITradeExecutor {
  buy(params: TradeParams): Promise<string>;
  sell(params: TradeParams): Promise<string>;
  executeTrade(params: TradeParams): Promise<TradeResult>;
}

export interface RiskAssessmentResult {
  decision: 'allow' | 'deny' | 'defer';
  reason?: string;
  riskScore?: number;
  delayMs?: number;
}

export interface PositionUpdate {
  tokenMint: string;
  amount: number;
  entryPrice?: number;
  currentPrice?: number;
  pnl?: number;
  timestamp: number;
}

export interface IRiskManager {
  assessBeforeBuy(tokenMint: string, amount: number, context?: any): Promise<RiskAssessmentResult>;
  assessBeforeSell(tokenMint: string, amount: number, context?: any): Promise<RiskAssessmentResult>;
  onPositionUpdate(update: PositionUpdate): void;
  getCurrentRiskLevel(): string;
}

// Shared enums and constants
export enum ExecutionMethod {
  DIRECT = 'DIRECT',
  JITO_BUNDLE = 'JITO_BUNDLE',
  DUAL_EXECUTION = 'DUAL_EXECUTION',
}

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}