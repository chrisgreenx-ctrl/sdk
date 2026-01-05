#!/usr/bin/env node
/**
 * Smithery Deploy MCP Server Entry Point
 *
 * This file is the entry point for running the Smithery Deploy tool as an MCP server.
 * It uses the Smithery SDK to create a stateless HTTP server.
 */

import express from 'express';
import cors from 'cors';
import { createStatelessServer } from "@smithery/sdk"
import createServer, { configSchema } from "./server.js"

// 1. Manually create the Express app
const app = express();

// 2. Apply Permissive CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    // Return the origin itself to allow it (reflects the request origin)
    // If no origin (CLI/Server-to-Server), allow it.
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "mcp-protocol-version",
    "mcp-session-id"
  ]
}));

// 3. Add health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 4. Pass the configured app to the SDK
createStatelessServer(createServer, {
	schema: configSchema,
	app: app
})

// 5. Listen on the port
const port = Number(process.env.PORT) || 8081
app.listen(port, () => {
	console.log(`Smithery Deploy MCP Server running on port ${port}`)
	console.log(`MCP endpoint: http://localhost:${port}/mcp`)
	console.log(`Config schema: http://localhost:${port}/.well-known/mcp-config`)
})
