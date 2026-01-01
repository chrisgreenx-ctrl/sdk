/**
 * MCP Server Detector
 *
 * Detects the type of MCP server and extracts configuration from local repositories.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { parse as parseYaml } from "yaml"
import type {
	ConfigSchema,
	DetectionResult,
	RuntimeType,
	SmitheryYamlConfig,
} from "./types.js"

/**
 * Detect the type of MCP server in a directory
 */
export async function detectMcpServer(
	targetDir: string
): Promise<DetectionResult> {
	const absoluteDir = path.resolve(targetDir)

	if (!fs.existsSync(absoluteDir)) {
		throw new Error(`Directory does not exist: ${absoluteDir}`)
	}

	// Check for existing smithery.yaml
	const smitheryYamlPath = path.join(absoluteDir, "smithery.yaml")
	const hasExistingSmitheryYaml = fs.existsSync(smitheryYamlPath)
	let existingSmitheryConfig: SmitheryYamlConfig | undefined

	if (hasExistingSmitheryYaml) {
		try {
			const content = fs.readFileSync(smitheryYamlPath, "utf-8")
			existingSmitheryConfig = parseYaml(content) as SmitheryYamlConfig
		} catch {
			// Invalid YAML, will regenerate
		}
	}

	// Detect based on project files
	const tsResult = await detectTypeScript(absoluteDir)
	const pyResult = await detectPython(absoluteDir)
	const containerResult = await detectContainer(absoluteDir)

	// Determine the best match
	let bestResult: DetectionResult

	if (existingSmitheryConfig) {
		// Use existing config as hint
		if (existingSmitheryConfig.runtime === "typescript" && tsResult) {
			bestResult = tsResult
		} else if (existingSmitheryConfig.runtime === "python" && pyResult) {
			bestResult = pyResult
		} else if (existingSmitheryConfig.runtime === "container") {
			bestResult = containerResult || tsResult || pyResult || createFallback()
		} else {
			bestResult = tsResult || pyResult || containerResult || createFallback()
		}
		bestResult.details.existingSmitheryConfig = existingSmitheryConfig
	} else {
		// Priority: TypeScript > Python > Container (based on MCP SDK availability)
		if (tsResult && tsResult.details.hasMcpDependency) {
			bestResult = tsResult
		} else if (pyResult && pyResult.details.hasMcpDependency) {
			bestResult = pyResult
		} else if (tsResult) {
			bestResult = tsResult
		} else if (pyResult) {
			bestResult = pyResult
		} else if (containerResult) {
			bestResult = containerResult
		} else {
			bestResult = createFallback()
		}
	}

	bestResult.details.hasExistingSmitheryYaml = hasExistingSmitheryYaml
	bestResult.details.hasDockerfile = fs.existsSync(
		path.join(absoluteDir, "Dockerfile")
	)

	return bestResult
}

function createFallback(): DetectionResult {
	return {
		runtime: "container",
		confidence: "low",
		details: {
			hasExistingSmitheryYaml: false,
			hasMcpDependency: false,
			hasDockerfile: false,
		},
		suggestions: [
			"Could not detect MCP server type automatically",
			"Will deploy as container - please ensure you have a Dockerfile",
			"Make sure your server implements the MCP Streamable HTTP transport",
		],
	}
}

/**
 * Detect TypeScript/JavaScript MCP server
 */
