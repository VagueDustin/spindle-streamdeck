import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { RawEntity } from "../../src/ha/playerState";

export type Msg = Record<string, unknown> & { id?: number; type?: string };

export type FakeHaOptions = {
	token: string;
	entities?: Record<string, RawEntity>;
	/** Answer `subscribe_entities` with `{success:false, error:{code:"unknown_command"}}`. */
	rejectSubscribeEntities?: boolean;
	/** The `message` sent with `auth_invalid`. */
	authInvalidMessage?: string;
	/** Answer `call_service` with `{success:false, error:{code, message}}`. */
	serviceError?: { code: string; message: string };
};

type Client = {
	socket: ServerSocket;
	authed: boolean;
	/** subscribe_entities subscription id -> requested entity ids. */
	entitySubs: Map<number, string[]>;
	/** subscribe_events state_changed subscription ids. */
	eventSubs: Set<number>;
};

export const HA_VERSION = "2026.10.0";

/** A minimal Home Assistant WebSocket API on an ephemeral localhost port. */
export class FakeHa {
	/** Every message received after auth, in order, across all connections. */
	readonly received: Msg[] = [];
	readonly serviceCalls: Msg[] = [];
	readonly entities: Map<string, RawEntity>;
	/** Total connections accepted. */
	connections = 0;

	private readonly clients = new Set<Client>();
	private pongs = true;
	private refusing = false;
	private readonly held = new Set<string>();

	private constructor(private readonly server: WebSocketServer, private readonly opts: FakeHaOptions) {
		this.entities = new Map(Object.entries(opts.entities ?? {}));
		server.on("connection", (socket) => this.accept(socket));
	}

	static async start(opts: FakeHaOptions): Promise<FakeHa> {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
		return new FakeHa(server, opts);
	}

	get url(): string {
		const { port } = this.server.address() as AddressInfo;
		return `ws://127.0.0.1:${port}/api/websocket`;
	}

	/** Currently open sockets. */
	get open(): number {
		return this.clients.size;
	}

	/** Messages of one type received after auth. */
	sent(type: string): Msg[] {
		return this.received.filter((m) => m.type === type);
	}

	/** Sends a raw message to every authenticated client. */
	push(msg: unknown): void {
		for (const client of this.clients) {
			if (client.authed) {
				client.socket.send(JSON.stringify(msg));
			}
		}
	}

	/** Sends a subscribe_entities event payload (`{a?, c?, r?}`) to every entity subscription. */
	pushEntities(event: unknown): void {
		for (const client of this.clients) {
			for (const id of client.entitySubs.keys()) {
				client.socket.send(JSON.stringify({ id, type: "event", event }));
			}
		}
	}

	/** Sends a state_changed event to every state_changed subscription. */
	pushStateChanged(entityId: string, newState: RawEntity | null): void {
		const data = {
			entity_id: entityId,
			old_state: null,
			new_state: newState && { entity_id: entityId, ...newState }
		};
		for (const client of this.clients) {
			for (const id of client.eventSubs) {
				client.socket.send(JSON.stringify({ id, type: "event", event: { event_type: "state_changed", data } }));
			}
		}
	}

	/** Abruptly drops every open connection. */
	dropAll(): void {
		for (const client of this.clients) {
			client.socket.terminate();
		}
	}

	/** Stops answering `ping`. */
	silencePongs(): void {
		this.pongs = false;
	}

	/** Records messages of this type but never answers them. */
	holdReplies(type: string): void {
		this.held.add(type);
	}

	/** While refusing, new connections are closed before `auth_required`. */
	refuse(on: boolean): void {
		this.refusing = on;
	}

	async close(): Promise<void> {
		for (const client of this.clients) {
			client.socket.terminate();
		}
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: ServerSocket): void {
		this.connections++;
		if (this.refusing) {
			socket.close(1013, "try again later");
			return;
		}
		const client: Client = { socket, authed: false, entitySubs: new Map(), eventSubs: new Set() };
		this.clients.add(client);
		socket.on("close", () => this.clients.delete(client));
		socket.on("message", (data) => this.onMessage(client, JSON.parse(String(data)) as Msg));
		socket.send(JSON.stringify({ type: "auth_required", ha_version: HA_VERSION }));
	}

	private onMessage(client: Client, msg: Msg): void {
		const reply = (body: Record<string, unknown>) => client.socket.send(JSON.stringify({ id: msg.id, ...body }));
		const ok = (result: unknown = null) => reply({ type: "result", success: true, result });

		if (!client.authed) {
			if (msg.type === "auth" && msg.access_token === this.opts.token) {
				client.authed = true;
				client.socket.send(JSON.stringify({ type: "auth_ok", ha_version: HA_VERSION }));
			} else {
				client.socket.send(JSON.stringify({ type: "auth_invalid", message: this.opts.authInvalidMessage ?? "Invalid access token or password" }));
				client.socket.close();
			}
			return;
		}

		this.received.push(msg);
		if (this.held.has(msg.type ?? "")) {
			return;
		}
		switch (msg.type) {
			case "ping":
				if (this.pongs) {
					reply({ type: "pong" });
				}
				break;
			case "get_states":
				ok([...this.entities].map(([entity_id, raw]) => ({ entity_id, ...raw })));
				break;
			case "call_service":
				this.serviceCalls.push(msg);
				if (this.opts.serviceError) {
					reply({ type: "result", success: false, error: this.opts.serviceError });
				} else {
					ok({ context: { id: "ctx" } });
				}
				break;
			case "subscribe_entities": {
				if (this.opts.rejectSubscribeEntities) {
					reply({ type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } });
					break;
				}
				const ids = (msg.entity_ids as string[]) ?? [];
				client.entitySubs.set(msg.id as number, ids);
				ok();
				const a: Record<string, { s: string; a: Record<string, unknown> }> = {};
				for (const id of ids) {
					const raw = this.entities.get(id);
					if (raw) {
						a[id] = { s: raw.state, a: raw.attributes };
					}
				}
				reply({ type: "event", event: { a } });
				break;
			}
			case "subscribe_events":
				client.eventSubs.add(msg.id as number);
				ok();
				break;
			case "unsubscribe_events":
				client.entitySubs.delete(msg.subscription as number);
				client.eventSubs.delete(msg.subscription as number);
				ok();
				break;
			default:
				reply({ type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } });
		}
	}
}
