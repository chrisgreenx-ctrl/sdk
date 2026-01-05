/**
 * Git Deploy Module
 *
 * Handles git operations for deploying repositories to Smithery via GitHub.
 * Uses GitHub API directly - no git binary required.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import * as tar from "tar"
import type { DetectionResult, GeneratedFiles } from "./types.js"

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

/**
 * Download and extract a GitHub repository using the GitHub API
 * No git binary required - uses tarball download
 */
export async function cloneRepository(
	repoUrl: string,
	branch?: string,
	token?: string
): Promise<{ tempDir: string; defaultBranch: string }> {
	// Parse the GitHub URL
	const parsed = parseGitUrl(repoUrl)
	if (!parsed) {
		throw new Error(
			`Invalid GitHub URL: ${repoUrl}. Only GitHub repositories are supported.`
		)
	}

	const { owner, repo } = parsed

	// Create a unique temp directory
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithery-deploy-"))

	try {
		// Get default branch if not specified
		let targetBranch = branch
		if (!targetBranch) {
			const repoInfo = await getRepoInfo(owner, repo, token)
			targetBranch = repoInfo.default_branch || "main"
		}

		// Download tarball from GitHub API
		const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${targetBranch}`
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "smithery-deploy",
		}
		if (token) {
			headers["Authorization"] = `Bearer ${token}`
		}

		const response = await fetch(tarballUrl, {
			headers,
			redirect: "follow",
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Failed to download repository: ${response.status} ${response.statusText}. ${errorText}`
			)
		}

		// Get the response body as a readable stream
		if (!response.body) {
			throw new Error("No response body received from GitHub API")
		}

		// Convert web stream to Node.js readable stream and extract
		const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream)

		await pipeline(
			nodeStream,
			tar.extract({
				cwd: tempDir,
				strip: 1, // Remove the top-level directory (owner-repo-sha)
			})
		)

		return { tempDir, defaultBranch: targetBranch }
	} catch (error) {
		// Clean up on failure
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
		throw new Error(
			`Failed to download repository: ${(error as Error).message}`
		)
	}
}

/**
 * Get repository information from GitHub API
 */
async function getRepoInfo(
	owner: string,
	repo: string,
	token?: string
): Promise<{ default_branch: string }> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "smithery-deploy",
	}
	if (token) {
		headers["Authorization"] = `Bearer ${token}`
	}

	const response = await fetch(
		`https://api.github.com/repos/${owner}/${repo}`,
		{ headers }
	)

	if (!response.ok) {
		// Default to 'main' if we can't get repo info
		return { default_branch: "main" }
	}

	return (await response.json()) as { default_branch: string }
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
					"User-Agent": "smithery-deploy",
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
				"User-Agent": "smithery-deploy",
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
				"User-Agent": "smithery-deploy",
			},
			body: JSON.stringify({
				name: repo,
				description:
					options.description || "MCP server deployed via Smithery",
				private: options.isPrivate ?? false,
				auto_init: true, // Initialize with README so we have a branch to push to
			}),
		})

		if (!response.ok) {
			const error = (await response.json()) as { message: string }
			return { success: false, error: error.message }
		}

		const data = (await response.json()) as { html_url: string }

		// Wait a moment for GitHub to initialize the repo
		await new Promise(resolve => setTimeout(resolve, 2000))

		return { success: true, htmlUrl: data.html_url }
	} catch (error) {
		return { success: false, error: (error as Error).message }
	}
}

