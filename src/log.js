const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${args.map(String).join(' ')}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export function logger(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
  };
}
