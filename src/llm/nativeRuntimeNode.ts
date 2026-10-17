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

function listDevices(config: NativeRuntimeConfig): Promise<string> {
	return new Promise((resolve, reject) => {
		const process = spawn(config.executablePath, ["--list-devices"], {
			cwd: config.engineDir,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		process.stdout.setEncoding("utf8");
		process.stderr.setEncoding("utf8");
		process.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		process.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		process.once("error", reject);
		process.once("exit", (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`Vulkan device discovery exited with code ${code ?? "unknown"}`));
		});
	});
}

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

function spawnServer(config: NativeRuntimeConfig, args: readonly string[]): NativeProcess {
	return spawn(config.executablePath, args, {
		cwd: config.engineDir,
		windowsHide: true,
		stdio: "ignore",
	});
}

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
		process.once("exit", onExit);
	});
}

export const nativeRuntimeDependencies: NativeRuntimeDependencies = {
	listDevices,
	findAvailablePort,
	randomApiKey: () => randomBytes(16).toString("hex"),
	spawnServer,
	request,
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	waitForExit,
};
