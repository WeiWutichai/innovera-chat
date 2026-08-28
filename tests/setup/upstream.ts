import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertLocalUpstream } from "./guards";

export type UpstreamMode =
  | "ok"
  | "http502"
  | "http429"
  | "nonjson"
  | "empty"
  | "nousage";

export type UpstreamRecord = {
  model: string;
  user: string | null;
  messageCount: number;
  roles: string[];
  contents: string[];
  totalChars: number;
  rawBody: string;
  /** True when the CALLER severed the connection before we replied. */
  abortedByCaller: boolean;
};

/**
 * Ephemeral stand-in for the LiteLLM endpoint, bound to port 0 so the OS assigns a free
 * port and parallel runs never collide. It is a real HTTP server on a real socket —
 * that is what makes "did the server-side fetch actually get aborted" observable, which
 * a fetch-layer interceptor cannot show.
 */
export class UpstreamServer {
  private server: http.Server;
  private mode: UpstreamMode = "ok";
  private delayMs = 0;
  private last: UpstreamRecord | null = null;
  public baseUrl = "";

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    assertLocalUpstream(this.baseUrl);
    return this.baseUrl;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  setMode(mode: UpstreamMode, delayMs = 0) {
    this.mode = mode;
    this.delayMs = delayMs;
  }

  lastRequest() {
    return this.last;
  }

  reset() {
    this.mode = "ok";
    this.delayMs = 0;
    this.last = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end("{}");
      }

      const parsed = JSON.parse(body);
      const record: UpstreamRecord = {
        model: parsed.model,
        user: parsed.user ?? null,
        messageCount: parsed.messages.length,
        roles: parsed.messages.map((m: { role: string }) => m.role),
        contents: parsed.messages.map((m: { content: string }) => m.content),
        totalChars: parsed.messages.reduce(
          (n: number, m: { content: string }) => n + m.content.length,
          0
        ),
        rawBody: body,
        abortedByCaller: false,
      };
      this.last = record;

      const markAborted = () => {
        record.abortedByCaller = true;
      };
      req.on("aborted", markAborted);
      res.on("close", () => {
        if (!res.writableEnded) markAborted();
      });

      const respond = () => {
        if (res.writableEnded || res.destroyed) return;

        switch (this.mode) {
          case "http502":
            res.writeHead(502, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: "UPSTREAM SECRET DETAIL must never reach the browser",
                  type: "upstream_failure",
                  code: "vllm_down",
                },
              })
            );
          case "http429":
            res.writeHead(429, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({ error: { message: "rate limited upstream", type: "rate_limit", code: "429" } })
            );
          case "nonjson":
            res.writeHead(503, { "Content-Type": "text/html" });
            return res.end("<html><body>503 from nginx</body></html>");
          case "empty":
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                choices: [{ message: { content: null } }],
                usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
              })
            );
          case "nousage":
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({ choices: [{ message: { content: "answer without usage" } }] })
            );
          default: {
            const lastUser = [...parsed.messages]
              .reverse()
              .find((m: { role: string }) => m.role === "user");
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: `ECHO n=${parsed.messages.length} last=${
                        lastUser ? String(lastUser.content).slice(0, 40) : "?"
                      }`,
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
              })
            );
          }
        }
      };

      if (this.delayMs > 0) setTimeout(respond, this.delayMs);
      else respond();
    });
  }
}
