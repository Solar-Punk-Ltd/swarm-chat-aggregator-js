import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export class DockerError extends Error {
  constructor(args, result) {
    super(
      `docker ${args.join(' ')} exited ${result.status}\n` +
        `--- stdout\n${result.stdout.trim()}\n--- stderr\n${result.stderr.trim()}`,
    );
    this.name = 'DockerError';
    this.status = result.status;
  }
}

/**
 * Runs the docker CLI and returns both streams. A failure carries both streams and the exit code,
 * because a CLI that explains itself on one stream and exits on the other is the usual way a cause gets lost.
 */
export function docker(args, { allowFailure = false, input } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new DockerError(args, result);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const CONTAINER_ID_IN_MOUNTINFO = /\/containers\/([0-9a-f]{64})\//;

/**
 * The id of the container this process runs in, or null outside one.
 * Docker names a container's hostname after its short id unless told otherwise, and mountinfo
 * carries the full id either way.
 */
export function ownContainerId() {
  const candidates = [hostname()];
  try {
    const match = readFileSync('/proc/self/mountinfo', 'utf8').match(CONTAINER_ID_IN_MOUNTINFO);
    if (match) candidates.push(match[1]);
  } catch {
    // not Linux, so not a container this daemon started
  }
  return candidates.find((id) => docker(['container', 'inspect', id], { allowFailure: true }).status === 0) ?? null;
}
