import http from "node:http";
import express from "express";

export type PinBehavior = "ok" | "429" | "500" | "503" | "400" | "401" | "hang" | "ok-then-hang";

export interface FakePinterest {
  boards: { id: string; name: string; description?: string; privacy?: string }[];
  pins: { id: string; board_id: string; title: string; description: string; alt_text?: string; created_at: string; media_source: { url: string } }[];
  pinBehaviors: PinBehavior[];
  validTokens: Set<string>;
  tokenCalls: Record<string, string>[];
  pinCalls: number;
  close(): Promise<void>;
}

/** A small stand-in for the Pinterest v5 API used by integration and e2e tests. */
export async function startFakePinterest(port = 4599): Promise<FakePinterest> {
  const app = express();
  const state: Omit<FakePinterest, "close"> = {
    boards: [],
    pins: [],
    pinBehaviors: [],
    validTokens: new Set(["access-1"]),
    tokenCalls: [],
    pinCalls: 0,
  };
  let tokenSeq = 1;
  let pinSeq = 1000;

  const auth = (req: express.Request, res: express.Response) => {
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!state.validTokens.has(tok)) {
      res.status(401).json({ code: 2, message: "Authentication failed." });
      return false;
    }
    return true;
  };

  app.post("/v5/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    const basic = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    if (basic !== "client-id:client-secret") return void res.status(401).json({ message: "bad client" });
    state.tokenCalls.push(req.body);
    if (req.body.grant_type === "authorization_code" && req.body.code !== "good-code") return void res.status(400).json({ message: "invalid code" });
    if (req.body.grant_type === "refresh_token" && req.body.refresh_token !== "refresh-1") return void res.status(400).json({ message: "invalid refresh" });
    const access = `access-${++tokenSeq}`;
    state.validTokens.add(access);
    res.json({ access_token: access, refresh_token: "refresh-1", expires_in: 2592000, refresh_token_expires_in: 31536000, scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read", token_type: "bearer" });
  });

  app.get("/v5/user_account", (req, res) => {
    if (!auth(req, res)) return;
    res.json({ username: "quotetester", id: "pin-user-1" });
  });

  app.get("/v5/boards", (req, res) => {
    if (!auth(req, res)) return;
    const pageSize = 2; // force pagination
    const start = req.query.bookmark ? Number(req.query.bookmark) : 0;
    const items = state.boards.slice(start, start + pageSize);
    const next = start + pageSize < state.boards.length ? String(start + pageSize) : null;
    res.json({ items, bookmark: next });
  });

  app.get("/v5/boards/:id/pins", (req, res) => {
    if (!auth(req, res)) return;
    res.json({ items: state.pins.filter((p) => p.board_id === req.params.id).reverse(), bookmark: null });
  });

  app.post("/v5/pins", express.json(), async (req, res) => {
    if (!auth(req, res)) return;
    state.pinCalls++;
    const behavior = state.pinBehaviors.shift() ?? "ok";
    const create = () => {
      const pin = { id: String(++pinSeq), board_id: req.body.board_id, title: req.body.title, description: req.body.description, alt_text: req.body.alt_text, created_at: new Date().toISOString(), media_source: req.body.media_source };
      state.pins.push(pin);
      return pin;
    };
    if (!state.boards.some((b) => b.id === req.body.board_id)) return void res.status(404).json({ code: 40, message: "Board not found." });
    switch (behavior) {
      case "ok":
        return void res.status(201).json(create());
      case "429":
        return void res.status(429).set("retry-after", "1").json({ code: 8, message: "Rate limited" });
      case "500":
        return void res.status(500).json({ code: 1, message: "Internal error" });
      case "503":
        return void res.status(503).json({ code: 1, message: "Unavailable" });
      case "400":
        return void res.status(400).json({ code: 1, message: "Invalid parameters" });
      case "401":
        state.validTokens.clear();
        return void res.status(401).json({ code: 2, message: "Authentication failed." });
      case "hang":
        return; // never respond → client timeout → unknown outcome, nothing created
      case "ok-then-hang":
        create(); // created on Pinterest's side but the response is lost
        return;
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return Object.assign(state, {
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}
