import http from "node:http";
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { X509Certificate, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { validateProfile, type ConnectionProfile } from "./connection-profile.ts";

/** Ordered SSE delivery; deliberately no reconnect or request replay. */
export class HTTPWire extends EventEmitter {
	destroyed = false;
	private stream?: http.IncomingMessage;
	private requests = new Set<http.ClientRequest>();
	private profiles = new Map<string, Promise<string>>();
	constructor(
		private profile: ConnectionProfile,
		private clientId: string,
	) {
		super();
		validateProfile(profile, true);
	}
	setEncoding(_encoding: string) {
		return this;
	}
	private request(method: string, path: string, body?: unknown): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const url = new URL(path, this.profile.origin);
			const certificate = this.profile.certificate;
			const options: https.RequestOptions = {
				method,
				headers: {
					Authorization: `Bearer ${this.profile.token}`,
					"X-Pi-Client": this.clientId,
					"Content-Type": "application/json",
				},
				...(url.protocol === "https:"
					? {
							ca: certificate,
							rejectUnauthorized: true,
							agent: false,
							checkServerIdentity: (host, cert) => {
								const error = checkServerIdentity(host, cert);
								if (error) return error;
								const expected = new X509Certificate(certificate!).raw;
								if (
									!cert.raw ||
									expected.length !== cert.raw.length ||
									!timingSafeEqual(expected, cert.raw)
								)
									return Error("CERTIFICATE_PIN_MISMATCH");
							},
						}
					: {}),
			};
			const req = (url.protocol === "https:" ? https : http).request(url, options, (response) => {
				if ((response.statusCode ?? 500) >= 300) {
					response.resume();
					reject(Error(`HTTP_TRANSPORT_${response.statusCode}`));
				} else resolve(response);
			});
			this.requests.add(req);
			req.once("close", () => this.requests.delete(req));
			req.once("error", () => reject(Error("HTTP_TRANSPORT_FAILED")));
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	private async json(method: string, path: string, body?: unknown) {
		const response = await this.request(method, path, body);
		const chunks: Buffer[] = [];
		for await (const chunk of response) chunks.push(Buffer.from(chunk));
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
	async open() {
		const response = await this.request("GET", "/v1/events");
		this.stream = response;
		response.setEncoding("utf8");
		let chunks: string[] = [],
			data: string[] = [],
			event = "";
		response.on("data", (chunk: string) => {
			// Keep incomplete long lines as chunks, avoiding quadratic snapshot copying.
			let start = 0;
			for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", start)) {
				chunks.push(chunk.slice(start, i));
				const line = chunks.join("").replace(/\r$/, "");
				chunks = [];
				start = i + 1;
				if (!line) {
					if (event === "gap") {
						this.destroy(Error("EVENT_HISTORY_LOST"));
						return;
					}
					if (data.length) this.emit("data", data.join("\n") + "\n");
					data = [];
					event = "";
				} else if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			}
			if (start < chunk.length) chunks.push(chunk.slice(start));
		});
		response.once("end", () => this.destroy());
		response.once("error", () => this.destroy());
		response.once("close", () => this.destroy());
	}
	write(line: string) {
		if (this.destroyed) return false;
		const frame = JSON.parse(line);
		const reads = ["list", "get", "snapshot", "operation", "serviceRead"];
		const response =
			frame.method === "hello"
				? this.json("GET", "/v1/hello").then((result) => ({ replyTo: frame.id, result }))
				: reads.includes(frame.method) && !(frame.method === "serviceRead" && frame.params?.operation === "commandCompletions")
					? this.readState(frame).then((reply) => ({ ...reply, replyTo: frame.id }))
					: frame.method === "create" && frame.params?.profile !== undefined
						? this.profileParameters(frame).then((params) => this.json("POST", "/v1/rpc", { ...frame, params }))
						: this.json("POST", "/v1/rpc", frame);
		void response
			.then((reply) => this.emit("data", JSON.stringify(reply) + "\n"))
			.catch(() => this.destroy());
		return true;
	}
	private async profileParameters(frame: { id: number; params?: Record<string, unknown> }) {
		const params = { ...frame.params };
		if (params.profile !== undefined) {
			// Launch environments can contain secrets: never encode them into GET URLs.
			const key = JSON.stringify(params.profile);
			let registered = this.profiles.get(key);
			if (!registered) {
				registered = this.json("POST", "/v1/rpc", {
					id: frame.id,
					method: "registerProfile",
					params: { profile: params.profile },
				}).then((reply) => {
					if (reply.error || typeof reply.result?.profileId !== "string")
						throw Error("PROFILE_REGISTRATION_FAILED");
					return reply.result.profileId as string;
				});
				this.profiles.set(key, registered);
			}
			params.profileId = await registered;
			delete params.profile;
		}
		return params;
	}
	private async readState(frame: { id: number; method: string; params?: Record<string, unknown> }) {
		const params = await this.profileParameters(frame);
		return this.json(
			"GET",
			`/v1/state?${new URLSearchParams({ method: frame.method, params: JSON.stringify(params) })}`,
		);
	}
	end() {
		this.destroy();
	}
	destroy(error?: Error) {
		if (this.destroyed) return;
		this.destroyed = true;
		this.stream?.destroy();
		for (const request of this.requests) request.destroy();
		if (error && this.listenerCount("error")) this.emit("error", error);
		this.emit("close");
	}
}
