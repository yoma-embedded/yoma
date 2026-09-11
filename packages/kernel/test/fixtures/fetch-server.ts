import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface FetchServer {
	readonly port: number;
	readonly url: string;
	stop(): void;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	if (req.method === "GET" || req.method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

export async function serveFetch(handler: FetchHandler): Promise<FetchServer> {
	let port = 0;
	const server = createServer(async (req, res) => {
		try {
			const body = await readBody(req);
			const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body,
			});
			const response = await handler(request);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			res.writeHead(response.status, headers);
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			res.writeHead(500);
			res.end(String(error));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		stop() {
			server.closeAllConnections();
			server.close();
		},
	};
}