async function detectTypeScript(dir: string): Promise<DetectionResult | null> {
	const packageJsonPath = path.join(dir, "package.json")

	if (!fs.existsSync(packageJsonPath)) {
		return null
	}

	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
		const allDeps = {
			...(packageJson.dependencies || {}),
			...(packageJson.devDependencies || {}),
		}

		const hasMcpSdk = "@modelcontextprotocol/sdk" in allDeps
		const hasSmitherySdk = "@smithery/sdk" in allDeps
		const hasSmitheryCli = "@smithery/cli" in allDeps

		// Find entry point
		const entryPoint = findTypeScriptEntryPoint(dir, packageJson)

		// Try to extract config schema
		const configSchema = entryPoint
			? await extractTypeScriptConfigSchema(path.join(dir, entryPoint))
			: undefined

		const suggestions: string[] = []

		if (!hasMcpSdk && !hasSmitherySdk) {
			suggestions.push(
				'Install @modelcontextprotocol/sdk: npm install @modelcontextprotocol/sdk'
			)
		}

		if (!hasSmitherySdk) {
			suggestions.push('Install @smithery/sdk: npm install @smithery/sdk')
		}

		if (!hasSmitheryCli) {
			suggestions.push(
				'Install @smithery/cli for development: npm install -D @smithery/cli'
			)
		}

		if (!entryPoint) {
			suggestions.push(
				"Create src/index.ts with a default export function createServer"
			)
		}

		return {
			runtime: "typescript",
			confidence: hasMcpSdk || hasSmitherySdk ? "high" : "medium",
			details: {
				entryPoint,
				hasExistingSmitheryYaml: false,
				hasMcpDependency: hasMcpSdk || hasSmitherySdk,
				hasDockerfile: false,
				configSchema,
				serverName: packageJson.name,
				serverVersion: packageJson.version,
				language: "typescript",
				framework: hasSmitherySdk ? "smithery-sdk" : hasMcpSdk ? "mcp-sdk" : undefined,
			},
			suggestions,
		}
	} catch {
		return null
	}
}

function findTypeScriptEntryPoint(
	dir: string,
	packageJson: Record<string, unknown>
): string | undefined {
	// Check common entry points
	const candidates = [
		packageJson.module as string,
		packageJson.main as string,
		"src/index.ts",
		"src/server.ts",
		"src/main.ts",
		"index.ts",
		"server.ts",
		"src/index.js",
		"index.js",
	].filter(Boolean)

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(dir, candidate))) {
			return candidate
		}
	}

	return undefined
}

async function extractTypeScriptConfigSchema(
	filePath: string
): Promise<ConfigSchema | undefined> {
	if (!fs.existsSync(filePath)) {
		return undefined
	}

	try {
		const content = fs.readFileSync(filePath, "utf-8")

		// Look for configSchema export with z.object
		const configSchemaMatch = content.match(
			/export\s+const\s+configSchema\s*=\s*z\.object\s*\(\s*\{([^}]+)\}\s*\)/s
		)

		if (!configSchemaMatch) {
			return undefined
		}

		// Basic parsing of Zod schema - extract field names and types
		const schemaBody = configSchemaMatch[1]
		const properties: Record<string, { type: string; description?: string }> = {}
		const required: string[] = []

		// Match field definitions like: fieldName: z.string().describe("...")
		const fieldMatches = schemaBody.matchAll(
			/(\w+)\s*:\s*z\.(\w+)\(\)(?:\.default\([^)]*\))?(?:\.describe\(\s*["']([^"']+)["']\s*\))?/g
		)

		for (const match of fieldMatches) {
			const [, fieldName, zodType, description] = match
			const jsonType = zodTypeToJsonType(zodType)
			properties[fieldName] = {
				type: jsonType,
				...(description && { description }),
			}

			// If no .default(), consider it required
			if (!match[0].includes(".default(")) {
				required.push(fieldName)
			}
		}

		if (Object.keys(properties).length === 0) {
			return undefined
		}

		return {
			type: "object",
			properties,
			...(required.length > 0 && { required }),
		}
	} catch {
		return undefined
	}
}

function zodTypeToJsonType(zodType: string): string {
	const typeMap: Record<string, string> = {
		string: "string",
		number: "number",
		boolean: "boolean",
		array: "array",
		object: "object",
		enum: "string",
	}
	return typeMap[zodType] || "string"
}

/**
 * Detect Python MCP server
 */
