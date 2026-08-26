import { afterEach, describe, expect, it, vi } from "vitest";
import {
	flushRawStdout,
	isStdoutBroken,
	isStdoutTakenOver,
	restoreStdout,
	takeOverStdout,
	writeRawStdout,
} from "../../../src/core/output-guard.ts";

/**
 * Stub process.stdout.write so that invoking the supplied callback reports the
 * given error asynchronously (like a real Socket write that fails). Once stdout
 * is taken over, the captured raw write is the bound stub, driving the actual
 * writeRawStdout/flushRawStdout code paths.
 */
function stubStdoutWriteWithCallbackError(error?: Error | null): void {
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: unknown,
		encodingOrCallback?: unknown,
		callback?: unknown,
	) => {
		const cb =
			typeof encodingOrCallback === "function"
				? encodingOrCallback
				: typeof callback === "function"
					? callback
					: undefined;
		if (cb) {
			// Report success or failure asynchronously, like a real async write.
			void Promise.resolve().then(() => (cb as (err?: Error | null) => void)(error));
		}
		return true;
	}) as typeof process.stdout.write);
}

describe("output-guard stdout 'error' handling", () => {
	afterEach(() => {
		// Ensure the takeover listener is always cleaned up between tests.
		if (isStdoutTakenOver()) {
			restoreStdout();
		}
		vi.restoreAllMocks();
	});

	it("attaches a listener to process.stdout while taken over that swallows EPIPE", () => {
		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);
		expect(process.stdout.listenerCount("error")).toBe(1);

		const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		// With no 'error' listener, EventEmitter.emit("error") throws synchronously.
		// The takeover listener must swallow EPIPE so it never becomes unhandled.
		expect(() => process.stdout.emit("error", epipe)).not.toThrow();
	});

	it("forwards non-EPIPE stdout errors to stderr", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		takeOverStdout();

		const eio = Object.assign(new Error("write EIO"), { code: "EIO" });
		expect(() => process.stdout.emit("error", eio)).not.toThrow();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("EIO"));
	});

	it("removes the listener when the takeover is restored", () => {
		takeOverStdout();
		expect(process.stdout.listenerCount("error")).toBe(1);

		restoreStdout();
		expect(process.stdout.listenerCount("error")).toBe(0);
		expect(isStdoutTakenOver()).toBe(false);
	});

	it("absorbs EPIPE from the write callback across fire-and-forget and flush paths", async () => {
		const onUnhandledRejection = vi.fn();
		const onUncaughtException = vi.fn();
		process.on("unhandledRejection", onUnhandledRejection);
		process.on("uncaughtException", onUncaughtException);
		stubStdoutWriteWithCallbackError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		takeOverStdout();

		// Fire-and-forget write (writeRawStdout tail).
		writeRawStdout("hello\n");
		// Bare-awaited flush (like runPrintMode's `finally { await flushRawStdout() }`).
		await flushRawStdout();

		// Give any pending rejection a tick to surface.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(onUnhandledRejection).not.toHaveBeenCalled();
		expect(onUncaughtException).not.toHaveBeenCalled();
		process.off("unhandledRejection", onUnhandledRejection);
		process.off("uncaughtException", onUncaughtException);
	});

	it("does not swallow non-EPIPE write-callback errors (they still reject)", async () => {
		stubStdoutWriteWithCallbackError(Object.assign(new Error("write EIO"), { code: "EIO" }));
		takeOverStdout();

		// flushRawStdout devolves to await writeRawStdoutChunk(""), which rejects on EIO.
		await expect(flushRawStdout()).rejects.toMatchObject({ code: "EIO" });
	});

	it("sets isStdoutBroken() when the write callback reports EPIPE", async () => {
		stubStdoutWriteWithCallbackError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		takeOverStdout();
		expect(isStdoutBroken()).toBe(false);

		writeRawStdout("hello\n");
		await flushRawStdout();
		expect(isStdoutBroken()).toBe(true);
	});

	it("sets isStdoutBroken() when the Socket emits an EPIPE error event", () => {
		stubStdoutWriteWithCallbackError(null);
		takeOverStdout();
		expect(isStdoutBroken()).toBe(false);

		process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		expect(isStdoutBroken()).toBe(true);
	});

	it("resets isStdoutBroken() on a fresh takeOverStdout()", () => {
		stubStdoutWriteWithCallbackError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		takeOverStdout();
		writeRawStdout("x\n");
		// Let the EPIPE-in-callback path run and set the flag.
		flushRawStdout();

		expect(isStdoutBroken()).toBe(true);
		restoreStdout();
		takeOverStdout();
		expect(isStdoutBroken()).toBe(false);
	});
});
