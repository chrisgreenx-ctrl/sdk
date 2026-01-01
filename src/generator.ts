/**
 * Configuration File Generator
 *
 * Generates smithery.yaml, Dockerfile, and other files needed for Smithery deployment.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { stringify as stringifyYaml } from "yaml"
import type {
	ConfigSchema,
	DetectionResult,
	DockerfileConfig,
	GeneratedFiles,
	SmitheryYamlConfig,
} from "./types.js"

/**
 * Generate all files needed for Smithery deployment
 */
export function generateDeploymentFiles(
	detection: DetectionResult,
	options: {
		target?: "remote" | "local"
		overwrite?: boolean
	} = {}
): GeneratedFiles {
	const files: GeneratedFiles = {}

	// Generate smithery.yaml
	files["smithery.yaml"] = generateSmitheryYaml(detection, options.target)

	// Generate Dockerfile if needed
	if (detection.runtime === "container" && !detection.details.hasDockerfile) {
		const dockerConfig = generateDockerfileConfig(detection)
		files["Dockerfile"] = generateDockerfile(dockerConfig)
		files[".dockerignore"] = generateDockerignore(detection)
	}

	// For Python without existing Dockerfile, suggest container deployment
	if (
		detection.runtime === "python" &&
		!detection.details.hasDockerfile &&
		options.target === "remote"
	) {
		const dockerConfig = generateDockerfileConfig(detection)
		files["Dockerfile"] = generateDockerfile(dockerConfig)
		files[".dockerignore"] = generateDockerignore(detection)
	}

	return files
}

/**
 * Generate smithery.yaml content
 */
export function generateSmitheryYaml(
	detection: DetectionResult,
	target: "remote" | "local" = "remote"
): string {
	const config: SmitheryYamlConfig = {
		runtime: detection.runtime,
	}

	// Add target only if not the default (remote)
	if (target === "local") {
		config.target = "local"
	}

	// For container runtime, add build and startCommand
	if (detection.runtime === "container") {
		config.build = {
			dockerfile: "Dockerfile",
			dockerBuildPath: ".",
		}

		config.startCommand = {
			type: "http",
		}

		// Add config schema if detected
		if (detection.details.configSchema) {
			config.startCommand.configSchema = detection.details.configSchema
			config.startCommand.exampleConfig = generateExampleConfig(
				detection.details.configSchema
			)
		}
	}

	// For TypeScript, minimal config is fine (runtime: typescript)
	// Smithery CLI handles the build

	// For Python, similar minimal config
	// But we might need container for remote deployment

	return stringifyYaml(config, {
		indent: 2,
		lineWidth: 100,
	})
}

function generateExampleConfig(
	schema: ConfigSchema
): Record<string, unknown> {
	const example: Record<string, unknown> = {}

	for (const [key, prop] of Object.entries(schema.properties)) {
		if (prop.default !== undefined) {
			example[key] = prop.default
		} else if (prop.type === "string") {
			if (key.toLowerCase().includes("key") || key.toLowerCase().includes("token")) {
				example[key] = "your-api-key-here"
			} else {
				example[key] = `example-${key}`
			}
		} else if (prop.type === "number" || prop.type === "integer") {
			example[key] = prop.minimum ?? 0
		} else if (prop.type === "boolean") {
			example[key] = false
		} else if (prop.type === "array") {
			example[key] = []
		} else if (prop.type === "object") {
			example[key] = {}
		}
	}

	return example
}

/**
 * Generate Dockerfile configuration based on detected server type
 */
