export class Pool {
  private available: number;
  constructor(capacity: number) {
    this.available = capacity;
  }
  async reserve(amount: number): Promise<boolean> {
    if (amount <= 0) throw new Error("invalid amount");
    if (this.available < amount) return false;
    await Promise.resolve();
    this.available -= amount;
    return true;
  }
  remaining() {
    return this.available;
  }
}
