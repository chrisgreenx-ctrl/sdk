/**
 * Smithery Deploy MCP Server
 *
 * An MCP server that exposes deployment tools for converting local MCP servers
 * to remote SHTTP servers hosted on Smithery.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import * as path from "node:path"
import * as fs from "node:fs"
import { detectMcpServer } from "./detector.js"
import {
	generateDeploymentFiles,
	generateTransformationGuide,
	writeGeneratedFiles,
} from "./generator.js"
import type { RuntimeType } from "./types.js"
import {
	cloneRepository,
	checkRepoExists,
	createGitHubRepo,
	pushToGitHub,
	cleanupTempDir,
	validateGitHubToken,
	parseGitUrl,
} from "./git-deploy.js"

/**
 * Configuration schema for the MCP server
 */
export const configSchema = z.object({
	workingDirectory: z
		.string()
		.default(process.cwd())
		.describe("Base directory for resolving relative paths"),
	allowWrite: z
		.boolean()
		.default(false)
		.describe("Allow writing files to disk (required for init/convert commands)"),
})

export type Config = z.infer<typeof configSchema>

/**
 * Create the Smithery Deploy MCP server
 */
export default function createServer({
	config,
}: {
	config: Config
}) {
	const server = new McpServer({
		name: "Smithery Deploy",
		version: "1.0.0",
	})

	// Helper to resolve paths relative to working directory
	const resolvePath = (targetPath: string): string => {
		if (path.isAbsolute(targetPath)) {
			return targetPath
		}
		return path.resolve(config.workingDirectory, targetPath)
	}

	// Tool: detect
	server.registerTool(
		"detect",
		{
			title: "Detect MCP Server",
			description:
				"Analyze a directory to detect the type of MCP server (TypeScript, Python, or container) and extract configuration details",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory to analyze (relative to working directory)"),
			},
		},
		async ({ directory }) => {
			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const result = await detectMcpServer(targetDir)

				const output = {
					runtime: result.runtime,
					confidence: result.confidence,
					details: {
						language: result.details.language,
						framework: result.details.framework,
						entryPoint: result.details.entryPoint,
						serverName: result.details.serverName,
						serverVersion: result.details.serverVersion,
						hasMcpDependency: result.details.hasMcpDependency,
						hasSmitheryYaml: result.details.hasExistingSmitheryYaml,
						hasDockerfile: result.details.hasDockerfile,
						configSchema: result.details.configSchema,
					},
					suggestions: result.suggestions,
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(output, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error detecting MCP server: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: generate_config
	server.registerTool(
		"generate_config",
		{
			title: "Generate Deployment Config",
			description:
				"Generate smithery.yaml and other deployment files for an MCP server without writing to disk. Returns the file contents.",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory to analyze"),
				runtime: z
					.enum(["typescript", "python", "container"])
					.optional()
					.describe("Force a specific runtime type (auto-detected if not specified)"),
				target: z
					.enum(["remote", "local"])
					.default("remote")
					.describe("Deployment target: remote (SHTTP on Smithery) or local (stdio)"),
			},
		},
		async ({ directory, runtime, target }) => {
			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const detection = await detectMcpServer(targetDir)

				if (runtime) {
					detection.runtime = runtime as RuntimeType
				}

				const files = generateDeploymentFiles(detection, {
					target: target as "remote" | "local",
				})

				const output: Record<string, string> = {}
				for (const [filename, content] of Object.entries(files)) {
					if (content) {
						output[filename] = content
					}
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									detectedRuntime: detection.runtime,
									confidence: detection.confidence,
									files: output,
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error generating config: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: init
	server.registerTool(
		"init",
		{
			title: "Initialize Deployment",
			description:
				"Initialize Smithery deployment by writing smithery.yaml and other required files to disk. Requires allowWrite=true in config.",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory"),
				runtime: z
					.enum(["typescript", "python", "container"])
					.optional()
					.describe("Force a specific runtime type"),
				target: z
					.enum(["remote", "local"])
					.default("remote")
					.describe("Deployment target"),
				force: z
					.boolean()
					.default(false)
					.describe("Overwrite existing files"),
			},
		},
		async ({ directory, runtime, target, force }) => {
			if (!config.allowWrite) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Writing files is disabled. Set allowWrite=true in the server configuration to enable file writing.",
						},
					],
					isError: true,
				}
			}

			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const detection = await detectMcpServer(targetDir)

				if (runtime) {
					detection.runtime = runtime as RuntimeType
				}

				const files = generateDeploymentFiles(detection, {
					target: target as "remote" | "local",
					overwrite: force,
				})

				const { written, skipped } = writeGeneratedFiles(targetDir, files, {
					overwrite: force,
				})

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									detectedRuntime: detection.runtime,
									filesWritten: written,
									filesSkipped: skipped,
									nextSteps: [
										"Review the generated smithery.yaml",
										"Push your changes to GitHub",
										"Visit https://smithery.ai/new to deploy",
									],
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error initializing deployment: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: validate
	server.registerTool(
		"validate",
		{
			title: "Validate Configuration",
			description:
				"Validate that an MCP server is properly configured for Smithery deployment",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory to validate"),
			},
		},
		async ({ directory }) => {
			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const detection = await detectMcpServer(targetDir)

				const issues: string[] = []
				const warnings: string[] = []

				// Check smithery.yaml
				if (!detection.details.hasExistingSmitheryYaml) {
					issues.push(
						"Missing smithery.yaml - run the 'init' tool to create it"
					)
				}

				// Check MCP dependency
				if (!detection.details.hasMcpDependency) {
					warnings.push(
						"No MCP SDK dependency detected - ensure you have @modelcontextprotocol/sdk (TS) or mcp (Python)"
					)
				}

				// Check Dockerfile for container runtime
				if (
					detection.runtime === "container" &&
					!detection.details.hasDockerfile
				) {
					issues.push("Container runtime requires a Dockerfile")
				}

				// Check entry point
				if (
					detection.runtime !== "container" &&
					!detection.details.entryPoint
				) {
					warnings.push(
						"Could not detect entry point - ensure you have src/index.ts (TS) or server.py (Python)"
					)
				}

				const isValid = issues.length === 0

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									valid: isValid,
									runtime: detection.runtime,
									confidence: detection.confidence,
									issues,
									warnings,
									...(isValid && {
										nextSteps: [
											"Push to GitHub",
											"Visit https://smithery.ai/new to deploy",
										],
									}),
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error validating: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: guide
	server.registerTool(
		"guide",
		{
			title: "Transformation Guide",
			description:
				"Get a detailed guide for transforming an MCP server to be Smithery-compatible",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory to analyze"),
			},
		},
		async ({ directory }) => {
			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const detection = await detectMcpServer(targetDir)
				const guide = generateTransformationGuide(detection)

				return {
					content: [
						{
							type: "text",
							text: guide,
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error generating guide: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: list_files
	server.registerTool(
		"list_files",
		{
			title: "List Project Files",
			description:
				"List relevant files in a directory to understand the project structure",
			inputSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Target directory to list"),
				pattern: z
					.string()
					.default("*")
					.describe("Glob pattern to filter files (e.g., '*.ts', '*.py')"),
			},
		},
		async ({ directory, pattern }) => {
			try {
				const targetDir = resolvePath(directory)

				if (!fs.existsSync(targetDir)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Directory does not exist: ${targetDir}`,
							},
						],
						isError: true,
					}
				}

				const { glob } = await import("glob")
				const files = await glob(pattern, {
					cwd: targetDir,
					nodir: true,
					ignore: [
						"node_modules/**",
						".git/**",
						"dist/**",
						"__pycache__/**",
						".venv/**",
						"venv/**",
					],
				})

				// Get file stats
				const fileDetails = files.slice(0, 50).map((file) => {
					const fullPath = path.join(targetDir, file)
					try {
						const stats = fs.statSync(fullPath)
						return {
							path: file,
							size: stats.size,
							modified: stats.mtime.toISOString(),
						}
					} catch {
						return { path: file, size: 0, modified: null }
					}
				})

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									directory: targetDir,
									pattern,
									totalFiles: files.length,
									files: fileDetails,
									...(files.length > 50 && {
										note: `Showing first 50 of ${files.length} files`,
									}),
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error listing files: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: read_file
	server.registerTool(
		"read_file",
		{
			title: "Read File",
			description: "Read the contents of a file in the project",
			inputSchema: {
				filePath: z.string().describe("Path to the file to read"),
				maxLines: z
					.number()
					.default(200)
					.describe("Maximum number of lines to return"),
			},
		},
		async ({ filePath, maxLines }) => {
			try {
				const fullPath = resolvePath(filePath)

				if (!fs.existsSync(fullPath)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: File does not exist: ${fullPath}`,
							},
						],
						isError: true,
					}
				}

				const stats = fs.statSync(fullPath)
				if (stats.isDirectory()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Path is a directory, not a file: ${fullPath}`,
							},
						],
						isError: true,
					}
				}

				const content = fs.readFileSync(fullPath, "utf-8")
				const lines = content.split("\n")
				const truncated = lines.length > maxLines

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									path: fullPath,
									lines: lines.length,
									truncated,
									content: truncated
										? lines.slice(0, maxLines).join("\n") +
											`\n\n... [${lines.length - maxLines} more lines]`
										: content,
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error reading file: ${(error as Error).message}`,
						},
					],
					isError: true,
				}
			}
		}
	)

	// Tool: deploy_from_git
	server.registerTool(
		"deploy_from_git",
		{
			title: "Deploy from Git Repository",
			description:
				"Clone a git repository, generate Smithery deployment files, and push to GitHub for automatic deployment via Smithery's GitHub App. Requires githubToken in server config.",
			inputSchema: {
				sourceRepoUrl: z
					.string()
					.describe("The git repository URL to clone (e.g., https://github.com/user/repo)"),
				sourceBranch: z
					.string()
					.optional()
					.describe("Branch to clone from source (default: main or master)"),
				targetOwner: z
					.string()
					.describe("GitHub owner (username or org) for the target repository"),
				targetRepo: z
					.string()
					.describe("Target repository name to push to"),
				targetBranch: z
					.string()
					.default("main")
					.describe("Target branch to push to"),
				runtime: z
					.enum(["typescript", "python", "container"])
					.optional()
					.describe("Force a specific runtime type (auto-detected if not specified)"),
				createIfNotExists: z
					.boolean()
					.default(true)
					.describe("Create the target repository if it doesn't exist"),
				force: z
					.boolean()
					.default(false)
					.describe("Overwrite existing deployment files"),
			},
		},
		async ({
			sourceRepoUrl,
			sourceBranch,
			targetOwner,
			targetRepo,
			targetBranch,
			runtime,
			createIfNotExists,
			force,
		}) => {
			// Get GitHub token from environment variable
			const githubToken = process.env.GITHUB_TOKEN

			// Check for GitHub token
			if (!githubToken) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: false,
									error:
										"GitHub token is required. Set the GITHUB_TOKEN environment variable.",
									hint: "You can get a token from https://github.com/settings/tokens with 'repo' scope.",
								},
								null,
								2
							),
						},
					],
					isError: true,
				}
			}

			let tempDir: string | undefined

			try {
				// Step 1: Validate GitHub token
				const tokenValidation = await validateGitHubToken(githubToken)
				if (!tokenValidation.valid) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: false,
										error: `Invalid GitHub token: ${tokenValidation.error}`,
									},
									null,
									2
								),
							},
						],
						isError: true,
					}
				}

				// Step 2: Clone the source repository
				const cloneResult = await cloneRepository(sourceRepoUrl, sourceBranch)
				tempDir = cloneResult.tempDir

				// Step 3: Detect MCP server type
				const detection = await detectMcpServer(tempDir)

				if (runtime) {
					detection.runtime = runtime as RuntimeType
				}

				// Step 4: Generate deployment files
				const files = generateDeploymentFiles(detection, {
					target: "remote",
					overwrite: force,
				})

				// Step 5: Write generated files to the cloned repo
				const filesGenerated: string[] = []
				const filesSkipped: string[] = []

				for (const [filename, content] of Object.entries(files)) {
					if (!content) continue

					const filePath = path.join(tempDir, filename)
					const exists = fs.existsSync(filePath)

					if (exists && !force) {
						filesSkipped.push(filename)
					} else {
						fs.writeFileSync(filePath, content, "utf-8")
						filesGenerated.push(filename)
					}
				}

				// Step 6: Check if target repo exists
				const repoExists = await checkRepoExists(
					targetOwner,
					targetRepo,
					githubToken
				)

				if (!repoExists) {
					if (createIfNotExists) {
						const createResult = await createGitHubRepo(
							targetOwner,
							targetRepo,
							githubToken,
							{
								description: `MCP server: ${detection.details.serverName || "Deployed via Smithery"}`,
							}
						)

						if (!createResult.success) {
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												success: false,
												error: `Failed to create repository: ${createResult.error}`,
											},
											null,
											2
										),
									},
								],
								isError: true,
							}
						}
					} else {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											success: false,
											error: `Repository ${targetOwner}/${targetRepo} does not exist and createIfNotExists is false`,
										},
										null,
										2
									),
								},
							],
							isError: true,
						}
					}
				}

				// Step 7: Push to GitHub
				const pushResult = await pushToGitHub(tempDir, {
					githubToken,
					targetOwner,
					targetRepo,
					targetBranch: targetBranch || "main",
					commitMessage: "Add Smithery deployment configuration",
				})

				if (!pushResult.success) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: false,
										error: `Failed to push: ${pushResult.error}`,
									},
									null,
									2
								),
							},
						],
						isError: true,
					}
				}

				// Step 8: Return success with deployment instructions
				const repoUrl = `https://github.com/${targetOwner}/${targetRepo}`
				const deployUrl = `https://smithery.ai/new`

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									clonedFrom: sourceRepoUrl,
									pushedTo: repoUrl,
									detectedRuntime: detection.runtime,
									confidence: detection.confidence,
									filesGenerated,
									filesSkipped,
									nextSteps: [
										`Repository created/updated at ${repoUrl}`,
										`Install Smithery GitHub App: https://github.com/apps/smithery-ai`,
										`Deploy at: ${deployUrl}`,
										"Connect your repository and Smithery will automatically deploy",
									],
									deployment: {
										githubAppUrl: "https://github.com/apps/smithery-ai",
										deployUrl,
										repositoryUrl: repoUrl,
									},
								},
								null,
								2
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: false,
									error: `Deployment failed: ${(error as Error).message}`,
								},
								null,
								2
							),
						},
					],
					isError: true,
				}
			} finally {
				// Clean up temp directory
				if (tempDir) {
					cleanupTempDir(tempDir)
				}
			}
		}
	)

	// Resource: smithery_yaml_template
	server.registerResource(
		"smithery-yaml-template",
		"template://smithery.yaml",
		{
			title: "smithery.yaml Template",
			description: "Template and reference for smithery.yaml configuration",
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/yaml",
					text: `# Smithery Configuration Reference
# Place this file in your repository root

# ============================================
# TypeScript Runtime
# ============================================
# For TypeScript/JavaScript MCP servers using @smithery/sdk

runtime: typescript
# target: remote  # Options: remote (default) or local
# env:
#   NODE_ENV: production

# ============================================
# Python Runtime
# ============================================
# For Python MCP servers using smithery package

# runtime: python
# target: remote

# ============================================
# Container Runtime
# ============================================
# For any language using Docker

# runtime: container
# build:
#   dockerfile: Dockerfile
#   dockerBuildPath: "."
# startCommand:
#   type: http
#   configSchema:
#     type: object
#     properties:
#       apiKey:
#         type: string
#         description: Your API key
#     required:
#       - apiKey
#   exampleConfig:
#     apiKey: your-api-key-here
`,
				},
			],
		})
	)

	// Resource: dockerfile_templates
	server.registerResource(
		"dockerfile-templates",
		"template://dockerfile",
		{
			title: "Dockerfile Templates",
			description: "Dockerfile templates for different languages",
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/plain",
					text: `# Dockerfile Templates for MCP Servers

## Node.js / TypeScript
\`\`\`dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build 2>/dev/null || true
ENV NODE_ENV=production PORT=8081
EXPOSE 8081
CMD ["node", "dist/index.js"]
\`\`\`

## Python
\`\`\`dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt pyproject.toml* ./
RUN pip install --no-cache-dir smithery mcp fastmcp || true
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir -e . 2>/dev/null || true
COPY . .
ENV PYTHONUNBUFFERED=1 PORT=8081
EXPOSE 8081
CMD ["sh", "-c", "smithery start --host 0.0.0.0 --port \${PORT:-8081}"]
\`\`\`

## Go (Multi-stage)
\`\`\`dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/server .
ENV PORT=8081
EXPOSE 8081
CMD ["./server"]
\`\`\`

## Rust (Multi-stage)
\`\`\`dockerfile
FROM rust:1.75-slim AS builder
WORKDIR /app
COPY Cargo.* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/server .
ENV PORT=8081
EXPOSE 8081
CMD ["./server"]
\`\`\`
`,
				},
			],
		})
	)

	// Prompt: deploy_server
	server.registerPrompt(
		"deploy_server",
		{
			title: "Deploy MCP Server",
			description:
				"Step-by-step workflow to deploy a local MCP server to Smithery",
			argsSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Directory containing the MCP server"),
			},
		},
		async ({ directory }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Please help me deploy the MCP server in "${directory}" to Smithery as a remote SHTTP server.

Follow these steps:
1. First, use the 'detect' tool to analyze the server type
2. Use the 'validate' tool to check if it's ready for deployment
3. If there are issues, use the 'guide' tool to show me what changes are needed
4. Generate the deployment configuration using 'generate_config'
5. If I confirm, use 'init' to write the files (requires allowWrite=true)

Start by detecting the server type.`,
					},
				},
			],
		})
	)

	// Prompt: convert_server
	server.registerPrompt(
		"convert_server",
		{
			title: "Convert Existing Server",
			description:
				"Convert an existing MCP server (stdio or other transport) to Smithery SHTTP format",
			argsSchema: {
				directory: z
					.string()
					.default(".")
					.describe("Directory containing the MCP server"),
			},
		},
		async ({ directory }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `I have an existing MCP server in "${directory}" that I want to convert to use Smithery's SHTTP transport for remote hosting.

Please:
1. Detect what type of server it is
2. Show me the transformation guide with specific code changes needed
3. Generate the smithery.yaml configuration
4. List any manual changes I need to make to my code

Start by analyzing the server.`,
					},
				},
			],
		})
	)

	return server.server
}
