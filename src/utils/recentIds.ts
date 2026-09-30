/** A set that forgets its oldest members past `limit`. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly limit: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    for (const oldest of this.ids) {
      if (this.ids.size <= this.limit) {
        break;
      }
      this.ids.delete(oldest);
    }
  }
}
