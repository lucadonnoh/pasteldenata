export interface SerialJobTask {
  onStart: () => void;
  onPosition: (position: number) => void;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Runs jobs one at a time while immediately giving every caller its own
 * queued record. Serial execution is a correctness boundary: the Hedera demo
 * deliberately reuses parent buyer wallets between runs.
 */
export class SerialJobQueue {
  private active = false;
  private readonly pending: SerialJobTask[] = [];

  enqueue(task: SerialJobTask): void {
    this.pending.push(task);
    this.startNext();
    this.refreshPositions();
  }

  private refreshPositions(): void {
    this.pending.forEach((task, index) => task.onPosition(index + 1));
  }

  private startNext(): void {
    if (this.active) return;
    const task = this.pending.shift();
    if (!task) return;

    this.active = true;
    try {
      task.onStart();
    } catch (error) {
      task.onError(error);
      this.active = false;
      this.startNext();
      this.refreshPositions();
      return;
    }
    void Promise.resolve()
      .then(task.run)
      .catch(task.onError)
      .finally(() => {
        this.active = false;
        this.startNext();
        this.refreshPositions();
      });
  }
}
