import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Local/explicit tool endpoints are execution channels, not model API requests.
 * No implicit HTTP header deadline may turn a live operation into a failed call.
 */
export async function requestToolJson(
	url: string, body: unknown, options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<any> {
	const endpoint = new URL(url);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Unsupported tool transport protocol");
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
			method: "POST", signal: options.signal,
			headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...options.headers },
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			response.once("error", reject);
			response.once("aborted", () => reject(new Error("Tool response interrupted; execution outcome is uncertain")));
			response.once("end", () => {
				try {
					const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						throw new Error(`Tool transport ${response.statusCode}: ${JSON.stringify(value)}`);
					}
					resolve(value);
				} catch (error) { reject(error); }
			});
		});
		request.once("error", reject);
		request.end(payload);
	});
}
