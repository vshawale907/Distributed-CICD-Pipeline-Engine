const { spawn } = require('child_process');

function runStep(repoPath, command, onLog, image = 'node:18-alpine') {
  return new Promise((resolve, reject) => {
    console.log(`🐳 Docker: ${command}`);

    const child = spawn('docker', [
      'run', '--rm',
      '-v', `${repoPath}:/app`,
      '-w', '/app',
      image,
      'sh', '-c', command
    ], { timeout: 5 * 60 * 1000 });

    child.stdout.on('data', (data) => {
      data.toString().split('\n')
        .filter(l => l.trim())
        .forEach(line => onLog(`[stdout] ${line}`));
    });

    child.stderr.on('data', (data) => {
      data.toString().split('\n')
        .filter(l => l.trim())
        .forEach(line => onLog(`[stderr] ${line}`));
    });

    child.on('close', (code) => resolve({ exitCode: code }));
    child.on('error', (err) => reject(err));
  });
}

module.exports = { runStep };

