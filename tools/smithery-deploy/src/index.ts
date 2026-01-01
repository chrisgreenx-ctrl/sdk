/**
 * Smithery Deploy Tool
 *
 * Programmatic API for converting local MCP servers to remote SHTTP servers on Smithery.
 */

export { detectMcpServer } from "./detector.js"
export {
	generateDeploymentFiles,
	generateDockerfile,
	generateDockerfileConfig,
	generateDockerignore,
	generateSmitheryYaml,
	generateTransformationGuide,
	writeGeneratedFiles,
} from "./generator.js"
export * from "./types.js"

import { detectMcpServer } from "./detector.js"
import {
	generateDeploymentFiles,
	writeGeneratedFiles,
} from "./generator.js"
import type { DeploymentOptions, GeneratedFiles } from "./types.js"

/**
 * Main deployment function - detects server type and generates deployment files
 *
 * @example
 * ```typescript
 * import { deploy } from "@smithery/deploy-tool"
 *
 * // Deploy a local MCP server to Smithery
 * const result = await deploy({
 *   targetDir: "./my-mcp-server",
 *   dryRun: false,
 *   force: false,
 * })
 *
 * console.log("Generated files:", result.files)
 * console.log("Detection:", result.detection)
 * ```
 */
export async function deploy(options: DeploymentOptions): Promise<{
	detection: Awaited<ReturnType<typeof detectMcpServer>>
	files: GeneratedFiles
	written: string[]
	skipped: string[]
}> {
	const { targetDir, dryRun, force, runtime, target } = options

	// Detect server type
	const detection = await detectMcpServer(targetDir)

	// Override runtime if specified
	if (runtime) {
		detection.runtime = runtime
	}

	// Generate files
	const files = generateDeploymentFiles(detection, {
		target: target || "remote",
		overwrite: force,
	})

	// Write files unless dry run
	const { written, skipped } = dryRun
		? { written: Object.keys(files).filter((k) => files[k as keyof GeneratedFiles]), skipped: [] }
		: writeGeneratedFiles(targetDir, files, { overwrite: force })

	return {
		detection,
		files,
		written,
		skipped,
	}
}

export default deploy
