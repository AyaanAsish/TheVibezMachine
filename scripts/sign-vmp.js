const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const electronDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');

function findPython() {
  const candidates = os.platform() === 'win32'
    ? ['python.exe', 'python3.exe', 'py.exe']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('No Python interpreter found. Please install Python 3.');
  process.exit(1);
}

try {
  execSync(`"${python}" -m castlabs_evs.vmp sign-pkg "${electronDist}"`, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
} catch (err) {
  console.error('VMP signing failed:', err.message);
  process.exit(1);
}