async function detectPython(dir: string): Promise<DetectionResult | null> {
	// Check for Python project indicators
	const hasPyprojectToml = fs.existsSync(path.join(dir, "pyproject.toml"))
	const hasRequirementsTxt = fs.existsSync(path.join(dir, "requirements.txt"))
	const hasSetupPy = fs.existsSync(path.join(dir, "setup.py"))

	if (!hasPyprojectToml && !hasRequirementsTxt && !hasSetupPy) {
		return null
	}

	let hasMcpDependency = false
	let hasSmitheryDependency = false
	let hasFastMcpDependency = false

	// Check pyproject.toml
	if (hasPyprojectToml) {
		try {
			const content = fs.readFileSync(
				path.join(dir, "pyproject.toml"),
				"utf-8"
			)
			hasMcpDependency = content.includes('"mcp"') || content.includes("'mcp'")
			hasSmitheryDependency =
				content.includes('"smithery"') || content.includes("'smithery'")
			hasFastMcpDependency =
				content.includes('"fastmcp"') || content.includes("'fastmcp'")
		} catch {
			// Ignore parse errors
		}
	}

	// Check requirements.txt
	if (hasRequirementsTxt) {
		try {
			const content = fs.readFileSync(
				path.join(dir, "requirements.txt"),
				"utf-8"
			)
			hasMcpDependency = hasMcpDependency || /^mcp[>=<\s]/m.test(content)
			hasSmitheryDependency =
				hasSmitheryDependency || /^smithery[>=<\s]/m.test(content)
			hasFastMcpDependency =
				hasFastMcpDependency || /^fastmcp[>=<\s]/m.test(content)
		} catch {
			// Ignore read errors
		}
	}

	// Find entry point
	const entryPoint = findPythonEntryPoint(dir)

	// Try to extract config schema
	const configSchema = entryPoint
		? await extractPythonConfigSchema(path.join(dir, entryPoint))
		: undefined

	const suggestions: string[] = []

	if (!hasMcpDependency && !hasFastMcpDependency) {
		suggestions.push("Install mcp package: pip install mcp")
	}

	if (!hasSmitheryDependency) {
		suggestions.push("Install smithery package: pip install smithery")
	}

	if (!entryPoint) {
		suggestions.push(
			"Create a server.py or src/server.py with a @smithery.server() decorated function"
		)
	}

	return {
		runtime: "python",
		confidence:
			hasMcpDependency || hasFastMcpDependency || hasSmitheryDependency
				? "high"
				: "medium",
		details: {
			entryPoint,
			hasExistingSmitheryYaml: false,
			hasMcpDependency: hasMcpDependency || hasFastMcpDependency,
			hasDockerfile: false,
			configSchema,
			language: "python",
			framework: hasSmitheryDependency
				? "smithery"
				: hasFastMcpDependency
					? "fastmcp"
					: hasMcpDependency
						? "mcp"
						: undefined,
		},
		suggestions,
	}
}

function findPythonEntryPoint(dir: string): string | undefined {
	const candidates = [
		"server.py",
		"src/server.py",
		"main.py",
		"src/main.py",
		"app.py",
		"src/app.py",
	]

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(dir, candidate))) {
			return candidate
		}
	}

	// Look for any Python file with @smithery.server or FastMCP
	const pyFiles = findPythonFiles(dir)
	for (const pyFile of pyFiles) {
		try {
			const content = fs.readFileSync(path.join(dir, pyFile), "utf-8")
			if (
				content.includes("@smithery.server") ||
				content.includes("FastMCP") ||
				content.includes("McpServer")
			) {
				return pyFile
			}
		} catch {
			// Ignore read errors
		}
	}

	return undefined
}

function findPythonFiles(dir: string, prefix = ""): string[] {
	const files: string[] = []
	const entries = fs.readdirSync(dir, { withFileTypes: true })

	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "venv" || entry.name === ".venv" || entry.name === "node_modules") {
			continue
		}

		const fullPath = path.join(prefix, entry.name)

		if (entry.isFile() && entry.name.endsWith(".py")) {
			files.push(fullPath)
		} else if (entry.isDirectory() && prefix.split("/").length < 3) {
			files.push(...findPythonFiles(path.join(dir, entry.name), fullPath))
		}
	}

	return files.slice(0, 20) // Limit to prevent long scans
}

