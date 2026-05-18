import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let repoStatusBarItem: vscode.StatusBarItem;
let filterStatusBarItem: vscode.StatusBarItem;
let uploadStatusBarItem: vscode.StatusBarItem;
let downloadStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  repoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  repoStatusBarItem.command = 'githubSync.setRepo';
  repoStatusBarItem.tooltip = 'Click to set GitHub repository (username/repo)';
  updateRepoDisplay(context);

  filterStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  filterStatusBarItem.text = '$(filter) Files';
  filterStatusBarItem.command = 'githubSync.filterFiles';
  filterStatusBarItem.tooltip = 'Select files to include in upload';
  filterStatusBarItem.show();

  uploadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  uploadStatusBarItem.text = '$(cloud-upload) Upload';
  uploadStatusBarItem.command = 'githubSync.upload';
  uploadStatusBarItem.tooltip = 'Stage + Commit + Push to GitHub';
  uploadStatusBarItem.show();

  downloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  downloadStatusBarItem.text = '$(cloud-download) Download';
  downloadStatusBarItem.command = 'githubSync.download';
  downloadStatusBarItem.tooltip = 'Pull latest changes from GitHub';
  downloadStatusBarItem.show();

  context.subscriptions.push(repoStatusBarItem, filterStatusBarItem, uploadStatusBarItem, downloadStatusBarItem);

  const setRepoCmd = vscode.commands.registerCommand('githubSync.setRepo', async () => {
    const current = context.globalState.get<string>('githubSync.repository', '');
    const input = await vscode.window.showInputBox({
      prompt: 'Enter GitHub repository (e.g. LionHYE/quant-research)',
      placeHolder: 'username/repo',
      value: current,
      validateInput: (value) => {
        if (!value) return null;
        return /^[\w.-]+\/[\w.-]+$/.test(value) ? null : 'Format must be username/repo';
      }
    });
    if (input === undefined) return;
    await context.globalState.update('githubSync.repository', input.trim());
    updateRepoDisplay(context);
    if (input.trim()) {
      vscode.window.showInformationMessage(`GitHub Sync: Repository set to "${input.trim()}"`);
    }
  });

  const filterCmd = vscode.commands.registerCommand('githubSync.filterFiles', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }
    await showFileFilterPanel(context, workspaceRoot);
  });

  const uploadCmd = vscode.commands.registerCommand('githubSync.upload', async () => {
    const repo = context.globalState.get<string>('githubSync.repository', '');
    if (!repo) {
      const setNow = await vscode.window.showWarningMessage(
        'No repository set. Please enter a GitHub repository first.',
        'Set Repository'
      );
      if (setNow) vscode.commands.executeCommand('githubSync.setRepo');
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const commitMsg = await vscode.window.showInputBox({
      prompt: 'Commit message',
      placeHolder: 'Update files',
      value: `Update ${new Date().toLocaleString()}`
    });
    if (commitMsg === undefined) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitHub Sync: Uploading...', cancellable: false },
      async (progress) => {
        try {
          progress.report({ message: 'Checking git status...' });
          await ensureRemote(workspaceRoot, repo, context);

          progress.report({ message: 'Staging changes...' });
          runGit(workspaceRoot, 'add -A');

          const status = runGit(workspaceRoot, 'status --porcelain');
          if (!status.trim()) {
            vscode.window.showInformationMessage('Nothing to commit — working tree clean.');
            return;
          }

          progress.report({ message: 'Committing...' });
          runGit(workspaceRoot, `commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

          progress.report({ message: 'Pushing to GitHub...' });
          const branch = runGit(workspaceRoot, 'rev-parse --abbrev-ref HEAD').trim();

          try {
            runGit(workspaceRoot, `push -u origin ${branch}`);
          } catch (pushErr: unknown) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            if (pushMsg.includes('rejected') || pushMsg.includes('fetch first')) {
              progress.report({ message: 'Remote has new changes, pulling first...' });
              try {
                runGit(workspaceRoot, 'pull --rebase');
              } catch (rebaseErr: unknown) {
                const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
                try { runGit(workspaceRoot, 'rebase --abort'); } catch {}
                throw new Error(
                  `Merge conflict detected. Please run "git pull" manually to resolve conflicts, then upload again.\n\n${rebaseMsg}`
                );
              }
              progress.report({ message: 'Retrying push...' });
              runGit(workspaceRoot, `push -u origin ${branch}`);
            } else {
              throw pushErr;
            }
          }

          vscode.window.showInformationMessage(`Uploaded to ${repo} (branch: ${branch})`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Upload failed: ${msg}`);
        }
      }
    );
  });

  const downloadCmd = vscode.commands.registerCommand('githubSync.download', async () => {
    const repo = context.globalState.get<string>('githubSync.repository', '');
    if (!repo) {
      const setNow = await vscode.window.showWarningMessage(
        'No repository set. Please enter a GitHub repository first.',
        'Set Repository'
      );
      if (setNow) vscode.commands.executeCommand('githubSync.setRepo');
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitHub Sync: Downloading...', cancellable: false },
      async (progress) => {
        try {
          progress.report({ message: 'Checking git status...' });
          const dirty = runGit(workspaceRoot, 'status --porcelain').trim();
          if (dirty) {
            const choice = await vscode.window.showWarningMessage(
              'You have uncommitted changes. Pulling may cause conflicts.',
              'Continue',
              'Cancel'
            );
            if (choice !== 'Continue') return;
          }

          progress.report({ message: 'Ensuring remote...' });
          await ensureRemote(workspaceRoot, repo, context);

          progress.report({ message: 'Pulling from GitHub...' });
          const result = runGit(workspaceRoot, 'pull').trim();
          vscode.window.showInformationMessage(`Downloaded from ${repo}: ${result}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Download failed: ${msg}`);
        }
      }
    );
  });

  context.subscriptions.push(setRepoCmd, filterCmd, uploadCmd, downloadCmd);
  repoStatusBarItem.show();
}

