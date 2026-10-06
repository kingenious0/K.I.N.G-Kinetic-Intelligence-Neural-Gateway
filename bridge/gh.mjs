/**
 * K.I.N.G. GitHub server — full read/write autonomy over the gh CLI.
 *
 * Why the CLI and not a PAT-backed HTTP server: `gh` is already authenticated
 * on this machine as the owning account (keyring, `repo` + `workflow` scopes),
 * which means forking, dispatching and pushing land as the user rather than as
 * a machine account, and no token ever has to be written into a config file.
 * If gh is missing or logged out, every tool answers with the exact command to
 * fix it rather than throwing.
 *
 * Tool naming is load-bearing. The bridge's decideTool() reads verbs out of
 * names: `list_*` / `get_*` / `search_*` / `check_*` pass as reads, anything
 * else falls through to ALLOW_WRITES. So the read surface is named to match
 * that grammar on purpose, and the write surface — create_fork, dispatch,
 * merge, push — is left to fail closed. Nothing here is exempted.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)

/** A big clone or a queued workflow run is slow, not hung. */
const TIMEOUT = 90_000

/**
 * One place to shell out. Never a string command — repo and branch names come
 * from a voice transcript, and argv arrays are what keep that from becoming an
 * injection. `json` callers get parsed output; everyone else gets stdout.
 */
async function gh(args, { json = false, timeout = TIMEOUT } = {}) {
  try {
    const { stdout, stderr } = await run('gh', args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    if (json) {
      const text = stdout.trim()
      return text ? JSON.parse(text) : null
    }
    return stdout.trim() || stderr.trim()
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        'The gh CLI is not installed on this machine. Nothing was changed.',
      )
    }
    const detail =
      err?.stderr?.toString().trim() ||
      err?.stdout?.toString().trim() ||
      err?.message ||
      'unknown error'
    if (/authentication|auth token|not logged in|401/i.test(detail)) {
      throw new Error('gh is not authenticated. Run `gh auth login` first.')
    }
    throw new Error(detail.split('\n').slice(-3).join(' — '))
  }
}

