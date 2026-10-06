/**
 * K.I.N.G. execution workspace — clone and deploy.
 *
 * Two effectful operations the PRD puts under M3, both of which run real
 * commands against real infrastructure, so both are built behind the same
 * write gate the Chrome server uses: `opsServer({ allowWrites })` only ever
 * registers these tools when JARVIS_ALLOW_WRITES=1. The bridge's own
 * decideTool() veto would deny them by name regardless — `king_deploy` matches
 * /deploy/ and `king_clone` matches neither read verb — so this is the second
 * layer, not the first.
 *
 * Everything here uses execFile with an argv array, never a shell string. A
 * repository name arrives from a voice transcript; concatenating that into a
 * command line would hand the microphone to whoever is in the room.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const run = promisify(execFile)

/**
 * Where clones land. Deliberately outside the project: a repo pulled down by
 * voice is scratch space, and putting it inside the app directory would get it
 * tangled up in this project's own git status on the next commit.
 */
const WORKSPACE = process.env.KING_WORKSPACE ?? join(homedir(), 'KING-WORKSPACE')

/** Slow, unattended operations get a real timeout — a big clone is not a hang. */
const CLONE_TIMEOUT = 10 * 60 * 1000
const DEPLOY_TIMEOUT = 2 * 60 * 1000

/**
 * Accepts `owner/repo`, a full https URL, or a git@ URL, and returns a
 * canonical `https://github.com/owner/repo.git`. Rejecting anything that is
 * not plainly a GitHub repo is the whole of the validation: it is what stops
 * `git clone` being pointed at an arbitrary argument.
 */
function normaliseRepo(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null

  const url = value.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
    'i',
  )
  if (url) return `https://github.com/${url[1]}/${url[2]}.git`

  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`

  return null
}

/** Last lines of a failed command, which is where git puts the actual reason. */
function tail(err) {
  const text = `${err?.stderr ?? ''}\n${err?.stdout ?? ''}\n${err?.message ?? ''}`
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' — ') || 'no output'
  )
}

const cloneDescription = `Clone a GitHub repository into the K.I.N.G. execution workspace.

Accepts "owner/repo", a full https://github.com/owner/repo URL, or a git@ URL.
Clones into ${WORKSPACE}/<repo-name>. Never clones into the application directory.

Fork first with the GitHub fork tool if they will push to it, then clone —
cloning an upstream they do not own produces a local copy they cannot write to.
Reports the branch, the commit count and the resulting path.`

const deployDescription = `Trigger a live deployment or a service restart.

  vercel         redeploy the latest production deployment for a project
  github         dispatch a GitHub Actions workflow on a branch
  pm2            restart a pm2 process by name
  nginx          reload nginx (clears a stale cache)

Pick the target from what they asked for: "deploy the portal" is vercel,
"run the build workflow" is github, "restart the API" is pm2.
Always report the deployment id, run URL or exit status you got back — a
confirmation without a result is a claim, not a confirmation.`

/**
 * @param {{ allowWrites: boolean }} opts
 */
export function opsServer({ allowWrites }) {
  const clone = tool(
    'king_clone',
    cloneDescription,
    {
      repo: z
        .string()
        .describe('owner/repo, https://github.com/owner/repo, or a git URL'),
      branch: z
        .string()
        .optional()
        .describe('Branch or tag to check out. Defaults to the remote HEAD.'),
    },
    async ({ repo, branch }) => {
      if (!allowWrites) {
        return deny('Clone needs write access. Start the bridge with `npm run bridge:writes`.')
      }
      const url = normaliseRepo(repo)
      if (!url) {
        return fail(
          `Not a GitHub repository: ${String(repo).slice(0, 80)}. ` +
            'Expected owner/repo or a github.com URL.',
        )
      }
      const name = url.split('/').pop().replace(/\.git$/, '')
      const dest = join(WORKSPACE, name)

      try {
        await mkdir(WORKSPACE, { recursive: true })
        const argv = ['clone', '--depth', '50']
        if (branch) argv.push('--branch', branch)
        argv.push(url, dest)
        const { stdout } = await run('git', argv, { timeout: CLONE_TIMEOUT })

        // The clone stdout is progress chatter on stderr; the facts the
        // model wants come from interrogating what actually landed.
        const [{ stdout: head }, { stdout: count }] = await Promise.all([
          run('git', ['-C', dest, 'log', '-1', '--format=%h %s'], { timeout: 30_000 }),
          run('git', ['-C', dest, 'rev-list', '--count', 'HEAD'], { timeout: 30_000 }),
        ])
        return ok(
          `Cloned ${url}${branch ? ` @ ${branch}` : ''} into ${dest}\n` +
            `HEAD ${head.trim()}\ncommits ${count.trim()}\n${stdout.trim()}`,
        )
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return fail('git is not on PATH on this machine, so nothing was cloned.')
        }
        if (await exists(dest)) {
          return fail(
            `${dest} already exists. Say so and offer to pull or remove it — ` +
              `never delete it to make room. Reason: ${tail(err)}`,
          )
        }
        return fail(`Clone failed: ${tail(err)}`)
      }
    },
  )

  const deploy = tool(
    'king_deploy',
    deployDescription,
    {
      target: z
        .enum(['vercel', 'github', 'pm2', 'nginx'])
        .describe('Which system to act on.'),
      project: z
        .string()
        .optional()
        .describe('Vercel project name, GitHub owner/repo, or pm2 process name.'),
      workflow: z
        .string()
        .optional()
        .describe('GitHub Actions workflow file, e.g. deploy.yml. github target only.'),
      ref: z
        .string()
        .optional()
        .describe('Git ref to dispatch on. Defaults to main. github target only.'),
    },
    async ({ target, project, workflow, ref }) => {
      if (!allowWrites) {
        return deny(
          'Deployments need write access. Start the bridge with `npm run bridge:writes`.',
        )
      }
      try {
        if (target === 'vercel') return await deployVercel(project)
        if (target === 'github') return await dispatchWorkflow(project, workflow, ref)
        if (target === 'pm2') return await restartPm2(project)
        return await reloadNginx()
      } catch (err) {
        return fail(`${target} action failed: ${tail(err)}`)
      }
    },
  )

  // Register only what the gate would let through. Advertising a tool that
  // decideTool() will veto before the handler runs is a wasted slot in the
  // model's context and a promise the bridge does not intend to keep; the
  // in-handler deny above stays as the second layer for any path that reaches
  // it without going through the gate.
  return createSdkMcpServer({
    name: 'king_ops',
    version: '1.0.0',
    instructions:
      'K.I.N.G. execution workspace: clone repositories and trigger ' +
      'deployments. Both require write access to be enabled on the bridge.',
    tools: allowWrites ? [clone, deploy] : [],
  })
}

/* ------------------------------------------------------------------ vercel */

async function deployVercel(project) {
  const token = process.env.VERCEL_TOKEN
  if (!token) return deny('No VERCEL_TOKEN is configured on the bridge.')
  if (!project) return fail('A Vercel project name is required.')

  const auth = { Authorization: `Bearer ${token}` }

  // Find the most recent production deployment, then ask Vercel to build a new
  // one from the same target. Redeploying rather than pushing keeps the action
  // reversible and means nothing on disk has to change.
  const list = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(project)}` +
      '&target=production&limit=1&state=READY',
    { headers: auth },
  )
  if (!list.ok) return fail(`Vercel list failed (${list.status}): ${await list.text()}`)
  const found = await list.json()
  const last = found.deployments?.[0]
  if (!last) return fail(`No production deployment found for "${project}".`)

  const redeploy = await fetch(
    'https://api.vercel.com/v13/deployments?forceNew=1&skipAutoDetection=1',
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: last.name,
        deploymentId: last.uid,
        target: 'production',
        meta: { githubCommitSha: last.meta?.githubCommitSha ?? '' },
      }),
    },
  )
  const body = await redeploy.text()
  if (!redeploy.ok) return fail(`Vercel redeploy failed (${redeploy.status}): ${body}`)

  const made = JSON.parse(body)
  return ok(
    `Vercel redeploy triggered for ${made.name ?? project}\n` +
      `deployment ${made.id ?? made.uid ?? 'created'}\n` +
      `url https://${made.url ?? made.alias?.[0] ?? project + '.vercel.app'}\n` +
      `source commit ${(made.meta?.githubCommitSha ?? 'unknown').slice(0, 7)}`,
  )
}

