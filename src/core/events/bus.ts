import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();

export type DomainEvent =
  | { type: 'OrderPlaced'; payload: { tokenMint: string; amount: number; action: 'buy' | 'sell'; signature?: string } }
  | { type: 'PositionOpened'; payload: { tokenMint: string; amount: number; entryPrice: number; timestamp: number } }
  | { type: 'RiskUpdated'; payload: { tokenMint: string; riskLevel: string; reason: string } }
  | { type: 'AutoSellTrigger'; payload: { tokenMint: string; reason: string; targetPrice?: number } };

export const emit = (e: DomainEvent) => bus.emit(e.type, e);

export const on = <T extends DomainEvent['type']>(
  type: T, 
  handler: (event: Extract<DomainEvent, { type: T }>) => void
) => {
  bus.on(type, handler as any);
  return () => bus.off(type, handler as any);
};