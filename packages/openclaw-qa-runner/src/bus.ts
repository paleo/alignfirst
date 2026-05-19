import { createServer } from "node:http";
import { createBus } from "@paleo/openclaw-channel-mock-core";

const PORT = 43123;
const HOST = "0.0.0.0";

export function startBus(): void {
  const { handler } = createBus();
  const server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`channel-mock bus listening on ${HOST}:${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBus();
}
