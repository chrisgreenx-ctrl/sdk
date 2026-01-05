/**
 * Git Deploy Module
 *
 * Handles git operations for deploying repositories to Smithery via GitHub.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync, exec } from "node:child_process"
import { promisify } from "node:util"
import type { DetectionResult, GeneratedFiles } from "./types.js"

const execAsync = promisify(exec)

export interface GitDeployOptions {
	/** The source git repository URL to clone */
	sourceRepoUrl: string
	/** Branch to clone from source (default: main or master) */
	sourceBranch?: string
	/** GitHub personal access token for authentication */
	githubToken: string
	/** Target GitHub owner (username or org) */
	targetOwner: string
	/** Target repository name */
	targetRepo: string
	/** Target branch to push to (default: main) */
	targetBranch?: string
	/** Whether to create a new repo if it doesn't exist */
	createIfNotExists?: boolean
	/** Whether to force overwrite existing files */
	force?: boolean
}

export interface GitDeployResult {
	success: boolean
	tempDir?: string
	clonedFrom: string
	pushedTo: string
	filesGenerated: string[]
	filesSkipped: string[]
	deploymentUrl: string
	error?: string
}

/**
 * Clone a git repository to a temporary directory
 */
export async function cloneRepository(
	repoUrl: string,
	branch?: string
): Promise<{ tempDir: string; defaultBranch: string }> {
	// Create a unique temp directory
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithery-deploy-"))

	try {
		// Clone the repository
		const branchArg = branch ? `--branch ${branch}` : ""
		const cloneCmd = `git clone --depth 1 ${branchArg} "${repoUrl}" "${tempDir}"`

		await execAsync(cloneCmd, { timeout: 120000 }) // 2 minute timeout

		// Detect default branch if not specified
		let defaultBranch = branch || "main"
		if (!branch) {
			try {
				const { stdout } = await execAsync(
					"git rev-parse --abbrev-ref HEAD",
					{ cwd: tempDir }
				)
				defaultBranch = stdout.trim()
			} catch {
				// Fall back to main
			}
		}

		return { tempDir, defaultBranch }
	} catch (error) {
		// Clean up on failure
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
		throw new Error(
			`Failed to clone repository: ${(error as Error).message}`
		)
	}
}

/**
 * Check if a GitHub repository exists
 */
export async function checkRepoExists(
	owner: string,
	repo: string,
	token: string
): Promise<boolean> {
	try {
		const response = await fetch(
			`https://api.github.com/repos/${owner}/${repo}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)
		return response.ok
	} catch {
		return false
	}
}

/**
 * Create a new GitHub repository
 */
export async function createGitHubRepo(
	owner: string,
	repo: string,
	token: string,
	options: {
		description?: string
		isPrivate?: boolean
	} = {}
): Promise<{ success: boolean; htmlUrl?: string; error?: string }> {
	try {
		// Check if creating for user or org
		const userResponse = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		})
		const userData = (await userResponse.json()) as { login: string }
		const isUserRepo = userData.login === owner

		const endpoint = isUserRepo
			? "https://api.github.com/user/repos"
			: `https://api.github.com/orgs/${owner}/repos`

		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({
				name: repo,
				description:
					options.description || "MCP server deployed via Smithery",
				private: options.isPrivate ?? false,
				auto_init: false,
			}),
		})

		if (!response.ok) {
			const error = (await response.json()) as { message: string }
			return { success: false, error: error.message }
		}

		const data = (await response.json()) as { html_url: string }
		return { success: true, htmlUrl: data.html_url }
	} catch (error) {
		return { success: false, error: (error as Error).message }
	}
}

/**
 * Push changes to a GitHub repository
 */
export async function pushToGitHub(
	localDir: string,
	options: {
		githubToken: string
		targetOwner: string
		targetRepo: string
		targetBranch: string
		commitMessage: string
	}
): Promise<{ success: boolean; error?: string }> {
	const { githubToken, targetOwner, targetRepo, targetBranch, commitMessage } =
		options

	// Construct the authenticated remote URL
	const remoteUrl = `https://${githubToken}@github.com/${targetOwner}/${targetRepo}.git`

	try {
		// Configure git user (required for commits)
		await execAsync('git config user.email "smithery-deploy@smithery.ai"', {
			cwd: localDir,
		})
		await execAsync('git config user.name "Smithery Deploy"', {
			cwd: localDir,
		})

		// Remove existing origin and add new one
		try {
			await execAsync("git remote remove origin", { cwd: localDir })
		} catch {
			// Origin might not exist, ignore
		}
		await execAsync(`git remote add origin "${remoteUrl}"`, { cwd: localDir })

		// Stage all changes
		await execAsync("git add -A", { cwd: localDir })

		// Check if there are changes to commit
		const { stdout: status } = await execAsync("git status --porcelain", {
			cwd: localDir,
		})

		if (status.trim()) {
			// Commit changes
			await execAsync(`git commit -m "${commitMessage}"`, { cwd: localDir })
		}

		// Push to target branch
		await execAsync(`git push -u origin HEAD:${targetBranch} --force`, {
			cwd: localDir,
			timeout: 120000, // 2 minute timeout
		})

		return { success: true }
	} catch (error) {
		return { success: false, error: (error as Error).message }
	}
}

