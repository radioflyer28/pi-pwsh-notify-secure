export type NotificationKind = "ready" | "finished";

export interface NotificationItem<T> {
	jobId: string;
	kind: NotificationKind;
	content: string;
	details: T;
}

interface QueuedNotification<T> extends NotificationItem<T> {
	attempts: number;
}

export interface NotificationQueueOptions {
	debounceMs?: number;
	maxItems?: number;
	maxChars?: number;
	maxAttempts?: number;
	retryDelaysMs?: number[];
	onDrop?: (error: unknown, count: number) => void;
}

export class NotificationQueue<T> {
	private readonly send: (items: ReadonlyArray<NotificationItem<T>>) => void;
	private readonly options: NotificationQueueOptions;
	private readonly pending: Array<QueuedNotification<T>> = [];
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;
	private readonly debounceMs: number;
	private readonly maxItems: number;
	private readonly maxChars: number;
	private readonly maxAttempts: number;
	private readonly retryDelaysMs: number[];

	constructor(
		send: (items: ReadonlyArray<NotificationItem<T>>) => void,
		options: NotificationQueueOptions = {},
	) {
		this.send = send;
		this.options = options;
		this.debounceMs = options.debounceMs ?? 250;
		this.maxItems = Math.max(1, options.maxItems ?? 10);
		this.maxChars = Math.max(1, options.maxChars ?? 16_000);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
		this.retryDelaysMs = options.retryDelaysMs ?? [250, 500, 1_000];
	}

	enqueue(item: NotificationItem<T>): void {
		if (this.disposed) return;
		if (item.content.length > this.maxChars) {
			this.options.onDrop?.(new Error(`Notification exceeds the ${this.maxChars}-character limit`), 1);
			return;
		}
		this.pending.push({ ...item, attempts: 0 });
		this.schedule(this.debounceMs);
	}

	cancel(jobId: string, kinds?: ReadonlyArray<NotificationKind>): number {
		const allowed = kinds ? new Set(kinds) : undefined;
		let removed = 0;
		for (let index = this.pending.length - 1; index >= 0; index--) {
			const item = this.pending[index];
			if (item.jobId === jobId && (!allowed || allowed.has(item.kind))) {
				this.pending.splice(index, 1);
				removed++;
			}
		}
		return removed;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.length = 0;
	}

	private schedule(delayMs: number): void {
		if (this.disposed || this.timer || this.pending.length === 0) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, delayMs);
		this.timer.unref?.();
	}

	private takeBatch(): Array<QueuedNotification<T>> {
		const batch: Array<QueuedNotification<T>> = [];
		let chars = 0;
		while (this.pending.length > 0 && batch.length < this.maxItems) {
			const next = this.pending[0];
			if (batch.length > 0 && chars + next.content.length > this.maxChars) break;
			batch.push(this.pending.shift()!);
			chars += next.content.length;
		}
		return batch;
	}

	private flush(): void {
		if (this.disposed || this.pending.length === 0) return;
		const batch = this.takeBatch();
		try {
			this.send(batch);
			this.schedule(this.debounceMs);
		} catch (error) {
			for (const item of batch) item.attempts++;
			const retryable = batch.filter((item) => item.attempts < this.maxAttempts);
			const dropped = batch.length - retryable.length;
			if (retryable.length > 0) this.pending.unshift(...retryable);
			if (dropped > 0) this.options.onDrop?.(error, dropped);
			const attempt = Math.max(1, ...batch.map((item) => item.attempts));
			const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? this.debounceMs;
			this.schedule(delay);
		}
	}
}