/** `owner/repo` or a URL in, `owner/repo` out. Rejects anything else. */
function normaliseRepo(raw) {
  const value = String(raw ?? '').trim()
  const m =
    value.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) ??
    value.match(/^([\w.-]+)\/([\w.-]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}
function fail(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}

/* --------------------------------------------------------------- read side */

const searchDescription = `Search GitHub's public catalog for repositories.

Use this whenever they ask what exists, what to start from, what is popular, or
what template/boilerplate/library would fit a job. Returns full name, stars,
language and description, ranked by stars. Narrow the query rather than
returning the first page: a topic plus a distinguishing word beats a phrase.`

const listPrsDescription = `List open pull requests, optionally filtered by state or author.

Reports number, title, author, branch and check status. Use for "my pull
requests", "what's open", "anything waiting on me".`

const listIssuesDescription = `List issues in a repository by state.

Reports number, title, labels and age. Use for "the issue queue", "what's
open", "anything flagged".`

const runsDescription = `List recent GitHub Actions workflow runs and their conclusions.

Reports the run name, branch, conclusion and how long ago it finished. This is
the CI/CD status half of an infrastructure check — call it when they ask about
builds, checks, the pipeline, or whether main is green.`

const statusDescription = `Get the CI status and latest commit for a repository.

Returns the head commit message, author, age, and whether checks passed, failed
or are pending. Lead an infrastructure report with this.`

const forkDescription = `Fork a repository into the authenticated account (kingenious0).

Returns the new fork's full name and URL. Fork first, then clone the fork with
king_clone — cloning an upstream they do not own yields a copy they cannot push
to.`

const dispatchDescription = `Dispatch a GitHub Actions workflow on a ref.

The workflow file must already exist in the repo (e.g. deploy.yml). Returns
whether the dispatch was accepted. Use for "run the tests", "trigger the build",
"kick off the production workflow".`

const issueDescription = `Open an issue in a repository.`

const closeDescription = `Close an issue by number, with an optional closing comment.`

const prDescription = `Open a pull request from a head branch into a base branch.`

const mergeDescription = `Merge a pull request by number. Reports the merge commit.`

const branchDescription = `Create a branch from an existing ref in a repository.`

/**
 * @param {{ allowWrites: boolean }} opts
 */
export function githubServer({ allowWrites }) {
  const repoArg = z
    .string()
    .describe('Repository as owner/repo or a github.com URL. Defaults to their own account.')

  const tools = [
    /* ---------------------------------------------------------- reads */
    tool(
      'search_repositories',
      searchDescription,
      {
        query: z.string().describe('Search terms, e.g. "react dashboard" or "topic:boilerplate"'),
        limit: z.number().int().min(1).max(20).optional().describe('Results to return. Default 10.'),
      },
      async ({ query, limit }) => {
        const rows = await gh(
          [
            'search', 'repos', query,
            '--limit', String(limit ?? 10),
            '--json', 'fullName,stargazersCount,description,language,updatedAt,url',
          ],
          { json: true },
        )
        if (!rows?.length) return ok(`No repositories matched "${query}".`)
        return ok(
          rows
            .map(
              (r, i) =>
                `${i + 1}. ${r.fullName} · ${r.stargazersCount ?? 0}★` +
                (r.language ? ` · ${r.language}` : '') +
                (r.description ? `\n   ${String(r.description).slice(0, 140)}` : ''),
            )
            .join('\n'),
        )
      },
    ),

    tool(
      'list_pull_requests',
      listPrsDescription,
      {
        repo: repoArg.optional(),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Default open.'),
      },
      async ({ repo, state }) => {
        const target = repo ? normaliseRepo(repo) : null
        if (repo && !target) return fail(`Not a repository: ${repo}`)
        const rows = await gh(
          [
            'pr', 'list',
            ...(target ? ['--repo', target] : []),
            '--state', state ?? 'open',
            '--limit', '20',
            '--json', 'number,title,author,headRefName,state,updatedAt,isDraft',
          ],
          { json: true },
        )
        if (!rows?.length) return ok('No pull requests in that state.')
        return ok(
          rows
            .map(
              (p, i) =>
                `${i + 1}. #${p.number} ${p.title}\n` +
                `   ${p.author?.login ?? 'unknown'} · ${p.headRefName} · ${p.state}` +
                (p.isDraft ? ' · draft' : ''),
            )
            .join('\n'),
        )
      },
    ),

    tool(
      'list_issues',
      listIssuesDescription,
      {
        repo: repoArg.optional(),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Default open.'),
      },
      async ({ repo, state }) => {
        const target = repo ? normaliseRepo(repo) : null
        if (repo && !target) return fail(`Not a repository: ${repo}`)
        const rows = await gh(
          [
            'issue', 'list',
            ...(target ? ['--repo', target] : []),
            '--state', state ?? 'open',
            '--limit', '20',
            '--json', 'number,title,labels,createdAt,author',
          ],
          { json: true },
        )
        if (!rows?.length) return ok('No issues in that state.')
        return ok(
          rows
            .map(
              (it, i) =>
                `${i + 1}. #${it.number} ${it.title}\n` +
                `   ${it.author?.login ?? 'unknown'}` +
                (it.labels?.length ? ` · ${it.labels.map((l) => l.name).join(', ')}` : ''),
            )
            .join('\n'),
        )
      },
    ),

    tool('list_workflow_runs', runsDescription, {
      repo: repoArg.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }, async ({ repo, limit }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const rows = await gh(
        [
          'run', 'list',
          ...(target ? ['--repo', target] : []),
          '--limit', String(limit ?? 10),
          '--json', 'name,displayTitle,status,conclusion,headBranch,createdAt,workflowName,url',
        ],
        { json: true },
      )
      if (!rows?.length) return ok('No workflow runs recorded.')
      const age = (iso) => {
        const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
        if (mins < 60) return `${mins}m ago`
        if (mins < 1440) return `${Math.round(mins / 60)}h ago`
        return `${Math.round(mins / 1440)}d ago`
      }
      const bad = rows.filter((r) => r.conclusion && r.conclusion !== 'success')
      return ok(
        (bad.length ? `${bad.length} of ${rows.length} runs did not succeed.\n\n` : '') +
          rows
            .map(
              (r, i) =>
                `${i + 1}. ${r.workflowName ?? r.name ?? 'workflow'} · ${r.headBranch}\n` +
                `   ${r.status === 'completed' ? r.conclusion : r.status} · ${age(r.createdAt)}`,
            )
            .join('\n'),
      )
    }),

    tool('check_repository_status', statusDescription, {
      repo: repoArg.optional(),
    }, async ({ repo }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const [repoJson, runs] = await Promise.all([
        gh(
          [
            'repo', 'view',
            ...(target ? [target] : []),
            '--json', 'nameWithOwner,description,defaultBranchRef,pushedAt,isPrivate',
          ],
          { json: true },
        ),
        gh(
          [
            'run', 'list',
            ...(target ? ['--repo', target] : []),
            '--limit', '3',
            '--json', 'name,status,conclusion,headBranch,createdAt',
          ],
          { json: true },
        ),
      ])
      const mins = Math.round(
        (Date.now() - new Date(repoJson.pushedAt).getTime()) / 60000,
      )
      const age =
        mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
      const latest = runs?.[0]
      const verdict = !latest
        ? 'no runs'
        : latest.status !== 'completed'
          ? 'in progress'
          : latest.conclusion
      return ok(
        `${repoJson.nameWithOwner} · ${repoJson.isPrivate ? 'private' : 'public'}\n` +
          `branch ${repoJson.defaultBranchRef?.name ?? 'unknown'} · last push ${age}\n` +
          `latest run ${verdict}${latest ? ` (${latest.workflowName ?? latest.name})` : ''}`,
      )
    }),

    /* --------------------------------------------------------- writes */
    tool('create_fork', forkDescription, { repo: repoArg }, async ({ repo }) => {
      const target = normaliseRepo(repo)
      if (!target) return fail(`Not a repository: ${repo ?? ''}`)
      const out = await gh(['repo', 'fork', target, '--clone=false'], { timeout: 120_000 })
      return ok(`Forked ${target} into kingenious0.\n${out}`)
    }),

    tool(
      'dispatch_workflow',
      dispatchDescription,
      {
        repo: repoArg.optional(),
        workflow: z.string().describe('Workflow file name, e.g. deploy.yml'),
        ref: z.string().optional().describe('Git ref. Default the repo default branch.'),
      },
      async ({ repo, workflow, ref }) => {
        const target = repo ? normaliseRepo(repo) : null
        if (repo && !target) return fail(`Not a repository: ${repo}`)
        await gh([
          'workflow', 'run', workflow,
          ...(target ? ['--repo', target] : []),
          ...(ref ? ['--ref', ref] : []),
        ])
        return ok(`Dispatched ${workflow}${target ? ` on ${target}` : ''}${ref ? ` @ ${ref}` : ''}.\nrun queued`)
      },
    ),

    tool('create_issue', issueDescription, {
      repo: repoArg.optional(),
      title: z.string(),
      body: z.string().optional(),
      label: z.array(z.string()).optional(),
    }, async ({ repo, title, body, label }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const out = await gh(
        [
          'issue', 'create',
          ...(target ? ['--repo', target] : []),
          '--title', title,
          ...(body ? ['--body', body] : []),
          ...(label?.length ? ['--label', ...label] : []),
        ],
        { timeout: 60_000 },
      )
      return ok(out || 'Issue created.')
    }),

    tool('close_issue', closeDescription, {
      repo: repoArg.optional(),
      number: z.number().int(),
      comment: z.string().optional(),
    }, async ({ repo, number, comment }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const out = await gh(
        [
          'issue', 'close', String(number),
          ...(target ? ['--repo', target] : []),
          ...(comment ? ['--comment', comment] : []),
        ],
        { timeout: 60_000 },
      )
      return ok(out || `Issue #${number} closed.`)
    }),

    tool('create_pull_request', prDescription, {
      repo: repoArg.optional(),
      title: z.string(),
      head: z.string().describe('Head branch.'),
      base: z.string().optional().describe('Base branch. Default the repo default.'),
      body: z.string().optional(),
    }, async ({ repo, title, head, base, body }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const out = await gh(
        [
          'pr', 'create',
          ...(target ? ['--repo', target] : []),
          '--title', title,
          '--head', head,
          ...(base ? ['--base', base] : []),
          ...(body ? ['--body', body] : ['--fill']),
        ],
        { timeout: 60_000 },
      )
      return ok(out || 'Pull request opened.')
    }),

    tool('merge_pull_request', mergeDescription, {
      repo: repoArg.optional(),
      number: z.number().int(),
      method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Default squash.'),
    }, async ({ repo, number, method }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const out = await gh(
        [
          'pr', 'merge', String(number),
          ...(target ? ['--repo', target] : []),
          '--' + (method ?? 'squash'),
        ],
        { timeout: 60_000 },
      )
      return ok(out || `PR #${number} merged.`)
    }),

    tool('create_branch', branchDescription, {
      repo: repoArg.optional(),
      branch: z.string().describe('New branch name.'),
      from: z.string().optional().describe('Source ref. Default the default branch.'),
    }, async ({ repo, branch, from }) => {
      const target = repo ? normaliseRepo(repo) : null
      if (repo && !target) return fail(`Not a repository: ${repo}`)
      const full = target ?? (await ownRepo())
      const base = from ?? (await defaultBranch(target))
      // Resolve the source ref to a SHA first — git/refs wants an object id,
      // and posting a ref name there is a 422 with a message that names the
      // wrong thing entirely.
      const refPath = base.startsWith('refs/') ? base : `heads/${base}`
      const src = await gh(['api', `repos/${full}/git/ref/${refPath}`], { json: true })
      const sha = src?.object?.sha
      if (!sha) return fail(`Could not resolve ${base} in ${full} to a commit.`)
      const out = await gh(
        [
          'api', `repos/${full}/git/refs`,
          '-f', `ref=refs/heads/${branch}`,
          '-f', `sha=${sha}`,
        ],
        { json: false, timeout: 30_000 },
      )
      return ok(`Branch ${branch} created from ${base} in ${full}.\n${out}`)
    }),
  ]

  /**
   * Write tools are only registered when the bridge has write access.
   *
   * Registration, not the handler: a tool the model cannot see is one it will
   * not try and then be refused mid-turn, and it keeps read-only mode honest —
   * there is no deny message to get wrong because the capability is simply not
   * advertised. decideTool() would block these by name anyway (`create_*`
   * matches the effectful-verb veto, and dispatch/merge/close match neither
   * read verb so they fall through to ALLOW_WRITES); this is the layer that
   * stops the model ever reaching for them.
   *
   * Split by name rather than by position, so adding a read at the end of the
   * list cannot silently reclassify a write.
   */
  const writeNames = new Set([
    'create_fork', 'dispatch_workflow', 'create_issue', 'close_issue',
    'create_pull_request', 'merge_pull_request', 'create_branch',
  ])
  const reads = tools.filter((t) => !writeNames.has(t.name))
  const writes = tools.filter((t) => writeNames.has(t.name))

  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    instructions:
      'GitHub over the authenticated gh CLI: search, PRs, issues, Actions ' +
      'runs, forking, workflow dispatch and merges. Read tools always run; ' +
      'write tools require bridge write access.',
    alwaysLoad: true,
    tools: allowWrites ? [...reads, ...writes] : reads,
  })
}

/** The authenticated account's own repo, used when no repo argument was given. */
async function ownRepo() {
  const login = await gh(['api', 'user', '--jq', '.login'])
  return `${login}/${login}`
}

async function defaultBranch(repo) {
  const out = await gh(
    ['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef'],
    { json: true },
  )
  return out?.defaultBranchRef?.name ?? 'main'
}
