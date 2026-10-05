/** A race chooses success, not the first completion (which may be an error). */
export class SuccessRace<T> {
	readonly result: Promise<{ value: T; owner: string }>;
	private resolve!: (result: { value: T; owner: string }) => void;
	private pending = 0;
	private finished = false;
	private readonly cancellations = new Map<string, () => void>();
	private failure?: { value: T; owner: string };
	private readonly successful: (value: T) => boolean;
	private readonly failed: (error: unknown) => T;
	private readonly cancellationFailed?: (error: unknown, owner: string) => void;
	get isFinished(): boolean {
		return this.finished;
	}

	constructor(
		successful: (value: T) => boolean,
		failed: (error: unknown) => T,
		cancellationFailed?: (error: unknown, owner: string) => void,
	) {
		this.successful = successful;
		this.failed = failed;
		this.cancellationFailed = cancellationFailed;
		this.result = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	add(owner: string, promise: Promise<T>, cancel: () => void): boolean {
		if (this.finished || this.cancellations.has(owner)) return false;
		this.cancellations.set(owner, cancel);
		this.pending += 1;
		const settle = (value: T) => {
			this.pending -= 1;
			if (this.finished) return;
			if (this.successful(value)) {
				this.finish({ value, owner });
				return;
			}
			if (!this.failure || owner === "actor") this.failure = { value, owner };
			if (this.pending === 0) this.finish(this.failure);
		};
		void promise.then(settle, (error) => settle(this.failed(error)));
		return true;
	}

	abort(value: T): void {
		if (!this.finished) this.finish({ value, owner: "aborted" });
	}

	private finish(result: { value: T; owner: string }): void {
		this.finished = true;
		this.resolve(result);
		for (const [owner, cancel] of this.cancellations) {
			if (owner === result.owner) continue;
			try {
				cancel();
			} catch (error) {
				try {
					this.cancellationFailed?.(error, owner);
				} catch {
					/* Diagnostic callbacks cannot veto an already selected winner. */
				}
			}
		}
	}
}
