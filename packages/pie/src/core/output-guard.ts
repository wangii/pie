interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
	onStdoutError: (error: Error) => void;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

// Set when the stdout consumer closes the pipe (EPIPE). output-guard absorbs the
// error so neither the write callback nor the Socket's independent 'error' event
// can become an unhandled crash, but callers use isStdoutBroken() to report the
// truncation as a controlled non-zero exit instead of a silent success.
let stdoutBroken = false;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			// The consumer closed the pipe (e.g. `pi | head`). This is not an error the
			// process should crash on: the write callback already rejects and the Socket
			// also emits its own 'error' event, which the takeover listener swallows. Treat
			// EPIPE as "output disconnected" and resolve so neither the fire-and-forget
			// writeRawStdout tail nor the awaited flushRawStdout can surface an unhandled
			// rejection. Other errors (EIO, etc.) remain fatal.
			if (code === "EPIPE") {
				stdoutBroken = true;
				return;
			}
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	stdoutBroken = false;

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	// process.stdout is a Socket that emits its own 'error' event (e.g. EPIPE when
	// the consumer closes the pipe) independently of the write callback. Without a
	// listener this becomes an unhandled 'error' event that crashes the process even
	// though the write callback already reports the failure. Attach a persistent
	// listener for the duration of the takeover; the write callback remains the
	// source of truth for per-write errors, so this listener only prevents the
	// socket's independent event from becoming an uncaught exception.
	const onStdoutError = (error: Error) => {
		const code = (error as Error & { code?: unknown }).code;
		if (code === "EPIPE") {
			stdoutBroken = true;
			return;
		}
		process.stderr.write(`[output-guard] stdout error: ${error.message}\n`);
	};
	process.stdout.on("error", onStdoutError);

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
		onStdoutError,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	const onStdoutError = stdoutTakeoverState.onStdoutError;
	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	process.stdout.off("error", onStdoutError);
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

// Returns true if the consumer closed the pipe while output was being written.
// Callers that own the process exit code use this to exit non-zero on truncation
// (rather than treating EPIPE as a silent success).
export function isStdoutBroken(): boolean {
	return stdoutBroken;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
