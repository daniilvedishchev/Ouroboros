/**
 * Example: start the ZoethraDB relay server
 *
 *   node examples/start-relay.js
 *   node examples/start-relay.js 9090
 */

import { createRelayServer } from "../src/relay/server.js";

const port = parseInt(process.argv[2] ?? "8080", 10);
const { wss } = createRelayServer(port);

process.on("SIGINT", () => {
    console.log("\n[relay] shutting down…");
    wss.close(() => process.exit(0));
});