// ---------- File Filter Webview ----------

async function showFileFilterPanel(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'githubSyncFilter',
    'GitHub Sync — Select Files',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  const tree = buildFileTree(workspaceRoot, workspaceRoot);
  const ignoredPaths = readGitignoreEntries(workspaceRoot);

  panel.webview.html = getWebviewHtml(tree, ignoredPaths);

  panel.webview.onDidReceiveMessage(
    async (message: { command: string; ignored: string[] }) => {
      if (message.command === 'save') {
        writeGitignoreEntries(workspaceRoot, message.ignored);
        updateFilterButtonLabel(message.ignored.length);
        panel.dispose();
        vscode.window.showInformationMessage(
          message.ignored.length > 0
            ? `GitHub Sync: ${message.ignored.length} path(s) added to .gitignore`
            : 'GitHub Sync: .gitignore cleared of sync exclusions'
        );
      } else if (message.command === 'cancel') {
        panel.dispose();
      }
    },
    undefined,
    context.subscriptions
  );
}

interface FileNode {
  name: string;
  relativePath: string; // relative to workspace root, uses forward slashes
  isDir: boolean;
  children: FileNode[];
}

const ALWAYS_IGNORE = new Set(['.git', 'node_modules', '.DS_Store', 'out', '__pycache__']);

function buildFileTree(workspaceRoot: string, dir: string): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (ALWAYS_IGNORE.has(entry.name)) continue;
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(workspaceRoot, absPath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        relativePath: relPath,
        isDir: true,
        children: buildFileTree(workspaceRoot, absPath)
      });
    } else {
      nodes.push({ name: entry.name, relativePath: relPath, isDir: false, children: [] });
    }
  }
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

const GITIGNORE_MARKER = '# github-sync-extension';

function readGitignoreEntries(workspaceRoot: string): string[] {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];
  const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
  const markerIdx = lines.findIndex(l => l.trim() === GITIGNORE_MARKER);
  if (markerIdx === -1) return [];
  return lines.slice(markerIdx + 1).map(l => l.trim()).filter(Boolean);
}

function writeGitignoreEntries(workspaceRoot: string, ignored: string[]): void {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  let existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';

  // Strip old managed block
  const markerIdx = existing.indexOf(GITIGNORE_MARKER);
  if (markerIdx !== -1) {
    existing = existing.slice(0, markerIdx).trimEnd();
  }

  if (ignored.length === 0) {
    fs.writeFileSync(gitignorePath, existing + (existing ? '\n' : ''), 'utf8');
    return;
  }

  const block = [
    '',
    GITIGNORE_MARKER,
    ...ignored,
    ''
  ].join('\n');

  fs.writeFileSync(gitignorePath, existing + block, 'utf8');
}

function updateFilterButtonLabel(ignoredCount: number): void {
  filterStatusBarItem.text = ignoredCount > 0
    ? `$(filter) Files (${ignoredCount} ignored)`
    : '$(filter) Files';
}

// ---------- Webview HTML ----------

