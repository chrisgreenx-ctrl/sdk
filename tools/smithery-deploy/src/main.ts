#!/usr/bin/env node
/**
 * Smithery Deploy MCP Server Entry Point
 *
 * This file is the entry point for running the Smithery Deploy tool as an MCP server.
 * It uses the Smithery SDK to create a stateless HTTP server.
 */

import { createStatelessServer } from "@smithery/sdk"
import createServer, { configSchema } from "./server.js"

// Create and start the stateless MCP server
const { app } = createStatelessServer(createServer, {
	schema: configSchema,
})

// Listen on the PORT environment variable (required for Smithery deployment)
const port = Number(process.env.PORT) || 8081
app.listen(port, () => {
	console.log(`Smithery Deploy MCP Server running on port ${port}`)
	console.log(`MCP endpoint: http://localhost:${port}/mcp`)
	console.log(`Config schema: http://localhost:${port}/.well-known/mcp-config`)
})
