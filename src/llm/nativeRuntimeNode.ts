import { Buffer } from "buffer";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { createServer } from "net";
import type {
	NativeProcess,
	NativeRequest,
	NativeResponse,
	NativeRuntimeConfig,
	NativeRuntimeDependencies,
} from "./nativeRuntime";

/** Default timeout in milliseconds for Vulkan device discovery (`--list-devices`). */
export const LIST_DEVICES_TIMEOUT_MS = 10_000;

/**
 * Spawns the native server executable with `--list-devices` and returns its combined stdout/stderr output.
 * Kills the child process with `SIGKILL` if discovery does not finish within `timeoutMs`.
 */
export function listDevices(
	config: NativeRuntimeConfig,
	timeoutMs = LIST_DEVICES_TIMEOUT_MS,
	args: readonly string[] = ["--list-devices"],
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(config.executablePath, args, {
			cwd: config.engineDir,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let settled = false;
		const unregisterExitHook = registerExitHook(() => {
			if (!settled) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		});
		const finish = (): void => {
			unregisterExitHook();
			clearTimeout(timer);
			child.removeListener("error", onError);
			child.removeListener("close", onExit);
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			finish();
			reject(error);
		};
		const onExit = (code: number | null): void => {
			if (settled) return;
			settled = true;
			finish();
			if (code === 0) resolve(output);
			else reject(new Error(`Vulkan device discovery exited with code ${code ?? "unknown"}`));
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			finish();
			child.once("error", () => undefined);
			try {
				child.kill("SIGKILL");
			} catch {
				// Ignore kill errors when terminating a timed-out discovery process
			}
			reject(new Error("Vulkan device discovery timed out"));
		}, timeoutMs);
		(timer as { unref?: () => void })?.unref?.();

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", onError);
		child.once("close", onExit);
	});
}

/**
 * Allocates an ephemeral loopback TCP port by binding and immediately closing a temporary server.
 */
function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate a loopback port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

/**
 * Spawns the native `llama-server` child process with hidden console output.
 */
function spawnServer(config: NativeRuntimeConfig, args: readonly string[]): NativeProcess {
	return spawn(config.executablePath, args, {
		cwd: config.engineDir,
		windowsHide: true,
		stdio: "ignore",
	});
}

/**
 * Sends an authenticated HTTP request to the local native server over loopback.
 */
function request(options: NativeRequest): Promise<NativeResponse> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				hostname: "127.0.0.1",
				port: options.port,
				path: options.path,
				method: options.method,
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					...(options.body === undefined
						? {}
						: {
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(options.body),
						}),
				},
				timeout: options.timeoutMs,
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.once("error", reject);
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => resolve({ statusCode: response.statusCode, body }));
			},
		);
		request.once("error", reject);
		request.once("timeout", () => request.destroy(new Error("Native server request timed out")));
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

/**
 * Waits up to `timeoutMs` for a native child process to emit `"exit"`, returning `true` if it exited in time.
 */
function waitForExit(process: NativeProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const onExit = (): void => {
			clearTimeout(timeout);
			resolve(true);
		};
		const timeout = setTimeout(() => {
			process.removeListener("exit", onExit);
			resolve(false);
		}, timeoutMs);
		(timeout as { unref?: () => void })?.unref?.();
		process.once("exit", onExit);
	});
}

/**
 * Registers a synchronous process/window exit hook so an active child process is killed on app/renderer teardown.
 * Returns an idempotent cleanup function that removes all registered listeners.
 */
export function registerExitHook(onExit: () => void): () => void {
	let active = true;
	const cleanup = (): void => {
		if (!active) return;
		active = false;
		process.removeListener("exit", handler);
		if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
			window.removeEventListener("pagehide", handler);
			window.removeEventListener("beforeunload", handler);
		}
	};
	const handler = (): void => {
		if (!active) return;
		cleanup();
		onExit();
	};
	process.once("exit", handler);
	if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
		window.addEventListener("pagehide", handler);
		window.addEventListener("beforeunload", handler);
	}
	return cleanup;
}

/** Default Node.js process and HTTP dependency implementation for `NativeRuntime`. */
export const nativeRuntimeDependencies: NativeRuntimeDependencies = {
	listDevices,
	findAvailablePort,
	randomApiKey: () => randomBytes(16).toString("hex"),
	spawnServer,
	request,
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	waitForExit,
	registerExitHook,
};