async function extractPythonConfigSchema(
	filePath: string
): Promise<ConfigSchema | undefined> {
	if (!fs.existsSync(filePath)) {
		return undefined
	}

	try {
		const content = fs.readFileSync(filePath, "utf-8")

		// Look for Pydantic ConfigSchema class
		const classMatch = content.match(
			/class\s+ConfigSchema\s*\(\s*BaseModel\s*\)\s*:\s*\n((?:\s+.+\n)+)/
		)

		if (!classMatch) {
			return undefined
		}

		const classBody = classMatch[1]
		const properties: Record<string, { type: string; description?: string }> = {}
		const required: string[] = []

		// Match field definitions like: field_name: str = Field(..., description="...")
		const fieldMatches = classBody.matchAll(
			/^\s+(\w+)\s*:\s*(\w+)(?:\s*=\s*Field\s*\([^)]*description\s*=\s*["']([^"']+)["'][^)]*\))?/gm
		)

		for (const match of fieldMatches) {
			const [fullMatch, fieldName, pyType, description] = match
			const jsonType = pythonTypeToJsonType(pyType)
			properties[fieldName] = {
				type: jsonType,
				...(description && { description }),
			}

			// If no default value (no =), consider it required
			if (!fullMatch.includes("=") || fullMatch.includes("= Field(...)")) {
				required.push(fieldName)
			}
		}

		if (Object.keys(properties).length === 0) {
			return undefined
		}

		return {
			type: "object",
			properties,
			...(required.length > 0 && { required }),
		}
	} catch {
		return undefined
	}
}

function pythonTypeToJsonType(pyType: string): string {
	const typeMap: Record<string, string> = {
		str: "string",
		int: "integer",
		float: "number",
		bool: "boolean",
		list: "array",
		dict: "object",
		List: "array",
		Dict: "object",
	}
	return typeMap[pyType] || "string"
}

/**
 * Detect generic container-based MCP server
 */
async function detectContainer(dir: string): Promise<DetectionResult | null> {
	const hasDockerfile = fs.existsSync(path.join(dir, "Dockerfile"))

	if (!hasDockerfile) {
		// Check for other indicators of a containerizable app
		const hasGoMod = fs.existsSync(path.join(dir, "go.mod"))
		const hasCargoToml = fs.existsSync(path.join(dir, "Cargo.toml"))
		const hasGemfile = fs.existsSync(path.join(dir, "Gemfile"))
		const hasComposerJson = fs.existsSync(path.join(dir, "composer.json"))

		if (!hasGoMod && !hasCargoToml && !hasGemfile && !hasComposerJson) {
			return null
		}

		let language: string | undefined
		if (hasGoMod) language = "go"
		else if (hasCargoToml) language = "rust"
		else if (hasGemfile) language = "ruby"
		else if (hasComposerJson) language = "php"

		return {
			runtime: "container",
			confidence: "medium",
			details: {
				hasExistingSmitheryYaml: false,
				hasMcpDependency: false,
				hasDockerfile: false,
				language,
			},
			suggestions: [
				"Create a Dockerfile for your MCP server",
				"Ensure your server implements MCP Streamable HTTP transport",
				"Expose the /mcp endpoint on the PORT environment variable (default: 8081)",
			],
		}
	}

	// Parse Dockerfile to extract hints
	const dockerfileContent = fs.readFileSync(
		path.join(dir, "Dockerfile"),
		"utf-8"
	)

	let language: string | undefined
	if (
		dockerfileContent.includes("FROM node") ||
		dockerfileContent.includes("FROM npm")
	) {
		language = "nodejs"
	} else if (
		dockerfileContent.includes("FROM python") ||
		dockerfileContent.includes("FROM pip")
	) {
		language = "python"
	} else if (dockerfileContent.includes("FROM golang")) {
		language = "go"
	} else if (dockerfileContent.includes("FROM rust")) {
		language = "rust"
	}

	return {
		runtime: "container",
		confidence: "high",
		details: {
			hasExistingSmitheryYaml: false,
			hasMcpDependency: false,
			hasDockerfile: true,
			language,
		},
		suggestions: [
			"Ensure your server implements MCP Streamable HTTP transport",
			"Expose the /mcp endpoint on the PORT environment variable (default: 8081)",
			"Add CORS headers for cross-origin requests",
		],
	}
}
