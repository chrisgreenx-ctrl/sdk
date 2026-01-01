/**
 * Smithery Deploy Tool Types
 *
 * Type definitions for the MCP server deployment tool.
 */

export type RuntimeType = "typescript" | "python" | "container"

export type TargetType = "remote" | "local"

export interface ConfigSchemaProperty {
	type: string
	description?: string
	default?: unknown
	required?: boolean
	enum?: string[]
	minimum?: number
	maximum?: number
}

export interface ConfigSchema {
	type: "object"
	properties: Record<string, ConfigSchemaProperty>
	required?: string[]
}

export interface SmitheryYamlConfig {
	runtime: RuntimeType
	target?: TargetType
	env?: Record<string, string>
	build?: {
		dockerfile?: string
		dockerBuildPath?: string
	}
	startCommand?: {
		type: "http" | "stdio"
		configSchema?: ConfigSchema
		exampleConfig?: Record<string, unknown>
		commandFunction?: string
	}
}

export interface DetectionResult {
	runtime: RuntimeType
	confidence: "high" | "medium" | "low"
	details: {
		entryPoint?: string
		hasExistingSmitheryYaml: boolean
		existingSmitheryConfig?: SmitheryYamlConfig
		hasMcpDependency: boolean
		hasDockerfile: boolean
		configSchema?: ConfigSchema
		serverName?: string
		serverVersion?: string
		language?: string
		framework?: string
	}
	suggestions: string[]
}

export interface DeploymentOptions {
	targetDir: string
	dryRun: boolean
	force: boolean
	runtime?: RuntimeType
	target?: TargetType
}

export interface DockerfileConfig {
	baseImage: string
	workdir: string
	copyCommands: string[]
	installCommand: string
	buildCommand?: string
	startCommand: string
	port: number
	env: Record<string, string>
}

export interface GeneratedFiles {
	"smithery.yaml"?: string
	Dockerfile?: string
	".dockerignore"?: string
}