export function generateDockerfileConfig(
	detection: DetectionResult
): DockerfileConfig {
	const language = detection.details.language || detection.runtime

	switch (language) {
		case "typescript":
		case "nodejs":
		case "javascript":
			return {
				baseImage: "node:22-slim",
				workdir: "/app",
				copyCommands: ["COPY package*.json ./", "COPY . ."],
				installCommand: "npm ci",
				buildCommand: "npm run build",
				startCommand:
					'node dist/index.js || node .smithery/index.cjs || node --import tsx src/index.ts',
				port: 8081,
				env: {
					NODE_ENV: "production",
				},
			}

		case "python":
			return {
				baseImage: "python:3.12-slim",
				workdir: "/app",
				copyCommands: [
					"COPY pyproject.toml requirements*.txt* ./",
					"COPY . .",
				],
				installCommand:
					"pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir -e .",
				startCommand: 'smithery start --host 0.0.0.0 --port ${PORT:-8081}',
				port: 8081,
				env: {
					PYTHONUNBUFFERED: "1",
				},
			}

		case "go":
			return {
				baseImage: "golang:1.22-alpine AS builder",
				workdir: "/app",
				copyCommands: ["COPY go.* ./", "COPY . ."],
				installCommand: "go mod download",
				buildCommand: "go build -o server .",
				startCommand: "./server",
				port: 8081,
				env: {},
			}

		case "rust":
			return {
				baseImage: "rust:1.75-slim AS builder",
				workdir: "/app",
				copyCommands: ["COPY Cargo.* ./", "COPY src ./src"],
				installCommand: "",
				buildCommand: "cargo build --release",
				startCommand: "./target/release/server",
				port: 8081,
				env: {},
			}

		default:
			// Generic container
			return {
				baseImage: "ubuntu:22.04",
				workdir: "/app",
				copyCommands: ["COPY . ."],
				installCommand: "# Add your installation commands here",
				startCommand: "# Add your start command here",
				port: 8081,
				env: {},
			}
	}
}

/**
 * Generate Dockerfile content
 */
