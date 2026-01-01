#!/usr/bin/env node
/**
 * Smithery Deploy CLI
 *
 * Converts local MCP servers to remote SHTTP servers hosted on Smithery.
 */

import { Command } from "commander"
import chalk from "chalk"
import * as fs from "node:fs"
import * as path from "node:path"
import { detectMcpServer } from "./detector.js"
import {
	generateDeploymentFiles,
	generateTransformationGuide,
	writeGeneratedFiles,
} from "./generator.js"
import type { RuntimeType } from "./types.js"

const program = new Command()

program
	.name("smithery-deploy")
	.description(
		"Deploy local MCP servers to Smithery as remote SHTTP servers"
	)
	.version("1.0.0")

program
	.command("detect")
	.description("Detect the type of MCP server in a directory")
	.argument("[directory]", "Target directory", ".")
	.action(async (directory: string) => {
		try {
			const targetDir = path.resolve(directory)
			console.log(chalk.blue("Detecting MCP server type in:"), targetDir)
			console.log()

			const result = await detectMcpServer(targetDir)

			console.log(chalk.bold("Detection Results:"))
			console.log()
			console.log(
				chalk.cyan("Runtime:"),
				result.runtime,
				chalk.gray(`(confidence: ${result.confidence})`)
			)

			if (result.details.language) {
				console.log(chalk.cyan("Language:"), result.details.language)
			}
			if (result.details.framework) {
				console.log(chalk.cyan("Framework:"), result.details.framework)
			}
			if (result.details.entryPoint) {
				console.log(chalk.cyan("Entry Point:"), result.details.entryPoint)
			}
			if (result.details.serverName) {
				console.log(chalk.cyan("Server Name:"), result.details.serverName)
			}

			console.log()
			console.log(
				chalk.cyan("Has MCP Dependency:"),
				result.details.hasMcpDependency ? chalk.green("Yes") : chalk.yellow("No")
			)
			console.log(
				chalk.cyan("Has smithery.yaml:"),
				result.details.hasExistingSmitheryYaml
					? chalk.green("Yes")
					: chalk.yellow("No")
			)
			console.log(
				chalk.cyan("Has Dockerfile:"),
				result.details.hasDockerfile ? chalk.green("Yes") : chalk.yellow("No")
			)

			if (result.details.configSchema) {
				console.log()
				console.log(chalk.cyan("Detected Config Schema:"))
				console.log(
					JSON.stringify(result.details.configSchema, null, 2)
				)
			}

			if (result.suggestions.length > 0) {
				console.log()
				console.log(chalk.yellow("Suggestions:"))
				for (const suggestion of result.suggestions) {
					console.log(chalk.yellow("  -"), suggestion)
				}
			}
		} catch (error) {
			console.error(chalk.red("Error:"), (error as Error).message)
			process.exit(1)
		}
	})

program
	.command("init")
	.description("Initialize Smithery deployment configuration")
	.argument("[directory]", "Target directory", ".")
	.option("-r, --runtime <type>", "Force runtime type (typescript, python, container)")
	.option("-t, --target <type>", "Deployment target (remote, local)", "remote")
	.option("-f, --force", "Overwrite existing files")
	.option("--dry-run", "Show what would be generated without writing files")
	.action(
		async (
			directory: string,
			options: {
				runtime?: RuntimeType
				target?: "remote" | "local"
				force?: boolean
				dryRun?: boolean
			}
		) => {
			try {
				const targetDir = path.resolve(directory)
				console.log(chalk.blue("Initializing Smithery deployment for:"), targetDir)
				console.log()

				// Detect server type
				const detection = await detectMcpServer(targetDir)

				// Override runtime if specified
				if (options.runtime) {
					detection.runtime = options.runtime
				}

				console.log(
					chalk.cyan("Detected runtime:"),
					detection.runtime,
					chalk.gray(`(${detection.confidence} confidence)`)
				)
				console.log()

				// Generate files
				const files = generateDeploymentFiles(detection, {
					target: options.target,
					overwrite: options.force,
				})

				if (options.dryRun) {
					console.log(chalk.yellow("Dry run - files that would be generated:"))
					console.log()
					for (const [filename, content] of Object.entries(files)) {
						if (!content) continue
						console.log(chalk.bold(`=== ${filename} ===`))
						console.log(content)
						console.log()
					}
					return
				}

				// Write files
				const { written, skipped } = writeGeneratedFiles(targetDir, files, {
					dryRun: options.dryRun,
					overwrite: options.force,
				})

				if (written.length > 0) {
					console.log(chalk.green("Created files:"))
					for (const file of written) {
						console.log(chalk.green("  +"), file)
					}
				}

				if (skipped.length > 0) {
					console.log()
					console.log(chalk.yellow("Skipped (already exist):"))
					for (const file of skipped) {
						console.log(chalk.yellow("  -"), file, chalk.gray("(use --force to overwrite)"))
					}
				}

				console.log()
				console.log(chalk.green("Done!"), "Your server is ready for Smithery deployment.")
				console.log()
				console.log(chalk.cyan("Next steps:"))
				console.log("  1. Review the generated smithery.yaml")
				console.log("  2. Push your changes to GitHub")
				console.log("  3. Visit https://smithery.ai/new to deploy")
			} catch (error) {
				console.error(chalk.red("Error:"), (error as Error).message)
				process.exit(1)
			}
		}
	)