function getWebviewHtml(tree: FileNode[], ignoredPaths: string[]): string {
  const ignoredSet = JSON.stringify(ignoredPaths);
  const treeJson = JSON.stringify(tree);

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Select Files</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  h2 { margin-bottom: 4px; font-size: 15px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 12px; font-size: 12px; }
  .toolbar {
    display: flex; gap: 8px; margin-bottom: 10px; align-items: center;
  }
  .toolbar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; font-size: 12px;
  }
  .toolbar button:hover { filter: brightness(1.15); }
  .search {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 8px; border-radius: 3px; font-size: 12px;
  }
  .tree-container {
    flex: 1; overflow-y: auto;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px; padding: 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .node { user-select: none; }
  .node-row {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 4px; border-radius: 3px; cursor: default;
  }
  .node-row:hover { background: var(--vscode-list-hoverBackground); }
  .node-row.indeterminate > label { opacity: 0.7; }
  .toggle {
    width: 14px; text-align: center; cursor: pointer;
    color: var(--vscode-descriptionForeground); flex-shrink: 0; font-size: 10px;
  }
  .toggle.leaf { visibility: hidden; }
  input[type=checkbox] { cursor: pointer; flex-shrink: 0; width: 14px; height: 14px; }
  label { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icon { flex-shrink: 0; }
  .children { margin-left: 20px; }
  .hidden { display: none; }
  .actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 16px; cursor: pointer; border-radius: 3px; font-size: 13px;
  }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; padding: 6px 16px; cursor: pointer; border-radius: 3px; font-size: 13px;
  }
  .btn-secondary:hover { filter: brightness(1.15); }
  .status-bar {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    margin-top: 6px;
  }
</style>
</head>
<body>
<h2>Select Files to Upload</h2>
<p class="subtitle">Unchecked files/folders will be added to .gitignore and excluded from uploads.</p>
<div class="toolbar">
  <button id="btn-all">Check All</button>
  <button id="btn-none">Uncheck All</button>
  <input class="search" id="search" placeholder="Filter files…" type="text">