export function generateDockerfile(config: DockerfileConfig): string {
	const language = config.baseImage.split(":")[0]
	const isMultiStage =
		config.baseImage.includes(" AS ") ||
		["go", "rust"].some((lang) => config.baseImage.includes(lang))

	let dockerfile = `# Auto-generated Dockerfile for Smithery deployment
# MCP Server - Streamable HTTP Transport

`

	if (language.includes("golang") || language.includes("go")) {
		// Go multi-stage build
		dockerfile += `FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY go.* ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Production image
FROM alpine:3.19

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/server .

# Smithery sets PORT environment variable
ENV PORT=8081
EXPOSE 8081

CMD ["./server"]
`
	} else if (language.includes("rust")) {
		// Rust multi-stage build
		dockerfile += `FROM rust:1.75-slim AS builder

WORKDIR /app

# Copy manifests
COPY Cargo.* ./

# Create dummy src for dependency caching
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src

# Copy actual source and build
COPY src ./src
RUN touch src/main.rs && cargo build --release

# Production image
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/server .

# Smithery sets PORT environment variable
ENV PORT=8081
EXPOSE 8081

CMD ["./server"]
`
	} else if (language.includes("python")) {
		// Python
		dockerfile += `FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements*.txt pyproject.toml* ./
RUN pip install --no-cache-dir smithery mcp fastmcp || true
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir -e . 2>/dev/null || true

# Copy application
COPY . .

# Environment
ENV PYTHONUNBUFFERED=1
ENV PORT=8081

EXPOSE 8081

# Run with smithery for proper SHTTP transport
CMD ["sh", "-c", "smithery start --host 0.0.0.0 --port \${PORT:-8081}"]
`
	} else if (language.includes("node")) {
		// Node.js / TypeScript
		dockerfile += `FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Build if needed
RUN npm run build 2>/dev/null || true

# Environment
ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

# Try multiple entry points
CMD ["sh", "-c", "node dist/index.js 2>/dev/null || node .smithery/index.cjs 2>/dev/null || npx tsx src/index.ts"]
`
	} else {
		// Generic
		dockerfile += `FROM ${config.baseImage}

WORKDIR ${config.workdir}

# Copy files
${config.copyCommands.join("\n")}

# Install dependencies
RUN ${config.installCommand}

${config.buildCommand ? `# Build\nRUN ${config.buildCommand}\n` : ""}

# Environment variables
${Object.entries(config.env)
	.map(([k, v]) => `ENV ${k}=${v}`)
	.join("\n")}
ENV PORT=${config.port}

EXPOSE ${config.port}

CMD ${JSON.stringify(config.startCommand.split(" "))}
`
	}

	return dockerfile
}

/**
 * Generate .dockerignore content
 */
export function generateDockerignore(detection: DetectionResult): string {
	const common = `# Version control
.git
.gitignore

# IDE
.idea
.vscode
*.swp
*.swo

# CI/CD
.github
.gitlab

# Documentation
*.md
!README.md
LICENSE

# Logs
*.log
logs/
`

	const languageSpecific: Record<string, string> = {
		typescript: `
# Node.js
node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build output
dist
.smithery

# Test
coverage
.nyc_output

# Environment
.env
.env.*
!.env.example
`,
		python: `
# Python
__pycache__
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg

# Virtual environments
venv
.venv
ENV/
env/

# Test
.pytest_cache
.coverage
htmlcov/

# Environment
.env
.env.*
!.env.example
`,
		go: `
# Go
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
vendor/
`,
		rust: `
# Rust
target/
Cargo.lock
**/*.rs.bk
`,
	}

	const language = detection.details.language || detection.runtime
	return common + (languageSpecific[language] || "")
}

/**
 * Write generated files to disk
 */
export function writeGeneratedFiles(
	targetDir: string,
	files: GeneratedFiles,
	options: { dryRun?: boolean; overwrite?: boolean } = {}
): { written: string[]; skipped: string[] } {
	const written: string[] = []
	const skipped: string[] = []

	for (const [filename, content] of Object.entries(files)) {
		if (!content) continue

		const filePath = path.join(targetDir, filename)

		if (fs.existsSync(filePath) && !options.overwrite) {
			skipped.push(filename)
			continue
		}

		if (!options.dryRun) {
			fs.writeFileSync(filePath, content, "utf-8")
		}

		written.push(filename)
	}

	return { written, skipped }
}

/**
 * Generate transformation instructions for existing MCP servers
 */
export function generateTransformationGuide(
	detection: DetectionResult
): string {
	const lines: string[] = []

	lines.push("# MCP Server Transformation Guide")
	lines.push("")
	lines.push(
		`Detected: ${detection.runtime} server (confidence: ${detection.confidence})`
	)
	lines.push("")

	if (detection.runtime === "typescript") {
		lines.push("## TypeScript Server Setup")
		lines.push("")
		lines.push("### 1. Install Smithery SDK")
		lines.push("```bash")
		lines.push("npm install @smithery/sdk @modelcontextprotocol/sdk zod")
		lines.push("npm install -D @smithery/cli")
		lines.push("```")
		lines.push("")
		lines.push("### 2. Update your server entry point")
		lines.push("")
		lines.push("Your server should export a default function that creates the MCP server:")
		lines.push("")
		lines.push("```typescript")
		lines.push('import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"')
		lines.push('import { z } from "zod"')
		lines.push("")
		lines.push("// Optional: Define config schema for user settings")
		lines.push("export const configSchema = z.object({")
		lines.push('  apiKey: z.string().describe("Your API key"),')
		lines.push('  debug: z.boolean().default(false).describe("Enable debug mode"),')
		lines.push("})")
		lines.push("")
		lines.push("export default function createServer({")
		lines.push("  config,")
		lines.push("}: {")
		lines.push("  config: z.infer<typeof configSchema>")
		lines.push("}) {")
		lines.push("  const server = new McpServer({")
		lines.push('    name: "Your Server",')
		lines.push('    version: "1.0.0",')
		lines.push("  })")
		lines.push("")
		lines.push("  // Register your tools, resources, and prompts")
		lines.push('  server.registerTool("example", { ... }, async (args) => { ... })')
		lines.push("")
		lines.push("  return server.server")
		lines.push("}")
		lines.push("```")
		lines.push("")
		lines.push("### 3. Add npm scripts")
		lines.push("")
		lines.push("```json")
		lines.push('{')
		lines.push('  "scripts": {')
		lines.push('    "dev": "smithery dev",')
		lines.push('    "build": "smithery build"')
		lines.push('  }')
		lines.push('}')
		lines.push("```")
		lines.push("")
		lines.push("### 4. Run and test")
		lines.push("```bash")
		lines.push("npm run dev")
		lines.push("```")
	} else if (detection.runtime === "python") {
		lines.push("## Python Server Setup")
		lines.push("")
		lines.push("### 1. Install Smithery SDK")
		lines.push("```bash")
		lines.push("pip install smithery mcp fastmcp")
		lines.push("```")
		lines.push("")
		lines.push("### 2. Update your server")
		lines.push("")
		lines.push("Use the @smithery.server() decorator:")
		lines.push("")
		lines.push("```python")
		lines.push("from mcp.server.fastmcp import Context, FastMCP")
		lines.push("from pydantic import BaseModel, Field")
		lines.push("from smithery.decorators import smithery")
		lines.push("")
		lines.push("# Optional: Define config schema")
		lines.push("class ConfigSchema(BaseModel):")
		lines.push('    api_key: str = Field(..., description="Your API key")')
		lines.push('    debug: bool = Field(False, description="Enable debug mode")')
		lines.push("")
		lines.push("@smithery.server(config_schema=ConfigSchema)")
		lines.push("def create_server():")
		lines.push('    server = FastMCP("Your Server")')
		lines.push("")
		lines.push("    @server.tool()")
		lines.push("    def example_tool(arg: str, ctx: Context) -> str:")
		lines.push("        # Access config via ctx.session_config")
		lines.push("        config = ctx.session_config")
		lines.push('        return f"Hello {arg}"')
		lines.push("")
		lines.push("    return server")
		lines.push("```")
		lines.push("")
		lines.push("### 3. Run and test")
		lines.push("```bash")
		lines.push("smithery dev")
		lines.push("# Or: smithery playground")
		lines.push("```")
	} else {
		lines.push("## Container Server Setup")
		lines.push("")
		lines.push("### Requirements")
		lines.push("")
		lines.push("Your server must:")
		lines.push("")
		lines.push("1. **Implement MCP Streamable HTTP transport**")
		lines.push("   - Handle POST requests to `/mcp` endpoint")
		lines.push("   - Support the MCP JSON-RPC protocol")
		lines.push("")
		lines.push("2. **Listen on PORT environment variable**")
		lines.push("   - Smithery sets `PORT=8081` when launching your container")
		lines.push("   - Example: `server.listen(process.env.PORT || 8081)`")
		lines.push("")
		lines.push("3. **Add CORS headers**")
		lines.push("   ```")
		lines.push("   Access-Control-Allow-Origin: *")
		lines.push("   Access-Control-Allow-Methods: GET, POST, OPTIONS")
		lines.push("   Access-Control-Allow-Headers: Content-Type, Authorization, mcp-session-id, mcp-protocol-version")
		lines.push("   Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version")
		lines.push("   ```")
		lines.push("")
		lines.push("4. **Handle configuration via query parameters**")
		lines.push("   - Config is passed as URL params: `/mcp?apiKey=xxx&debug=true`")
		lines.push("   - Parse and validate in your request handler")
	}

	lines.push("")
	lines.push("## Deployment")
	lines.push("")
	lines.push("1. Ensure smithery.yaml is in your repository root")
	lines.push("2. Push to GitHub")
	lines.push("3. Visit https://smithery.ai/new to connect your repository")
	lines.push("4. Smithery will automatically build and deploy on commits to main")

	return lines.join("\n")
}
