import { Item, Warehouse } from './models';
import { logger } from './logger';
import { metrics } from './metrics';

// Inventory service: tracks stock levels across warehouses.
export class InventoryService {
  private readonly stock = new Map<string, number>();
  private readonly warehouses: Warehouse[] = [];

  constructor(private readonly maxPerItem: number) {}

  addWarehouse(w: Warehouse): void {
    this.warehouses.push(w);
    logger.info(`Added warehouse ${w.name}`);
  }

  receive(item: Item, quantity: number): void {
    if (quantity <= 0) {
      throw new RangeError('Quantity must be positive');
    }
    const current = this.stock.get(item.sku) ?? 0;
    const next = Math.min(current + quantity, this.maxPerItem);
    this.stock.set(item.sku, next);
    metrics.increment('inventory.received', quantity);
  }

  ship(item: Item, quantity: number): boolean {
    const current = this.stock.get(item.sku) ?? 0;
    if (current < quantity) {
      return false;
    }
    this.stock.set(item.sku, current - quantity);
    return true;
  }

  countAll(): number {
    let total = 0;
    for (const q of this.stock.values()) total += q;
    return total;
  }
}