</div>
<div class="tree-container" id="tree"></div>
<div class="status-bar" id="status"></div>
<div class="actions">
  <button class="btn-secondary" id="btn-cancel">Cancel</button>
  <button class="btn-primary" id="btn-save">Save &amp; Close</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const TREE = ${treeJson};
  const INITIAL_IGNORED = new Set(${ignoredSet});

  // checked: true = included (NOT in gitignore), false = excluded
  // We track excluded set (mirrors gitignore)
  const excluded = new Set(INITIAL_IGNORED);

  // Flatten all paths for quick lookup
  const allPaths = [];
  function flattenPaths(nodes) {
    for (const n of nodes) {
      allPaths.push(n.relativePath);
      if (n.children.length) flattenPaths(n.children);
    }
  }
  flattenPaths(TREE);

  function isExcluded(node) {
    // A node is excluded if itself or any ancestor is excluded
    const parts = node.relativePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (excluded.has(parts.slice(0, i).join('/'))) return true;
    }
    return false;
  }

  function dirState(node) {
    // Returns 'all', 'none', or 'partial'
    if (!node.isDir) return isExcluded(node) ? 'none' : 'all';
    const leaves = [];
    function collect(n) {
      if (!n.isDir) { leaves.push(n); return; }
      for (const c of n.children) collect(c);
    }
    collect(node);
    if (!leaves.length) return isExcluded(node) ? 'none' : 'all';
    const excCount = leaves.filter(l => isExcluded(l)).length;
    if (excCount === 0) return 'all';
    if (excCount === leaves.length) return 'none';
    return 'partial';
  }

  function buildNode(node, parentEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'node';
    wrapper.dataset.path = node.relativePath;

    const row = document.createElement('div');
    row.className = 'node-row';

    const toggle = document.createElement('span');
    toggle.className = node.isDir ? 'toggle' : 'toggle leaf';
    toggle.textContent = node.isDir ? '▶' : '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'cb_' + node.relativePath;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = node.isDir ? '📁' : getFileIcon(node.name);

    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.textContent = node.name;

    row.appendChild(toggle);
    row.appendChild(cb);
    row.appendChild(icon);
    row.appendChild(lbl);
    wrapper.appendChild(row);

    let childrenEl = null;
    if (node.isDir && node.children.length) {
      childrenEl = document.createElement('div');
      childrenEl.className = 'children hidden';
      for (const child of node.children) buildNode(child, childrenEl);
      wrapper.appendChild(childrenEl);

      toggle.style.cursor = 'pointer';
      toggle.addEventListener('click', () => {
        const open = !childrenEl.classList.contains('hidden');
        childrenEl.classList.toggle('hidden', open);
        toggle.textContent = open ? '▶' : '▼';
      });
      row.addEventListener('click', (e) => {
        if (e.target === cb || e.target === lbl) return;
        toggle.click();
      });
    }

    cb.addEventListener('change', () => {
      if (node.isDir) {
        // Toggle entire subtree
        setSubtree(node, cb.checked);
      } else {
        if (cb.checked) excluded.delete(node.relativePath);
        else excluded.add(node.relativePath);
      }
      refreshAll();
    });

    parentEl.appendChild(wrapper);
  }

  function setSubtree(node, include) {
    // Remove exclusions for all descendants, then set the dir itself
    function clearDescendants(n) {
      excluded.delete(n.relativePath);
      for (const c of n.children) clearDescendants(c);
    }
    clearDescendants(node);
    if (!include) excluded.add(node.relativePath);
  }

  function refreshAll() {
    document.querySelectorAll('.node').forEach(wrapper => {
      const p = wrapper.dataset.path;
      const node = findNode(p, TREE);
      if (!node) return;
      const cb = document.getElementById('cb_' + p);
      if (!cb) return;
      if (node.isDir) {
        const state = dirState(node);
        cb.checked = state !== 'none';
        cb.indeterminate = state === 'partial';
        wrapper.querySelector('.node-row').classList.toggle('indeterminate', state === 'partial');
      } else {
        cb.checked = !isExcluded(node);
        cb.indeterminate = false;
      }
    });
    updateStatus();
  }

  function findNode(p, nodes) {
    for (const n of nodes) {
      if (n.relativePath === p) return n;
      if (p.startsWith(n.relativePath + '/')) {
        const found = findNode(p, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  function updateStatus() {
    const total = allPaths.filter(p => !findNode(p, TREE)?.isDir).length;
    const excCount = allPaths.filter(p => {
      const n = findNode(p, TREE);
      return n && !n.isDir && isExcluded(n);
    }).length;
    document.getElementById('status').textContent =
      excCount > 0 ? \`\${excCount} of \${total} files excluded from upload\` : \`All \${total} files included\`;
  }

  function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const map = { py:'🐍', js:'📜', ts:'📘', json:'📋', md:'📄', txt:'📄',
                  png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼',
                  csv:'📊', ipynb:'📓', sh:'⚙️', yaml:'⚙️', yml:'⚙️',
                  html:'🌐', css:'🎨', gitignore:'🚫' };
    return map[ext] || '📄';
  }

  // Build tree
  const treeEl = document.getElementById('tree');
  for (const node of TREE) buildNode(node, treeEl);
  refreshAll();

  // Toolbar
  document.getElementById('btn-all').addEventListener('click', () => {
    excluded.clear();
    refreshAll();
  });
  document.getElementById('btn-none').addEventListener('click', () => {
    for (const p of allPaths) excluded.add(p);
    refreshAll();
  });

  // Search filter
  document.getElementById('search').addEventListener('input', function() {
    const q = this.value.toLowerCase();
    document.querySelectorAll('.node').forEach(wrapper => {
      const p = wrapper.dataset.path;
      if (!q) { wrapper.classList.remove('hidden'); return; }
      wrapper.classList.toggle('hidden', !p.toLowerCase().includes(q));
    });
  });

  // Actions
  document.getElementById('btn-save').addEventListener('click', () => {
    // Compute minimal set: prefer parent dirs over listing all children
    const toIgnore = [...excluded].filter(p => {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (excluded.has(parts.slice(0, i).join('/'))) return false;
      }
      return true;
    });
    vscode.postMessage({ command: 'save', ignored: toIgnore });
  });
  document.getElementById('btn-cancel').addEventListener('click', () => {
    vscode.postMessage({ command: 'cancel' });
  });
</script>
</body>
</html>`;
}

// ---------- Helpers ----------

function updateRepoDisplay(context: vscode.ExtensionContext) {
  const repo = context.globalState.get<string>('githubSync.repository', '');
  repoStatusBarItem.text = repo ? `$(repo) ${repo}` : '$(repo) Set repository…';
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function runGit(cwd: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const msg = err.stderr || err.stdout || err.message || String(e);
    throw new Error(msg.trim());
  }
}

async function ensureRemote(
  cwd: string,
  repo: string,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    runGit(cwd, 'rev-parse --git-dir');
  } catch {
    runGit(cwd, 'init');
  }

  let token: string;
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    token = session.accessToken;
  } catch {
    throw new Error('GitHub authentication failed. Please sign in to GitHub in VSCode.');
  }

  const remoteUrl = `https://${token}@github.com/${repo}.git`;
  try {
    runGit(cwd, 'remote get-url origin');
    runGit(cwd, `remote set-url origin "${remoteUrl}"`);
  } catch {
    runGit(cwd, `remote add origin "${remoteUrl}"`);
  }
}

export function deactivate() {}