/**
 * Clean up temporary directory
 */
export function cleanupTempDir(tempDir: string): void {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true })
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Main function to deploy a git repository to Smithery via GitHub
 */
export async function deployFromGit(
	options: GitDeployOptions,
	detection: DetectionResult,
	generatedFiles: GeneratedFiles
): Promise<GitDeployResult> {
	const {
		sourceRepoUrl,
		sourceBranch,
		githubToken,
		targetOwner,
		targetRepo,
		targetBranch = "main",
		createIfNotExists = true,
		force = false,
	} = options

	let tempDir: string | undefined

	try {
		// Step 1: Clone the source repository
		const cloneResult = await cloneRepository(sourceRepoUrl, sourceBranch)
		tempDir = cloneResult.tempDir

		// Step 2: Check if target repo exists
		const repoExists = await checkRepoExists(targetOwner, targetRepo, githubToken)

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
						success: false,
						clonedFrom: sourceRepoUrl,
						pushedTo: `github.com/${targetOwner}/${targetRepo}`,
						filesGenerated: [],
						filesSkipped: [],
						deploymentUrl: "",
						error: `Failed to create repository: ${createResult.error}`,
					}
				}
			} else {
				return {
					success: false,
					clonedFrom: sourceRepoUrl,
					pushedTo: `github.com/${targetOwner}/${targetRepo}`,
					filesGenerated: [],
					filesSkipped: [],
					deploymentUrl: "",
					error: `Repository ${targetOwner}/${targetRepo} does not exist and createIfNotExists is false`,
				}
			}
		}

		// Step 3: Write generated files to the cloned repo
		const filesGenerated: string[] = []
		const filesSkipped: string[] = []

		for (const [filename, content] of Object.entries(generatedFiles)) {
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

		// Step 4: Push to GitHub
		const pushResult = await pushToGitHub(tempDir, {
			githubToken,
			targetOwner,
			targetRepo,
			targetBranch,
			commitMessage: "Add Smithery deployment configuration",
		})

		if (!pushResult.success) {
			return {
				success: false,
				tempDir,
				clonedFrom: sourceRepoUrl,
				pushedTo: `github.com/${targetOwner}/${targetRepo}`,
				filesGenerated,
				filesSkipped,
				deploymentUrl: "",
				error: `Failed to push: ${pushResult.error}`,
			}
		}

		// Step 5: Return success with deployment URL
		const deploymentUrl = `https://smithery.ai/new?repo=${targetOwner}/${targetRepo}`

		return {
			success: true,
			clonedFrom: sourceRepoUrl,
			pushedTo: `https://github.com/${targetOwner}/${targetRepo}`,
			filesGenerated,
			filesSkipped,
			deploymentUrl,
		}
	} catch (error) {
		return {
			success: false,
			clonedFrom: sourceRepoUrl,
			pushedTo: `github.com/${targetOwner}/${targetRepo}`,
			filesGenerated: [],
			filesSkipped: [],
			deploymentUrl: "",
			error: (error as Error).message,
		}
	} finally {
		// Clean up temp directory
		if (tempDir) {
			cleanupTempDir(tempDir)
		}
	}
}

/**
 * Validate a GitHub token by making an API call
 */
export async function validateGitHubToken(
	token: string
): Promise<{ valid: boolean; username?: string; error?: string }> {
	try {
		const response = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		})

		if (!response.ok) {
			return { valid: false, error: "Invalid or expired token" }
		}

		const data = (await response.json()) as { login: string }
		return { valid: true, username: data.login }
	} catch (error) {
		return { valid: false, error: (error as Error).message }
	}
}

/**
 * Parse a git repository URL to extract owner and repo
 */
export function parseGitUrl(url: string): { owner: string; repo: string } | null {
	// Handle various git URL formats
	const patterns = [
		// https://github.com/owner/repo.git
		/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/,
		// git@github.com:owner/repo.git
		/git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/,
		// https://github.com/owner/repo
		/github\.com\/([^/]+)\/([^/]+?)$/,
	]

	for (const pattern of patterns) {
		const match = url.match(pattern)
		if (match) {
			return {
				owner: match[1],
				repo: match[2].replace(/\.git$/, ""),
			}
		}
	}

	return null
}