program
	.command("guide")
	.description("Show transformation guide for your MCP server")
	.argument("[directory]", "Target directory", ".")
	.action(async (directory: string) => {
		try {
			const targetDir = path.resolve(directory)
			const detection = await detectMcpServer(targetDir)
			const guide = generateTransformationGuide(detection)
			console.log(guide)
		} catch (error) {
			console.error(chalk.red("Error:"), (error as Error).message)
			process.exit(1)
		}
	})

program
	.command("validate")
	.description("Validate Smithery deployment configuration")
	.argument("[directory]", "Target directory", ".")
	.action(async (directory: string) => {
		try {
			const targetDir = path.resolve(directory)
			const detection = await detectMcpServer(targetDir)

			console.log(chalk.blue("Validating Smithery configuration in:"), targetDir)
			console.log()

			const issues: string[] = []
			const warnings: string[] = []

			// Check smithery.yaml
			if (!detection.details.hasExistingSmitheryYaml) {
				issues.push("Missing smithery.yaml - run 'smithery-deploy init' to create it")
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

			if (issues.length === 0 && warnings.length === 0) {
				console.log(chalk.green("✓"), "Configuration looks good!")
				console.log()
				console.log(chalk.cyan("Ready for deployment:"))
				console.log("  1. Push to GitHub")
				console.log("  2. Visit https://smithery.ai/new")
			} else {
				if (issues.length > 0) {
					console.log(chalk.red("Issues:"))
					for (const issue of issues) {
						console.log(chalk.red("  ✗"), issue)
					}
				}

				if (warnings.length > 0) {
					console.log()
					console.log(chalk.yellow("Warnings:"))
					for (const warning of warnings) {
						console.log(chalk.yellow("  !"), warning)
					}
				}

				if (issues.length > 0) {
					process.exit(1)
				}
			}
		} catch (error) {
			console.error(chalk.red("Error:"), (error as Error).message)
			process.exit(1)
		}
	})

program
	.command("convert")
	.description("Convert an existing MCP server to Smithery-compatible format")
	.argument("[directory]", "Target directory", ".")
	.option("-f, --force", "Overwrite existing files")
	.option("--dry-run", "Show changes without applying them")
	.action(
		async (
			directory: string,
			options: {
				force?: boolean
				dryRun?: boolean
			}
		) => {
			try {
				const targetDir = path.resolve(directory)
				console.log(chalk.blue("Converting MCP server to Smithery format:"), targetDir)
				console.log()

				const detection = await detectMcpServer(targetDir)

				console.log(
					chalk.cyan("Detected:"),
					detection.runtime,
					detection.details.framework
						? `(${detection.details.framework})`
						: ""
				)
				console.log()

				// Generate smithery.yaml
				const files = generateDeploymentFiles(detection, {
					target: "remote",
					overwrite: options.force,
				})

				if (options.dryRun) {
					console.log(chalk.yellow("Dry run - changes that would be made:"))
					console.log()

					for (const [filename, content] of Object.entries(files)) {
						if (!content) continue
						const filePath = path.join(targetDir, filename)
						const exists = fs.existsSync(filePath)

						if (exists && !options.force) {
							console.log(
								chalk.yellow(`[SKIP] ${filename}`),
								chalk.gray("(already exists)")
							)
						} else {
							console.log(
								chalk.green(`[${exists ? "UPDATE" : "CREATE"}] ${filename}`)
							)
						}
					}

					console.log()
					console.log(chalk.bold("Generated smithery.yaml:"))
					console.log(files["smithery.yaml"])
					return
				}

				const { written, skipped } = writeGeneratedFiles(targetDir, files, {
					overwrite: options.force,
				})

				if (written.length > 0) {
					console.log(chalk.green("Created/Updated:"))
					for (const file of written) {
						console.log(chalk.green("  +"), file)
					}
				}

				if (skipped.length > 0) {
					console.log()
					console.log(chalk.yellow("Skipped:"))
					for (const file of skipped) {
						console.log(chalk.yellow("  -"), file)
					}
				}

				// Show transformation guide for manual changes
				if (detection.suggestions.length > 0) {
					console.log()
					console.log(chalk.cyan("Manual changes needed:"))
					for (const suggestion of detection.suggestions) {
						console.log(chalk.cyan("  -"), suggestion)
					}
				}

				console.log()
				console.log(chalk.bold("Next steps:"))
				console.log()

				if (detection.runtime === "typescript") {
					console.log("1. Ensure your server exports a default createServer function")
					console.log("2. Add dev/build scripts to package.json:")
					console.log('   "dev": "smithery dev"')
					console.log('   "build": "smithery build"')
					console.log("3. Test locally: npm run dev")
					console.log("4. Push to GitHub and deploy at https://smithery.ai/new")
				} else if (detection.runtime === "python") {
					console.log("1. Add @smithery.server() decorator to your server function")
					console.log("2. Test locally: smithery dev")
					console.log("3. Push to GitHub and deploy at https://smithery.ai/new")
				} else {
					console.log("1. Ensure your server implements MCP Streamable HTTP")
					console.log("2. Listen on PORT environment variable (default: 8081)")
					console.log("3. Build and test your Docker container")
					console.log("4. Push to GitHub and deploy at https://smithery.ai/new")
				}
			} catch (error) {
				console.error(chalk.red("Error:"), (error as Error).message)
				process.exit(1)
			}
		}
	)

program.parse()
