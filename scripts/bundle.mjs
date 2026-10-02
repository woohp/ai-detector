// One step from a fresh clone to an extension bundle for one browser:
//   npm run bundle:chrome    (or: node scripts/bundle.mjs chrome)
//   npm run bundle:firefox
// Needs Node.js and Python 3.10+. On first run it exports the model, using the active Python
// environment (venv or conda) or creating .venv here; later runs skip the export.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'vanguard';
const win = process.platform === 'win32';

const INSTALL = {
  chrome: `chrome://extensions → enable Developer mode → Load unpacked → .output/chrome-mv3/
  (or unzip the zip and pick that folder)`,
  firefox: `about:debugging → This Firefox → Load Temporary Add-on → the zip or .output/firefox-mv3/manifest.json
  (removed when Firefox restarts)`,
};
const target = process.argv[2];
if (!Object.hasOwn(INSTALL, target ?? '')) {
  console.error('Usage: node scripts/bundle.mjs chrome|firefox');
  process.exit(1);
}

function run(cmd, args, { quiet = false } = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: quiet ? 'ignore' : 'inherit', shell: win });
  return res.status === 0;
}

function must(cmd, args) {
  if (!run(cmd, args)) {
    console.error(`\nFailed: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

const isPython310 = (py) => run(py, ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { quiet: true });

/** Python of the active environment, else of .venv (created if needed). */
function python() {
  if (process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX) return 'python';
  const venv = join(root, '.venv');
  if (!existsSync(venv)) {
    const base = ['python3', 'python'].find(isPython310);
    if (!base) {
      console.error('Python 3.10+ not found. Install it, or activate an environment that has it.');
      process.exit(1);
    }
    console.log('Creating .venv for the model export…');
    must(base, ['-m', 'venv', venv]);
  }
  return join(venv, win ? 'Scripts/python.exe' : 'bin/python');
}

console.log('Installing npm packages…');
must('npm', ['install', '--no-audit', '--no-fund']);

if (existsSync(join(root, 'public/models', MODEL, 'onnx/model_fp16.onnx'))) {
  console.log(`Model already exported (public/models/${MODEL}/); skipping.`);
} else {
  const py = python();
  if (!isPython310(py)) {
    console.error('The active Python environment is older than 3.10.');
    process.exit(1);
  }
  // The export runs on CPU. PyPI's torch for Linux and Windows bundles GBs of CUDA libraries.
  if (process.platform !== 'darwin' && !run(py, ['-c', 'import torch'], { quiet: true })) {
    must(py, ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu']);
  }
  must(py, ['-m', 'pip', 'install', '-r', 'model/requirements.txt']);
  must(py, ['model/export.py', MODEL]);
}

must('npm', ['run', `zip:${target}`]);

const out = join(root, '.output');
const zip = readdirSync(out).find((f) => f.endsWith(`-${target}.zip`));
console.log(`\nBundle: .output/${zip}  (${Math.round(statSync(join(out, zip)).size / 1e6)} MB)`);
console.log(`\nInstall in ${target === 'chrome' ? 'Chrome' : 'Firefox'}:\n  ${INSTALL[target]}`);
