# Smithery Deploy Tool

Deploy local MCP (Model Context Protocol) servers to Smithery as remote SHTTP (Streamable HTTP) servers.

This tool automatically detects your MCP server type (TypeScript, Python, or container-based) and generates the necessary configuration files for Smithery deployment.

**Available as both a CLI tool and an MCP server!**

## Features

- **Automatic Detection**: Detects TypeScript, Python, Go, Rust, and other MCP server types
- **Smart Configuration**: Generates `smithery.yaml` with appropriate settings
- **Dockerfile Generation**: Creates optimized Dockerfiles for container deployments
- **Config Schema Extraction**: Extracts configuration schemas from your code
- **Validation**: Validates your deployment configuration before deploying
- **MCP Server**: Use this tool via AI assistants that support MCP

## Installation

```bash
# From this repository
cd tools/smithery-deploy
npm install
npm run build

# Or run directly with npx
npx tsx src/cli.ts <command>
```

## Usage

### Detect Server Type

Analyze a directory to determine the MCP server type:

```bash
smithery-deploy detect ./my-mcp-server
```

Output:
```
Detected runtime: typescript (high confidence)
Language: typescript
Framework: smithery-sdk
Entry Point: src/index.ts
Has MCP Dependency: Yes
Has smithery.yaml: No
```

### Initialize Deployment Configuration

Generate `smithery.yaml` and other required files:

```bash
# Initialize with auto-detection
smithery-deploy init ./my-mcp-server

# Force a specific runtime
smithery-deploy init ./my-mcp-server --runtime container

# Set deployment target
smithery-deploy init ./my-mcp-server --target remote

# Preview without writing files
smithery-deploy init ./my-mcp-server --dry-run
```

### Convert Existing Server

Convert an existing MCP server to Smithery-compatible format:

```bash
smithery-deploy convert ./my-mcp-server
```

This will:
1. Detect your server type
2. Generate `smithery.yaml`
3. Create Dockerfile if needed (for container deployments)
4. Show manual changes needed for full compatibility

### Validate Configuration

Check if your server is ready for deployment:

```bash
smithery-deploy validate ./my-mcp-server
```

### View Transformation Guide

Get detailed instructions for transforming your server:

```bash
smithery-deploy guide ./my-mcp-server
```

## MCP Server Mode

This tool is also available as an MCP server, allowing AI assistants to help you deploy your MCP servers.

### Running as MCP Server

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm run serve

# Or directly
node dist/main.js
```

The server runs on port 8081 by default (configurable via `PORT` environment variable).

### Configuration

The MCP server accepts the following configuration via URL query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `workingDirectory` | string | Current directory | Base directory for resolving paths |
| `allowWrite` | boolean | `false` | Enable file writing (required for `init` tool) |

Example: `http://localhost:8081/mcp?workingDirectory=/path/to/project&allowWrite=true`

### Available Tools

| Tool | Description |
|------|-------------|
| `detect` | Analyze a directory to detect MCP server type |
| `generate_config` | Generate deployment files without writing to disk |
| `init` | Write deployment files to disk (requires `allowWrite=true`) |
| `validate` | Check if server is ready for deployment |
| `guide` | Get transformation guide for the server |
| `list_files` | List project files with glob patterns |
| `read_file` | Read file contents |

### Available Resources

| Resource | URI | Description |
|----------|-----|-------------|
| smithery.yaml Template | `template://smithery.yaml` | Configuration reference |
| Dockerfile Templates | `template://dockerfile` | Templates for different languages |

### Available Prompts

| Prompt | Description |
|--------|-------------|
| `deploy_server` | Step-by-step workflow to deploy an MCP server |
| `convert_server` | Convert existing server to Smithery format |

