#!/usr/bin/env node
/**
 * Smithery Deploy MCP Server Entry Point
 *
 * This file is the entry point for running the Smithery Deploy tool as an MCP server.
 * It uses the Smithery SDK to create a stateless HTTP server.
 */

import { createStatelessServer } from "@smithery/sdk"
import express from "express"
import cors from "cors"
import createServer, { configSchema } from "./server.js"

// Initialize Express app manually to apply middleware before routes
const app = express()

// Configure CORS
app.use(
	cors({
		origin: (origin, callback) => {
			// Allow all origins by reflecting the request origin
			// This is required to support credentials: true with "wildcard-like" behavior
			callback(null, true)
		},
		credentials: true,
		methods: ["GET", "POST", "OPTIONS", "HEAD"],
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"mcp-protocol-version",
			"mcp-session-id",
		],
	})
)

// Create and start the stateless MCP server
// Pass the existing app instance so createStatelessServer adds its routes after our middleware
createStatelessServer(createServer, {
	schema: configSchema,
	app,
})

// Listen on the PORT environment variable (required for Smithery deployment)
const port = Number(process.env.PORT) || 8081
app.listen(port, () => {
	console.log(`Smithery Deploy MCP Server running on port ${port}`)
	console.log(`MCP endpoint: http://localhost:${port}/mcp`)
	console.log(`Config schema: http://localhost:${port}/.well-known/mcp-config`)
})