/**
 * Push files to a GitHub repository using the GitHub API
 * No git binary required - uses Contents API and Git Data API
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
	const { githubToken, targetOwner, targetRepo, targetBranch, commitMessage } = options

	const headers = {
		Authorization: `Bearer ${githubToken}`,
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
		"User-Agent": "smithery-deploy",
	}

	try {
		// Step 1: Get the current commit SHA for the branch (or create branch if new repo)
		let baseSha: string
		let baseTreeSha: string

		const refResponse = await fetch(
			`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${targetBranch}`,
			{ headers }
		)

		if (refResponse.ok) {
			const refData = (await refResponse.json()) as { object: { sha: string } }
			baseSha = refData.object.sha

			// Get the tree SHA from the commit
			const commitResponse = await fetch(
				`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits/${baseSha}`,
				{ headers }
			)
			const commitData = (await commitResponse.json()) as { tree: { sha: string } }
			baseTreeSha = commitData.tree.sha
		} else {
			// Branch doesn't exist, try to get default branch
			const defaultRefResponse = await fetch(
				`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/main`,
				{ headers }
			)

			if (!defaultRefResponse.ok) {
				// Try master branch
				const masterRefResponse = await fetch(
					`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/master`,
					{ headers }
				)

				if (!masterRefResponse.ok) {
					return { success: false, error: "Could not find any branch to base commit on" }
				}

				const masterData = (await masterRefResponse.json()) as { object: { sha: string } }
				baseSha = masterData.object.sha
			} else {
				const defaultData = (await defaultRefResponse.json()) as { object: { sha: string } }
				baseSha = defaultData.object.sha
			}

			const commitResponse = await fetch(
				`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits/${baseSha}`,
				{ headers }
			)
			const commitData = (await commitResponse.json()) as { tree: { sha: string } }
			baseTreeSha = commitData.tree.sha
		}

		// Step 2: Collect all files to upload
		const filesToUpload = collectFiles(localDir)

		if (filesToUpload.length === 0) {
			return { success: false, error: "No files to upload" }
		}

		// Step 3: Create blobs for each file
		const treeItems: Array<{
			path: string
			mode: "100644"
			type: "blob"
			sha: string
		}> = []

		for (const file of filesToUpload) {
			const content = fs.readFileSync(file.fullPath)
			const base64Content = content.toString("base64")

			const blobResponse = await fetch(
				`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/blobs`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						content: base64Content,
						encoding: "base64",
					}),
				}
			)

			if (!blobResponse.ok) {
				const error = await blobResponse.text()
				return { success: false, error: `Failed to create blob for ${file.relativePath}: ${error}` }
			}

			const blobData = (await blobResponse.json()) as { sha: string }
			treeItems.push({
				path: file.relativePath,
				mode: "100644",
				type: "blob",
				sha: blobData.sha,
			})
		}

		// Step 4: Create a new tree
		const treeResponse = await fetch(
			`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/trees`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					base_tree: baseTreeSha,
					tree: treeItems,
				}),
			}
		)

		if (!treeResponse.ok) {
			const error = await treeResponse.text()
			return { success: false, error: `Failed to create tree: ${error}` }
		}

		const treeData = (await treeResponse.json()) as { sha: string }

		// Step 5: Create a new commit
		const newCommitResponse = await fetch(
			`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					message: commitMessage,
					tree: treeData.sha,
					parents: [baseSha],
				}),
			}
		)

		if (!newCommitResponse.ok) {
			const error = await newCommitResponse.text()
			return { success: false, error: `Failed to create commit: ${error}` }
		}

		const newCommitData = (await newCommitResponse.json()) as { sha: string }

		// Step 6: Update the branch reference (or create it)
		const updateRefResponse = await fetch(
			`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${targetBranch}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify({
					sha: newCommitData.sha,
					force: true,
				}),
			}
		)

		if (!updateRefResponse.ok) {
			// Branch might not exist, try to create it
			const createRefResponse = await fetch(
				`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						ref: `refs/heads/${targetBranch}`,
						sha: newCommitData.sha,
					}),
				}
			)

			if (!createRefResponse.ok) {
				const error = await createRefResponse.text()
				return { success: false, error: `Failed to update/create branch: ${error}` }
			}
		}

		return { success: true }
	} catch (error) {
		return { success: false, error: (error as Error).message }
	}
}

/**
 * Collect all files from a directory recursively
 */
function collectFiles(
	dir: string,
	baseDir: string = dir
): Array<{ fullPath: string; relativePath: string }> {
	const files: Array<{ fullPath: string; relativePath: string }> = []
	const entries = fs.readdirSync(dir, { withFileTypes: true })

	// Directories and files to skip
	const skipDirs = new Set([
		".git",
		"node_modules",
		"__pycache__",
		".venv",
		"venv",
		".pytest_cache",
		"dist",
		".next",
		"coverage",
	])

	const skipFiles = new Set([".DS_Store", "Thumbs.db"])

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name)
		const relativePath = path.relative(baseDir, fullPath)

		if (entry.isDirectory()) {
			if (!skipDirs.has(entry.name)) {
				files.push(...collectFiles(fullPath, baseDir))
			}
		} else if (entry.isFile()) {
			if (!skipFiles.has(entry.name)) {
				files.push({ fullPath, relativePath })
			}
		}
	}

	return files
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
				"User-Agent": "smithery-deploy",
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
		// Step 1: Clone the source repository (downloads via GitHub API)
		const cloneResult = await cloneRepository(sourceRepoUrl, sourceBranch, githubToken)
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

		// Step 4: Push to GitHub using API
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