### Using with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "smithery-deploy": {
      "command": "node",
      "args": ["/path/to/sdk/tools/smithery-deploy/dist/main.js"],
      "env": {
        "PORT": "8082"
      }
    }
  }
}
```

Or connect via SHTTP:

```json
{
  "mcpServers": {
    "smithery-deploy": {
      "url": "http://localhost:8081/mcp?workingDirectory=/your/project&allowWrite=true"
    }
  }
}
```

## Supported Server Types

### TypeScript

The tool detects TypeScript servers by looking for:
- `package.json` with `@modelcontextprotocol/sdk` or `@smithery/sdk`
- Entry points: `src/index.ts`, `src/server.ts`, `index.ts`
- Config schema exports using Zod

Generated `smithery.yaml`:
```yaml
runtime: typescript
```

### Python

The tool detects Python servers by looking for:
- `pyproject.toml` or `requirements.txt` with `mcp`, `smithery`, or `fastmcp`
- Entry points: `server.py`, `src/server.py`, files with `@smithery.server`
- Config schema using Pydantic BaseModel

Generated `smithery.yaml`:
```yaml
runtime: python
```

### Container (Any Language)

For other languages or custom setups, the tool generates:
- `smithery.yaml` with `runtime: container`
- Optimized Dockerfile for the detected language
- `.dockerignore` with appropriate exclusions

Generated `smithery.yaml`:
```yaml
runtime: container
build:
  dockerfile: Dockerfile
  dockerBuildPath: "."
startCommand:
  type: http
  configSchema:
    type: object
    properties: {}
```

## smithery.yaml Reference

### TypeScript Runtime

```yaml
runtime: typescript
target: remote  # or "local" for stdio transport
env:
  NODE_ENV: production
```

### Python Runtime

```yaml
runtime: python
target: remote
```

### Container Runtime

```yaml
runtime: container
build:
  dockerfile: Dockerfile
  dockerBuildPath: "."
startCommand:
  type: http
  configSchema:
    type: object
    properties:
      apiKey:
        type: string
        description: Your API key
    required:
      - apiKey
  exampleConfig:
    apiKey: your-api-key-here
```

## Programmatic API

Use the tool programmatically in your Node.js projects:

```typescript
import { deploy, detectMcpServer, generateDeploymentFiles } from "@smithery/deploy-tool"

// Full deployment
const result = await deploy({
  targetDir: "./my-mcp-server",
  dryRun: false,
  force: false,
})

console.log("Detection:", result.detection)
console.log("Generated files:", Object.keys(result.files))
console.log("Written:", result.written)

// Just detection
const detection = await detectMcpServer("./my-mcp-server")
console.log("Runtime:", detection.runtime)
console.log("Confidence:", detection.confidence)

// Just file generation
const files = generateDeploymentFiles(detection, { target: "remote" })
console.log("smithery.yaml:", files["smithery.yaml"])
```

## Server Requirements

### For SHTTP (Remote) Deployment

Your server must:

1. **Implement MCP Streamable HTTP transport**
   - Handle POST requests to `/mcp` endpoint
   - Support the MCP JSON-RPC protocol

2. **Listen on PORT environment variable**
   - Smithery sets `PORT=8081` when launching your container

3. **Add CORS headers** (for container deployments)
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET, POST, OPTIONS
   Access-Control-Allow-Headers: Content-Type, Authorization, mcp-session-id
   Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version
   ```

4. **Handle configuration via query parameters**
   - Config is passed as URL params: `/mcp?apiKey=xxx`

### For TypeScript Servers

Export a default function that creates an MCP server:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

export const configSchema = z.object({
  apiKey: z.string(),
})

export default function createServer({ config }) {
  const server = new McpServer({ name: "My Server", version: "1.0.0" })
  // Register tools, resources, prompts
  return server.server
}
```

### For Python Servers

Use the `@smithery.server()` decorator:

```python
from smithery.decorators import smithery
from mcp.server.fastmcp import FastMCP, Context

@smithery.server()
def create_server():
    server = FastMCP("My Server")

    @server.tool()
    def my_tool(arg: str, ctx: Context) -> str:
        return f"Hello {arg}"

    return server
```

## Deployment Steps

1. Run `smithery-deploy init` in your MCP server directory
2. Review the generated `smithery.yaml`
3. Push your changes to GitHub
4. Visit https://smithery.ai/new to connect your repository
5. Smithery will automatically build and deploy on commits to main

## License

MIT