/* ------------------------------------------------------------------ github */

async function dispatchWorkflow(project, workflow, ref) {
  const token = await githubToken()
  if (!token) return deny('No GitHub token is configured on the bridge.')
  if (!project) return fail('A GitHub owner/repo is required, e.g. kingenious0/repo.')
  if (!workflow) return fail('A workflow file is required, e.g. deploy.yml.')

  const repo = project.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: ref || 'main' }),
    },
  )
  // 204 is success with no body — the dispatch accepted, the run is queued.
  if (res.status !== 204) {
    return fail(`Workflow dispatch failed (${res.status}): ${await res.text()}`)
  }
  return ok(
    `Workflow ${workflow} dispatched on ${repo} @ ${ref || 'main'}\n` +
      'run queued — poll the Actions tab for the run URL',
  )
}

/** The bridge already knows where GitHub credentials live; do not duplicate them. */
async function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  if (fromEnv) return fromEnv
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8'))
    const env = cfg.mcpServers?.github?.env ?? {}
    return env.GITHUB_PERSONAL_ACCESS_TOKEN ?? env.GITHUB_TOKEN ?? null
  } catch {
    return null
  }
}

/** True when a path already exists — used to tell "already cloned" from "failed". */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------- pm2 */

async function restartPm2(name) {
  if (!name) return fail('A pm2 process name is required.')
  const { stdout } = await run('pm2', ['restart', name], { timeout: DEPLOY_TIMEOUT })
  return ok(`pm2 restart ${name}\n${stdout.trim()}`)
}

/* ------------------------------------------------------------------ nginx */

async function reloadNginx() {
  // aaPanel exposes a REST endpoint for cache purge and config reload, keyed by
  // a panel secret. Without one, a plain nginx -t && nginx -s reload is the
  // honest equivalent and needs no credentials.
  const panelUrl = process.env.AAPANEL_URL
  const panelKey = process.env.AAPANEL_KEY
  if (panelUrl && panelKey) {
    const res = await fetch(
      `${panelUrl.replace(/\/+$/, '')}/panel/api?call_name=nginx&action=reload&secret=${encodeURIComponent(panelKey)}`,
      { method: 'POST', timeout: DEPLOY_TIMEOUT },
    )
    const text = await res.text()
    if (!res.ok) return fail(`aaPanel nginx reload failed (${res.status}): ${text}`)
    return ok(`aaPanel nginx reload accepted\n${text.slice(0, 200)}`)
  }
  const { stdout } = await run('nginx', ['-t'], { timeout: 30_000 })
  await run('nginx', ['-s', 'reload'], { timeout: 30_000 })
  return ok(`nginx reloaded\n${stdout.trim()}`)
}

/* ---------------------------------------------------------------- helpers */

function ok(text) {
  return { content: [{ type: 'text', text }] }
}
function fail(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}
function deny(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}
